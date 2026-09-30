'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

/**
 * ⚠️⚠️ 公开的 JWT 密钥 = 等于没有鉴权（2026-09-30 实测踩到）
 *
 * 下面这几串**都写在公开仓库里**：代码兜底值 / docker-compose 兜底值 / .env.example 示例值。
 * 用它们签出来的 token 任何人都能自己造 —— 而 adminAuth 只验签名、不查库，
 * 所以伪造一个 { id:1, username:'teacher', role:0 } 就能直接进后台，**完全绕过密码**。
 *
 * 实测（当时线上就是这么跑的）：拿 .env.example 那串自签 token 打 /api/admin/profile，
 * 直接返回 code:0 + 真实管理员资料。
 */
const PUBLIC_JWT_SECRETS = [
  'radio-station-default-secret',
  'please-change-me-in-production',
  'please-change-me-to-a-long-random-string',
];

const jwtSecret = process.env.JWT_SECRET || 'radio-station-default-secret';
const nodeEnv = process.env.NODE_ENV || 'development';

if (PUBLIC_JWT_SECRETS.includes(jwtSecret)) {
  if (nodeEnv === 'production') {
    throw new Error(
      '[config] 拒绝启动：JWT_SECRET 未配置，或仍是公开的默认值。\n' +
        '  公开的签名密钥 = 任何人都能伪造管理员 token（绕过密码直接进后台）。\n' +
        '  修法：在部署目录的 .env 里写一个真实随机值，例如 `openssl rand -hex 32`，然后：\n' +
        '      docker compose up -d --force-recreate radio-backend\n' +
        '  （学生端云函数 lib/auth.js 用的是另一个 JWT_SECRET；两边都失效后重登一次即可。）'
    );
  }
  // 本机开发放行，但必须吵一声
  console.warn(
    '\n[config] ⚠️⚠️ JWT_SECRET 是公开的默认值，任何人都能伪造管理员 token。\n' +
      '         本机开发无所谓；NODE_ENV=production 会直接拒绝启动。\n'
  );
}

module.exports = {
  env: nodeEnv,
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',

  jwt: {
    secret: jwtSecret,
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
    // ⚠️ 这里不设默认值（2026-09-30）：留空则由 src/utils/seed.js 随机生成，
    //    且只在首次启动日志里打印一次。原来回落到一个公开的固定密码，
    //    等于把管理员凭据写死在仓库里 —— 谁 clone 一下就知道后台怎么进。
    password: process.env.INIT_ADMIN_PASSWORD || '',
    nickname: process.env.INIT_ADMIN_NICKNAME || '指导老师',
  },

  rateLimit: {
    windowMs: 60 * 1000,
    submitMax: 10,    // 1分钟内最多10次投稿
    messageMax: 5,    // 1分钟内最多5条留言
    loginMax: 10,     // 1分钟内最多10次登录
  },
};