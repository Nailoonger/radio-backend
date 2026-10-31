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

const { C, findOne, findById, findAllPaged } = require('../../lib/db');
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

/**
 * 岗位 → 部门（2026-10-30 定稿：岗位是主维度，部门是它的影子）
 *
 * ⚠️ 只在这一处定义，`me.js`（落库时推）和 `personDto`（读出来时兜底）都用它，
 *    两套映射表必然出现「配了却判不过」这种自相矛盾。
 * ⚠️ 记者 / 技术 不挂部门 —— 它们不在表里。
 */
const DEPT_BY_ROLE = { 播音: '播音部', 主持: '主持部', 编辑: '编辑部' };

/**
 * 岗位数组 → 主部门（按 DUTY_ROLES 的顺序取第一个命中项；推不出来返回 ''）
 *
 * ⚠️ 顺序必须固定：兼播音+主持的人主部门是「播音部」，换个顺序结果就变了。
 */
function deptOfRoles(roles) {
  const list = Array.isArray(roles) ? roles : [];
  for (let i = 0; i < DUTY_ROLES.length; i++) {
    if (list.indexOf(DUTY_ROLES[i]) >= 0 && DEPT_BY_ROLE[DUTY_ROLES[i]]) return DEPT_BY_ROLE[DUTY_ROLES[i]];
  }
  return '';
}

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

// ─────────────────────────── 权限分发（2026-10-31）───────────────────────────

/**
 * 三个权限位 —— **只在这里定义一次**
 *
 * 为什么低层放在 _kit 而不是 permissions.js：
 *   `permissions.js` 要用 `_kit.asSuperPartner`，如果 `_kit` 反过来 require 它，
 *   就成了循环依赖（打包成单文件后表现为「读到一半 undefined」这种极难查的崩）。
 *   所以「怎么读、怎么判」沉在这里，`permissions.js` 只做 HTTP 层的编排。
 *
 * ⚠️ `deny` 就是前端弹窗的标题，陛下原话是「暂无权限」「暂无审核权限」「暂无代录权限」，
 *    别在页面里再硬编码一遍 —— 改词只改这张表。
 *
 * ⚠️⚠️ 2026-10-31 二次定稿：`schedule` 与 `proxy` **必须分开**。
 *    第一版把「代录」绑在排班权限上，陛下当场纠回来：
 *    「代录的话需要超管开放代录权限给社干才可以……不开的话社干只能填写自己的」。
 *    这两件事的语义本来就不同 —— 排班是「排谁上班」，代录是「替别人说自己能不能来」。
 *    一个人可以只会收时间、不会排班（宣传口的人常常这样）。
 */
const PERM_KEYS = ['schedule', 'review', 'proxy'];
const PERM_TEXT = {
  // ⚠️ `short` 给人少的胶囊用（一行要塞三个，写全名会挤成两三行）
  schedule: { key: 'schedule', name: '排班权限', short: '排班', desc: '进入排班工作台', deny: '暂无权限' },
  review: { key: 'review', name: '审核权限', short: '审核', desc: '进入审核模块', deny: '暂无审核权限' },
  proxy: { key: 'proxy', name: '代录权限', short: '代录', desc: '替别人填可排时间', deny: '暂无代录权限' },
};

/** 三态归一：true / false / null（null = 跟随全局；脏值一律当跟随，不当作 true） */
function triPerm(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * 「这个集合还没建」的判定
 *
 * ⚠️⚠️ 云开发里查一个**没建过**的集合是**抛错**（-502005 / collection not exists），
 *    **不是**返回空数组。这和 SQL 里「表不存在报错」一个道理，但很容易想当然。
 *    2026-10-31 实际踩到：新增 `partner_permissions` 忘了跑一次 init-collections，
 *    权限管理页直接 50001「服务器繁忙」，而本地 harness 的内存库是「查什么都没有就返回 []」，
 *    所以本地全绿、线上白屏。
 */
function isMissingCollection(err) {
  const msg = String((err && (err.errMsg || err.message)) || err);
  return /collection not exists|-502005|Db or Table not exist|not exist/i.test(msg);
}

/**
 * 读兜底：集合不存在时当成「没有这一行」
 *
 * 语义上是自洽的 —— 这套权限本来就是「缺行 = 全开」，表都没建当然更等于缺行。
 * 宁可让开关显示「开」而实际不生效，也别让人打开页面就看见「服务器繁忙」。
 */
async function readOr(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    if (isMissingCollection(e)) return fallback;
    throw e;
  }
}

