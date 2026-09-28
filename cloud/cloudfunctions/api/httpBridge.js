'use strict';

/**
 * HTTP 访问服务（云接入）适配层 —— 阶段 9：给 admin-web 用
 *
 * 背景：小程序走 `wx.cloud.callFunction`，event 就是我们自己的形状
 *       `{ method, path, body, token }`；而管理后台是**网页**，没有 wx 环境，
 *       只能走「云函数 HTTP 触发」，此时云函数收到的是**集成请求**：
 *
 *       {
 *         path: '/api',                    // = 控制台里配的「触发路径」
 *         httpMethod: 'POST',
 *         headers: { authorization: 'Bearer xxx', ... },
 *         queryStringParameters: {...},
 *         body: '<原始请求体字符串>',
 *         isBase64Encoded: false,
 *       }
 *
 * ⚠️⚠️ 本层的存在意义：**把集成请求还原成 `index.js` 认识的形状**，
 *     这样路由 / handler / 鉴权全都不用为 admin-web 改一个字。
 *
 * 两种形态都支持（前端用哪种都行，判据是请求体里有没有 `path`）：
 *
 *  ① 信封模式（**推荐**，admin-web 走这个）
 *     POST /api    body = '{"method":"GET","path":"/admin/switch/list","body":{},"token":"xxx"}'
 *     → 不依赖「路径透传」是否开启，触发路径永远是 `/api`，最稳。
 *
 *  ② RESTful 模式（兜底）
 *     GET /api/admin/switch/list?page=1   （需要控制台开启**路径透传**）
 *     → path 取 `event.path`，query 取 `queryStringParameters`。
 *
 * ⚠️ `token` 的取法：先看 `Authorization: Bearer <jwt>`，再退回信封里的 `token`。
 *     两者都没有 → `''`，后续鉴权照常返回 40101（不会因此给出"参数错误"这类误导文案）。
 */

/** 是不是「HTTP 访问服务」触发的集成请求 */
function isHttpEvent(event) {
  return !!(event && typeof event === 'object' && (event.httpMethod || event.requestContext));
}

/** 取 header（大小写不敏感） */
function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  const hit = Object.keys(headers).find((k) => String(k).toLowerCase() === want);
  return hit ? String(headers[hit] || '') : '';
}

/** 从 Authorization 头里剥出 JWT */
function tokenFromHeaders(headers) {
  const raw = headerOf(headers, 'authorization');
  if (!raw) return '';
  return String(raw).replace(/^Bearer\s+/i, '').trim();
}

/** 把集成请求的 body 解析成对象；坏 JSON / 空 body 都返回 null（**不抛**） */
function parseBody(event) {
  let raw = event.body;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return typeof raw === 'object' ? raw : null;

  // ⚠️ 有些客户端/配置下 body 会被 base64 编码；`isBase64Encoded` 可能是布尔也可能是字符串
  const enc = String(event.isBase64Encoded);
  if (enc === 'true' || enc === '1') {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { return null; }
  }

  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;   // 表单/纯文本等 —— 交给调用方兜底，绝不在这里抛
  }
}

/**
 * 集成请求 → `{ method, path, body, token, query }`
 * 不是 HTTP 事件（小程序 callFunction / 定时触发）→ 返回 **null**，调用方保持原逻辑。
 *
 * @returns {null|{method:string, path:string, body:object, token:string, query:object, via:string}}
 */
function normalizeHttpEvent(event) {
  if (!isHttpEvent(event)) return null;

  const method = String(event.httpMethod || 'GET').toUpperCase();
  const payload = parseBody(event);
  const token = tokenFromHeaders(event.headers) || (payload && payload.token) || '';
  const qs = event.queryStringParameters && typeof event.queryStringParameters === 'object'
    ? event.queryStringParameters : {};

  // ① 信封模式：请求体里带了 `path` —— admin-web 走的正是这个
  if (payload && typeof payload.path === 'string' && payload.path) {
    return {
      method: String(payload.method || method || 'GET').toUpperCase(),
      path: payload.path,
      body: payload.body && typeof payload.body === 'object' ? payload.body : {},
      query: (payload.query && typeof payload.query === 'object') ? payload.query : {},
      token: token || String(payload.token || ''),
      via: 'envelope',
    };
  }

  // ② RESTful 兜底：路径透传开启时，`event.path` 才是真实路由
  const isGet = method === 'GET' || method === 'HEAD';
  return {
    method,
    path: String(event.path || '/'),
    // GET 的查询参数在 queryStringParameters；非 GET 的请求体就是 body
    query: Object.assign({}, qs),
    body: isGet ? {} : (payload || {}),
    token,
    via: 'rest',
  };
}

module.exports = { isHttpEvent, normalizeHttpEvent, parseBody, tokenFromHeaders };
