'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Configuration values stay in memory. Errors contain stage names and field names only.
const FUNCTION_VOLATILE = new Set([
  'RequestId', 'RequestID', 'CodeInfo', 'CodeSize', 'CodeResult', 'ErrNo',
  'CodeSha256', 'ModTime', 'AddTime', 'Status', 'StatusDesc', 'StatusReasons',
  'AvailableStatus',
]);
const NESTED_VOLATILE = new Set(['ModTime', 'AddTime', 'CreateTime', 'UpdateTime']);
const ROUTE_VOLATILE = new Set([
  ...NESTED_VOLATILE, 'RequestId', 'RequestID', 'Status', 'DNSStatus',
  'PlatformCnameDNSStatus',
]);

function fail(message, code = 'RELEASE_CLOUD_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePlatformError(stage, error) {
  // Never interpolate message, errMsg, response bodies, URL signatures, or config.
  const rawCode = error && typeof error.code === 'string' ? error.code.split('.')[0] : '';
  const code = new Set(['FailedOperation', 'UnauthorizedOperation', 'InvalidParameter',
    'InvalidParameterValue', 'ResourceNotFound', 'InternalError', 'UnsupportedOperation',
    'ResourceUnavailable', 'OperationDenied', 'MissingParameter', 'AuthFailure',
    'LimitExceeded', 'RequestLimitExceeded', 'INVALID_PARAM', 'NOT_FOUND', 'NETWORK_ERROR',
    'API_ERROR', 'MISSING_CREDENTIAL', 'FILE_READ_ERROR', 'ENOTFOUND', 'ECONNRESET',
    'ETIMEDOUT']).has(rawCode) ? rawCode : '';
  const requestId = error && (error.requestId || error.RequestId);
  const safeId = typeof requestId === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)
    ? requestId : '';
  return fail(stage + '失败' + (code ? '，错误类别：' + code : '')
    + (safeId ? '，请求编号：' + safeId : ''), 'CLOUD_PLATFORM_ERROR');
}

function stable(value, omit = new Set(), parentKey = '') {
  if (Array.isArray(value)) {
    const items = value.map((item) => stable(item, omit));
    // Route/domain and declaration sets have no meaningful ordering; routing-rule
    // precedence and unknown runtime arrays retain their original order.
    return ['Variables', 'Triggers', 'Layers', 'Tags', 'Domains', 'Routes'].includes(parentKey)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => !omit.has(key))
      .map((key) => [key, stable(value[key], omit, key)]));
  }
  return value;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function functionConfig(detail) {
  if (!detail || typeof detail !== 'object'
      || detail.Type !== 'Event'
      || typeof detail.Runtime !== 'string' || !/^Nodejs\d+/i.test(detail.Runtime)
      || typeof detail.Handler !== 'string' || !detail.Handler
      || !['TRUE', 'FALSE'].includes(detail.InstallDependency)
      || !Number.isFinite(detail.MemorySize) || detail.MemorySize <= 0
      || !Number.isFinite(detail.Timeout) || detail.Timeout <= 0
      || !detail.Environment || !Array.isArray(detail.Environment.Variables)
      || !detail.Environment.Variables.every((item) => item && typeof item.Key === 'string'
        && Object.prototype.hasOwnProperty.call(item, 'Value'))
      || !Array.isArray(detail.Triggers)) {
    throw fail('云函数配置不完整或不是现有事件函数，已停止发布', 'INCOMPLETE_FUNCTION_CONFIG');
  }
  const timer = detail.Triggers.find((item) => item
    && (item.Name === 'songSweepTick' || item.TriggerName === 'songSweepTick')
    && String(item.Type).toLowerCase() === 'timer'
    && typeof (item.Config || item.TriggerDesc) === 'string' && (item.Config || item.TriggerDesc));
  if (!timer) {
    throw fail('线上缺少 songSweepTick 定时触发器，已停止发布', 'MISSING_TIMER');
  }
  return stable(Object.fromEntries(Object.entries(detail)
    .filter(([key]) => !FUNCTION_VOLATILE.has(key))), NESTED_VOLATILE);
}

