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

  /**
   * ── HTTP 访问服务（阶段 9：给 admin-web 用）──────────────────────────
   * 网页没有 wx 环境，只能走云函数的 HTTP 触发，此时 event 是**集成请求**
   * （`{ path, httpMethod, headers, queryStringParameters, body, isBase64Encoded }`）。
   *
   * ⚠️⚠️ 必须在**解构 event 之前**把它还原成我们自己的形状 ——
   *    这样下面所有逻辑（路由 / handler / 鉴权）一行都不用为 admin-web 改。
   *    `normalizeHttpEvent` 对非 HTTP 事件（小程序 callFunction / 定时触发）返回 null，
   *    所以这条分支对原有两条通道**零影响**。
   */
  let httpVia = null;
  // Only platform-injected request context may supply an HTTP source address.
  // Envelope fields and forwarding headers are user input, never a rate-limit identity.
  const httpSourceIp = event && event.requestContext && (
    (event.requestContext.http && event.requestContext.http.sourceIp) ||
    (event.requestContext.identity && event.requestContext.identity.sourceIp)
  );
  try {
    const info = require('./httpBridge').normalizeHttpEvent(event);
    if (info) {
      // 浏览器预检（OPTIONS）：没有业务语义，直接放行，别让它落到「接口不存在」
      if (info.method === 'OPTIONS') return { code: 0, message: 'ok', data: null };
      httpVia = info.via;
      event = { method: info.method, path: info.path, body: info.body, token: info.token, query: info.query };
    }
  } catch (e) {
    // 适配层自身出错不能把整个云函数拖挂：记一行日志后按原样继续（等价于没开 HTTP 通道）
    console.error('[http] 集成请求适配失败', (e && e.message) || e);
  }

  const started = Date.now();
  const { method = 'GET', path: rawPath = '', body = {}, token = '', query: eventQuery = {} } = event || {};
  const { cloud, ApiError, Codes, match } = b;

  /**
   * ── 定时触发器（阶段 6）─────────────────────────────────────────────
   * 替换原 `songQueueService.startScheduler()` 的 60 秒 `setInterval`。
   *
   * 定时触发时 `event = { Type: 'Timer', TriggerName: 'songSweepTick', TriggerTime: ... }`
   * ⚠️ 必须在**路由匹配之前**拦掉：定时事件没有 `method` / `path`，
   *    走路由只会得到「接口不存在」，而且触发器**不关心返回值**，
   *    那种错误是纯静默的（日志里看着像正常触发）。
   *
   * ⚠️ `require` 放在分支内部（惰性）：排期服务的加载失败**不能**影响普通请求。
   */
  if (event && (event.Type === 'Timer' || event.TriggerName)) {
    try {
      // Bound maintenance to 100 expired rate documents per tick; recruitment
      // collections may not yet be initialized in existing deployments.
      if (Math.floor(Date.now() / 60000) % 60 === 0) {
        try { await require('./services/recruitmentStore').cleanupRates(); }
        catch (_) { console.warn('[cron] 招新限流记录清理暂不可用'); }
      }
      const sched = require('./services/scheduling');
      const out = await sched.sweepTick({ now: Date.now() });
      console.log('[cron]', event.TriggerName || 'timer', JSON.stringify({
        skipped: out.skipped, reason: out.reason, weeks: out.weeks, played: out.played, error: out.error,
      }));
      return {
        code: 0,
        message: 'ok',
        data: { cron: true, skipped: out.skipped, reason: out.reason || null, weeks: out.weeks, played: out.played, error: out.error || null },
      };
    } catch (e) {
      console.error('[cron] 未捕获异常', (e && e.message) || e, (e && e.stack) || '');
      return { code: Codes.SERVER_ERROR, message: '定时任务失败', data: { error: String((e && e.message) || e) } };
    }
  }

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
      // A native caller can forge HTTP-looking event fields. Platform OPENID
      // always takes precedence, so changing fake sourceIp cannot reset quotas.
      source: wxContext.OPENID ? `cloud:${wxContext.OPENID}` : (httpVia && httpSourceIp ? `http:${httpSourceIp}` : ''),
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
    // Recruitment carries bearer credentials and student data: never return or log
    // SDK diagnostics that could embed a submitted document or query credential.
    if (reqPath.includes('/recruitment')) {
      console.error('[recruitment] 未捕获异常', { method, path: reqPath });
      return { code: Codes.SERVER_ERROR, message: '服务器繁忙，请稍后再试', data: null };
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
    // `httpVia` 只有 HTTP 访问服务来的请求才有（'envelope' / 'rest'），日志里带上便于分辨通道
    console.log('[api]', httpVia ? `http:${httpVia}` : 'cloud', method, reqPath, `${Date.now() - started}ms`, wxContext.OPENID || '-');
  }
};
