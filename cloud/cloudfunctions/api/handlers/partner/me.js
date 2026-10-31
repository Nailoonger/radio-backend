'use strict';

/**
 * 伙伴端 · 身份与资格
 *
 * GET  /partner/me        当前伙伴是谁、能做什么
 * PUT  /partner/me/duty   维护自己的部门 / 值班岗位
 * GET  /partner/people    人员池（排班与代录都要用）
 *
 * ═══════════ 为什么单独一个 me 接口 ═══════════
 * 管理端已有 `GET /admin/profile`，但它的返回是「后台账号信息」，
 * 不含伙伴端要的两样东西：
 *   ① 资格（dutyRoles / department）—— 决定「这个时段我能不能被排」
 *   ② 能力位（canEditSlots / canPublish / canProxy）—— 决定菜单显示什么
 * 让前端自己从 `role` 推能力位是**危险的**：前端推错就是越权入口，
 * 后端推错至少还有 handler 里的 asSuperPartner 兜底。所以能力位一律后端给。
 */

const { C, findOne, updateById } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const {
  asPartner, asSuperPartner, listPeople, resolvePerson, permsOf,
  DUTY_ROLES, DEPARTMENTS, deptOfRoles, normalizePhone,
} = require('./_kit');

/**
 * 只有「社干」才需要查权限开关 —— 超管恒放行、站员一律 false，
 * 这两种人多查两次库纯属浪费（/partner/me 是打开 App 第一个接口）。
 */
async function permsFor(p) {
  if (p.isSuper || !p.isManager) return null;
  return permsOf(p.admin);
}

/**
 * 把「身份 + 资格 + 权限开关」翻译成能力位
 *
 * ⚠️ 与 handler 里的实际鉴权**必须一一对应**：
 *    canEditSlots 为 true 的接口必须只要求 asPartner；
 *    为 false 的接口才要求 asSuperPartner。
 *    两边不一致就会出现「按钮点了报 40301」，这是最容易被当成 bug 报上来的形态。
 *
 * ⚠️ 2026-11-01：`canManageSchedule` / `canReview` 不再只看角色，还要看**超管分发的开关**
 *    （`partner_permissions`：全局总闸 + 按人覆盖）。所以这两个位必须由调用方传 `perms` 进来，
 *    本函数同步、不自己查库 —— 查库是 async，塞进来会让所有调用点都要跟着改成 await，
 *    而调用点本来就在 async 函数里，在外面查一次更清楚。
 *    **perms 缺省时按「角色能就当作能」兜底**：这是升级前的行为，
 *    用在「不需要权限位」的返回体里（比如 slots 的能力位）不会因为少传一个参数就全变 false。
 */
function abilities(p, perms) {
  // 站员（role=2）只有「做自己的事」：填自己的可排时间、看自己的班/考勤/请假、互评、写稿。
  // ⚠️ 这里每一位都必须与 handler 的鉴权一一对应：
  //    为 true 的接口必须只要求 asPartner；为 false 的必须要求 asManager / asSuperPartner。
  const mgr = p.isSuper || p.isManager;
  const pm = perms || { schedule: mgr, review: mgr, proxy: mgr };
  // 超管恒放行（他自己就是总闸）；社干看开关；站员一律 false
  const schedOk = p.isSuper || (p.isManager && pm.schedule === true);
  const revOk = p.isSuper || (p.isManager && pm.review === true);
  // ⚠️ 代录（2026-10-31 二次定稿）：独立的第三个开关，不再跟排班权限绑在一起
  const proxyOk = p.isSuper || (p.isManager && pm.proxy === true);
  return {
    // 超管：时段配置、排班规则、账号管理
    canEditSlots: p.isSuper,
    canPublishSlots: p.isSuper,
    canEditRules: p.isSuper,
    canManageAccounts: p.isSuper,
    // 超管专属：权限分发
    canManagePermissions: p.isSuper,
    // 社干（含超管）：代录、生成/发布班表、审稿、批假、点名、看汇总
    //   ⇒ 代录 / 排班 / 审核吃各自那道开关，其余三项仍看角色
    canProxyAvailability: proxyOk,
    canManageSchedule: schedOk,
    canReview: revOk,
    canApproveLeave: mgr,
    canMarkAttendance: mgr,
    canViewOverview: mgr,
    // 人人都有：填自己的可排时间、报自己的假、写自己的稿、互评
    canFillOwn: true,
    isPartner: true,
    isMember: !!p.isMember,
  };
}

