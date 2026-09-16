'use strict';

/**
 * 统一 API 响应格式
 *  { code: 0, message: 'ok', data: {} }
 *  code: 0=成功，非0=业务错误
 */

const SUCCESS_CODE = 0;

class ApiError extends Error {
  constructor(code, message, httpStatus = 200) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function success(res, data = null, message = 'ok') {
  return res.json({ code: SUCCESS_CODE, message, data });
}

function fail(res, code, message, httpStatus = 200) {
  return res.status(httpStatus).json({ code, message, data: null });
}

module.exports = {
  ApiError,
  success,
  fail,
  // 常用错误码
  Codes: {
    SUCCESS: 0,
    PARAM_ERROR: 40001,
    UNAUTHORIZED: 40101,
    FORBIDDEN: 40301,
    MODULE_DISABLED: 40302,
    NOT_FOUND: 40401,
    CONFLICT: 40901,
    SERVER_ERROR: 50001,
    WECHAT_API_ERROR: 60001,
    CONTENT_BLOCKED: 60002,
  },
};