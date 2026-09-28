'use strict';

/**
 * 统一响应与错误码 —— 从 src/utils/response.js 原样移植
 *
 * 差异：Express 版有 res.json / res.status，云函数没有 HTTP 响应对象，
 *       因此只保留 ApiError 与 Codes；成功路径由 index.js 统一包装成 { code: 0, ... }。
 *
 * ⚠️ 错误码数值与原后端**必须完全一致**，前端按码分支的逻辑（40303 弹注意事项、
 *    40907 拿 opensAt 倒计时等）才不用改。
 */

const SUCCESS_CODE = 0;

class ApiError extends Error {
  /**
   * ⚠️⚠️ **签名必须与原后端 `src/utils/response.js` 完全一致（4 参）**。
   *
   * 云版一度简化成 3 参 `(code, message, data)`，看起来更干净，但代价是：
   * 从 src 里**逐字移植**过来的 service 仍在写 4 参 —— 于是
   * `new ApiError(Codes.SONG_WINDOW_CLOSED, msg, 200, { opensAt })` 的 `200`
   * 被当成了 `data`，`{ opensAt }` 被静默丢弃。
   * 后果是**前端拿不到倒计时数据**，而且不报任何错（message 还是对的），
   * 属于最难发现的一类漂移。
   *
   * 这类拦截（40907 窗口、排期满、候补满…）在阶段 5/7 还会继续出现，
   * 所以这里选择「保持四方言一致」而不是「每处调用都记得少写一个参数」。
   *
   * @param {number} code   业务码
   * @param {string} message 给用户看的文案
   * @param {number} httpStatus HTTP 状态码（云函数无 HTTP，单纯为签名对齐而保留，默认 200）
   * @param {object} data   可选附加数据（如 40907 的 opensAt / windowText，前端拿来做倒计时）
   */
  constructor(code, message, httpStatus = 200, data = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.data = data;
  }
}

const Codes = {
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
  // 40904 / 40906 已无生产路径，仅保留常量（详见项目文档）
  SLOT_AND_QUEUE_FULL: 40904,
  SLOT_FULL: 40906,
  SONG_WINDOW_CLOSED: 40907, // 不在点歌时间段（窗口外提交），data 带 opensAt / windowText
  SERVER_ERROR: 50001,
  WECHAT_API_ERROR: 60001,
  CONTENT_BLOCKED: 60002,
};

/**
 * 快捷抛错（云函数里取代 res.status().json()）
 * ⚠️ 注意 ApiError 是 4 参，这里必须显式补上 httpStatus，否则 data 会被当成状态码。
 */
function fail(code, message, data = null) {
  throw new ApiError(code, message, 200, data);
}

module.exports = { ApiError, Codes, fail, SUCCESS_CODE };
