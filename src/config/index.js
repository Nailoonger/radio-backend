'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',

  jwt: {
    secret: process.env.JWT_SECRET || 'radio-station-default-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  wechat: {
    appId: process.env.WECHAT_APPID || '',
    secret: process.env.WECHAT_SECRET || '',
    code2sessionUrl:
      process.env.WECHAT_CODE2SESSION_URL ||
      'https://api.weixin.qq.com/sns/jscode2session',
    subscribeTemplateId: process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || '',
    enableSecurityCheck: process.env.WECHAT_SECURITY_CHECK === '1',
    msgCheckUrl:
      process.env.WECHAT_MSG_CHECK_URL ||
      'https://api.weixin.qq.com/wxa/msg_sec_check',
  },

  initAdmin: {
    username: process.env.INIT_ADMIN_USERNAME || 'teacher',
    password: process.env.INIT_ADMIN_PASSWORD || 'admin123456',
    nickname: process.env.INIT_ADMIN_NICKNAME || '指导老师',
  },

  rateLimit: {
    windowMs: 60 * 1000,
    submitMax: 10,    // 1分钟内最多10次投稿
    messageMax: 5,    // 1分钟内最多5条留言
    loginMax: 10,     // 1分钟内最多10次登录
  },
};