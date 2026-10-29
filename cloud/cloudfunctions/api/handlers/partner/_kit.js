'use strict';

/**
 * 伙伴端 handler 公共件
 *
 * 与 admin/_kit.js 的分工：
 *   admin/_kit  → 「管理端通用」（分页 / LIKE / 多键排序 / 字段投影），面向后台管理语义
 *   partner/_kit → 「伙伴端专有」（身份资格 / 值班周锚点 / 人员池 / 时段模板校验）
 *
 * ═══════════ 身份模型（2026-10-27 定稿）═══════════
 * 伙伴端**只有一个身份来源**：admin 表的账号，token 走 `admin_token`。
 *   admin.role = 0 → 超管（老师）
 *   admin.role = 1 → 社干（社员）
 *
 * ⚠️ 站员**不进伙伴端**：站员用学生 token，走 pages/ 下的页面。
 *    伙伴端任何 handler 的第一行都必须是 `await asPartner(ctx)`，
 *    否则会出现「没登录也能调」的静默漂移（与 admin/_kit 头注同一类坑）。
 *
 * ⚠️ 为什么 asPartner 是 **async**：它要多查一次 admin 文档拿 `dutyRoles` / `department`。
 *    admin/_kit 的 asAdmin 只看 token payload（同步），是因为管理端接口不需要资格字段。
 *
 * ═══════════ 人员池口径（P1 阶段的明确取舍）═══════════
 * 人员池 = **admin 表里 status=1 的账号**，`personId` 就是 `admin.id`（数字）。
 *
 * 这是有意的阶段性收敛：
 *   - 能填「可排时间」、能被排班的人，必须先能登录伙伴端 → 必须有 admin 账号。
 *   - staff 表（部门人员）目前是**官网展示用**（有 avatar / motto / sort），
 *     不代表有登录账号，直接混进来会产生「排了班但人永远填不了时间」的僵尸岗。
 *   - 若将来要把 staff 也纳入，扩展方式是给 personId 加前缀（`a:12` / `s:5`），
 *     **只改本文件的 personKey() 与 resolvePerson()，不动任何接口签名**。
 */

const { C, findOne, findAllPaged } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { requireAdmin } = require('../../lib/auth');
const bj = require('../../lib/bjTime');

/** admin.role 取值 */
const ROLE_SUPER = 0;
const ROLE_MANAGER = 1;
/**
 * 站员（2026-10-29 新增）
 *
 * ⚠️ 站员**不是第三种人**：他是学生的第二种角色。所以这个 role 只用来限定
 *    「在伙伴端能做什么」，不是身份来源 —— 人仍然挂在 user 表（admin.userId → user.id）。
 * ⚠️ 为什么 personId 还是 admin.id：排班/请假/考勤/互评四张表的 personId 全部指向 admin.id，
 *    改键就要迁数据。所以站员也在 admin 表有一行，只是权限被压到最小。
 */
const ROLE_MEMBER = 2;

/** 值班岗位白名单 —— 与 staff.role 的常见取值、原型「部门」下拉保持一致 */
const DUTY_ROLES = ['播音', '主持', '编辑', '记者', '技术'];
/** 部门白名单 */
const DEPARTMENTS = ['播音部', '主持部', '编辑部'];

/** 一周固定 5 个值班日（周一 ~ 周五），周六周日不排班 */
const WEEK_DAYS = 5;

/**
 * 伙伴端身份校验 —— **每个 partner handler 的第一行**
 *
 * 返回 { payload, admin, id, isSuper, isManager, dutyRoles, department }
 * 失败抛 40101（未登录/过期）或 40301（禁用）。
 *
 * ⚠️ 禁用状态**每次请求都查库**，不缓存：管理员被禁用后要立刻失效，
 *    而 JWT 有效期 7 天，只靠 token 会留下长达一周的空窗。
 */
async function asPartner(ctx) {
  const payload = requireAdmin(ctx);
  const admin = await findOne(C.ADMIN, { id: Number(payload.id) });
  if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号不存在');
  if (Number(admin.status) !== 1) throw new ApiError(Codes.FORBIDDEN, '账号已禁用');

  const role = Number(admin.role);
  const isSuper = role === ROLE_SUPER;
  const isMember = role === ROLE_MEMBER;
  ctx.admin = payload;
  ctx.partner = {
    payload,
    admin,
    id: Number(admin.id),
    role,
    isSuper,
    isMember,
    // 只有超管/社干算「管理者」—— 站员不算
    isManager: role === ROLE_MANAGER,
    dutyRoles: Array.isArray(admin.dutyRoles) ? admin.dutyRoles : [],
    department: admin.department || '',
  };
  return ctx.partner;
}

/** 仅超管 —— 时段配置 / 规则 / 账号管理这类「改全局」的动作 */
async function asSuperPartner(ctx) {
  const p = ctx.partner || (await asPartner(ctx));
  if (!p.isSuper) throw new ApiError(Codes.FORBIDDEN, '仅超级管理员可操作');
  return p;
}

