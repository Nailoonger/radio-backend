'use strict';

/**
 * 鉴权 —— 与 src/middlewares/auth.js + utils/jwt.js 语义等价
 *
 * 关键决策（见 cloud/README.md 第四节）：**沿用原 JWT，不用云开发原生登录态**。
 * 原因：本项目「账号体系复用 user 表，JWT.openid 字段填学号」是业务基石，
 *       换成云开发身份会导致 submit / message / notice_ack 的归属逻辑全部重写。
 *
 * payload 字段与原后端完全一致：
 *   学生： { openid: <学号>, uid, username, pv }
 *   管理员：{ id, username, role }            role: 0 超管 / 1 普管
 *
 * ⚠️ JWT_SECRET 必须与原服务器**同一个值**，否则已登录用户的旧 token 全部失效。
 *    在云函数配置里设环境变量：JWT_SECRET / JWT_EXPIRES_IN（默认 7d）。
 */

const jwt = require('jsonwebtoken');
const { ApiError, Codes } = require('./response');

const SECRET = process.env.JWT_SECRET || 'radio-station-default-secret';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verify(token) {
  return jwt.verify(token, SECRET);
}

/** 从 ctx 里取出并通过校验的 payload；失败抛 40101 */
function decodeToken(ctx) {
  if (!ctx || !ctx.token) throw new ApiError(Codes.UNAUTHORIZED, '请先登录');
  try {
    return verify(String(ctx.token).replace(/^Bearer\s+/i, ''));
  } catch (e) {
    throw new ApiError(Codes.UNAUTHORIZED, '登录已过期，请重新登录');
  }
}

/**
 * 学生态：等价于原 userAuth
 * 注入 ctx.user = { openid, uid, username }
 *
 * ⚠️ 额外做 `assertTokenFresh(payload)`（与原中间件一致）：
 *    账号被禁用 / 删除 / 密码已变更 → 40101，旧 token 立刻作废（最多迟 30 秒，靠实例内状态缓存）。
 *    老微信用户（payload 无 username）不参与，直接放行。
 *
 * ⚠️ 因含数据库校验，**本函数是异步的，调用方必须 await**。
 * ⚠️ 对 services 层用**惰性 require**：lib 层不应在顶层依赖 services 层，
 *    否则 services 里任一模块加载失败会把整个 handler 拖挂（回落到笼统的 50001）。
 */
async function requireUser(ctx) {
  const payload = decodeToken(ctx);
  if (!payload.openid) throw new ApiError(Codes.UNAUTHORIZED, '请先登录');
  ctx.user = { openid: payload.openid, uid: payload.uid, username: payload.username, pv: payload.pv };
  ctx.payload = payload;
  await require('../services/studentAccount').assertTokenFresh(payload);
  return ctx.user;
}

/**
 * 管理态：等价于原 adminAuth
 *
 * ⚠️ 角色**以库为准**（2026-11-02 修「切角色不同步」）：
 *    token 里的 `role` 只是签发那一刻的快照，超管在「账号管理」改完角色，
 *    旧 token 里还是老值 —— 降权的人照样能调 asSuper，升权的人永远进不去。
 *    入口（index.js）已经查好一份最新的行放进 `ctx.adminLive`，这里优先用它；
 *    没有（直接调 handler 的测试 / 存量 token）就退回 payload 里的旧口径，行为不变。
 */
function requireAdmin(ctx) {
  const payload = decodeToken(ctx);
  if (!payload.id || !payload.username) throw new ApiError(Codes.UNAUTHORIZED, '请先登录');
  const live = ctx && ctx.adminLive;
  const fresh = live && Number(live.id) === Number(payload.id)
    ? Object.assign({}, payload, { role: live.role, status: live.status })
    : payload;
  ctx.admin = fresh;
  ctx.payload = payload;
  return fresh;
}

/** 仅超管：等价于原 requireSuperAdmin（role!==0 → 40301） */
function requireSuperAdmin(ctx) {
  const admin = ctx.admin || requireAdmin(ctx);
  if (Number(admin.role) !== 0) throw new ApiError(Codes.FORBIDDEN, '仅超级管理员可操作');
  return admin;
}

module.exports = { sign, verify, decodeToken, requireUser, requireAdmin, requireSuperAdmin, SECRET, EXPIRES_IN };
