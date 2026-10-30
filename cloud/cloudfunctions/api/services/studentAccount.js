'use strict';

/**
 * 学生账号「账号级」逻辑 —— 从 src/services/studentAccountService.js 移植
 *   · 初始密码规则与哈希
 *   · 账号状态缓存（禁用 / 改密 / 重置后旧 token 自动失效的地基）
 *   · JWT 新鲜度校验
 *   · 微信登录守卫开关
 *
 * ⚠️ 缓存差异（有意为之）：原实现靠常驻进程的 30 秒内存缓存；云函数实例会被回收、
 *    也会多实例并发，因此本缓存**只保证同一热实例内**有效。
 *    最坏情况：跨实例看到新状态迟 30 秒 —— 与原实现「最多迟 30 秒」的承诺一致，不会更差。
 *
 * ⚠️ 初始密码规则（2026-09-18 改版）：`user` + 学号，如 user20240101。
 *    每人不同 → 不能「整批共用一个哈希」，导入时逐行哈希。
 */

const bcrypt = require('bcryptjs');
const { C, findOne } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');
const switchService = require('./switch');

const INIT_PASSWORD_PREFIX = 'user';
const CACHE_TTL = 30 * 1000; // 30s

/** username -> { expiresAt, status, pwdVersion, id, missing? } */
const cache = new Map();

/** 初始密码唯一出口（改规则只改这里） */
function initPasswordFor(username) {
  return INIT_PASSWORD_PREFIX + String(username || '').trim();
}

/** 初始密码哈希：cost 8（导入几百行时省时间；登录 compare 会自动适配哈希里记录的 cost） */
async function hashInitPasswordFor(username) {
  return bcrypt.hash(initPasswordFor(username), 8);
}

/** 用户自设密码哈希：cost 10 */
async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

/** 把 pwdChangedAt 折成可比较的版本号（null = 0 = 仍是初始密码） */
function pwdVersionOf(pwdChangedAt) {
  return pwdChangedAt ? new Date(pwdChangedAt).getTime() : 0;
}

/**
 * 读账号状态（带 30 秒实例内缓存）
 * @returns {Promise<null|{id:number|null, username:string, status:number, pwdVersion:number, missing?:boolean}>}
 */
async function getStatus(username, force = false) {
  if (!username) return null;
  const now = Date.now();
  const hit = cache.get(username);
  if (!force && hit && hit.expiresAt > now) return hit;

  const user = await findOne(C.USER, { username });

  const row = user
    ? {
        id: user.id,
        username: user.username,
        status: Number(user.status),
        pwdVersion: pwdVersionOf(user.pwdChangedAt),
        expiresAt: now + CACHE_TTL,
      }
    : { id: null, username, status: 0, pwdVersion: 0, missing: true, expiresAt: now + CACHE_TTL };

  cache.set(username, row);
  return row;
}

/** 主动失效（改密 / 重置 / 启停 / 删除账号后调用） */
async function invalidate(username) {
  if (username) cache.delete(username);
  else cache.clear();
  await getStatus(username, true);
}

/**
 * 校验 token 是否还「新鲜」—— 由 lib/auth.js 的 requireUser 调用
 *   · 账号被禁用 / 删除 → 40101
 *   · 密码已变更（改密或被管理员重置）→ 40101
 * 老微信用户（token 里没有 username）直接放行，逻辑与改造前完全一致。
 */
async function assertTokenFresh(payload) {
  const username = payload && payload.username;
  if (!username) return true; // 老微信用户：不参与账号体系

  const st = await getStatus(username);
  if (!st || st.missing) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号不存在，请重新登录');
  }
  if (st.status !== 1) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号已停用，请联系广播站');
  }
  const tokenPv = Number(payload.pv || 0);
  if (tokenPv !== st.pwdVersion) {
    throw new ApiError(Codes.UNAUTHORIZED, '密码已变更，请重新登录');
  }
  return true;
}

/**
 * 严格版 token 新鲜度校验：**不走缓存**，直接查库。
 *
 * 用途：云函数入口（index.js）的统一鉴权前置 —— 改密后任何角色、任何端**立刻**失效。
 *
 * ⚠️ 为什么不能复用 assertTokenFresh：getStatus 带 30 秒实例内缓存（CACHE_TTL），
 *    改密后最多 30 秒旧 token 还能用。要「立刻」就只能直查。
 * ⚠️ 靠 invalidate() 清缓存也不行：多实例部署时它只清本实例那份，别的实例照样是旧的。
 * ⚠️ 代价：每个请求多一次库查询（约 20–50ms）。全站是几十人的校园广播站，这个量级不用担心。
 *
 * ⚠️⚠️ 存量 admin token 的例外（否则会死锁）：
 *    老师那条 user 记录是**登录时才惰性补建**的（见 services/accountPassword）。
 *    如果这里碰到「user 表还没有这条」就直接 401，老师会在「还没登录过」的时候就被拦住，
 *    而他必须先登录才能建出这条 —— 死锁。
 *    所以：admin token（有 id、无 openid）查不到 user 记录时放行，交给 handler 照原样处理。
 *    一旦登录过，user 记录就存在了，之后改密就能立刻失效。
 */
async function assertTokenFreshStrict(payload) {
  const username = payload && payload.username;
  if (!username) return true; // 老微信用户：不参与账号体系

  const st = await getStatus(username, true);
  if (!st || st.missing) {
    const isAdminToken = Boolean(payload.id) && !payload.openid;
    if (isAdminToken) return true;   // 见上方「存量 admin token 的例外」
    throw new ApiError(Codes.UNAUTHORIZED, '账号不存在，请重新登录');
  }
  if (st.status !== 1) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号已停用，请联系广播站');
  }
  // 老 token 没有 pv 字段时按 0 算（改造前签发的 admin token）。
  // 这与「从没改过密码」的账号（pwdChangedAt=null → pv=0）相等，所以这些人不会被踢；
  // 只有真正改过密码的人（pv 非 0）才对不上 —— 正是要的效果。
  const tokenPv = Number(payload.pv || 0);
  if (tokenPv !== st.pwdVersion) {
    throw new ApiError(Codes.UNAUTHORIZED, '密码已变更，请重新登录');
  }
  return true;
}

/**
 * 微信登录守卫：开关打开时禁止微信登录，强制走账号密码。
 *
 * ⚠️ 与 source 的差异：原实现是同步读内存缓存（靠启动预热）；
 *    云函数没有启动钩子，同步读会恒为「未预热 → 视为 on」，
 *    导致管理员把开关**关掉**也不生效（会误拦）。故改为异步、以库为准。
 *
 * ⚠️ 测试环境（NODE_ENV=test）一律放行：与源实现一致。
 */
async function isWechatLoginBlocked(env = process.env.NODE_ENV) {
  if (env === 'test') return false;
  const row = await switchService.publicGet('account_login_required');
  return row.value !== 'off';
}

module.exports = {
  INIT_PASSWORD_PREFIX,
  CACHE_TTL,
  initPasswordFor,
  hashInitPasswordFor,
  hashPassword,
  pwdVersionOf,
  getStatus,
  invalidate,
  assertTokenFresh,
  assertTokenFreshStrict,
  isWechatLoginBlocked,
  // 仅测试 / 验证脚本使用
  _clearCache: () => cache.clear(),
};
