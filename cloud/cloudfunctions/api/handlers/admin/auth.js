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
const account = require('../../services/accountPassword');
const { pwdVersionOf } = require('../../services/studentAccount');

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

  const admin = await findOne(C.ADMIN, { username: String(username).trim() });
  if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
  if (Number(admin.status) !== 1) throw new ApiError(Codes.FORBIDDEN, '账号已禁用');

  /**
   * ── 密码唯一事实源 = user.password（2026-10-31 账号密码统一）──
   *
   * 改造前这里比对的是 `admin.password`，和学生的 `user.password` 各存一份，
   * 学生一改密两边就分叉。现在统一成一份：站员用学号、老师用工号，
   * 密码都落在 user 表，学生端改一次，伙伴端和后台立刻同密码。
   *
   * ⚠️ 顺序很重要：**先校验，后补建**。
   *    存量老师还没有 user 记录，如果先补建再校验，随便一个错密码都会往 user 表写数据。
   */
  let user = await account.findUserOfAdmin(admin);
  let ok = false;
  if (user) {
    ok = await account.passwordMatches(user, password);
    if (ok) await account.bindAdminUser(admin, user);   // 顺手把 userId 回填
  } else {
    // 存量 admin（老师 / 社干）还没有 user 记录：先用旧字段校验
    ok = Boolean(admin.password) && await bcrypt.compare(String(password), admin.password);
    // 通过了才补建 —— 哈希原样搬过去，本人不需要重设密码
    if (ok) user = await account.ensureTeacherProfile(admin);
  }
  if (!ok || !user) throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');

  // 原实现 `await admin.save()` 会就地刷实例，返回的 admin 是「更新后」的值 —— 这里对齐
  const now = new Date();
  await updateById(C.ADMIN, admin._id, { lastLoginAt: now, updateTime: now });

  /**
   * token 结构一个字没变（id / username / role），只多带一个 pv。
   * ⚠️ pv = 密码版本（pwdChangedAt 的时间戳，没改过就是 0）。
   *    云函数入口会拿它和库里的值比对 —— 改密后 pv 变了，学生端 / 伙伴端 / 后台的
   *    旧 token 会在下一次请求同时 40101，不需要任何通知机制。
   */
  const token = sign({
    id: admin.id,
    username: admin.username,
    role: admin.role,
    pv: pwdVersionOf(user.pwdChangedAt),
  });
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

  /**
   * 改密写的是 **user.password**（密码唯一事实源），不是 admin.password。
   * ⚠️ 改完 pwdChangedAt 一变，三端 token 里的 pv 就全部对不上 ——
   *    所以这里必须把新 token 一起吐回去，否则改密的人自己下一个请求就 40101。
   *    （学生端 `/user/change-password` 早就是这么做的，管理端这次补齐。）
   */
  const user = await account.findUserOfAdmin(admin);
  if (!user) throw new ApiError(Codes.NOT_FOUND, '账号资料缺失，请联系超级管理员');

  const ok = await account.passwordMatches(user, oldPassword);
  if (!ok) throw new ApiError(Codes.PARAM_ERROR, '原密码错误');

  const now = new Date();
  const hashed = await bcrypt.hash(String(newPassword), account.BCRYPT_COST);
  await updateById(C.USER, user._id, { password: hashed, pwdChangedAt: now, updateTime: now });

  // 清掉本实例的状态缓存（多实例场景靠入口直查兜底，不依赖这一步）
  try { await require('../../services/studentAccount').invalidate(user.username); } catch (e) { /* 清缓存失败不影响改密结果 */ }

  return {
    token: sign({
      id: admin.id,
      username: admin.username,
      role: admin.role,
      pv: pwdVersionOf(now),
    }),
  };
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