/**
 * 仅社干及以上（超管 / 社干）
 *
 * ⚠️ 2026-10-29 收紧：原来等价于 asPartner（谁都能过），加了站员角色之后这就是**越权漏洞**
 *    —— 站员能调审稿、批假、生成班表、点名。现在站员（role=2）一律 40301。
 */
async function asManager(ctx) {
  const p = ctx.partner || (await asPartner(ctx));
  if (p.role !== ROLE_SUPER && p.role !== ROLE_MANAGER) {
    throw new ApiError(Codes.FORBIDDEN, '站员没有这个权限');
  }
  return p;
}

// ─────────────────────────── 值班周锚点 ───────────────────────────

const WEEK_START_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 校验并规范化 weekStart（必须是北京时间周一，格式 YYYY-MM-DD）
 *
 * ⚠️ 前端**不要自己算周一**：小程序端与云函数的时区/日历切点不一致，
 *    前端只负责传一个它认为是周一的日期，这里做权威校验。
 *    传错就报错，而不是「悄悄修正」—— 悄悄修正会让班表落到错误的周，且无日志。
 *
 * 实现要点：把 `YYYY-MM-DD` 当作 UTC 零点解析，再用 bjTime.shifted 平移，
 *          此时 getUTCDay() 读到的就是**北京日历**上的星期几（1=周一）。
 */
function assertWeekStart(raw) {
  const s = String(raw || '').trim();
  const m = WEEK_START_RE.exec(s);
  if (!m) throw new ApiError(Codes.PARAM_ERROR, 'week 需为 YYYY-MM-DD 格式');

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));

  // 反向校验：2026-02-31 这种会被 Date 静默进位成 3-03，必须挡掉
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new ApiError(Codes.PARAM_ERROR, 'week 不是一个真实存在的日期');
  }
  if (bj.weekdayOf(t) !== 1) {
    throw new ApiError(Codes.PARAM_ERROR, 'week 必须是周一');
  }
  return s;
}

/** 北京时间「本周周一」的 YYYY-MM-DD */
function currentWeekStart(ts) {
  const r = bj.weekRange(ts === undefined ? Date.now() : ts);
  // weekRange 返回的是真实 UTC 时刻（周一 00:00 北京时间），转回北京日历日即可
  return bj.dayKey(r.start.getTime());
}

/** 从 weekStart 展开 5 个值班日的日期字符串（周一 ~ 周五） */
function weekDates(weekStart) {
  const s = assertWeekStart(weekStart);
  const m = WEEK_START_RE.exec(s);
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const out = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    out.push(bj.ymd(new Date(base + i * bj.DAY_MS)));
  }
  return out;
}

/** 该周是否已经开始（用于「已开始的周禁止撤回」这类判定） */
function weekStarted(weekStart, ts) {
  const dates = weekDates(weekStart);
  return bj.dayKey(ts === undefined ? Date.now() : ts) >= dates[0];
}

// ─────────────────────────── 时段模板 ───────────────────────────

/** 分钟数 → HH:MM */
function hhmm(min) {
  const n = Math.max(0, Math.min(1439, Number(min) || 0));
  return `${bj.pad2(Math.floor(n / 60))}:${bj.pad2(n % 60)}`;
}

/**
 * 校验并规范化一组时段模板
 *
 * 形状：{ day: 0..4, title, start, end, dept, role, count }
 *   day   0=周一 … 4=周五
 *   start/end 为**当天分钟数**（410 = 06:50），end 必须大于 start
 *   count 该时段需要几个人（同格多部门靠 dept+seq 区分，见 duty_assignments）
 *
 * 同一时刻可配置多个部门/岗位；每个需求有独立 slotKey。
 * 完全相同起止时间的不同部门/岗位可以并行；同一需求重复和部分重叠仍拦截。
 */
