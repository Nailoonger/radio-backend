'use strict';

/**
 * 阶段 9 · HTTP 访问服务适配层本地实测（harness）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-http-bridge.js
 *
 * 覆盖：`httpBridge.normalizeHttpEvent` 的两种形态 + **穿透 index.js 真跑路由**，
 *        以及最重要的一条：**不能影响小程序 callFunction / 定时触发这两条既有通道**。
 *
 * ⚠️ 最后那组不是"顺手加的"：适配层加在 `index.js` 解构 event **之前**，
 *    一处判据写宽就会把小程序请求误判成 HTTP 事件（小程序 event 里没有 httpMethod，
 *    但如果哪天加了同名字段，或者判据写成「只要有 path 就算」—— 后者**必然**误判）。
 *    ⇒ 断言里放一个**形状近似但缺 httpMethod**的事件，钉死「只有 httpMethod/requestContext 才算」。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const { normalizeHttpEvent, isHttpEvent } = require(path.join(API_DIR, 'httpBridge'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

const T1 = '2026-01-01T00:00:00.000Z';
const HASH = bcrypt.hashSync('password123', 4);
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });

/** 最小的集成请求骨架 */
function httpEvent(over) {
  return Object.assign({
    path: '/api',
    httpMethod: 'POST',
    headers: {},
    queryStringParameters: {},
    body: '',
    isBase64Encoded: false,
  }, over || {});
}

