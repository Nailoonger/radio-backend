'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');
const { fail, Codes } = require('../utils/response');

/**
 * 投稿限流（防刷）
 */
const submitLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.submitMax,
  keyGenerator: (req) => req.user?.openid || req.ip,
  handler: (req, res) =>
    fail(res, Codes.CONFLICT, '操作太频繁，请稍后再试', 429),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 留言限流
 */
const messageLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.messageMax,
  keyGenerator: (req) => req.user?.openid || req.ip,
  handler: (req, res) =>
    fail(res, Codes.CONFLICT, '留言太频繁，请稍后再试', 429),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 管理员登录限流
 */
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.loginMax,
  keyGenerator: (req) => req.ip,
  handler: (req, res) =>
    fail(res, Codes.CONFLICT, '登录尝试过多，请稍后再试', 429),
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  submitLimiter,
  messageLimiter,
  loginLimiter,
};