'use strict';

/**
 * 云函数入口（网关）
 *
 * 调用约定（与小程序 utils/request.js 的 cloud 模式严格对应）：
 *   wx.cloud.callFunction({
 *     name: 'api',
 *     data: { method: 'GET', path: '/user/switch/list', body: {}, token: 'xxx' }
 *   })
 *
 * 返回约定：与现有后端 HTTP 响应体**完全一致**，前端解包逻辑零改动：
 *   { code: 0, message: 'ok', data: {...} }     成功
 *   { code: <业务码>, message: '...', data: null } 业务失败
 *
 * 设计要点：
 *  - 业务码与 HTTP 状态码无关（云函数没有 HTTP 状态），401 场景以 code=40101 表达，
 *    前端 cloud 模式据此清 token（与原 direct 模式的 statusCode===401 分支等价）。
 *  - 一切异常都在这里兜住，绝不把堆栈抛给前端。
 */

const cloud = require('wx-server-sdk');
const { ApiError, Codes } = require('./lib/response');
const { match } = require('./router');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}, context) => {
  const started = Date.now();
  const { method = 'GET', path = '', body = {}, token = '' } = event || {};

  // 记录请求来源，便于在云开发日志里定位（等价于原 requestId 中间件的作用）
  let wxContext = {};
  try { wxContext = cloud.getWXContext() || {}; } catch (e) { wxContext = {}; }

  try {
    const hit = match(method, path);
    if (!hit) {
      return { code: Codes.NOT_FOUND, message: `接口不存在: ${method} ${path}`, data: null };
    }

    const ctx = {
      method: String(method).toUpperCase(),
      path,
      params: hit.params,        // 路径参数，如 { id: '123' }
      body: body || {},
      token,
      openid: wxContext.OPENID || '',        // 云开发原生 openid（备用；业务仍以 JWT 内的 openid 为准）
      unionid: wxContext.UNIONID || '',
      cloud,
    };

    const data = await hit.handler(ctx);
    return { code: 0, message: 'ok', data: data === undefined ? null : data };
  } catch (err) {
    if (err instanceof ApiError) {
      // 业务错误：code 原样返回，data 可带附加信息（如 40907 的 opensAt / windowText）
      return { code: err.code, message: err.message, data: err.data || null };
    }
    console.error('[api] 未捕获异常', { method, path, msg: err && err.message, stack: err && err.stack });
    return { code: Codes.SERVER_ERROR, message: '服务器繁忙，请稍后再试', data: null };
  } finally {
    console.log('[api]', method, path, `${Date.now() - started}ms`, wxContext.OPENID || '-');
  }
};
