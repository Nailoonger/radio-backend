'use strict';

/**
 * 社团提报通知（提报 / 改 / 撤 / 审核 / 驳回 / 已播出）—— 真路由 + 真 handler + 内存云库
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-club-notice.js
 *
 * ═══════════ 这个套件守什么 ═══════════
 * 一条通知从「社团写」到「广播里念出来」要过五道手，每一道错了都不报错：
 *   ① 归属错：拿 A 社团的票据改 B 社团的单子（越权，且页面上看不出）
 *   ② 状态错：已经审核了还能改 / 已播出还能撤回（满屏状态自相矛盾）
 *   ③ 驳回没理由：学生只知道「没通过」，反复重提同一条
 *   ④ 排序错：先提交的排到最后 ⇒ 昨天那条最急的永远没人审
 *   ⑤ 跳审：待审核直接标已播出 ⇒ 没过审的话上了麦
 * 所以这里不测 UI，只钉状态机与归属。
 */

const assert = require('assert');
const path = require('path');
const H = require('./harness');

const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib', 'auth'));
const { ST } = require(path.join(API, 'services', 'clubNotice'));

let checks = 0;
const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const ok = (name, cond, extra) => { assert.ok(cond, `${name}${extra ? ' :: ' + extra : ''}`); checks++; };
const section = (t) => console.log(`\n---- ${t} ----`);

const STU = '20240101';
const T_STU = sign({ openid: STU, uid: 1, username: STU, pv: 0 });
const T_SUPER = sign({ id: 1, username: 'p1', role: 0 });
const T_MGR = sign({ id: 2, username: 'p2', role: 1 });
const T_MEMBER = sign({ id: 3, username: 'p3', role: 2 });

function seed() {
  return {
    user: [{ _id: 'u1', id: 1, openid: null, username: STU, status: 1, pwdChangedAt: null }],
    admin: [
      { _id: 'a1', id: 1, username: 'p1', nickname: '老师', role: 0, status: 1 },
      { _id: 'a2', id: 2, username: 'p2', nickname: '陈屿', role: 1, status: 1 },
      { _id: 'a3', id: 3, username: 'p3', nickname: '站员丙', role: 2, status: 1 },
    ],
  };
}

const call = (method, url, body, token) => H.call(H.req(method, url, body || {}, token || ''));
const save = (body, tk) => call('POST', '/user/club-notice', body, T_STU);
const myList = (ticket) => call('GET', '/user/club-notice/my', { ticket }, T_STU);
const detail = (id, ticket) => call('GET', `/user/club-notice/${id}`, { ticket }, T_STU);
const edit = (id, body, ticket) => call('PUT', `/user/club-notice/${id}`, { ticket, ...body }, T_STU);
const withdraw = (id, ticket) => call('POST', `/user/club-notice/${id}/withdraw`, { ticket }, T_STU);
const queue = (status, tk) => call('GET', `/partner/club-notice/queue${status === undefined ? '' : `?status=${status}`}`, {}, tk);
const review = (id, body, tk) => call('PUT', `/partner/club-notice/${id}/review`, body, tk);
const air = (id, tk) => call('PUT', `/partner/club-notice/${id}/air`, {}, tk);

/** 给第 n 家社团发一把钥匙，返回票据 */
async function ticketOf(n) {
  const r = await call('POST', `/partner/club-keys/${n}/reset`, {}, T_SUPER);
  const v = await call('POST', '/user/club-key/verify', { key: r.data.plain }, T_STU);
  return v.data.ticket;
}

const BODY = '因操场施工，本周六外拍集合点改到图书馆正门，8:30 准时出发，请带好相机和存储卡。';
const BODY2 = '摄影社招新面试定于本周三 17:30 在艺术楼 302 进行，请自带作品三张。';