/** 全局总闸；**缺行 = 全开**（与 system_switch 同口径，发版当天不改变任何人的现状） */
async function readGlobalPerm() {
  /**
   * ⚠️⚠️ 默认值必须把**每一个** PERM_KEYS 都列出来。
   *    只写 `{schedule:true, review:true}` 时，后加的 `proxy` 会取到 undefined
   *    ⇒ `!!undefined === false` ⇒ 所有社干一夜之间「暂无代录权限」。
   *    这次是测试逮住的；靠肉眼看是看不出来的（界面上开关还显示着「开」）。
   */
  const out = { schedule: true, review: true, proxy: true };
  // ⚠️ readOr：集合还没建时当「缺行」处理，不让整页 50001（见 isMissingCollection 头注）
  const doc = await readOr(() => findById(C.PARTNER_PERMISSION, 'global'), null);
  if (doc) {
    PERM_KEYS.forEach((k) => {
      const v = triPerm(doc[k]);
      if (v !== null) out[k] = v;
    });
  }
  return out;
}

/** 某个 admin.id 的按人设置（null = 没单独设过） */
async function readPersonPerm(adminId) {
  const id = Number(adminId);
  const out = { schedule: null, review: null, proxy: null };
  if (!Number.isInteger(id) || id <= 0) return out;
  const doc = await readOr(() => findById(C.PARTNER_PERMISSION, `p:${id}`), null);
  if (doc) PERM_KEYS.forEach((k) => { out[k] = triPerm(doc[k]); });
  return out;
}

/** 生效值 = 按人覆盖全局 */
function effectivePerm(global, over) {
  const out = {};
  PERM_KEYS.forEach((k) => {
    const v = over ? over[k] : null;
    out[k] = (v === true || v === false) ? v : !!(global && global[k]);
  });
  return out;
}

/** admin 文档 → 生效权限（两次读：全局 + 按人） */
async function permsOf(admin) {
  const id = Number(admin && admin.id);
  const [global, over] = await Promise.all([readGlobalPerm(), readPersonPerm(id)]);
  return effectivePerm(global, over);
}

/**
 * 排班工作台权限（生成 / 发布 / 撤回 / 换人 / 清空 / 候选池）
 *
 * 超管恒放行 —— 他自己就是总闸，不该被自己关的开关锁在门外。
 * 站员照样 40301（这是**角色**层面的拒绝，和开关无关，别把两件事混成一句话）。
 * 社干被关掉时抛的 message 就是弹窗标题：`暂无权限`。
 */
async function asScheduler(ctx) {
  const p = ctx.partner || (await asPartner(ctx));
  if (p.isSuper) {
    p.perms = { schedule: true, review: true, proxy: true };
    return p;
  }
  if (p.role !== ROLE_MANAGER) throw new ApiError(Codes.FORBIDDEN, '站员没有这个权限');
  const perms = await permsOf(p.admin);
  p.perms = perms;
  if (!perms.schedule) throw new ApiError(Codes.FORBIDDEN, PERM_TEXT.schedule.deny);
  return p;
}

/** 审核模块权限（内部稿件审稿队列 / 通过 / 驳回），语义同 asScheduler */
async function asReviewer(ctx) {
  const p = ctx.partner || (await asPartner(ctx));
  if (p.isSuper) {
    p.perms = { schedule: true, review: true, proxy: true };
    return p;
  }
  if (p.role !== ROLE_MANAGER) throw new ApiError(Codes.FORBIDDEN, '站员没有这个权限');
  const perms = await permsOf(p.admin);
  p.perms = perms;
  if (!perms.review) throw new ApiError(Codes.FORBIDDEN, PERM_TEXT.review.deny);
  return p;
}

