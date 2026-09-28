// utils/request.direct.bak.js
//
// ⚠️ 这是改造前 request.js 的**完整原版备份**（2026-09-28 云开发迁移时留存）。
// 用途：万一 cloud 通道出问题、或想彻底退回「只走服务器直连」，可以：
//   1. 把本文件内容复制回 utils/request.js；或
//   2. 保持现结构，把 app.js 里 globalData.requestMode 改回 'direct'（推荐，等价且更快）。
// 请勿删除。

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