function assertConfigSame(before, after, stage) {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !same(before[key], after[key]));
  if (fields.length) {
    const names = fields.map((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : '未知字段');
    throw fail(stage + '配置发生变化：' + names.join('、'), 'CONFIG_CHANGED');
  }
}

function websiteConfig(result) {
  const config = result && result.WebsiteConfiguration;
  const suffix = config && config.IndexDocument && config.IndexDocument.Suffix;
  const fallback = config && ((config.ErrorDocument && config.ErrorDocument.Key === 'index.html')
    || (Array.isArray(config.RoutingRules) && config.RoutingRules.some((rule) => rule
      && rule.Condition && String(rule.Condition.HttpErrorCodeReturnedEquals) === '404'
      && rule.Redirect && String(rule.Redirect.ReplaceKeyWith || '').replace(/^\//, '') === 'index.html')));
  if (suffix !== 'index.html' || !fallback) {
    throw fail('静态托管缺少 index.html 索引或页面刷新回退规则，已停止发布', 'MISSING_SPA_FALLBACK');
  }
  return stable(config);
}

async function streamBytes(stream, limit) {
  if (typeof stream === 'string' || Buffer.isBuffer(stream) || stream instanceof Uint8Array) {
    const bytes = Buffer.from(stream);
    if (bytes.length > limit) throw fail('远端发布文件超过读取上限', 'REMOTE_FILE_TOO_LARGE');
    return bytes;
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw fail('远端文件读取结果无效', 'INVALID_REMOTE_FILE');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      if (typeof stream.destroy === 'function') stream.destroy();
      throw fail('远端发布文件超过读取上限', 'REMOTE_FILE_TOO_LARGE');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function createCloudAdapter({
  manager, envId, apiUrl, webUrl, apiDir, distDir, codeSecret,
  fetchImpl = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = () => {},
}) {
  async function platform(stage, action) {
    try { return await action(); } catch (error) { throw safePlatformError(stage, error); }
  }

  async function readFunction() {
    return platform('读取云函数配置', () => manager.commonService().call({
      Action: 'GetFunction',
      Param: { EnvId: envId, Namespace: envId, FunctionName: 'api', ShowCode: 'FALSE',
        ...(codeSecret ? { CodeSecret: codeSecret } : {}) },
    }));
  }

  async function readRoutes() {
    const domains = [];
    let offset = 0;
    let total;
    let originDomain;
    do {
      const page = await platform('读取 HTTP 访问路由', () => manager.env.describeHttpServiceRoute({
        EnvId: envId, Offset: offset, Limit: 1000,
      }));
      if (!page || !Array.isArray(page.Domains) || !Number.isInteger(page.TotalCount)
          || page.TotalCount < 0 || typeof page.OriginDomain !== 'string') {
        throw fail('HTTP 访问路由信息不完整，已停止发布', 'INCOMPLETE_GATEWAY');
      }
      if (total !== undefined && (total !== page.TotalCount || originDomain !== page.OriginDomain)) {
        throw fail('HTTP 路由分页期间发生变化，请重试', 'GATEWAY_CHANGED_DURING_READ');
      }
      total = page.TotalCount;
      originDomain = page.OriginDomain;
      if (!page.Domains.length && offset < total) {
        throw fail('HTTP 路由分页缺失，已停止发布', 'INCOMPLETE_GATEWAY');
      }
      domains.push(...page.Domains);
      offset += page.Domains.length;
      if (domains.length > 10000) throw fail('HTTP 路由数量异常，已停止发布', 'INCOMPLETE_GATEWAY');
    } while (offset < total);
    let apiHost;
    try { apiHost = new URL(apiUrl).host; } catch { throw fail('云 API 地址无效', 'INVALID_API_URL'); }
    const apiDomain = domains.find((domain) => domain.Domain === apiHost);
    const apiRoute = apiDomain && Array.isArray(apiDomain.Routes)
      && apiDomain.Routes.find((route) => route.Path === '/api' && route.UpstreamResourceName === 'api'
        && route.UpstreamResourceType === 'SCF' && route.Enable === true);
    if (!apiDomain || apiDomain.Enable !== true || !apiRoute) {
      throw fail('现有云 API 域名缺少启用的 /api 事件函数入口，已停止发布', 'MISSING_API_ROUTE');
    }
    // Retain all returned route settings while dropping only transient diagnostics.
    return stable({ OriginDomain: originDomain, Domains: domains }, ROUTE_VOLATILE);
  }

  async function localFile(directory, name) {
    try { return await fs.readFile(path.join(directory, name)); }
    catch { throw fail('发布产物缺少 ' + name, 'MISSING_ARTIFACT'); }
  }

  async function request(url, options = {}, timeoutMs = 10000) {
    // A request cannot hold the publish job indefinitely; errors never print its URL or body.
    try {
      return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    } catch { throw fail('线上只读检查请求失败', 'HEALTH_REQUEST_FAILED'); }
  }

  async function waitHealth() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await request(apiUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ method: 'GET', path: '/health', body: {}, token: '' }),
        });
        if (response.ok) {
          const raw = await response.json();
          // Keep the same string-response compatibility as the existing admin request layer.
          const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (body && body.code === 0 && body.data && body.data.dbReady === true
              && body.data.jwtReady === true) return;
        }
      } catch { /* Platform responses and diagnostic bodies may contain sensitive values. */ }
      if (attempt < 7) await sleepFn(2000);
    }
    throw fail('云 API 健康检查未通过，后续网页发布已停止', 'API_HEALTH_FAILED');
  }

  async function publishApi() {
    await localFile(apiDir, 'index.js');
    await localFile(apiDir, 'package.json');
    await localFile(apiDir, 'package-lock.json');
    const detail = await readFunction();
    const before = functionConfig(detail);
    const routesBefore = await readRoutes();
    logger('云函数：已验证运行配置、定时触发器和 API 入口');
    const result = await platform('更新云函数代码', () => manager.functions.updateFunctionCode({
      func: { name: 'api', handler: detail.Handler, runtime: detail.Runtime,
        installDependency: detail.InstallDependency, isWaitInstall: true },
      functionPath: apiDir, deployMode: 'cos', ...(codeSecret ? { codeSecret } : {}),
    }));
    if (!result || typeof result.RequestId !== 'string' || !result.RequestId) {
      throw fail('云函数更新未返回有效请求编号，已停止发布', 'INCOMPLETE_UPDATE_RESULT');
    }
    if (result.SCFErrorCode || result.SCFErrorMsg) {
      throw safePlatformError('更新云函数代码', { code: result.SCFErrorCode, requestId: result.RequestId });
    }
    let after;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      after = await readFunction();
      if (after.Status === 'Active') break;
      if (!['Creating', 'Updating'].includes(after.Status)) {
        throw fail('云函数更新后未处于可用状态', 'API_NOT_ACTIVE');
      }
      if (attempt < 29) await sleepFn(1000);
    }
    if (!after || after.Status !== 'Active') throw fail('等待云函数可用超时', 'API_NOT_ACTIVE');
    assertConfigSame(before, functionConfig(after), '云函数');
    assertConfigSame(routesBefore, await readRoutes(), 'HTTP 访问路由');
    await waitHealth();
    logger('云函数：配置保持一致，API 健康检查通过');
    return { configurationVerified: true, gatewayVerified: true, healthy: true };
  }

  function webBudget() {
    const deadline = Date.now() + 30000;
    let retryDelayLeft = 30000;
    const left = () => Math.max(0, Math.min(retryDelayLeft, deadline - Date.now()));
    return {
      left,
      async retry() {
        if (left() < 2000) return false;
        retryDelayLeft -= 2000;
        await sleepFn(2000);
        return true;
      },
      async run(action) {
        const timeoutMs = left();
        if (!timeoutMs) throw fail('等待网页传播超时', 'WEB_PROPAGATION_TIMEOUT');
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(action),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(fail('等待网页传播超时', 'WEB_PROPAGATION_TIMEOUT')), timeoutMs);
            }),
          ]);
        } finally { clearTimeout(timer); }
      },
    };
  }

  async function checkWebFiles(index, metadata, budget) {
    const cacheKey = digest(metadata);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const remoteMetadata = await budget.run(async () => streamBytes(await manager.hosting.downloadFile({
          cloudPath: 'release.json?radio-release=' + cacheKey,
        }), 65536));
        const remoteIndex = await budget.run(async () => streamBytes(await manager.hosting.downloadFile({
          cloudPath: 'index.html?radio-release=' + cacheKey,
        }), 2 * 1024 * 1024));
        if (remoteMetadata.equals(metadata) && remoteIndex.equals(index)) return cacheKey;
      } catch { /* Retry short-lived CDN propagation without printing response content. */ }
      if (attempt >= 7 || !(await budget.retry())) break;
    }
    throw fail('线上网页入口或发布版本与本次产物不一致', 'WEB_CONTENT_MISMATCH');
  }

  async function checkPublicWeb(index, cacheKey, budget) {
    let origin;
    try { origin = new URL(webUrl); } catch { throw fail('管理后台网址无效', 'INVALID_WEB_URL'); }
    for (const route of ['', 'submit/settings']) {
      const url = new URL(route, origin.href.endsWith('/') ? origin.href : origin.href + '/');
      url.searchParams.set('radio-release', cacheKey);
      let verified = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const matches = await budget.run(async () => {
            const response = await request(url.href, { headers: {
              Accept: 'text/html', Referer: origin.href,
              'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
              'Cache-Control': 'no-cache',
            } }, Math.min(10000, budget.left()));
            return (response.ok || (route && response.status === 404))
              && Buffer.from(await response.arrayBuffer()).equals(index);
          });
          if (matches) {
            verified = true;
            break;
          }
        } catch { /* Allow CDN propagation without logging response or network error bodies. */ }
        if (attempt >= 7 || !(await budget.retry())) break;
      }
      if (!verified) throw fail('原管理后台网址或子页面刷新检查未通过', 'WEB_ROUTE_HEALTH_FAILED');
    }
  }

  async function publishWeb() {
    try { new URL(webUrl); } catch { throw fail('管理后台网址无效', 'INVALID_WEB_URL'); }
    const index = await localFile(distDir, 'index.html');
    const metadata = await localFile(distDir, 'release.json');
    const before = websiteConfig(await platform('读取静态托管配置', () => manager.hosting.getWebsiteConfig()));
    logger('管理后台：已验证页面刷新回退规则');
    await platform('上传管理后台网页', () => manager.hosting.uploadFiles({
      localPath: distDir, cloudPath: '', entryFiles: ['index.html'],
      verify: true, safe: true, prune: false,
    }));
    const after = websiteConfig(await platform('复查静态托管配置', () => manager.hosting.getWebsiteConfig()));
    assertConfigSame(before, after, '静态托管');
    // All hosted-file and public-domain propagation checks share a 30-second budget.
    const budget = webBudget();
    const cacheKey = await checkWebFiles(index, metadata, budget);
    await checkPublicWeb(index, cacheKey, budget);
    logger('管理后台：网页版本、原网址和页面刷新检查通过');
    return { configurationVerified: true, contentVerified: true, publicVerified: true };
  }

  return { publishApi, publishWeb };
}

module.exports = { createCloudAdapter };
