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
 *
 * ⚠️ 启动阶段的 require 全部包在 try/catch 里（2026-09-28 加固）：
 *    顶层 require 一旦失败（文件缺失 / 依赖缺失 / 路径大小写），整个云函数直接挂掉，
 *    前端只能看到笼统的 `-504002 functions execute fail`，真正原因完全不可见、
 *    排查代价极高。现在改为「启动失败也返回诊断体」（含 __dirname 目录快照），一眼定位。
 */

const fs = require('fs');
const path = require('path');

let BOOT = null;

function boot() {
  if (BOOT) return BOOT;
  const out = { cloud: null, ApiError: null, Codes: null, match: null, error: null };
  try {
    out.cloud = require('wx-server-sdk');
    out.cloud.init({ env: out.cloud.DYNAMIC_CURRENT_ENV });
    const resp = require('./lib/response');
    out.ApiError = resp.ApiError;
    out.Codes = resp.Codes;
    out.match = require('./router').match;
  } catch (e) {
    out.error = e;
  }
  BOOT = out;
  return out;
}

/** 启动失败时返回的目录快照：用于区分「文件没传上去」与「路径/大小写不对」 */
function dirSnapshot() {
  const snap = (p) => {
    try { return fs.readdirSync(p); } catch (e) { return 'ERR ' + e.message; }
  };
  const here = __dirname;
  return {
    dirname: here,
    cwd: process.cwd(),
    root: snap(here),
    lib: snap(path.join(here, 'lib')),
    handlers: snap(path.join(here, 'handlers')),
    services: snap(path.join(here, 'services')),
  };
}

exports.main = async (event = {}, context) => {
  const b = boot();

  // 启动失败：返回可诊断的错误体，而不是让云函数整个挂掉
  if (b.error) {
    return {
      code: 90001,
      message: `BOOT_ERROR: ${(b.error && b.error.message) || b.error}`,
      data: dirSnapshot(),
    };
  }

  const started = Date.now();
  const { method = 'GET', path: rawPath = '', body = {}, token = '', query: eventQuery = {} } = event || {};
  const { cloud, ApiError, Codes, match } = b;

  // 拆出 path 里可能自带的 querystring（兼容 `/user/notice/list?page=1` 写法）
  let reqPath = String(rawPath);
  const inlineQuery = {};
  const qi = reqPath.indexOf('?');
  if (qi >= 0) {
    const qs = reqPath.slice(qi + 1);
    reqPath = reqPath.slice(0, qi);
    qs.split('&').forEach((kv) => {
      if (!kv) return;
      const eq = kv.indexOf('=');
      const k = eq >= 0 ? kv.slice(0, eq) : kv;
      const v = eq >= 0 ? kv.slice(eq + 1) : '';
      try { inlineQuery[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { inlineQuery[k] = v; }
    });
  }

  // ⚠️ GET 参数约定：小程序端 `request(path, 'GET', { page: 1 })` 在 direct 模式下由
  //    wx.request 自动拼成 query string；cloud 模式下这些参数落在 body 里。
  //    这里统一收敛成 ctx.query，让移植过来的控制器能照原样写 `ctx.query.page` —— 前端零改动。
  const isGet = String(method).toUpperCase() === 'GET';
  const query = Object.assign({}, inlineQuery, eventQuery || {}, isGet ? (body || {}) : {});

  // 记录请求来源，便于在云开发日志里定位（等价于原 requestId 中间件的作用）
  let wxContext = {};
  try { wxContext = cloud.getWXContext() || {}; } catch (e) { wxContext = {}; }

  try {
    const hit = match(method, reqPath);
    if (!hit) {
      return { code: Codes.NOT_FOUND, message: `接口不存在: ${method} ${reqPath}`, data: null };
    }

    const ctx = {
      method: String(method).toUpperCase(),
      path: reqPath,
      params: hit.params,        // 路径参数，如 { id: '123' }
      query,                     // GET 参数（见上方「GET 参数约定」）
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
    console.error('[api] 未捕获异常', { method, path: reqPath, msg: err && err.message, stack: err && err.stack });
    // ⚠️ 迁移期刻意把错误详情放进 `data`（前端只读 message 做 toast，不受影响）：
    //    云函数没有随时可看的日志面板时，这是唯一能拿到真实异常的手段。
    //    `dirs` 是云端**真实**目录快照 —— 用来区分「文件没传上去」与「代码报错」，
    //    这条路径不依赖任何 handler，所以即使 router 整个挂掉也拿得到。
    //    稳定期（阶段 9 之后）应当把 data 里的明细去掉，只留通用文案。
    return {
      code: Codes.SERVER_ERROR,
      message: '服务器繁忙，请稍后再试',
      data: {
        error: String((err && err.message) || err),
        stack: String((err && err.stack) || '').split('\n').slice(0, 6),
        dirs: dirSnapshot(),
      },
    };
  } finally {
    console.log('[api]', method, reqPath, `${Date.now() - started}ms`, wxContext.OPENID || '-');
  }
};