/** GET /partner/me */
async function profile(ctx) {
  const p = await asPartner(ctx);
  const a = p.admin;
  const perms = await permsFor(p);
  const phone = normalizePhone(a.phone, { strict: false });
  return {
    id: p.id,
    username: a.username || '',
    nickname: a.nickname || '',
    name: a.nickname || a.username || `账号${p.id}`,
    role: Number(a.role),
    roleKey: p.isSuper ? 'super' : (p.isMember ? 'member' : 'manager'),
    roleText: p.isSuper ? '超级管理员' : (p.isMember ? '站员' : '社干'),
    isSuper: p.isSuper,
    department: p.department,
    dutyRoles: p.dutyRoles,
    // 资格是否完整：没部门也没岗位的人，排班时无法通过硬条件过滤，等于「永远不会被排上」
    qualified: !!(p.department && p.dutyRoles.length),
    /*
     * 手机号（2026-10-31 伙伴名册）：
     *   phone     —— 规范化后的号码，没填就是 ''
     *   needPhone —— 前端拿它决定「进名册要不要弹强制填写」。
     *                ⚠️ 由后端算，不让前端自己 `!phone` 判：前端判空写错一次，
     *                弹窗就永远不弹（或者每次都弹），这是最容易被忽略的静默漂移。
     */
    phone,
    needPhone: !phone,
    createTime: a.createTime || null,
    lastLoginAt: a.lastLoginAt || null,
    abilities: abilities(p, perms),
  };
}

/**
 * PUT /partner/me/profile   body: { phone }
 *
 * 自己改自己的手机号（名册用）。
 *
 * ⚠️ 只允许改手机号：姓名/学号是学校名册来的，伙伴自己不能改 —— 这条边界要写死在 handler 里，
 *    不能只靠前端不给输入框（否则改个包就能提交 nickname）。
 * ⚠️ 站员也要能调：所以只 `asPartner`，不进 asManager / asSuperPartner。
 * ⚠️ 只落 `phone` + `phoneUpdatedAt`，**不碰 updateTime**：updateTime 是管理员账号的
 *    资料修订时间，被「填个手机号」刷掉会让后台的「最近更新」看着很怪。
 */
async function saveMyProfile(ctx) {
  const p = await asPartner(ctx);
  const body = ctx.body || {};
  if (body.phone === undefined) throw new ApiError(Codes.PARAM_ERROR, '请填写手机号');

  const phone = normalizePhone(body.phone, { strict: true });
  const now = new Date();
  await updateById(C.ADMIN, p.admin._id, { phone, phoneUpdatedAt: now });

  // 就地更新，后面 abilities() 之类读的是同一个对象
  p.admin.phone = phone;
  return { phone, needPhone: false, phoneUpdatedAt: now };
}


/**
 * PUT /partner/me/duty   body: { department, dutyRoles: [] }
 *
 * 自己维护自己的资格。
 * ⚠️ 为什么不给「超管改别人」的入口（本轮）：那属于「账号管理」页（P5 之后），
 *    现在只做自助，避免和 accounts 页的权限模型打架、后面还要改一次。
 */
