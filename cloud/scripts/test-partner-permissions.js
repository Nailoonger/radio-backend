'use strict';

// 伙伴端权限分发（超管开关 + 按人覆盖）—— 真路由 + 真 handler + 内存云库
//
// 用法（仓库根目录）：
//   node cloud/scripts/test-partner-permissions.js
//
// ═══════════ 这个套件守什么 ═══════════
// 权限只有两种错法，而且都不报错：
//   ① 该拦的没拦（前端藏了按钮，接口还开着）⇒ 越权，事后完全看不出来
//   ② 不该拦的拦了（全局一关，连超管自己都进不去）⇒ 一片「暂无权限」，得靠人喊
// 所以这里不测 UI，只钉三件事：
//   · 缺行 = 全开（升级当天谁都不受影响）
//   · 全局 / 按人两层谁盖谁（生效值算法）
//   · **哪些接口真的吃这个开关**（schedule 写接口 + 候选池 + 代录 + 审稿），
//     以及**哪些不吃**（请假 / 考勤 —— 关掉排班权限不该连打卡都进不去）

const assert = require('assert');
const path = require('path');
const H = require('./harness');
const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib/auth'));
const {
  currentWeekStart, availabilityWindow, assertWindowWritable,
} = require(path.join(API, 'handlers/partner/_kit'));

const WEEK = currentWeekStart(Date.now() + 7 * 24 * 3600 * 1000);

/** 1 超管 / 2 社干·甲 / 3 社干·乙 / 4 站员 */
const tokens = {};
[1, 2, 3, 4].forEach((id) => {
  tokens[id] = sign({ id, username: `p${id}`, role: id === 1 ? 0 : (id === 4 ? 2 : 1) });
});

let checks = 0;
const equal = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const yes = (name, cond) => { assert.ok(cond, name); checks++; };

function seed(permDocs) {
  const admin = [
    { id: 1, role: 0, nickname: '老师', department: '播音部', dutyRoles: ['播音'] },
    { id: 2, role: 1, nickname: '社干甲', department: '播音部', dutyRoles: ['播音'] },
    { id: 3, role: 1, nickname: '社干乙', department: '主持部', dutyRoles: ['主持'] },
    { id: 4, role: 2, nickname: '站员丙', department: '播音部', dutyRoles: ['播音'] },
  ].map((a) => ({ _id: `a${a.id}`, username: `p${a.id}`, status: 1, ...a }));
  const out = { admin };
  if (permDocs) out.partner_permissions = permDocs;
  return out;
}

const reset = (permDocs) => H.reset(seed(permDocs));
const call = (method, url, body, id = 1) => H.call(H.req(method, url, body || {}, tokens[id] || ''));

/** 权限接口的现成动作，省得每处都拼 URL */
const mine = (id) => call('GET', '/partner/permissions/mine', {}, id);
const setGlobal = (patch, id = 1) => call('PUT', '/partner/permissions', patch, id);
const setPerson = (pid, patch, id = 1) => call('PUT', `/partner/permissions/person/${pid}`, patch, id);