/**
 * 代录权限（替别人填可排时间）
 *
 * ⚠️ 站员的报错文案**保持原样**「只能填自己的可排时间」：
 *    对站员来说这不是「没开权限」，而是角色上就没有这件事 —— 两句话别混成一句。
 */
async function asProxyer(ctx) {
  const p = ctx.partner || (await asPartner(ctx));
  if (p.isSuper) {
    p.perms = { schedule: true, review: true, proxy: true };
    return p;
  }
  if (p.role !== ROLE_MANAGER) throw new ApiError(Codes.FORBIDDEN, '只能填自己的可排时间');
  const perms = await permsOf(p.admin);
  p.perms = perms;
  if (!perms.proxy) throw new ApiError(Codes.FORBIDDEN, PERM_TEXT.proxy.deny);
  return p;
}

// ─────────────────────────── 可排时间填写窗口 ───────────────────────────

/**
 * 填写窗口：**周一 00:00 ~ 周六 23:59:59.999 可填，周日整日只读**（2026-10-31 陛下定）
 *
 * 原话：「填写窗口是周一 0 点到周六 24 点，周日那天整页只读，要改只能超管代录」。
 *
 * ⚠️ 判据只有一条：**看「今天」是星期几**，不看目标周。
 *    周日已经算下一周了（`currentWeekStart` 的 duty 口径），这天收时间意味着
 *    「下周班表已经该生成了，再改就来不及」，所以关窗，把例外通道留给超管。
 * ⚠️ 返回 `open` 而不是直接抛错：GET 也要用它 —— 前端要先知道「现在是只读态」
 *    才能把整页渲染成只读，而不是等点了保存才被拒。
 */
function availabilityWindow(ts) {
  const t = ts === undefined ? Date.now() : ts;
  const dow = bj.weekdayOf(t);        // 0 = 周日
  const open = dow !== 0;
  return {
    open,
    weekday: dow,
    // 文案只在这里写一份：前端整页只读的提示条直接用它
    text: open ? '' : '周日只读 · 要改只能找超管代录',
  };
}

/**
 * 写接口的窗口闸
 *
 * ⚠️ 只放超管过去（陛下原话「要改只能超管代录」）。
 *    所以周日这天，**有代录权限的社干也被关在门外** —— 这不是漏掉，是照原话做的。
 *    如果哪天要放开，改这一行就行，别去动前端。
 */
