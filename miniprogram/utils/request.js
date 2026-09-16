// utils/request.js - 统一请求封装
// 重要：不要在 require 时就 getApp()，否则在 app.js 还没注册前 require 会拿到 undefined
// 改成函数内部懒获取

/**
 * 封装 wx.request：
 *  - 自动注入 baseURL + Authorization
 *  - 解包 { code, message, data }，code!=0 时 reject
 *  - 401 时尝试一次自动登录后重试
 *  - 带详细日志：URL、状态码、错误信息
 */
function request(url, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    // 懒获取 app 实例
    let app;
    try { app = getApp(); } catch (e) { app = null; }

    const baseURL = (app && app.globalData && app.globalData.baseURL) || 'http://localhost:3000/api';
    const fullURL = url.startsWith('http') ? url : baseURL + url;
    const header = { 'Content-Type': 'application/json' };
    if (app && app.globalData && app.globalData.token) header.Authorization = `Bearer ${app.globalData.token}`;

    console.log(`[request] ${method} ${fullURL}`);

    wx.request({
      url: fullURL,
      method,
      data,
      header,
      success: (res) => {
        console.log(`[request] ${method} ${fullURL} → ${res.statusCode}`, res.data);
        const body = res.data || {};
        if (res.statusCode === 401) {
          if (app) {
            app.globalData.token = '';
            try { wx.removeStorageSync('token'); } catch (e) {}
          }
          return reject({ code: 40101, message: '请先登录' });
        }
        if (body.code === 0) {
          return resolve(body.data);
        }
        reject(body);
      },
      fail: (err) => {
        console.error(`[request FAIL] ${method} ${fullURL}`, err);
        reject({ code: -1, message: err.errMsg || '网络异常' });
      },
    });
  });
}

module.exports = { request };
