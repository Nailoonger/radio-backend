'use strict';

/**
 * 云通道整链路验证（走小程序自动化，无需人工点编译/看弹窗）
 *
 * 前置：
 *   1) 启动自动化服务（后台常驻）：
 *        cd /d/dev/wx-devtools && ./cli.bat auto --project "C:\Users\Administrator\radio-backend\miniprogram" --trust-project
 *      它会打印 ws 端点（默认 ws://127.0.0.1:9420）
 *   2) 运行本脚本：
 *        NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
 *          node cloud/scripts/verify-cloud.js ws://127.0.0.1:9420
 *
 * 原理：automator 连上 IDE 的 appservice，用 evaluate() 直接在模拟器里执行
 *       wx.cloud.callFunction，把**真实返回**拿回 Node 侧打印。
 *       比「人点编译 + 看 wx.showModal」可靠得多，且可重复跑。
 */

const WS = process.argv[2] || 'ws://127.0.0.1:9420';

async function main() {
  let automator;
  try {
    automator = require('miniprogram-automator');
  } catch (e) {
    console.error('[verify] 缺少 miniprogram-automator，请先：');
    console.error('  cd C:/Users/Administrator/.workbuddy/binaries/node/workspace && npm install miniprogram-automator');
    process.exit(1);
  }

  console.log('[verify] 连接', WS);
  const mp = await automator.connect({ wsEndpoint: WS });
  console.log('[verify] 已连接，开始执行 evaluate …');

  const out = await mp.evaluate(() => {
    const callFn = (method, path) =>
      wx.cloud
        .callFunction({ name: 'api', data: { method, path } })
        .then((r) => r.result)
        .catch((e) => ({ code: -1, message: String((e && e.errMsg) || e) }));

    const slim = (r) => {
      const d = (r && r.data) || {};
      return {
        code: r && r.code,
        message: r && r.message,
        total: d.total,
        supported: d.supported,
        summary: d.summary || null,
        dbReady: d.dbReady,
        dbError: d.dbError,
        loadError: d.loadError,
        listCount: (d.list || []).length,
        list: d.list || null,
      };
    };

    return callFn('GET', '/health').then((h) =>
      callFn('POST', '/system/init-collections').then((i) =>
        callFn('GET', '/user/switch/list').then((s) => ({
          health: slim(h),
          init: slim(i),
          switch: slim(s),
        }))
      )
    );
  });

  console.log('[verify] 结果：');
  console.log(JSON.stringify(out, null, 2));

  const okAll =
    out && out.health && out.health.code === 0 &&
    out.init && out.init.code === 0 &&
    out.switch && out.switch.code === 0;

  console.log(okAll ? '\n✅ 全部通过' : '\n❌ 存在失败项，见上方 code/message');

  try { if (mp.disconnect) await mp.disconnect(); } catch (e) { /* ignore */ }
  process.exit(okAll ? 0 : 2);
}

main().catch((e) => {
  console.error('[verify] 失败：', (e && e.message) || e);
  process.exit(1);
});
