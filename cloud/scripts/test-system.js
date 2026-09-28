'use strict';

/**
 * 系统接口本地实测（harness，无需云环境/网络）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-system.js
 *
 * 覆盖：/health、/system/init-collections（含幂等）、/user/switch/list
 */

const H = require('./harness');

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name} :: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}

(async () => {
  // ---------- 1. /health ----------
  H.reset();
  const h = await H.call(H.req('GET', '/health'));
  eq('health code', h.code, 0);
  eq('health ok', h.data.ok, true);
  eq('health dbReady', h.data.dbReady, true);
  eq('health dbError', h.data.dbError, null);
  eq('health jwtReady', h.data.jwtReady, true);

  // ---------- 2. /system/init-collections（首次：全新建）----------
  H.reset();
  const init1 = await H.call(H.req('POST', '/system/init-collections'));
  eq('init code', init1.code, 0);
  eq('init supported', init1.data.supported, true);
  eq('init loadError', init1.data.loadError, null);
  ok('init total > 0', init1.data.total > 0, `total=${init1.data.total}`);
  eq('init 首次全部 created', init1.data.summary.created, init1.data.total);
  eq('init 首次无失败', (init1.data.summary.error || 0), 0);

  // ---------- 3. 幂等：再跑一次应全部 exists ----------
  const init2 = await H.call(H.req('POST', '/system/init-collections'));
  eq('init 二次 code', init2.code, 0);
  eq('init 二次全部 exists', init2.data.summary.exists, init2.data.total);
  eq('init 二次无失败', (init2.data.summary.error || 0), 0);

  // ---------- 4. /user/switch/list（集合已建、空表）----------
  H.reset();
  await H.call(H.req('POST', '/system/init-collections'));
  const sw1 = await H.call(H.req('GET', '/user/switch/list'));
  eq('switch 空表 code', sw1.code, 0);
  ok('switch 空表返回数组', Array.isArray(sw1.data.list));
  eq('switch 空表长度', sw1.data.list.length, 0);

  // ---------- 5. 有 off 行时语义正确 ----------
  H.reset({ system_switch: [{ _id: 'switch:home_song_schedule', key: 'home_song_schedule', value: 'off' }] });
  await H.call(H.req('POST', '/system/init-collections'));
  const sw2 = await H.call(H.req('GET', '/user/switch/list'));
  eq('switch 命中 off 行', JSON.stringify(sw2.data.list), JSON.stringify([{ key: 'home_song_schedule', value: 'off' }]));

  // ---------- 6. 单键查询（含缺行默认 on）----------
  const one = await H.call(H.req('GET', '/user/switch/home_song_schedule'));
  eq('switch 单键命中', JSON.stringify(one.data), JSON.stringify({ key: 'home_song_schedule', value: 'off' }));
  const absent = await H.call(H.req('GET', '/user/switch/not_exist_key'));
  eq('switch 缺行默认 on', JSON.stringify(absent.data), JSON.stringify({ key: 'not_exist_key', value: 'on' }));

  lines.push('');
  lines.push(`结论：${lines.length} 行 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})();
