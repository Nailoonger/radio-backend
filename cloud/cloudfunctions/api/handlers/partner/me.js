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
  asPartner, asSuperPartner, listPeople, resolvePerson,
  DUTY_ROLES, DEPARTMENTS,
} = require('./_kit');

/**
 * 把「身份 + 资格」翻译成能力位
 *
 * ⚠️ 与 handler 里的实际鉴权**必须一一对应**：
 *    canEditSlots 为 true 的接口必须只要求 asPartner；
 *    为 false 的接口才要求 asSuperPartner。
 *    两边不一致就会出现「按钮点了报 40301」，这是最容易被当成 bug 报上来的形态。
 */
function abilities(p) {
  // 站员（role=2）只有「做自己的事」：填自己的可排时间、看自己的班/考勤/请假、互评、写稿。
  // ⚠️ 这里每一位都必须与 handler 的鉴权一一对应：
  //    为 true 的接口必须只要求 asPartner；为 false 的必须要求 asManager / asSuperPartner。
  const mgr = p.isSuper || p.isManager;
  return {
    // 超管：时段配置、排班规则、账号管理
    canEditSlots: p.isSuper,
    canPublishSlots: p.isSuper,
    canEditRules: p.isSuper,
    canManageAccounts: p.isSuper,
    // 社干（含超管）：代录、生成/发布班表、审稿、批假、点名、看汇总
    canProxyAvailability: mgr,
    canManageSchedule: mgr,
    canReview: mgr,
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
    createTime: a.createTime || null,
    lastLoginAt: a.lastLoginAt || null,
    abilities: abilities(p),
  };
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
    abilities: abilities(p),
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
 */
const DEPT_BY_ROLE = { 播音: '播音部', 主持: '主持部', 编辑: '编辑部' };
const MAPPED_ROLES = Object.keys(DEPT_BY_ROLE);
const ROLE_BY_DEPT = { 播音部: '播音', 主持部: '主持', 编辑部: '编辑' };

/** 多选岗位 → 主部门（按 播音→主持→编辑 的顺序取第一个命中的；一个都没命中返回空串） */
function deptOfRoles(roles) {
  const list = Array.isArray(roles) ? roles : [];
  for (let i = 0; i < MAPPED_ROLES.length; i++) {
    if (list.indexOf(MAPPED_ROLES[i]) >= 0) return DEPT_BY_ROLE[MAPPED_ROLES[i]];
  }
  return '';
}

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

/** GET /partner/people —— 人员池（排班选人、代录选人都走这里） */
async function people(ctx) {
  await asPartner(ctx);
  const list = await listPeople();
  return { list, total: list.length };
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
  return abilities(p);
}

module.exports = { profile, saveDuty, saveDutyFor, people, personDetail, abilities, abilityOf };
