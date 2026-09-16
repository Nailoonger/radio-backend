'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * 调用微信 code2session 换取 openid / session_key / unionid
 * 文档: https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/login/auth.code2Session.html
 *
 * @param {string} code 小程序 wx.login 返回的 code
 * @returns {Promise<{openid:string, session_key:string, unionid?:string}>}
 */
async function code2Session(code) {
  if (!code) {
    throw new Error('code不能为空');
  }
  if (!config.wechat.appId || !config.wechat.secret) {
    throw new Error('未配置 WECHAT_APPID / WECHAT_SECRET');
  }

  const url = `${config.wechat.code2sessionUrl}?appid=${config.wechat.appId}&secret=${config.wechat.secret}&js_code=${code}&grant_type=authorization_code`;

  const { data } = await axios.get(url, { timeout: 5000 });

  if (data.errcode) {
    logger.error('code2session error:', data);
    throw new Error(`微信接口错误: ${data.errmsg || data.errcode}`);
  }

  return {
    openid: data.openid,
    sessionKey: data.session_key,
    unionid: data.unionid,
  };
}

/**
 * 调用微信内容安全 API 检查文本
 * 文档: https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/sec-check/security.msgSecCheck.html
 *
 * 注意：需要小程序 access_token（通过 api.weixin.qq.com/cgi-bin/token 获取）
 *       本服务仅做封装，按需在调用处注入 token。
 */
async function msgSecCheck(content, accessToken) {
  if (!config.wechat.enableSecurityCheck) return { pass: true };
  if (!accessToken) {
    logger.warn('msgSecCheck: 缺少 access_token，跳过检测');
    return { pass: true };
  }
  try {
    const url = `${config.wechat.msgCheckUrl}?access_token=${accessToken}`;
    const { data } = await axios.post(
      url,
      { content, version: 2, scene: 2 },
      { timeout: 5000 }
    );
    if (data.errcode && data.errcode !== 0) {
      logger.warn('msgSecCheck errcode:', data);
      return { pass: true };
    }
    return { pass: data.result?.suggest === 'pass' };
  } catch (e) {
    logger.warn('msgSecCheck 调用失败，跳过:', e.message);
    return { pass: true };
  }
}

module.exports = {
  code2Session,
  msgSecCheck,
};