function normalizeTemplates(raw) {
  if (!Array.isArray(raw)) throw new ApiError(Codes.PARAM_ERROR, 'templates 必须是数组');
  if (raw.length > 100) throw new ApiError(Codes.PARAM_ERROR, '时段过多（上限 100 条）');

  const out = raw.map((t, i) => {
    const at = `第 ${i + 1} 个时段`;
    const day = Number(t && t.day);
    if (!Number.isInteger(day) || day < 0 || day >= WEEK_DAYS) {
      throw new ApiError(Codes.PARAM_ERROR, `${at}的 day 必须是 0~4（周一到周五）`);
    }
    const title = String((t && t.title) || '').trim();
    if (!title) throw new ApiError(Codes.PARAM_ERROR, `${at}缺少名称`);
    if (title.length > 20) throw new ApiError(Codes.PARAM_ERROR, `${at}的名称过长（上限 20 字）`);

    const start = Number(t && t.start);
    const end = Number(t && t.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new ApiError(Codes.PARAM_ERROR, `${at}的起止时间必须是整数分钟`);
    }
    if (start < 0 || end > 1440) throw new ApiError(Codes.PARAM_ERROR, `${at}的起止时间超出当天范围`);
    if (end <= start) throw new ApiError(Codes.PARAM_ERROR, `${at}的结束时间必须晚于开始时间`);

    const count = Number(t && t.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new ApiError(Codes.PARAM_ERROR, `${at}的人数必须是 1~20`);
    }

    const dept = String((t && t.dept) || '').trim();
    const role = String((t && t.role) || '').trim();
    if (dept && DEPARTMENTS.indexOf(dept) < 0) {
      throw new ApiError(Codes.PARAM_ERROR, `${at}的部门「${dept}」不在可选范围内`);
    }
    if (role && DUTY_ROLES.indexOf(role) < 0) {
      throw new ApiError(Codes.PARAM_ERROR, `${at}的岗位「${role}」不在可选范围内`);
    }

    return { day, title, start, end, dept, role, count };
  });

  // 同一天内两两查重叠（5 天 × 至多 20 条，O(n²) 完全够）
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      if (a.day !== b.day) continue;
      if (a.start < b.end && b.start < a.end) {
        const parallel = a.start === b.start && a.end === b.end;
        if (parallel && (a.dept !== b.dept || a.role !== b.role)) continue;
        throw new ApiError(
          Codes.PARAM_ERROR,
          `周${bj.WEEKDAY_CN[a.day + 1]}的「${a.title}」(${hhmm(a.start)}-${hhmm(a.end)}) 与「${b.title}」(${hhmm(b.start)}-${hhmm(b.end)}) 时间重叠`
        );
      }
    }
  }

  // 按天 + 起始时间排序，前端拿到的顺序就是展示顺序（不用再排）
  return out.sort((a, b) => (a.day - b.day) || (a.start - b.start));
}

/** 模板 → 可排时间的选项格（slotKey = `<day>-<序号>`，与拆解文档一致） */
function templatesToSlots(templates) {
  const list = Array.isArray(templates) ? templates : [];
  const seqByDay = {};
  return list.map((t) => {
    const day = Number(t.day) || 0;
    seqByDay[day] = (seqByDay[day] || 0) + 1;
    const seq = seqByDay[day];
    return {
      slotKey: `${day}-${seq}`,
      day,
      seq,
      title: t.title,
      start: t.start,
      end: t.end,
      dept: t.dept || '',
      role: t.role || '',
      count: t.count || 1,
      timeText: `${hhmm(t.start)}-${hhmm(t.end)}`,
    };
  });
}

// ─────────────────────────── 人员池 ───────────────────────────

/** admin 文档 → 人员池里的一项（**不含 password**） */
function personDto(a) {
  return {
    personId: Number(a.id),
    name: a.nickname || a.username || `账号${a.id}`,
    username: a.username || '',
    department: a.department || '',
    dutyRoles: Array.isArray(a.dutyRoles) ? a.dutyRoles : [],
    isSuper: Number(a.role) === ROLE_SUPER,
  };
}

/**
 * 取人员池：admin 表 status=1 的全部账号
 *
 * ⚠️ 用 findAllPaged 而不是 findMany：云函数端单次 get 上限 100 条，
 *    社团规模虽小，但「账号」是会长大的集合，不能埋这个雷。
 */
async function listPeople() {
  const rows = await findAllPaged(C.ADMIN, { status: 1 });
  return rows
    .filter((a) => a && a.id !== undefined && a.id !== null)
    .map(personDto)
    .sort((x, y) => {
      // 超管在后、其余按姓名，保证前端下拉顺序稳定
      if (x.isSuper !== y.isSuper) return x.isSuper ? 1 : -1;
      return String(x.name).localeCompare(String(y.name), 'zh-Hans-CN');
    });
}

/** personId → 人员池项；不存在则报错（防越权代录到不存在的人） */
async function resolvePerson(personId) {
  const id = Number(personId);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(Codes.PARAM_ERROR, 'personId 不合法');
  const a = await findOne(C.ADMIN, { id });
  if (!a) throw new ApiError(Codes.NOT_FOUND, '该成员不存在');
  if (Number(a.status) !== 1) throw new ApiError(Codes.PARAM_ERROR, '该成员账号已禁用');
  return personDto(a);
}

/** 统一的「接口未开放」错误（P2 之后才做的动作先显式占位，避免前端静默失败） */
function notYet(name) {
  return new ApiError(Codes.SERVER_ERROR, `${name} 将在后续阶段开放`);
}

module.exports = {
  ROLE_SUPER, ROLE_MANAGER, ROLE_MEMBER,
  DUTY_ROLES, DEPARTMENTS, WEEK_DAYS,
  asPartner, asSuperPartner, asManager,
  assertWeekStart, currentWeekStart, weekDates, weekStarted,
  hhmm, normalizeTemplates, templatesToSlots,
  personDto, listPeople, resolvePerson,
  notYet,
};