async function saveDuty(ctx) {
  const p = await asPartner(ctx);
  const body = ctx.body || {};

  // 岗位（多选）是主维度；不传＝保持原值
  const dutyRoles = body.dutyRoles === undefined ? (p.dutyRoles || []) : normalizeRoles(body.dutyRoles);

  // 部门：显式传优先；否则由岗位推导（改岗位就自动跟着换部门，不用用户再选一次）
  let department;
  if (body.department !== undefined) {
    department = String(body.department || '').trim();
    if (department && DEPARTMENTS.indexOf(department) < 0) {
      throw new ApiError(Codes.PARAM_ERROR, `部门必须是：${DEPARTMENTS.join(' / ')}`);
    }
  } else {
    department = deptOfRoles(dutyRoles) || (p.department || '');
  }

  await updateById(C.ADMIN, p.admin._id, {
    department,
    dutyRoles,
    updateTime: new Date(),
  });

  // 就地更新 ctx.partner，让 abilities() 反映新状态（虽然这两个字段不影响能力位）
  p.department = department;
  p.dutyRoles = dutyRoles;

  return {
    department,
    dutyRoles,
    qualified: !!(department && dutyRoles.length),
    abilities: abilities(p, await permsFor(p)),
  };
}

/**
 * 岗位 ↔ 部门（2026-10-30 定稿：陛下要「配岗位，而且可以多选」）
 *
 * ⚠️ 只让人管**一个维度：岗位（多选）**，部门由岗位反推、自动落库。
 *    - 界面：弹层里三格岗位可多选（播音 / 主持 / 编辑）
 *    - 落库：`department` 取「播音→主持→编辑」里第一个命中的那个部门（主部门）
 *    - 判定：排班硬条件里**岗位对得上就放行部门检查**（schedule.js#reasonsFor），
 *      否则一个人同时兼播音+主持，部门只能存一个，他第二个岗位的时段会全被「部门不匹配」封死，
 *      多选就成了摆设。
 * ⚠️ 记者 / 技术 不挂部门，不在这两张表里 —— 更新时**原样保留**，不许被覆盖掉。
 * ⚠️ 历史坑（别再来一次）：上一版改成「只配部门」，界面上部门单选、岗位由部门推 ——
 *    陛下当天就退回来了。他要的是配岗位。**部门和岗位只能有一个能被用户看见，谁是主谁就被点。**
 * ⚠️ `deptOfRoles` 从 `_kit.js` 引，不在这里另写一份：读（personDto）和写（这里）必须同一张表。
 */
const ROLE_BY_DEPT = { 播音部: '播音', 主持部: '主持', 编辑部: '编辑' };
/** 三个「挂部门」的岗位（播音/主持/编辑）—— 用来把记者 / 技术这类额外岗位挑出来 */
const MAPPED_ROLES = Object.keys(ROLE_BY_DEPT).map((d) => ROLE_BY_DEPT[d]);

/** 岗位数组校验 + 去重 + 白名单（saveDuty / saveDutyFor 共用，别再各写一遍） */
function normalizeRoles(list) {
  if (!Array.isArray(list)) throw new ApiError(Codes.PARAM_ERROR, 'dutyRoles 必须是数组');
  let roles = list.map((r) => String(r).trim()).filter(Boolean);
  // 去重（前端多选组件可能重复传）
  roles = roles.filter((r, i) => roles.indexOf(r) === i);
  const bad = roles.filter((r) => DUTY_ROLES.indexOf(r) < 0);
  if (bad.length) {
    throw new ApiError(Codes.PARAM_ERROR, `岗位「${bad[0]}」不在可选范围内（${DUTY_ROLES.join(' / ')}）`);
  }
  return roles;
}

/**
 * PUT /partner/people/:id/duty   body: { dutyRoles?: [], department? }
 *
 * 超管**替别人**配值班岗位（2026-10-30；陛下定稿：配岗位、可多选）。
 *
 * ⚠️ 主维度是 `dutyRoles`（多选）。`department` 由岗位反推、自动落库（见 deptOfRoles），
 *    前端不再让用户额外选一次部门 —— 两个地方各选一遍必然对不上。
 * ⚠️ `department` 仍可显式传（兼容老调用 / 后台手工修数据）：显式传时以显式为准，
 *    且 `dutyRoles` 不传就按部门带一个岗位，记者/技术那种额外岗位原样保留。
 * ⚠️ 只选「记者 / 技术」时反推不出部门 → **保留原部门不清空**，别把历史数据砸掉。
 * ⚠️ 与 PUT /partner/me/duty 的分工：
 *    那条是**自助**（谁调都是改自己，锁死 p.admin._id）；
 *    这条必须显式给 :id，且只有超管能调 —— 别把两条合成一条，合并后
 *    「传了别人的 id」和「改自己」就分不清了。
 */
