'use strict';

const { fail, Codes, ApiError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * 404 处理
 */
function notFound(req, res) {
  return fail(res, Codes.NOT_FOUND, `路由不存在: ${req.method} ${req.originalUrl}`, 404);
}

/**
 * 全局错误处理
 * 注意 4 参数签名是 Express 识别错误处理器的依据
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // 业务错误
  if (err instanceof ApiError) {
    return fail(res, err.code, err.message, err.httpStatus);
  }

  // Sequelize 校验错误
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return fail(res, Codes.PARAM_ERROR, err.message, 400);
  }

  // body-parser JSON 解析错误
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return fail(res, Codes.PARAM_ERROR, '请求体JSON格式错误', 400);
  }

  // 请求体过大
  if (err.type === 'entity.too.large') {
    return fail(res, Codes.PARAM_ERROR, '请求体过大', 413);
  }

  logger.error(`[${req.requestId || '-'}] Unhandled error:`, err);
  return fail(res, Codes.SERVER_ERROR, '服务器内部错误', 500);
}

module.exports = { notFound, errorHandler };