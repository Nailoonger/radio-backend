'use strict';

/**
 * 网关本地实测 —— 用内存假数据库把云函数真跑一遍
 *
 * 跑法（仓库根目录）：node cloud/scripts/test-gateway.js
 * 断言全部真实执行、真实返回值，不依赖云环境、不联网。
 */

const path = require('path');
const H = require('./harness');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');

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

(async () => {
  // ============ 种子数据 ============
  H.reset({
    system_switch: [
      { _id: 'switch:submit_song', key: 'submit_song', value: 'on', desc: '点歌' },
      { _id: 'switch:submit_article', key: 'submit_article', value: 'on', desc: '文稿' },
      { _id: 'switch:message', key: 'message', value: 'off', desc: '留言' },
      { _id: 'switch:member', key: 'member', value: 'on', desc: '风采' },
    ],
    system_setting: [
      { _id: 'setting:station_intro', key: 'station_intro', value: '菁菁校园情，悠悠广播声' },
    ],
  });

  // ============ 1. 健康检查 ============
  let r = await H.call(H.req('GET', '/health'));
  eq('GET /health → code', r.code, 0);
  ok('GET /health → ok:true', r.data && r.data.ok === true, JSON.stringify(r.data));

  // ============ 2. 模块开关（小程序启动首个请求） ============
  r = await H.call(H.req('GET', '/user/switch/list'));
  eq('GET /user/switch/list → code', r.code, 0);
  eq('GET /user/switch/list → 内容', r.data && r.data.list, [
    { key: 'member', value: 'on' },
    { key: 'message', value: 'off' },
    { key: 'submit_article', value: 'on' },
    { key: 'submit_song', value: 'on' },
  ]);

  r = await H.call(H.req('GET', '/user/switch/message'));
  eq('GET /user/switch/message → off', r.data, { key: 'message', value: 'off' });

  r = await H.call(H.req('GET', '/user/switch/home_song_schedule'));
  eq('缺行开关 → 视为 on', r.data, { key: 'home_song_schedule', value: 'on' });

  // ============ 3. KV 站点信息 ============
  r = await H.call(H.req('GET', '/user/station/intro'));
  eq('GET /user/station/intro → 命中', r.data, { key: 'station_intro', value: '菁菁校园情，悠悠广播声' });

  r = await H.call(H.req('GET', '/user/station/contact'));
  eq('未配置 KV → 40401', r.code, 40401);
  eq('未配置 KV → 文案', r.message, '未配置');

  // ============ 4. 未登记模块优雅降级（不能把网关打崩） ============
  //
  // ⚠️ 阶段 7 落地后 93 条管理端路由**全部登记完毕**，原先拿 `/admin/submit/list`
  //    当「未移植样本」的写法已经失效（那条现在会正常走 40101 未登录）。
  //    降级路径本身仍必须一直在测 —— 改成**直接调用解析器**，用一个永不会登记的 key
  //    来钉住 `todoHandler` 的行为，不再依赖「恰好还有个模块没移植」这种临时状态。
  const { resolveHandler } = require(path.join(API_DIR, 'handlers'));
  const todo = resolveHandler('admin.noSuchModule.noSuchMethod');
  let todoErr = null;
  try { await todo({ method: 'GET', path: '/x', params: {}, query: {}, body: {} }); } catch (e) { todoErr = e; }
  ok('未登记 handler → 抛 ApiError', !!todoErr && todoErr.code === 50001, todoErr && String(todoErr.message));
  ok('未登记 handler → 提示含「未就绪」', !!todoErr && /未就绪/.test(todoErr.message), todoErr && todoErr.message);
  // 文案从「接口迁移中」改成「接口未就绪 · 原因：xxx」是**有意**的：
  // 原来只给一句笼统提示，「模块名写错 / 依赖缺失 / 模块不存在」长得一模一样，无法定位。
  // 现在必须带出真实原因（见 handlers/index.js 的 todoHandler）。
  ok('未登记 handler → 带出真实原因', !!todoErr && /模块未登记/.test(todoErr.message), todoErr && todoErr.message);

  // 已登记模块的**方法名写错**是另一条分支（模块在、导出不在）→ 原因不同，也要能分辨
  const badMethod = resolveHandler('admin.submit.nopeMethod');
  let bmErr = null;
  try { await badMethod({ method: 'GET', path: '/x', params: {}, query: {}, body: {} }); } catch (e) { bmErr = e; }
  ok('已登记模块 + 错方法名 → 提示「未导出」', !!bmErr && /未导出/.test(bmErr.message), bmErr && bmErr.message);

  // ============ 5. 路由兜底 ============
  r = await H.call(H.req('GET', '/user/nope/x/y'));
  eq('未知路径 → 40401', r.code, 40401);
  r = await H.call(H.req('POST', '/user/switch/list'));
  eq('方法不匹配 → 40401', r.code, 40401);

  // ============ 6. db 层并发原语（唯一键 / 自增 / 条件更新） ============
  const db = require(path.join(API_DIR, 'lib', 'db'));

  ok('reserveUnique 首次成功', (await db.reserveUnique('user_name', '20240101', 1)) === true);
  ok('reserveUnique 重复 → false（等价 UNIQUE 冲突）', (await db.reserveUnique('user_name', '20240101', 2)) === false);
  eq('getUniqueOwner 取回归属', await db.getUniqueOwner('user_name', '20240101'), 1);
  ok('releaseUnique 后可重新占用', (await db.releaseUnique('user_name', '20240101')) === true
    && (await db.reserveUnique('user_name', '20240101', 3)) === true);

  const id1 = await db.nextId('submit');
  const id2 = await db.nextId('submit');
  const id3 = await db.nextId('submit');
  eq('nextId 连续自增', [id1, id2, id3], [1, 2, 3]);
  const otherSeq = await db.nextId('notice');
  eq('nextId 按 scope 独立', otherSeq, 1);

  await H.call(H.req('GET', '/health'));   // 确保 db 模块已加载
  await db.insertOne('submit', { id: 900, openid: '20240101', review_status: 0, schedule_status: 0, status: 0 });

  const hitDoc = await db.findOne('submit', { id: 900 });
  ok('insertOne/findOne 往返', !!hitDoc && hitDoc.openid === '20240101');

  let n = await db.updateWhere('submit', { _id: hitDoc._id, review_status: 0 }, { review_status: 1, status: 6 });
  eq('条件更新命中 → updated=1', n, 1);
  n = await db.updateWhere('submit', { _id: hitDoc._id, review_status: 0 }, { review_status: 1 });
  eq('条件不再满足 → updated=0（等价 affectedRows=0）', n, 0);

  const after = await db.findById('submit', hitDoc._id);
  eq('状态已写入', [after.review_status, after.status], [1, 6]);

  const removed = await db.removeWhere('submit', { id: 900 });
  eq('removeWhere 计数', removed, 1);

  // ============ 输出 ============
  lines.push('');
  lines.push(`结论：${lines.length} 行 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { require('fs').writeFileSync(path.join(ROOT, '_cloud_gateway_test.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