(async () => {
  H.reset(seed());
  let ticket = await ticketOf(1);

  /* ═══════════ ① 两道鉴权 ═══════════ */
  section('① 鉴权');
  eq('没票据不能提报', (await save({ body: BODY })).code, 40101);
  eq('假票据不能提报', (await save({ body: BODY, ticket: 'deadbeef' })).code, 40101);
  eq('有票据但没登录也不能提报', (await call('POST', '/user/club-notice', { body: BODY, ticket }, '')).code, 40101);

  /* ═══════════ ② 提报 ═══════════ */
  section('② 提报');
  eq('空正文', (await save({ ticket })).code, 40001);
  eq('正文太短', (await save({ ticket, body: '通知' })).code, 40001);
  eq('正文超长', (await save({ ticket, body: '字'.repeat(301) })).code, 40001);

  let r = await save({ ticket, body: BODY, hopeText: '11月7日 周五 · 午间 12:20', note: '尽量早一点' });
  eq('提报成功', r.code, 0);
  const first = r.data.record;
  eq('初始状态待审核', first.status, ST.WAIT);
  eq('状态文案', first.statusText, '待审核');
  eq('标题由正文派生（前 20 字）', first.title, '因操场施工，本周六外拍集合点改到图书馆正…');
  eq('负责人还没填时落款退回学号', first.submitByName, STU);
  eq('字数', first.charCount, BODY.length);
  eq('未审核可改', first.canEdit, true);
  eq('未审核可撤', first.canWithdraw, true);
  ok('不带 key_hash/密钥字段', !/key_hash|key_mask/.test(JSON.stringify(r.data)));

  // 派生规则本身
  const { summaryOf } = require(path.join(API, 'services/clubNotice'));
  eq('派生：短句原样（去掉句末标点）', summaryOf('周六外拍改到图书馆门口集合。'), '周六外拍改到图书馆门口集合');
  eq('派生：超 20 字且无分句 → 硬截加省略号',
    summaryOf('一二三四五六七八九十一二三四五六七八九十一二三'), '一二三四五六七八九十一二三四五六七八九十…');
  eq('派生：超 20 字但有分句 → 在分句处收尾',
    summaryOf('关于本周社团活动安排调整的重要通知，请各位社长务必逐条读完并转达。'), '关于本周社团活动安排调整的重要通知');
  eq('派生：空正文给空串', summaryOf(''), '');

  /* ═══════════ ③ 提报人落款 ═══════════ */
  section('③ 提报人');
  // 把负责人写上，再提一条看落款
  await call('PUT', '/partner/club-keys/1', { ownerName: '林溪' }, T_SUPER);
  r = await save({ ticket, body: BODY2 });
  eq('落款是社团负责人', r.data.record.submitByName, '林溪');
  const second = r.data.record;

  /* ═══════════ ④ 我的提交 ═══════════ */
  section('④ 我的提交');
  r = await myList(ticket);
  eq('列表条数', r.data.list.length, 2);
  eq('最新在前', r.data.list[0].id, second.id);
  eq('计数', r.data.count, { total: 2, wait: 2, air: 0, done: 0, reject: 0 });

  /* ═══════════ ⑤ 归属：别家票据看不到 ═══════════ */
  section('⑤ 归属');
  const otherTicket = await ticketOf(2);
  eq('别家社团看列表看不到我的', (await myList(otherTicket)).data.list.length, 0);
  eq('别家社团看详情 → 40401', (await detail(first.id, otherTicket)).code, 40401);
  eq('别家社团改不了', (await edit(first.id, { body: BODY }, otherTicket)).code, 40401);
  eq('别家社团撤不了', (await withdraw(first.id, otherTicket)).code, 40401);
  // 前端硬塞 clubId 也没用
  eq('硬塞 clubId 也改不到别家', (await edit(first.id, { body: BODY, clubId: 2 }, otherTicket)).code, 40401);

  /* ═══════════ ⑥ 未审核前可改 ═══════════ */
  section('⑥ 修改');
  r = await edit(first.id, { body: '本周六外拍取消，改到下周六同一时间集合。', hopeText: '11月8日 · 午间' }, ticket);
  eq('改成功', r.code, 0);
  eq('正文已变', r.data.record.body, '本周六外拍取消，改到下周六同一时间集合。');
  eq('标题跟着重算', r.data.record.title, '本周六外拍取消，改到下周六同一时间集合');
  eq('希望播出也改了', r.data.record.hopeText, '11月8日 · 午间');

  /* ═══════════ ⑦ 撤回 ═══════════ */
  section('⑦ 撤回');
  r = await withdraw(second.id, ticket);
  eq('撤回成功', r.code, 0);
  eq('状态已撤回', r.data.record.status, ST.WITHDRAW);
  eq('撤回后不能再改', (await edit(second.id, { body: BODY2 }, ticket)).code, 40901);
  eq('撤回后不能再撤', (await withdraw(second.id, ticket)).code, 40901);

  r = await detail(second.id, ticket);
  eq('撤回的时间线只有两步', r.data.timeline.length, 2);
  eq('时间线第二步是已撤回', r.data.timeline[1].title, '已撤回');

  /* ═══════════ ⑧ 待审上限 ═══════════ */
  section('⑧ 待审核堆叠上限');
  // 已有 1 条待审（first），再提 4 条到上限
  for (let i = 0; i < 4; i += 1) {
    const x = await save({ ticket, body: `第 ${i + 1} 条补充通知：本周社团活动安排见群内通知。` });
    eq(`第 ${i + 2} 条待审可以提`, x.code, 0);
  }
  r = await save({ ticket, body: '再多一条就该被拦住了，因为已经堆了五条。' });
  eq('第 6 条待审被拦', r.code, 40901);
  ok('拦的时候说实话（提示等处理）', /审核/.test(r.message), r.message);

  /* ═══════════ ⑨ 伙伴端鉴权 ═══════════ */
  section('⑨ 处理台鉴权');
  eq('站员不能看队列', (await queue(0, T_MEMBER)).code, 40301);
  eq('没登录不能看队列', (await queue(0, '')).code, 40101);
  eq('社干缺行=全开，能看', (await queue(0, T_MGR)).code, 0);
  eq('超管能看', (await queue(0, T_SUPER)).code, 0);

  H.reset({ ...seed(), partner_permissions: [{ _id: 'global', schedule: true, review: false, proxy: true, clubkey: true }] });
  ticket = await ticketOf(1);
  eq('审核权被关掉 → 社干 40301', (await queue(0, T_MGR)).code, 40301);
  eq('且文案是统一四字', (await queue(0, T_MGR)).message, '暂无权限');
  eq('超管不受影响', (await queue(0, T_SUPER)).code, 0);

  /* ═══════════ ⑩ 队列排序与分段 ═══════════ */
  section('⑩ 队列');
  H.reset(seed());
  ticket = await ticketOf(1);
  const a = (await save({ ticket, body: '第一条：周三下午社团活动改到报告厅举行，请准时到场。' })).data.record;
  const b = (await save({ ticket, body: '第二条：周五中午摄影展布置需要六名志愿者协助搬运展架。' })).data.record;
  const c = (await save({ ticket, body: '第三条：下周一开始收社团年度总结，逾期不再受理。' })).data.record;

  r = await queue(0, T_SUPER);
  eq('待审核三条', r.data.list.length, 3);
  eq('先提交先审（id 升序）', r.data.list.map((x) => x.id), [a.id, b.id, c.id]);
  eq('计数', r.data.count, { wait: 3, air: 0, done: 0, reject: 0 });
  eq('非法 status → 40001', (await call('GET', '/partner/club-notice/queue?status=7', {}, T_SUPER)).code, 40001);

  /* ═══════════ ⑪ 通过（不填排期也能过） ═══════════ */
  section('⑪ 通过');
  r = await review(a.id, { pass: true }, T_SUPER);
  eq('通过成功', r.code, 0);
  eq('状态待播', r.data.record.status, ST.AIR);
  eq('审核人落款', r.data.record.reviewByName, '老师');

  r = await review(b.id, { pass: true, date: '2026-11-07', slot: '午间 12:20', title: '摄影展布置招志愿者' }, T_SUPER);
  eq('带排期通过', r.data.record.airSlot, '午间 12:20');
  eq('审核时可以改标题', r.data.record.title, '摄影展布置招志愿者');

  eq('处理过再审 → 40901', (await review(a.id, { pass: true }, T_SUPER)).code, 40901);
  eq('学生这时改不了', (await edit(a.id, { body: '想改成别的' }, ticket)).code, 40901);
  eq('学生这时撤不了', (await withdraw(a.id, ticket)).code, 40901);

  /* ═══════════ ⑫ 驳回 ═══════════ */
  section('⑫ 驳回');
  eq('不写理由 → 40001', (await review(c.id, { pass: false }, T_SUPER)).code, 40001);
  eq('理由太短 → 40001', (await review(c.id, { pass: false, reason: '不行' }, T_SUPER)).code, 40001);

  r = await review(c.id, { pass: false, reason: '这条要提前一天提报，今天报的排不进明早时段。' }, T_SUPER);
  eq('驳回成功', r.code, 0);
  eq('状态已驳回', r.data.record.status, ST.REJECT);
  ok('理由存下来了', r.data.record.rejectReason.indexOf('提前一天') >= 0);

  r = await detail(c.id, ticket);
  eq('学生能看到驳回理由', r.data.record.rejectReason.indexOf('提前一天') >= 0, true);
  eq('时间线第二步是驳回', r.data.timeline[1].title, '审核未通过');
  eq('时间线标记 bad', r.data.timeline[1].state, 'bad');
  eq('被驳回可以改一版重提', r.data.record.canResubmit, true);

  /* ═══════════ ⑬ 标记已播出 ═══════════ */
  section('⑬ 已播出');
  eq('待审核的不能直接标已播出（跳审）', (await air(c.id, T_SUPER)).code, 40901);
  r = await air(b.id, T_SUPER);
  eq('待播的可以标', r.code, 0);
  eq('状态已播出', r.data.record.status, ST.DONE);
  eq('记下是谁点的', r.data.record.airByName, '老师');
  ok('记下播出时刻', !!r.data.record.airTime);
  eq('已播出再标 → 40901', (await air(b.id, T_SUPER)).code, 40901);

  r = await detail(b.id, ticket);
  eq('学生端时间线走完四步', r.data.timeline.length, 4);
  eq('最后一步已播出', r.data.timeline[3].title, '已播出');
  eq('四步全是 done', r.data.timeline.every((s) => s.state === 'done'), true);

  /* ═══════════ ⑭ 作废社团 ⇒ 旧票据立刻失效 ═══════════ */
  section('⑭ 社团被作废');
  eq('作废前还能提报', (await save({ ticket, body: '作废前最后一条，用来对照。' })).code, 0);
  await call('PUT', '/partner/club-keys/1/status', { status: 0 }, T_SUPER);
  eq('作废后旧票据提不了报', (await save({ ticket, body: '作废之后应该进不来了。' })).code, 40101);
  eq('也看不了自己的列表', (await myList(ticket)).code, 40101);
  eq('文案是「请重新输入密钥」', (await myList(ticket)).message.indexOf('重新输入') >= 0, true);

  // ⚠️ 这行格式必须与其它套件一致（regression.js 靠它认「结论」行）
  console.log(`\n结论：断言 ${checks} 项 / 失败 0 项`);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.message);
  console.error((e && e.stack || '').split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
