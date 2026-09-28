'use strict';

/**
 * 管理端 · 登录 / 当前管理员 / 改密 / 退出
 * 迁移自 src/controllers/admin/authController.js —— 返回体逐字段一致
 *
 * ⚠️ 鉴权在**路由层**（原 routes/admin.js）：`/profile`、`/change-password`、
 *    `/logout` 挂着 `adminAuth`，`/login` 是唯一免登录入口。
 *    云函数没有中间件层，所以由 handler 第一行调 `asAdmin(ctx)` 补齐。
 *
 * ⚠️ 与原实现的一处**有意偏离**：原 `/admin/login` 挂了 `loginLimiter`
 *    （按 IP 的 15 分钟窗口限流，超限返回 429）。云函数侧没有搬 —— 见
 *    `cloud/docs/stage7-admin-plan.md` §「未搬的东西」。失败仍然返回同一句
 *    「账号或密码错误」，不会泄露账号是否存在。
 */

const bcrypt = require('bcryptjs');
const { C, findOne, updateById } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { sign } = require('../../lib/auth');
const { asAdmin, pick } = require('./_kit');

/** 管理员的对外形状（**绝不包含 password**） */
function adminDto(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    role: row.role,
  };
}

/** POST /admin/login   body: { username, password } */
async function login(ctx) {
  const { username, password } = ctx.body || {};
  if (!username || !password) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
  }

  const admin = await findOne(C.ADMIN, { username });
  if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
  if (Number(admin.status) !== 1) throw new ApiError(Codes.FORBIDDEN, '账号已禁用');

  const ok = await bcrypt.compare(String(password), admin.password);
  if (!ok) throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');

  // 原实现 `await admin.save()` 会就地刷实例，返回的 admin 是「更新后」的值 —— 这里对齐
  const now = new Date();
  await updateById(C.ADMIN, admin._id, { lastLoginAt: now, updateTime: now });

  const token = sign({ id: admin.id, username: admin.username, role: admin.role });
  return { token, admin: adminDto(admin) };
}

/**
 * GET /admin/profile
 *
 * ⚠️ 原实现用 `attributes: ['id','username','nickname','role','lastLoginAt','createTime']`
 *    投影 —— 云数据库没有该能力，这里手工挑（`pick` 同时把 password 摘掉）。
 */
async function profile(ctx) {
  const me = asAdmin(ctx);
  const admin = await findOne(C.ADMIN, { id: Number(me.id) });
  if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号不存在');
  return pick(admin, ['id', 'username', 'nickname', 'role', 'lastLoginAt', 'createTime']);
}

/** PUT /admin/change-password   body: { oldPassword, newPassword } */
async function changePassword(ctx) {
  const me = asAdmin(ctx);
  const { oldPassword, newPassword } = ctx.body || {};
  if (!oldPassword || !newPassword) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入原密码和新密码');
  }
  if (String(newPassword).length < 6) {
    throw new ApiError(Codes.PARAM_ERROR, '新密码长度不能少于6位');
  }

  const admin = await findOne(C.ADMIN, { id: Number(me.id) });
  if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号不存在');
  const ok = await bcrypt.compare(String(oldPassword), admin.password);
  if (!ok) throw new ApiError(Codes.PARAM_ERROR, '原密码错误');

  const now = new Date();
  const password = await bcrypt.hash(String(newPassword), 10);
  await updateById(C.ADMIN, admin._id, { password, updateTime: now });
  return null;
}

/**
 * POST /admin/logout
 * 原实现只返回一句成功文案（前端自行清 token），这里保持一致。
 */
async function logout(ctx) {
  asAdmin(ctx);
  return null;
}

module.exports = { login, profile, changePassword, logout };
