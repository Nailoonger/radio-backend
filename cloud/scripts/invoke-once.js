'use strict';

/**
 * 通用云函数调用器（走小程序自动化，免人工点编译）
 *
 * 用法：
 *   NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
 *   node cloud/scripts/invoke-once.js <wsEndpoint> <fnName> <METHOD> <path> [bodyJson] [token]
 *
 * 例：
 *   node cloud/scripts/invoke-once.js ws://127.0.0.1:9420 api GET /health
 *   node cloud/scripts/invoke-once.js ws://127.0.0.1:9420 api POST /user/login/account '{"username":"20240101","password":"user20240101"}'
 *
 * 前置：自动化服务已启动
 *   cd /d/dev/wx-devtools && ./cli.bat auto --project "C:\Users\Administrator\radio-backend\miniprogram" --trust-project
 */

const automator = require('miniprogram-automator');

const wsEndpoint = process.argv[2] || 'ws://127.0.0.1:9420';
const fnName = process.argv[3] || 'api';
const method = process.argv[4] || 'GET';
const apiPath = process.argv[5] || '/health';
const bodyRaw = process.argv[6] || '{}';
const token = process.argv[7] || '';

(async () => {
  let body = {};
  try {
    body = JSON.parse(bodyRaw);
  } catch (e) {
    console.error('[invoke] body 不是合法 JSON:', bodyRaw);
    process.exit(1);
  }

  const mp = await automator.connect({ wsEndpoint });

  const out = await mp.evaluate(
    (fn, m, p, b, t) =>
      wx.cloud
        .callFunction({ name: fn, data: { method: m, path: p, body: b, token: t } })
        .then((r) => ({ ok: true, result: r.result }))
        .catch((e) => ({ ok: false, err: String((e && e.errMsg) || e) })),
    fnName,
    method,
    apiPath,
    body,
    token
  );

  console.log(JSON.stringify(out, null, 2));

  try { if (mp.disconnect) await mp.disconnect(); } catch (e) { /* ignore */ }

  const good = out && out.ok && out.result && out.result.code === 0;
  process.exit(good ? 0 : 2);
})().catch((e) => {
  console.error('[invoke] 失败：', (e && e.message) || e);
  process.exit(1);
});
