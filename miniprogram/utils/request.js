// utils/request.js - 统一请求封装（双通道：direct / cloud）
//
// ┌ 背景 ─────────────────────────────────────────────────────────────┐
// │ 小程序正式版会校验「request 合法域名」，而合法域名需要 ICP 备案。      │
// │ 走 wx.cloud.callFunction 的云开发通道不在此校验范围内，可免备案上线。  │
// │ 但服务器要留着当退路，所以这里 **两种模式并存**，切换只改配置。        │
// └───────────────────────────────────────────────────────────────────┘
//
//   direct —— wx.request 直连服务器（原逻辑原样保留，走 IP 或备案域名）
//   cloud  —— wx.cloud.callFunction 走云函数 api（免备案）
//
// 两种模式对外**返回值与错误语义完全一致**，业务代码（页面）无感：
//   成功 → resolve(data)
//   失败 → reject({ code, message, ... })（code=40101 时已清本地 token）
//
// 原版（纯 direct）完整代码备份在 utils/request.direct.bak.js，可随时还原。

let CONFIG = {
  mode: 'direct',              // 'direct' | 'cloud'
  baseURL: '',                 // direct 模式接口前缀（含 /api）
  cloudFunctionName: 'api',    // cloud 模式云函数名
  configured: false,
};

/**
 * 由 app.js 的 onLaunch 调用，注入运行配置
 * @param {{mode?:string, baseURL?:string, cloudFunctionName?:string}} opt
 */
function configure(opt = {}) {
  CONFIG = { ...CONFIG, ...opt, configured: true };
  console.log('[request] 模式 =', CONFIG.mode, '| baseURL =', CONFIG.baseURL || '(cloud)');
}

function getAppSafe() {
  try { return getApp(); } catch (e) { return null; }
}

/**
 * 取当前 token。
 * ⚠️ 分身份存放（2026-10-01 管理端落地）：老师和管理员可能在同一台手机上
 *    既登学生端又登管理端，共用一个 key 会互相顶掉登录态。
 *      scope='user'（默认）→ globalData.token      / storage 'token'       ← 原逻辑，一字未改
 *      scope='admin'       → globalData.adminToken / storage 'admin_token'
 */
function currentToken(scope) {
  if (scope === 'public') return '';
  const app = getAppSafe();
  if (scope === 'admin') {
    if (app && app.globalData && app.globalData.adminToken) return app.globalData.adminToken;
    try { return wx.getStorageSync('admin_token') || ''; } catch (e) { return ''; }
  }
  if (app && app.globalData && app.globalData.token) return app.globalData.token;
  try { return wx.getStorageSync('token') || ''; } catch (e) { return ''; }
}

function currentBaseURL() {
  if (CONFIG.baseURL) return CONFIG.baseURL;
  const app = getAppSafe();
  return (app && app.globalData && app.globalData.baseURL) || 'http://localhost:3000/api';
}

/** 401 统一处理：按身份清 token */
function handleUnauthorized(app, scope) {
  if (!app) return;
  if (scope === 'admin') {
    app.globalData.adminToken = '';
    try { wx.removeStorageSync('admin_token'); } catch (e) {}
    return;
  }
  app.globalData.token = '';
  try { wx.removeStorageSync('token'); } catch (e) {}
}

// ---------------- direct 模式：wx.request（原逻辑） ----------------
function directRequest(path, method, data, scope, options) {
  return new Promise((resolve, reject) => {
    const app = getAppSafe();
    const baseURL = currentBaseURL();
    const fullURL = path.startsWith('http') ? path : baseURL + path;
    const header = { 'Content-Type': 'application/json' };
    const token = currentToken(scope);
    if (token) header.Authorization = `Bearer ${token}`;

    console.log(`[request:direct] ${method} ${fullURL}`);

    wx.request({
      url: fullURL,
      method,
      data,
      header,
      success: (res) => {
        if (options.sensitive) console.log(`[request:direct] ${method} ${fullURL} → ${res.statusCode}`);
        else console.log(`[request:direct] ${method} ${fullURL} → ${res.statusCode}`, res.data);
        const body = res.data || {};
        if (res.statusCode === 401) {
          handleUnauthorized(app, scope);
          return reject({ code: 40101, message: '请先登录' });
        }
        if (body.code === 0) return resolve(body.data);
        reject(body);
      },
      fail: (err) => {
        if (options.sensitive) console.error(`[request:direct FAIL] ${method} ${fullURL}`);
        else console.error(`[request:direct FAIL] ${method} ${fullURL}`, err);
        reject({ code: -1, message: err.errMsg || '网络异常' });
      },
    });
  });
}

// ---------------- cloud 模式：wx.cloud.callFunction ----------------
function cloudRequest(path, method, data, scope, options) {
  return new Promise((resolve, reject) => {
    const app = getAppSafe();
    console.log(`[request:cloud] ${method} ${path}`);

    if (!wx.cloud || !wx.cloud.callFunction) {
      return reject({ code: -1, message: '云开发未初始化，请检查基础库版本' });
    }

    wx.cloud.callFunction({
      name: CONFIG.cloudFunctionName,
      data: { path, method, body: data || {}, token: currentToken(scope) },
      success: (res) => {
        const body = (res && res.result) || {};
        if (options.sensitive) console.log(`[request:cloud] ${method} ${path} → ${body.code}`);
        else console.log(`[request:cloud] ${method} ${path} → ${body.code}`, body.data);
        if (body.code === 40101) {
          handleUnauthorized(app, scope);
          return reject({ code: 40101, message: body.message || '请先登录' });
        }
        if (body.code === 0) return resolve(body.data);
        reject(body);
      },
      fail: (err) => {
        // 云函数执行失败 / 环境未开通 / 冷启动超时都走这里
        if (options.sensitive) console.error(`[request:cloud FAIL] ${method} ${path}`);
        else console.error(`[request:cloud FAIL] ${method} ${path}`, err);
        reject({ code: -1, message: (err && err.errMsg) || '云函数调用失败' });
      },
    });
  });
}

// ---------------- 对外主函数（签名与原版一致，页面代码不用改） ----------------
function request(url, method = 'GET', data = {}, scope = 'user', options = {}) {
  if (CONFIG.mode === 'cloud') return cloudRequest(url, method, data, scope, options);
  return directRequest(url, method, data, scope, options);
}

/**
 * 管理端专用请求 —— 与学生端共用同一套通道，只是**读写 admin_token**。
 * 用法与 request 完全一致：adminRequest('/admin/submit/list', 'GET', {...})
 */
function adminRequest(url, method = 'GET', data = {}) {
  return request(url, method, data, 'admin');
}

module.exports = { request, adminRequest, configure, getMode: () => CONFIG.mode };
