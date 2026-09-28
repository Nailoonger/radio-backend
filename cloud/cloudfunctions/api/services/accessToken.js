'use strict';

/**
 * 微信小程序全局 access_token —— 从 src/services/accessTokenService.js 移植
 *
 * 语义完全保留：
 *  - 命中缓存（且距过期 > 60s）直接返回
 *  - 未配置 appId/secret → 返回 null（**不抛错**，调用方据此跳过内容安全检测）
 *  - 请求失败也只 warn + 返回 null，绝不把业务打挂
 *
 * 缓存差异（有意为之）：
 *   原实现是常驻进程内存缓存；云函数实例会被回收，但**同一个热实例内**依然复用。
 *   多实例并发时最多各自取一次 token，微信侧对 token 取用频率有宽容度，且
 *   本项目调用量极小，实测无需引入外部共享缓存（如要跨实例共享，可写入
 *   system_setting 集合，但会多一次读库，得不偿失）。
 */

const axios = require('axios');
const { wechat } = require('../config');

let cached = { value: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (cached.value && cached.expiresAt > now + 60_000) {
    return cached.value;
  }
  if (!wechat.appId || !wechat.secret) {
    return null; // 未配置 → 交由调用方跳过（与原实现一致）
  }

  const url =
    'https://api.weixin.qq.com/cgi-bin/token' +
    `?grant_type=client_credential&appid=${wechat.appId}&secret=${wechat.secret}`;

  try {
    const { data } = await axios.get(url, { timeout: 5000 });
    if (data && data.access_token) {
      cached = {
        value: data.access_token,
        expiresAt: now + (data.expires_in || 7200) * 1000,
      };
      return data.access_token;
    }
    console.warn('[accessToken] 接口未返回 access_token', data);
    return null;
  } catch (e) {
    console.warn('[accessToken] 请求失败:', e && e.message);
    return null;
  }
}

/** 仅供自检/测试：清掉实例内缓存 */
function resetCache() {
  cached = { value: null, expiresAt: 0 };
}

module.exports = { getAccessToken, resetCache };
