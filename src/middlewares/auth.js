'use strict';

const { verify } = require('../utils/jwt');
const { fail, Codes } = require('../utils/response');

/**
 * 解析 Authorization: Bearer <token>
 * 解析 openid（小程序用户）从 X-Openid 或 token
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * 小程序用户鉴权中间件
 * 通过 Authorization 头传递 token，token 中包含 { openid }
 */
function userAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return fail(res, Codes.UNAUTHORIZED, '请先登录', 401);
  }
  try {
    const payload = verify(token);
    if (!payload.openid) {
      return fail(res, Codes.UNAUTHORIZED, 'token无效', 401);
    }
    req.user = { openid: payload.openid };
    return next();
  } catch (e) {
    return fail(res, Codes.UNAUTHORIZED, 'token已过期或无效', 401);
  }
}

/**
 * 管理员鉴权中间件
 * token 中包含 { id, username, role }
 */
function adminAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return fail(res, Codes.UNAUTHORIZED, '请先登录管理后台', 401);
  }
  try {
    const payload = verify(token);
    if (!payload.id || !payload.username) {
      return fail(res, Codes.UNAUTHORIZED, 'token无效', 401);
    }
    req.admin = payload;
    return next();
  } catch (e) {
    return fail(res, Codes.UNAUTHORIZED, 'token已过期或无效', 401);
  }
}

module.exports = { userAuth, adminAuth };