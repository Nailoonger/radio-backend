'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

let cachedToken = { value: null, expiresAt: 0 };

/**
 * 获取微信小程序全局 access_token（带缓存）
 * 文档: https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/access-token/auth.getAccessToken.html
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken.value && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  if (!config.wechat.appId || !config.wechat.secret) {
    return null;
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechat.appId}&secret=${config.wechat.secret}`;
  try {
    const { data } = await axios.get(url, { timeout: 5000 });
    if (data.access_token) {
      cachedToken = {
        value: data.access_token,
        expiresAt: now + (data.expires_in || 7200) * 1000,
      };
      return data.access_token;
    }
    logger.warn('getAccessToken error:', data);
    return null;
  } catch (e) {
    logger.warn('getAccessToken 请求失败:', e.message);
    return null;
  }
}

module.exports = { getAccessToken };