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

  const department = String(body.department === undefined ? p.department : body.department).trim();
  if (department && DEPARTMENTS.indexOf(department) < 0) {
    throw new ApiError(Codes.PARAM_ERROR, `部门必须是：${DEPARTMENTS.join(' / ')}`);
  }

  let dutyRoles = body.dutyRoles === undefined ? p.dutyRoles : body.dutyRoles;
  if (!Array.isArray(dutyRoles)) throw new ApiError(Codes.PARAM_ERROR, 'dutyRoles 必须是数组');
  dutyRoles = dutyRoles.map((r) => String(r).trim()).filter(Boolean);
  // 去重（前端多选组件可能重复传）
  dutyRoles = dutyRoles.filter((r, i) => dutyRoles.indexOf(r) === i);
  const bad = dutyRoles.filter((r) => DUTY_ROLES.indexOf(r) < 0);
  if (bad.length) {
    throw new ApiError(Codes.PARAM_ERROR, `岗位「${bad[0]}」不在可选范围内（${DUTY_ROLES.join(' / ')}）`);
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
 * PUT /partner/people/:id/duty   body: { dutyRoles: [] }
 *
 * 超管**替别人**配值班岗位（2026-10-30 新增：陛下要求「代录页超管可以为社干配置值班角色」）。
 *
 * ⚠️ 只动 dutyRoles，**不动 department**：
 *    部门是人事归属，改它会连带影响「部门不匹配」这条排班硬条件；
 *    这里要解决的只是「这个人能不能上播音 / 主持 / 编辑」。
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
  let dutyRoles = body.dutyRoles;
  if (!Array.isArray(dutyRoles)) throw new ApiError(Codes.PARAM_ERROR, 'dutyRoles 必须是数组');
  dutyRoles = dutyRoles.map((r) => String(r).trim()).filter(Boolean);
  dutyRoles = dutyRoles.filter((r, i) => dutyRoles.indexOf(r) === i);
  const bad = dutyRoles.filter((r) => DUTY_ROLES.indexOf(r) < 0);
  if (bad.length) {
    throw new ApiError(Codes.PARAM_ERROR, `岗位「${bad[0]}」不在可选范围内（${DUTY_ROLES.join(' / ')}）`);
  }

  await updateById(C.ADMIN, target._id, { dutyRoles, updateTime: new Date() });

  const department = target.department || '';
  return {
    personId: id,
    name: target.nickname || target.username || `账号${id}`,
    department,
    dutyRoles,
    // 资格完整 ＝ 有部门且至少一个岗位；没资格的人排班时永远过不了硬条件
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
