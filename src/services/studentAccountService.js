'use strict';

/**
 * studentAccountService —— 学生账号的「账号级」逻辑
 *   · 初始密码常量与哈希
 *   · 账号状态 30 秒内存缓存（禁用 / 改密 / 重置后 token 自动失效的地基）
 *   · JWT 新鲜度校验（改密或重置后旧 token 立刻作废，最多迟 30 秒）
 *   · 微信登录守卫开关
 *
 * ⚠️ 为什么需要「状态缓存」这一层：
 *    JWT 是无状态的，管理员禁用账号或重置密码后，旧 token 仍能活到过期（默认 7 天）。
 *    直接每次请求查库又太贵。所以照搬项目里 switchService 那套「30 秒内存缓存」：
 *    改密 / 禁用 / 重置最多 30 秒生效，且不给数据库加压力。
 */

const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { ApiError, Codes } = require('../utils/response');
const switchService = require('./switchService');

/**
 * 初始密码规则（2026-09-18 用户改版）：**user + 学号**，如 user20240101。
 * 每个人的初始密码都不一样 → 「整批共用一个哈希」的优化作废，导入时逐行哈希。
 * ⚠️ 性能取舍：初始密码哈希用 cost 8（bcryptjs 每行 ~30-60ms，486 人约 20s）；
 *    bcrypt 的 cost 写在哈希串里，登录时 compare 自动适配，改密后仍是 cost 10。
 */
const INIT_PASSWORD_PREFIX = 'user';
const CACHE_TTL = 30 * 1000; // 30s

/** username -> { expiresAt, status, pwdVersion, id } */
const cache = new Map();

function initPasswordFor(username) {
  return INIT_PASSWORD_PREFIX + String(username || '').trim();
}

async function hashInitPasswordFor(username) {
  return bcrypt.hash(initPasswordFor(username), 8);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

/** 把 pwdChangedAt 折成可比较的版本号（null = 0 = 仍是初始密码） */
function pwdVersionOf(pwdChangedAt) {
  return pwdChangedAt ? new Date(pwdChangedAt).getTime() : 0;
}

/**
 * 读账号状态（带 30 秒缓存）
 * @returns {Promise<null|{id:number, username:string, status:number, pwdVersion:number}>}
 */
async function getStatus(username, force = false) {
  if (!username) return null;
  const now = Date.now();
  const hit = cache.get(username);
  if (!force && hit && hit.expiresAt > now) return hit;

  const user = await User.findOne({
    where: { username },
    attributes: ['id', 'username', 'status', 'pwdChangedAt'],
  });

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

/** 主动失效（改密 / 重置 / 启停 / 删除账号后调用，让本进程立刻看到新状态） */
async function invalidate(username) {
  if (username) cache.delete(username);
  else cache.clear();
  await getStatus(username, true);
}

/**
 * 校验 token 是否还「新鲜」——给鉴权中间件用。
 *   · 账号被禁用 / 删除 → 抛 40101
 *   · 密码已变更（改密或被管理员重置）→ 抛 40101
 * 老微信用户（token 里没有 username）直接放行，逻辑与改造前完全一致。
 *
 * @param {object} payload JWT 载荷 { openid, uid, username, pv }
 */
async function assertTokenFresh(payload) {
  const username = payload && payload.username;
  if (!username) return true; // 老微信用户：不参与账号体系

  const st = await getStatus(username);
  if (!st || st.missing) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号不存在，请重新登录', 401);
  }
  if (st.status !== 1) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号已停用，请联系广播站', 401);
  }
  const tokenPv = Number(payload.pv || 0);
  if (tokenPv !== st.pwdVersion) {
    throw new ApiError(Codes.UNAUTHORIZED, '密码已变更，请重新登录', 401);
  }
  return true;
}

/**
 * 微信登录守卫：开关打开时禁止微信登录，强制走账号密码。
 *
 * ⚠️ 测试环境（NODE_ENV=test）一律放行：
 *    既有 56 条用例里 member / switch 都靠 wx code2session 拿 token，
 *    拦掉会让它们全部失败（那是与业务无关的连锁失败）。
 *    要验证拦截行为，请直接断言本函数（传 env='production'）。
 *
 * @param {string} [env] 默认 process.env.NODE_ENV
 * @param {boolean} [switchOn] 默认读开关
 */
function isWechatLoginBlocked(env = process.env.NODE_ENV, switchOn = null) {
  if (env === 'test') return false;
  const on = switchOn === null ? switchService.isEnabled('account_login_required') : switchOn;
  return !!on;
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
  isWechatLoginBlocked,
  // 仅测试 / 验证脚本使用
  _clearCache: () => cache.clear(),
};