function assertWindowWritable(p, ts) {
  const w = availabilityWindow(ts);
  if (w.open || (p && p.isSuper)) return w;
  throw new ApiError(Codes.FORBIDDEN, w.text);
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

/** 北京时间「本周周一」的 YYYY-MM-DD（**值班周口径**：周日 00:00 起算下一周） */
function currentWeekStart(ts) {
  /**
   * ⚠️⚠️ 2026-10-31 改：周日 0 点就切到下一周（陛下定）。
   *
   * 原来直接用 bj.weekRange（日历周，周一起算），于是周日打开任何一个带「本周」的页面 ——
   * 考勤 / 请假 / 排班工作台 / 大白卡 / 我的班表 —— 看到的都是**一周前那一周**，
   * 而周日恰恰是「下周班表已经发布、还没填可排时间的人要被代录」的那一天。
   * 现在走 bj.dutyWeekStart：周一 0 点到周六 24 点 = 本周，周日 0 点起 = 下周。
   *
   * ⚠️ 这是一个**全局口径**，所有「不传 week 时默认哪一周」的地方都吃它。
   *    改这里等于同时改五个页面；改完必须逐页看一眼（见 test-partner-week-anchor.js）。
   */
  return bj.dutyWeekStart(ts === undefined ? Date.now() : ts);
}

/**
 * 北京时间「下一周周一」的 YYYY-MM-DD —— **站员要填的那一周**
 *
 * ⚠️ 可排时间的默认周锚点（2026-10-31 陛下定：「当然是本周填下一周的啊」）。
 *    站员周一 0 点到周六 24 点填的是**还没开始**的那一周。
 * ⚠️ 走 bj.nextWeekRange（**日历**周 +7，不含周日切周的那套）：
 *    它是「今天之后的下一个周一」，周一到周日算出来永远是同一个答案 ——
 *    周日算出来正好等于 currentWeekStart（周日已经算下周了），这是对的，不是 bug。
 * ⚠️ 别改成 currentWeekStart + 7：周日会算成再下一周，代录就会落到用户没打算填的那一周。
 */
function nextWeekStart(ts) {
  const r = bj.nextWeekRange(ts === undefined ? Date.now() : ts);
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
  const dutyRoles = Array.isArray(a.dutyRoles) ? a.dutyRoles : [];
  return {
    personId: Number(a.id),
    name: a.nickname || a.username || `账号${a.id}`,
    username: a.username || '',
    /*
     * ⚠️⚠️ 部门这里**允许由岗位反推**（`a.department || deptOfRoles(...)`），2026-10-30 加。
     *    原因：10-30 之前那版「配岗位」弹层只写 `dutyRoles`、**不写 department**，
     *    于是老数据「有岗位、没部门」，排班时被判「部门不匹配」，看着像压根没配过
     *    （陛下当天就是拿这个来问的：「点换人也显示其他人未配置部门」）。
     *    只读推导、不写库：判定与显示立刻正确，下次保存时自然落库。
     *    手配的部门**永远优先**，这里只在它为空时兜底。
     */
    department: a.department || deptOfRoles(dutyRoles),
    dutyRoles,
    isSuper: Number(a.role) === ROLE_SUPER,
    isMember: Number(a.role) === ROLE_MEMBER,
    /*
     * 手机号（2026-10-31 伙伴名册）：**只存 admin 文档上的 `phone`**，不另起表。
     * ⚠️ 空值统一成 ''，不要 null / undefined —— 前端拿它判「要不要强制填」，
     *    三种空值各写一遍判断迟早漏一个（`!x` 能过，`x === ''` 就漏）。
     * ⚠️ 这里不做脱敏：名册的用途就是「找人打电话」，脱敏等于没这功能。
     */
    phone: normalizePhone(a.phone, { strict: false }),
  };
}

/**
 * 手机号规范化（2026-10-31）
 *
 * 只认大陆手机号：11 位、1 开头、第二位 3–9。空白与 `-` `(` `)` 一律当分隔符去掉，
 * 全角数字转半角（微信键盘切全角很容易打出来）。
 *
 * @param {*} raw         原始值
 * @param {object} opt    strict=true 时非法直接抛 PARAM_ERROR（写接口用）；
 *                        false 时非法返回 ''（读接口用，脏数据不该让整张名册挂掉）。
 */
function normalizePhone(raw, opt) {
  const strict = !!(opt && opt.strict);
  let v = String(raw == null ? '' : raw)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-()（）]/g, '');
  if (!v) {
    if (strict) throw new ApiError(Codes.PARAM_ERROR, '请填写手机号');
    return '';
  }
  if (!/^1[3-9]\d{9}$/.test(v)) {
    if (strict) throw new ApiError(Codes.PARAM_ERROR, '手机号要 11 位、1 开头，请检查后重填');
    return '';
  }
  return v;
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
  DUTY_ROLES, DEPARTMENTS, WEEK_DAYS, DEPT_BY_ROLE, deptOfRoles,
  asPartner, asSuperPartner, asManager, asScheduler, asReviewer, asProxyer,
  PERM_KEYS, PERM_TEXT, triPerm, readGlobalPerm, readPersonPerm, effectivePerm, permsOf,
  isMissingCollection, readOr,
  availabilityWindow, assertWindowWritable,
  assertWeekStart, currentWeekStart, nextWeekStart, weekDates, weekStarted,
  hhmm, normalizeTemplates, templatesToSlots,
  personDto, normalizePhone, listPeople, resolvePerson,
  notYet,
};
