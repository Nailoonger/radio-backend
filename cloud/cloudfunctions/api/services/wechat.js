'use strict';

/**
 * 微信服务端接口封装 —— 从 src/services/wechatService.js 移植
 *
 *  - code2Session : wx.login 的 code 换 openid / session_key / unionid（登录用）
 *  - msgSecCheck  : 文本内容安全检测（留言 / 投稿用）
 *
 * 语义完全保留（重要）：
 *  - **任何异常都返回 pass: true**（原实现如此）—— 微信接口抖动不应误伤用户内容，
 *    只有明确判定 suggest !== 'pass' 才拦截。不要「顺手改成失败即拦截」。
 *  - 未开启 WECHAT_SECURITY_CHECK 时直接放行，不发请求。
 */

const axios = require('axios');
const { wechat } = require('../config');

/**
 * code2Session
 * @param {string} code 小程序 wx.login 返回的 code
 */
async function code2Session(code) {
  if (!code) throw new Error('code不能为空');
  if (!wechat.appId || !wechat.secret) {
    throw new Error('未配置 WECHAT_APPID / WECHAT_SECRET');
  }

  const url =
    `${wechat.code2sessionUrl}?appid=${wechat.appId}&secret=${wechat.secret}` +
    `&js_code=${code}&grant_type=authorization_code`;

  const { data } = await axios.get(url, { timeout: 5000 });

  if (data && data.errcode) {
    console.error('[wechat] code2session error:', data);
    throw new Error(`微信接口错误: ${data.errmsg || data.errcode}`);
  }

  return {
    openid: data.openid,
    sessionKey: data.session_key,
    unionid: data.unionid,
  };
}

/**
 * 文本内容安全检测
 * @returns {Promise<{pass: boolean}>}  异常一律 pass=true（见文件头说明）
 */
async function msgSecCheck(content, accessToken) {
  if (!wechat.enableSecurityCheck) return { pass: true };
  if (!accessToken) {
    console.warn('[wechat] msgSecCheck: 缺少 access_token，跳过检测');
    return { pass: true };
  }
  try {
    const url = `${wechat.msgCheckUrl}?access_token=${accessToken}`;
    const { data } = await axios.post(
      url,
      { content, version: 2, scene: 2 },
      { timeout: 5000 }
    );
    if (data.errcode && data.errcode !== 0) {
      console.warn('[wechat] msgSecCheck errcode:', data);
      return { pass: true };
    }
    return { pass: !!(data.result && data.result.suggest === 'pass') };
  } catch (e) {
    console.warn('[wechat] msgSecCheck 调用失败，跳过:', e && e.message);
    return { pass: true };
  }
}

module.exports = { code2Session, msgSecCheck };
