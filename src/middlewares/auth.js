'use strict';

const { verify } = require('../utils/jwt');
const { fail, Codes } = require('../utils/response');
const accountService = require('../services/studentAccountService');

/**
 * 解析 Authorization: Bearer <token>
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * 小程序用户鉴权中间件
 * 通过 Authorization 头传递 token，token 中包含 { openid }
 *
 * 学生账号的 token 额外带 { uid, username, pv }：
 *   · username 存在 = 走账号体系，需要校验账号是否被停用 / 密码是否已变更
 *     （改密或被管理员重置后旧 token 立刻作废，最多迟 30 秒，靠 30s 状态缓存）
 *   · 老微信用户的 token 只有 openid，不做额外校验，行为与改造前完全一致
 */
async function userAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return fail(res, Codes.UNAUTHORIZED, '请先登录', 401);
    }

    let payload;
    try {
      payload = verify(token);
    } catch (e) {
      return fail(res, Codes.UNAUTHORIZED, 'token已过期或无效', 401);
    }
    if (!payload.openid) {
      return fail(res, Codes.UNAUTHORIZED, 'token无效', 401);
    }

    // openid 在账号体系下就是「账号本身」，存量按 openid 归属的逻辑不用改
    req.user = {
      openid: payload.openid,
      uid: payload.uid || null,
      username: payload.username || null,
    };

    try {
      await accountService.assertTokenFresh(payload);
    } catch (e) {
      return fail(res, e.code || Codes.UNAUTHORIZED, e.message || '登录状态已失效', e.httpStatus || 401);
    }

    return next();
  } catch (e) {
    return next(e);
  }
}

/**
 * 管理员鉴权中间件
 * token 中包含 { id, username, role }
 */
/**
 * 管理端鉴权中间件（2026-10-31：改为异步，加密码版本校验）
 *
 * ⚠️ 为什么要异步：改密后要「所有端立刻失效」，必须查一次库比对 pv。
 *    Express 的 async 中间件不会自动把异常交给 next，所以这里全程 try/catch 自己兜。
 * ⚠️ 与云端 `index.js` 入口的统一前置校验同一条口径（两处逻辑必须一致，
 *    否则 direct / cloud 两种模式下「改密即失效」的行为会不一样）。
 */
async function adminAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return fail(res, Codes.UNAUTHORIZED, '请先登录管理后台', 401);
  }

  let payload;
  try {
    payload = verify(token);
  } catch (e) {
    return fail(res, Codes.UNAUTHORIZED, 'token已过期或无效', 401);
  }
  if (!payload.id || !payload.username) {
    return fail(res, Codes.UNAUTHORIZED, 'token无效', 401);
  }

  try {
    // 不走缓存：30 秒窗口在「改密即失效」面前是不允许的
    await accountService.assertTokenFreshStrict(payload);
  } catch (e) {
    return fail(res, Codes.UNAUTHORIZED, (e && e.message) || '登录已失效，请重新登录', 401);
  }

  req.admin = payload;
  return next();
}

module.exports = { userAuth, adminAuth, extractToken };