(async () => {
  /* ───────── ① 缺行 = 全开 ───────── */
  reset();
  let r = await mine(2);
  equal('缺行：社干排班默认开', r.data.schedule, true);
  equal('缺行：社干审核默认开', r.data.review, true);
  equal('缺行：不是超管', r.data.isSuper, false);

  r = await mine(1);
  equal('超管排班恒开', r.data.schedule, true);
  equal('超管审核恒开', r.data.review, true);

  r = await mine(4);
  equal('站员排班一律 false', r.data.schedule, false);
  equal('站员审核一律 false', r.data.review, false);

  /* ───────── ② 谁能读这张看板 ───────── */
  equal('社干不能看看板', (await call('GET', '/partner/permissions', {}, 2)).code, 40301);
  equal('站员不能看看板', (await call('GET', '/partner/permissions', {}, 4)).code, 40301);
  equal('超管能看看板', (await call('GET', '/partner/permissions', {}, 1)).code, 0);

  r = await call('GET', '/partner/permissions', {}, 1);
  equal('看板只列社干', r.data.people.map((p) => p.personId), [2, 3]);
  equal('看板计数', r.data.count, { managers: 2, scheduleOn: 2, reviewOn: 2, proxyOn: 2, overridden: 0 });
  equal('看板文案位齐全（三个开关）', r.data.meta.map((m) => m.key), ['schedule', 'review', 'proxy']);

  /* ───────── ③ 全局关掉 ⇒ 社干被拦，超管不受影响 ───────── */
  r = await setGlobal({ schedule: false });
  equal('全局关排班：响应', r.data.global.schedule, false);

  r = await mine(2);
  equal('全局关后社干排班 false', r.data.schedule, false);
  equal('全局关后排班拒绝文案', r.data.text.schedule, '暂无权限');

  r = await call('PUT', '/partner/schedule/generate', { weekStart: WEEK }, 2);
  equal('社干被拦：生成班表 40301', r.code, 40301);
  equal('社干被拦：弹窗标题就是「暂无权限」', r.message, '暂无权限');

  r = await call('GET', `/partner/schedule/candidates?week=${WEEK}&day=${WEEK}`, {}, 2);
  equal('社干被拦：候选池 40301', r.code, 40301);

  // 超管不受任何开关影响 —— 这是「自己关的开关不能锁住自己」
  r = await call('GET', `/partner/schedule?week=${WEEK}`, {}, 1);
  yes('超管仍能读班表', r.code === 0 && !!r.data);

  /* ───────── ④ 按人开回来（分发）───────── */
  r = await setPerson(3, { schedule: true });
  equal('按人开：生效值', r.data.eff.schedule, true);
  equal('按人开：标记为单独设置', r.data.overridden, true);

  equal('甲仍被拦（没单独开）', (await mine(2)).data.schedule, false);
  equal('乙被放行（单独开了）', (await mine(3)).data.schedule, true);

  // 被放行的人真的能进工作台（不是只有能力位好看）。
  // ⚠️ 这里断言「不是 40301」而不是「code===0」：本套件没种时段模板，候选池会因为
  //    「时段未发布」回 40001 —— 那是业务校验，不是权限。要验的只是**没有被权限拦住**。
  r = await call('GET', `/partner/schedule/candidates?week=${WEEK}`, {}, 3);
  yes('乙能拉候选池（不被 40301 拦）', r.code !== 40301);

  /* ───────── ⑤ 按人关掉（全局开着也拦得住个别）───────── */
  reset();
  r = await setPerson(2, { review: false });
  equal('按人关审核：生效值', r.data.eff.review, false);
  equal('甲审核被关', (await mine(2)).data.review, false);
  equal('乙审核照常', (await mine(3)).data.review, true);

  r = await call('GET', '/partner/draft/review', {}, 2);
  equal('甲审稿队列 40301', r.code, 40301);
  equal('甲审稿拒绝文案', r.message, '暂无审核权限');
  yes('乙审稿队列可读', (await call('GET', '/partner/draft/review', {}, 3)).code === 0);

  /* ───────── ⑥ 跟回全局（null）───────── */
  r = await setPerson(2, { review: null });
  equal('跟回全局：不再单独设置', r.data.overridden, false);
  equal('跟回全局：回到全局值', (await mine(2)).data.review, true);

  /* ───────── ⑦ 全部关闭（一键）───────── */
  reset();
  await setGlobal({ schedule: false });
  await setGlobal({ review: false });
  r = await call('GET', '/partner/permissions', {}, 1);
  equal('全部关闭：没人能用排班', r.data.count.scheduleOn, 0);
  equal('全部关闭：没人能用审核', r.data.count.reviewOn, 0);
  equal('全部关闭：甲排班', (await mine(2)).data.schedule, false);
  equal('全部关闭：乙审核', (await mine(3)).data.review, false);

  /* ───────── ⑧ 参数与身份校验 ───────── */
  reset();
  equal('全局传 null 被拒', (await setGlobal({ schedule: null })).code, 40001);
  equal('非法值被拒', (await setGlobal({ schedule: 'yes' })).code, 40001);
  equal('空 body 被拒', (await setGlobal({})).code, 40001);
  equal('给超管分配被拒', (await setPerson(1, { schedule: true })).code, 40001);
  equal('给站员分配被拒', (await setPerson(4, { schedule: true })).code, 40001);
  equal('不存在的人被拒', (await setPerson(999, { schedule: true })).code, 40401);
  equal('社干不能改全局', (await setGlobal({ schedule: false }, 2)).code, 40301);
  equal('社干不能改别人', (await setPerson(3, { schedule: false }, 2)).code, 40301);

  /* ───────── ⑨ 不该被牵连的接口 ───────── */
  // 关掉排班/审核权限 ≠ 关掉人。请假、考勤、自己的班表必须照常。
  reset();
  await setGlobal({ schedule: false });
  await setGlobal({ review: false });
  yes('关掉权限后社干仍能看请假队列', (await call('GET', '/partner/leave/pending', {}, 2)).code === 0);
  yes('关掉权限后社干仍能看考勤总览', (await call('GET', '/partner/attendance/overview', {}, 2)).code === 0);
  yes('关掉权限后社干仍能看自己的班', (await call('GET', '/partner/schedule/mine', {}, 2)).code === 0);

  /* ───────── ⑩ 代录吃「代录权限」，**不吃**排班权限 ───────── */
  // 2026-10-31 二次定稿（陛下纠的）：第一版把代录绑在排班权限上，是错的。
  //   「代录的话需要超管开放代录权限给社干才可以……不开的话社干只能填写自己的」。
  // 这一节同时钉住两件事：① 关排班权限 → 代录照旧；② 关代录权限 → 才停。
  // ⚠️ 周日的用例会走不进来（填写窗口关闭，会先收到「周日只读」），所以整段跳过并明说。
  if (!availabilityWindow().open) {
    console.log('\n[skip] 今天是周日（填写窗口关闭），代录接口的 8 条用例跳过 —— 周一~周六再跑才准');
  } else {
    reset();
    const body = { week: WEEK, personId: 4, picks: [], reason: '替他填' };
    equal(
      '缺行时社干能代录（走到「时段未发布」那一步，不是权限错）',
      (await call('PUT', '/partner/availability', body, 2)).code,
      40001
    );

    // ★ 关键：关掉**排班**权限，代录不该受影响（两件事是分开的）
    await setGlobal({ schedule: false });
    equal(
      '关掉排班权限后，代录照样能进行（两件事分开）',
      (await call('PUT', '/partner/availability', body, 2)).code,
      40001
    );

    // 关掉代录权限 ⇒ 才停
    await setGlobal({ proxy: false });
    r = await call('PUT', '/partner/availability', body, 2);
    equal('关掉代录权限后代录被拦', r.code, 40301);
    equal('代录被拦的文案', r.message, '暂无代录权限');

    // 按人开回来
    await setPerson(3, { proxy: true });
    equal('乙被单独开了代录，能走到业务校验',
      (await call('PUT', '/partner/availability', body, 3)).code, 40001);
    equal('甲仍被拦（没单独开）',
      (await call('PUT', '/partner/availability', body, 2)).code, 40301);

    // 站员的报错文案不是「暂无代录权限」—— 对他是「角色上没这件事」
    const m4 = await call('PUT', '/partner/availability', { ...body, personId: 2 }, 4);
    equal('站员代录：文案是「只能填自己的」', m4.message, '只能填自己的可排时间');

    // 代录**查看**也要拦：能读别人的填报 = 全站谁哪天能来全公开
    // ⚠️ 目标必须传**别人**（personId=4 是站员）；传自己的 id 走的是「看自己」，本来就不该拦
    equal('关掉代录权限后，读别人的填报也被拦',
      (await call('GET', `/partner/availability?week=${WEEK}&personId=4`, {}, 2)).code, 40301);
    equal('有代录权限的乙能读别人的填报',
      (await call('GET', `/partner/availability?week=${WEEK}&personId=4`, {}, 3)).code, 0);
  }

  /* ───────── ⑪ 填写窗口：周一 0 点 ~ 周六 24 点；周日整页只读 ───────── */
  // 夹具复用 test-partner-week-anchor：北京 2026-11-07 周六 / 11-08 周日
  const SAT_NOON = Date.UTC(2026, 10, 7, 4, 0, 0);          // 周六 12:00
  const SAT_LAST = Date.UTC(2026, 10, 7, 15, 59, 59, 999);  // 周六 23:59:59.999
  const SUN_FIRST = Date.UTC(2026, 10, 7, 16, 0, 0);        // 周日 00:00:00.000
  const SUN_NOON = Date.UTC(2026, 10, 8, 4, 0, 0);          // 周日 12:00

  equal('窗口：周六 12:00 开着', availabilityWindow(SAT_NOON).open, true);
  equal('窗口：周六 23:59:59.999 还开着', availabilityWindow(SAT_LAST).open, true);
  equal('窗口：周日 00:00 整关上', availabilityWindow(SUN_FIRST).open, false);
  equal('窗口：周日 12:00 关着', availabilityWindow(SUN_NOON).open, false);
  equal('窗口：周日的提示文案', availabilityWindow(SUN_NOON).text, '周日只读 · 要改只能找超管代录');
  equal('窗口：周一~周六没有提示文案', availabilityWindow(SAT_NOON).text, '');

  let werr = null;
  try { assertWindowWritable({ isSuper: false }, SUN_NOON); } catch (e) { werr = e; }
  equal('写闸：周日社干被拒', werr && werr.code, 40301);
  equal('写闸：周日社干被拒的文案', werr && werr.message, '周日只读 · 要改只能找超管代录');
  yes('写闸：周日超管放行', (() => {
    try { assertWindowWritable({ isSuper: true }, SUN_NOON); return true; } catch (e) { return false; }
  })());
  yes('写闸：周一~周六谁都能写', (() => {
    try { assertWindowWritable({ isSuper: false }, SAT_NOON); return true; } catch (e) { return false; }
  })());

  // READ 侧也要把只读态说清楚：前端靠它整页渲染只读，而不是点完才被拒
  reset();
  r = await call('GET', `/partner/availability?week=${WEEK}`, {}, 2);
  yes('GET 带 window 字段', r.data && !!r.data.window);
  equal('GET 的 window.weekday 与窗口判定一致',
    r.data.window.weekday === 0, r.data.window.open === false);
  equal('社干没有超管身份 ⇒ readonly 与 open 互斥',
    r.data.window.readonly, !r.data.window.open);
  equal('超管在周日不 readonly', (await call('GET', `/partner/availability?week=${WEEK}`, {}, 1)).data.window.readonly, false);

  console.log(`\n结论：断言 ${checks} 项 / 失败 0 项`);
})().catch((e) => {
  console.error('FAIL', e && e.message);
  if (e && e.actual !== undefined) console.error('  actual  =', JSON.stringify(e.actual));
  if (e && e.expected !== undefined) console.error('  expected=', JSON.stringify(e.expected));
  process.exit(1);
});
