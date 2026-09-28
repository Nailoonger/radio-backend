'use strict';

/**
 * 系统类 handler（无业务依赖）
 * 目前只有健康检查：部署云函数后，用它验证「小程序 → 云函数」通道是否打通。
 */

const { version: jwtVersion } = (() => {
  try { return require('jsonwebtoken/package.json'); } catch (e) { return {}; }
})();

async function health(ctx) {
  return {
    ok: true,
    scope: 'cloud-function',
    now: new Date().toISOString(),
    // 便于排查：确认云函数能正常拿到调用者身份
    hasOpenid: !!ctx.openid,
    hasToken: !!ctx.token,
    jwtReady: !!jwtVersion,
  };
}

module.exports = { health };
