'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * 简易请求 ID 中间件：
 *  1. 优先使用上游传入的 X-Request-Id
 *  2. 否则生成一个 16 字节十六进制字符串
 *  3. 挂在 req.requestId 并回写响应头
 *  4. 监听 res.on('finish') 输出访问日志（耗时 + 状态）
 *
 * 注：与 morgan 互补 —— morgan 输出访问行，本中间件输出结构化字段。
 */
module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = (typeof incoming === 'string' && incoming.length <= 64 && /^[\w\-:.]+$/.test(incoming))
    ? incoming
    : crypto.randomBytes(8).toString('hex');

  req.requestId = id;
  res.setHeader('X-Request-Id', id);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const costMs = Number(process.hrtime.bigint() - start) / 1e6;
    const user = req.user?.openid || req.admin?.username || '-';
    logger.info(
      `[${id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${costMs.toFixed(1)}ms user=${user}`
    );
  });

  next();
};
