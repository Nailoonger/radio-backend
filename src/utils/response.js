'use strict';

/**
 * 统一 API 响应格式
 *  { code: 0, message: 'ok', data: {} }
 *  code: 0=成功，非0=业务错误
 */

const SUCCESS_CODE = 0;

class ApiError extends Error {
  /**
   * @param {number} code   业务码
   * @param {string} message 给用户看的文案
   * @param {number} httpStatus HTTP 状态码（默认 200，业务错误一律 200）
   * @param {object} data   可选附加数据（如 40907 的 opensAt / windowText，前端要拿来做倒计时）
   */
  constructor(code, message, httpStatus = 200, data = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.data = data;
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
    NOTICE_UNACKED: 40303,   // 点歌注意事项未确认（前端据此弹出注意事项）
    NOT_FOUND: 40401,
    CONFLICT: 40901,
    // ⛔ 已退役（v2 起没有日/周名额概念）：保留常量只为兼容历史调用，新代码不要用
    QUOTA_EXHAUSTED: 40902,
    SUBMIT_REJECTED: 40903,   // 被提交规则拦下（同曲重复 / 本周次数用完）
    // 🆕 v2：正式位与候补队列都满了
    SLOT_AND_QUEUE_FULL: 40904,
    // 40905 有意留空不用，避免与外部既有对接混淆
    SLOT_FULL: 40906,         // 播出时段已排满（单格）
    // 🆕 v2：不在点歌时间段（窗口外提交），data 带 opensAt / windowText
    SONG_WINDOW_CLOSED: 40907,
    SERVER_ERROR: 50001,
    WECHAT_API_ERROR: 60001,
    CONTENT_BLOCKED: 60002,
  },
};