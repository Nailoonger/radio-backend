'use strict';

const { fail, Codes } = require('../utils/response');

/**
 * 仅超级管理员可访问（role === 0）
 * 用法: requireSuperAdmin
 */
function requireSuperAdmin(req, res, next) {
  if (!req.admin) {
    return fail(res, Codes.UNAUTHORIZED, '请先登录', 401);
  }
  if (req.admin.role !== 0) {
    return fail(res, Codes.FORBIDDEN, '仅超级管理员可操作', 403);
  }
  return next();
}

/**
 * 任何已登录管理员都可访问
 */
function requireAdmin(req, res, next) {
  if (!req.admin) {
    return fail(res, Codes.UNAUTHORIZED, '请先登录', 401);
  }
  return next();
}

module.exports = {
  requireSuperAdmin,
  requireAdmin,
};