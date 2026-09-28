'use strict';

/**
 * 云函数配置 —— 对齐 src/config/index.js 的 wechat 段
 *
 * 云函数读不到项目里的 .env（那文件在服务器上），只能读**云函数环境变量**：
 *   云开发控制台 → 云函数 → api → 配置 → 环境变量
 *
 * ⚠️ WECHAT_SECRET（小程序 AppSecret）**绝不写进代码、绝不进 git**，只放环境变量。
 *    未注入时按「不启用」降级（access_token 拿不到 → 内容安全检测跳过），
 *    与源码里 `if (!appId || !secret) return null;` 的行为一致 —— 不阻塞业务。
 *
 * ⚠️ appId 不是机密（它明文写在 miniprogram/project.config.json 里），可以作为兜底。
 */

const APPID_FALLBACK = 'wxa88836729f07a976'; // = miniprogram/project.config.json 的 appid

const wechat = {
  appId: process.env.WECHAT_APPID || APPID_FALLBACK,
  secret: process.env.WECHAT_SECRET || '',
  code2sessionUrl:
    process.env.WECHAT_CODE2SESSION_URL || 'https://api.weixin.qq.com/sns/jscode2session',
  subscribeTemplateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || '',
  /** 与原配置同款开关：只有显式设为 '1' 才真的走微信内容安全接口 */
  enableSecurityCheck: process.env.WECHAT_SECURITY_CHECK === '1',
  msgCheckUrl:
    process.env.WECHAT_MSG_CHECK_URL || 'https://api.weixin.qq.com/wxa/msg_sec_check',
};

/** 是否配齐了调用微信服务端接口所需的最小信息 */
function wechatReady() {
  return !!(wechat.appId && wechat.secret);
}

module.exports = { wechat, wechatReady, APPID_FALLBACK };