async function saveDutyFor(ctx) {
  const p = await asSuperPartner(ctx);
  const id = Number((ctx.params && ctx.params.id) || 0);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(Codes.PARAM_ERROR, '人员编号不合法');

  const target = await findOne(C.ADMIN, { id });
  if (!target) throw new ApiError(Codes.NOT_FOUND, '该成员不存在');

  const body = ctx.body || {};

  // 显式部门（可选）：传空串＝清空（清空后这个人排班时永远过不了部门门槛）
  let explicitDept;
  if (body.department !== undefined) {
    explicitDept = String(body.department || '').trim();
    if (explicitDept && DEPARTMENTS.indexOf(explicitDept) < 0) {
      throw new ApiError(Codes.PARAM_ERROR, `部门必须是：${DEPARTMENTS.join(' / ')}`);
    }
  }

  const currentRoles = Array.isArray(target.dutyRoles) ? target.dutyRoles : [];
  let dutyRoles;
  if (body.dutyRoles !== undefined) {
    // 正常路径：界面多选，直接以它为准
    dutyRoles = normalizeRoles(body.dutyRoles);
  } else if (explicitDept !== undefined) {
    // 老调用：只给部门 → 岗位跟着部门带，额外岗位（记者 / 技术）原样留着
    const mapped = ROLE_BY_DEPT[explicitDept] ? [ROLE_BY_DEPT[explicitDept]] : [];
    dutyRoles = mapped.concat(currentRoles.filter((r) => MAPPED_ROLES.indexOf(r) < 0));
  } else {
    dutyRoles = currentRoles.slice();
  }

  // 部门：显式传优先，否则由岗位反推（推不出来就保留原值，不做破坏性清空）
  const department = explicitDept !== undefined
    ? explicitDept
    : (deptOfRoles(dutyRoles) || (target.department || ''));

  await updateById(C.ADMIN, target._id, { department, dutyRoles, updateTime: new Date() });

  return {
    personId: id,
    name: target.nickname || target.username || `账号${id}`,
    department,
    dutyRoles,
    // 资格完整 ＝ 至少一个岗位；部门由岗位反推，所以有岗位就一定有部门
    qualified: !!(department && dutyRoles.length),
    by: p.id,
  };
}

/**
 * GET /partner/people —— 人员池（排班选人、代录选人都走这里）
 *
 * 2026-10-31 起顺带回一个 `me`：名册页要「自己那行置顶 + 判断要不要弹强制填写」，
 * 这两件事都得知道「我是名单里的哪一行」。挂在同一个接口里返回，
 * 比让前端再打一次 /partner/me 少一次往返（名册是打开就要用的页面）。
 * ⚠️ `me` 可能是 null：admin 行 status 被停用的人不会出现在 list 里 —— 这时前端按「没填过」处理。
 */
async function people(ctx) {
  const p = await asPartner(ctx);
  const list = await listPeople();
  const mine = list.filter((x) => x.personId === Number(p.id))[0] || null;
  return {
    list,
    total: list.length,
    me: mine ? {
      personId: mine.personId,
      name: mine.name,
      username: mine.username,
      phone: mine.phone,
      needPhone: !mine.phone,
      isSuper: mine.isSuper,
      isMember: mine.isMember,
    } : null,
  };
}

/** GET /partner/people/:id —— 单个成员（代录前确认对方资格） */
async function personDetail(ctx) {
  await asPartner(ctx);
  const id = (ctx.params && ctx.params.id) || '';
  return resolvePerson(id);
}

/** 内部复用：给 slots/availability 返回能力位 */
async function abilityOf(ctx) {
  const p = await asPartner(ctx);
  return abilities(p, await permsFor(p));
}

module.exports = { profile, saveDuty, saveMyProfile, saveDutyFor, people, personDetail, abilities, abilityOf };