(async () => {
  /* ══════════ A. 识别：什么算 HTTP 事件 ══════════ */
  section('A. 识别（判据宽一点就会误伤小程序通道）');
  eq('A01 小程序 callFunction 的事件 → 不是', isHttpEvent({ method: 'GET', path: '/user/switch/list', body: {}, token: '' }), false);
  eq('A02 ⭐ 有 path/body 但**没有 httpMethod** → 仍然不是（否则小程序请求会被误判）',
    isHttpEvent({ path: '/user/switch/list', body: {} }), false);
  eq('A03 定时触发事件 → 不是', isHttpEvent({ Type: 'Timer', TriggerName: 'songSweepTick' }), false);
  eq('A04 有 httpMethod → 是', isHttpEvent(httpEvent()), true);
  eq('A05 有 requestContext 也算（有些配置不放 httpMethod）',
    isHttpEvent({ requestContext: {}, path: '/api' }), true);
  eq('A06 normalize 对非 HTTP 事件返回 null',
    normalizeHttpEvent({ method: 'GET', path: '/x', body: {}, token: 't' }), null);

  /* ══════════ B. 信封模式（admin-web 走这个） ══════════ */
  section('B. 信封模式');
  const env1 = httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/admin/switch/list', body: {}, token: 'TOK' }),
  });
  const n1 = normalizeHttpEvent(env1);
  eq('B01 还原出 method/path/token', [n1.method, n1.path, n1.token], ['GET', '/admin/switch/list', 'TOK']);
  eq('B02 via 标为 envelope', n1.via, 'envelope');

  const n2 = normalizeHttpEvent(httpEvent({
    body: JSON.stringify({ method: 'POST', path: '/admin/submit/1/review', body: { action: 'approve' }, token: 'TOK' }),
  }));
  eq('B03 POST 的 body 原样保留', n2.body, { action: 'approve' });

  const n3 = normalizeHttpEvent(httpEvent({
    headers: { authorization: 'Bearer HDR' },
    body: JSON.stringify({ method: 'GET', path: '/x', body: {} }),
  }));
  eq('B04 ⭐ token 优先取 Authorization 头', n3.token, 'HDR');
  const n3b = normalizeHttpEvent(httpEvent({
    headers: { Authorization: 'bearer HDR2' },
    body: JSON.stringify({ method: 'GET', path: '/x', body: {}, token: 'BODY' }),
  }));
  eq('B05 header 大小写与 Bearer 前缀都不敏感', n3b.token, 'HDR2');
  const n3c = normalizeHttpEvent(httpEvent({
    headers: { authorization: 'Bearer HDR' },
    body: JSON.stringify({ method: 'GET', path: '/x', body: {}, token: 'BODY' }),
  }));
  eq('B06 两者都有时以 header 为准（避免信封里的旧 token 覆盖新登录）', n3c.token, 'HDR');

  const n4 = normalizeHttpEvent(httpEvent({
    body: Buffer.from(JSON.stringify({ method: 'GET', path: '/y', body: {} })).toString('base64'),
    isBase64Encoded: true,
  }));
  eq('B07 ⭐ base64 编码的请求体能解出来', n4.path, '/y');
  const n4b = normalizeHttpEvent(httpEvent({
    body: Buffer.from(JSON.stringify({ method: 'GET', path: '/y2', body: {} })).toString('base64'),
    isBase64Encoded: 'true',
  }));
  eq('B08 isBase64Encoded 是字符串 "true" 也认', n4b.path, '/y2');

  const n5 = normalizeHttpEvent(httpEvent({ body: '<html>不是 json</html>' }));
  eq('B09 坏 JSON 不抛错 → 走 RESTful 兜底', n5.via, 'rest');
  const n6 = normalizeHttpEvent(httpEvent({ body: '' }));
  eq('B10 空 body 也走 RESTful 兜底', [n6.via, n6.path], ['rest', '/api']);

  /* ══════════ C. RESTful 兜底（需控制台开路径透传） ══════════ */
  section('C. RESTful 兜底');
  const r1 = normalizeHttpEvent(httpEvent({
    httpMethod: 'GET', path: '/admin/submit/list', queryStringParameters: { page: '2', status: '1' },
  }));
  eq('C01 GET：query 取自 queryStringParameters', [r1.method, r1.path, r1.query], ['GET', '/admin/submit/list', { page: '2', status: '1' }]);
  eq('C02 GET：body 为空', r1.body, {});
  const r2 = normalizeHttpEvent(httpEvent({
    httpMethod: 'POST', path: '/admin/submit/1/review', body: JSON.stringify({ action: 'reject', reason: 'x' }),
  }));
  eq('C03 POST：请求体即 body', [r2.method, r2.body], ['POST', { action: 'reject', reason: 'x' }]);

  /* ══════════ D. 穿透 index.js：真跑路由 ══════════ */
  section('D. 穿透 index.js —— 适配后必须真的能命中路由');
  H.reset({
    admin: [{ _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, lastLoginAt: null, createTime: new Date(T1), updateTime: new Date(T1) }],
    system_switch: [{ _id: 'switch:home_song_schedule', id: 1, key: 'home_song_schedule', value: 'off', desc: '', createTime: new Date(T1), updatedAt: new Date(T1) }],
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '3', desc: '', updateTime: new Date(T1) }],
    unique_keys: [{ _id: 'admin:root', scope: 'admin', key: 'root', owner_id: 1, create_time: new Date(T1) }],
    notice: [1, 2, 3].map((i) => ({
      _id: `n${i}`, id: i, title: `公告${i}`, content: '', isTop: 0, isShow: 1,
      publisherId: 1, publishTime: new Date(T1), createTime: new Date(T1), updateTime: new Date(T1),
    })),
  });

  // ① 信封：登录（这条最能证明「鉴权没被通道绕过去」）
  const lg = await H.call(httpEvent({
    body: JSON.stringify({ method: 'POST', path: '/admin/login', body: { username: 'root', password: 'password123' } }),
  }));
  eq('D01 ★ HTTP 信封模式能登录（拿得到 token）', lg.code, 0);
  ok('D02 返回的 admin.id 正确', lg.data && lg.data.admin && lg.data.admin.id === 1);

  // ② 信封：带 token 读超管接口
  const st = await H.call(httpEvent({
    headers: { authorization: `Bearer ${SUPER_TOKEN}` },
    body: JSON.stringify({ method: 'GET', path: '/admin/setting/song_slot_capacity', body: {} }),
  }));
  eq('D03 ★ Authorization 头里的 JWT 能过鉴权', [st.code, st.data && st.data.value], [0, '3']);

  // ③ 信封：不带 token → 40101（证明通道没有绕过鉴权）
  const noTok = await H.call(httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/admin/setting/song_slot_capacity', body: {} }),
  }));
  eq('D04 ★ 没有 token 照样 40101（HTTP 通道不是后门）', noTok.code, 40101);

  // ④ 信封：接口不存在
  const nf = await H.call(httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/not/exist', body: {} }),
  }));
  eq('D05 不存在的路由 → 404 业务码', nf.code, 40401);

  // ⑤ RESTful 兜底（路径透传开启时的形态）
  const sw = await H.call(httpEvent({
    httpMethod: 'GET', path: '/user/switch/home_song_schedule', queryStringParameters: {}, body: '',
  }));
  eq('D06 ★ RESTful 模式也能命中（via=rest）', [sw.code, sw.data && sw.data.value], [0, 'off']);

  // ⑥ OPTIONS 预检
  const opt = await H.call(httpEvent({ httpMethod: 'OPTIONS', path: '/api', body: '' }));
  eq('D07 OPTIONS 预检放行（不落到「接口不存在」）', opt.code, 0);

  // ⑦ ⭐ GET 参数：信封里的 `query` 必须真的进 ctx.query
  //    这是信封模式最容易被忽略的一环 —— 若忘了传 query，分页/筛选会**静默退回默认值**，
  //    页面表现为「一直是第一页」，不报错。
  const p1 = await H.call(httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/user/notice/list', body: {}, query: { page: 1, pageSize: 2 } }),
  }));
  eq('D08 ★ 信封里的 query 进了 ctx.query（第 1 页 2 条）',
    [p1.code, p1.data.list.length, p1.data.pageSize], [0, 2, 2]);
  const p2 = await H.call(httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/user/notice/list', body: {}, query: { page: 2, pageSize: 2 } }),
  }));
  eq('D09 ★ 第 2 页只剩 1 条（证明分页参数真的生效，不是恒第一页）', [p2.code, p2.data.list.length], [0, 1]);
  const p0 = await H.call(httpEvent({
    body: JSON.stringify({ method: 'GET', path: '/user/notice/list', body: {} }),
  }));
  eq('D10 不给 query 时退回默认 pageSize=10', p0.data.pageSize, 10);

  /* ══════════ E. 反向保护：不能影响既有两条通道 ══════════ */
  section('E. ⭐ 反向保护：小程序 callFunction 与定时触发必须照旧');
  const mini = await H.call({ method: 'GET', path: '/user/switch/home_song_schedule', body: {}, token: '' });
  eq('E01 小程序形状的事件照旧能查', [mini.code, mini.data && mini.data.value], [0, 'off']);

  H.reset({
    admin: [{ _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, lastLoginAt: null, createTime: new Date(T1), updateTime: new Date(T1) }],
  });
  const timer = await H.call({ Type: 'Timer', TriggerName: 'songSweepTick', TriggerTime: new Date().toISOString() });
  eq('E02 定时事件仍走 cron 分支（data.cron = true）', [timer.code, timer.data && timer.data.cron], [0, true]);
  ok('E03 定时事件没被误判成 HTTP（via 不会出现在返回值里）', JSON.stringify(timer).indexOf('envelope') < 0);

  lines.push('');
  lines.push(`结论：断言 ${lines.filter((l) => l.startsWith('OK  ') || l.startsWith('FAIL')).length} 项 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(lines.join('\n'));
  console.log(`\n异常：${(e && e.stack) || e}`);
  process.exit(1);
});
