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
 * ⚠️ 原中间件还会调用 accountService.assertTokenFresh(payload) —— 依赖 DB 读 user.status + pwd_changed_at，
 *    阶段 3（数据层就位）时在此补上；届时保持「pv 不符 → 40101 密码已变更」的文案不变。
 */
function requireUser(ctx) {
  const payload = decodeToken(ctx);
  if (!payload.openid) throw new ApiError(Codes.UNAUTHORIZED, '请先登录');
  ctx.user = { openid: payload.openid, uid: payload.uid, username: payload.username, pv: payload.pv };
  ctx.payload = payload;
  return ctx.user;
}

/** 管理态：等价于原 adminAuth */
function requireAdmin(ctx) {
  const payload = decodeToken(ctx);
  if (!payload.id || !payload.username) throw new ApiError(Codes.UNAUTHORIZED, '请先登录');
  ctx.admin = payload;
  ctx.payload = payload;
  return ctx.admin;
}

/** 仅超管：等价于原 requireSuperAdmin（role!==0 → 40301） */
function requireSuperAdmin(ctx) {
  const admin = ctx.admin || requireAdmin(ctx);
  if (Number(admin.role) !== 0) throw new ApiError(Codes.FORBIDDEN, '仅超级管理员可操作');
  return admin;
}

module.exports = { sign, verify, decodeToken, requireUser, requireAdmin, requireSuperAdmin, SECRET, EXPIRES_IN };
