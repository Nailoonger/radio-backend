'use strict';

/**
 * 用户端接口云端实测（阶段 4 验收用）
 *
 * 前置：
 *   1) 启动自动化服务（后台常驻）：
 *        cd /d/dev/wx-devtools && ./cli.bat auto --project "C:\Users\Administrator\radio-backend\miniprogram" --trust-project
 *   2) 部署完成并**等 1~2 分钟**（云端 npm install 未完成时会报 Cannot find module）
 *   3) 运行：
 *        MSYS_NO_PATHCONV=1 \
 *        NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \
 *          node cloud/scripts/verify-user.js ws://127.0.0.1:9420
 *
 * ⚠️⚠️ 为什么**逐条**调用、不能一次 evaluate 里串 19 个：
 *    automator 的单次 evaluate 有 ~30s 上限，而云函数**默认超时仅 3 秒**，
 *    冷启动叠加起来必然超时 → 表现成 `timeout waiting for automator response`，
 *    看起来像「脚本坏了」，其实是「一次问太多」。
 *    逐条 + 瞬时失败重试（-1 视为冷启动/超时）最稳。
 *
 * ⚠️ 期望值基于「**空库**」状态（集合已建、无业务数据）：
 *    空库下 详情类 应为 40401、需登录的应为 40101。
 *    若库里已有数据，个别期望不成立 —— 那是数据问题，不是代码问题。
 */

const WS = process.argv[2] || 'ws://127.0.0.1:9420';
const RETRY = 3; // 瞬时失败（冷启动 -504003 / evaluate 超时）重试次数

/** [method, path, body, 期望 code, 说明] */
const CASES = [
  ['GET', '/health', null, 0, '云函数与库就绪'],
  ['GET', '/user/notice/list', null, 0, '分页列表'],
  ['GET', '/user/notice/1', null, 40401, '空库：公告不存在'],
  ['GET', '/user/cadre/1', null, 40401, '空库'],
  ['GET', '/user/staff/1', null, 40401, '空库'],
  ['GET', '/user/cadre/abc', null, 40401, '非法 id 不抛异常'],
  ['GET', '/user/showcase', null, 0, '部门分组'],
  ['GET', '/user/program/current', null, 0, '空库：data=null 但 code=0'],
  ['GET', '/user/program/weekly', null, 0, '本周节目单'],
  ['GET', '/user/program/schedule', null, 0, '范围查询（_.gte().and(_.lte())）'],
  ['GET', '/user/program/1', null, 40401, '空库'],
  ['GET', '/user/station/intro', null, 40401, '未配置'],
  ['GET', '/user/switch/list', null, 0, '开关列表'],
  ['GET', '/user/profile', null, 40101, '未带 token'],
  ['GET', '/user/message/my', null, 40101, '未带 token'],
  ['GET', '/user/me', null, 40101, '未带 token'],
  ['POST', '/user/message', { content: 'hi' }, 40101, '未带 token'],
  ['POST', '/user/login/account', { username: '20999999', password: 'x1234567' }, 40101, '账号不存在 → 统一文案'],
  ['PUT', '/user/change-password', { oldPassword: 'a', newPassword: 'abc12345' }, 40101, '未带 token'],

  // ── 阶段 4 收尾：投稿 / 点歌（11 个接口）────────────────────────────
  // ⚠️ 期望码取决于源路由有没有挂 userAuth，**不是**「controller 里有没有读 req.user」：
  //    本组只有 `/user/submit/week` 没挂（首页要能未登录看），其余全部 40101。
  //    所以未带 token 时：week → 0，其它 → 40101。这组用例同时钉住「字面量段路由优先」——
  //    若 /submit/my 被 /submit/:id 吞掉，它会变成「带鉴权的详情」，这里就会露出马脚。
  ['GET', '/user/submit/week', null, 0, '全组唯一免登录：首页本周排期（空库 → days 长度 5）'],
  ['GET', '/user/submit/notice', null, 40101, '未带 token（源路由挂了 userAuth）'],
  ['POST', '/user/submit/notice/ack', { version: 1 }, 40101, '未带 token'],
  ['GET', '/user/submit/window', null, 40101, '未带 token'],
  ['GET', '/user/submit/timeslots', null, 40101, '未带 token'],
  ['GET', '/user/submit/my', null, 40101, '未带 token'],
  ['GET', '/user/submit/my?page=1&pageSize=5', null, 40101, '带 query 仍走 myList（不被 :id 吞）'],
  ['GET', '/user/submit/quota', null, 40101, '未带 token'],
  ['GET', '/user/submit/1', null, 40101, '未带 token'],
  ['POST', '/user/submit', { type: 1, songName: 'x', singer: 'y', wantBroadcastTime: 'z' }, 40101, '未带 token'],
  ['DELETE', '/user/submit/1', null, 40101, '未带 token'],
  ['POST', '/user/submit/1/leave-queue', null, 40101, '未带 token'],
];

async function main() {
  let automator;
  try {
    automator = require('miniprogram-automator');
  } catch (e) {
    console.error('[verify] 缺少 miniprogram-automator，请先装到隔离目录');
    process.exit(1);
  }

  console.log('[verify] 连接', WS);
  const mp = await automator.connect({ wsEndpoint: WS });
  console.log('[verify] 已连接，逐条调用（共 ' + CASES.length + ' 条）…\n');

  /** 单次调用：evaluate 里只发一个云函数请求 */
  async function callOnce(method, path, body) {
    return mp.evaluate(
      async (m, p, b) => {
        try {
          const r = await wx.cloud.callFunction({
            name: 'api',
            data: { method: m, path: p, body: b || {}, token: '' },
          });
          const res = (r && r.result) || {};
          const d = res.data;
          return {
            code: res.code === undefined ? -1 : res.code,
            message: res.message || '',
            summary:
              d === null || d === undefined
                ? 'null'
                : Array.isArray(d.list)
                  ? 'list=' + d.list.length
                  : typeof d === 'object'
                    ? Object.keys(d).slice(0, 6).join(',')
                    : String(d).slice(0, 60),
          };
        } catch (e) {
          return { code: -1, message: String((e && e.errMsg) || e), summary: '-' };
        }
      },
      method,
      path,
      body || {}
    );
  }

  const rows = [];
  let failed = 0;

  for (const [method, path, body, want, note] of CASES) {
    let r = null;
    let tries = 0;
    for (; tries < RETRY; tries++) {
      try {
        r = await callOnce(method, path, body);
      } catch (e) {
        r = { code: -1, message: 'evaluate 超时/异常: ' + ((e && e.message) || e), summary: '-' };
      }
      if (r.code !== -1) break; // -1 = 冷启动/超时，重试
    }
    const ok = r.code === want;
    if (!ok) failed++;
    rows.push(
      `${ok ? 'OK  ' : 'FAIL'} ${(method + ' ' + path).padEnd(30)} code=${String(r.code).padEnd(6)} want=${String(want).padEnd(6)} ${r.summary}${tries > 0 ? `  (重试${tries}次)` : ''}${ok ? '' : '  ← ' + r.message}  ${note}`
    );
    process.stdout.write(`\r[${rows.length}/${CASES.length}]`);
  }

  console.log('\n');
  rows.forEach((l) => console.log(l));
  console.log('');
  console.log(failed === 0 ? `✅ 全部通过（${CASES.length} 条）` : `❌ ${failed} 条不符（共 ${CASES.length} 条）`);

  try { if (mp.disconnect) await mp.disconnect(); } catch (e) { /* ignore */ }
  process.exit(failed === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('[verify] 失败：', (e && e.message) || e);
  process.exit(1);
});
