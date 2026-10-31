'use strict';

/**
 * 伙伴端 · 批假联动班表（2026-11-01）
 *
 * 用法（仓库根目录）：node cloud/scripts/test-partner-leave-flow.js
 *
 * 守的是陛下 2026-11-01 这条原话，一条不漏：
 *   「超管批准请假之后，班表那边自动解锁格子把人删掉显示空缺，
 *     然后等待配置成功之后才可重新发布班表，在这期间主页卡片显示班表已撤回，
 *     此时班表为草稿状态，直到配置完成发布新的班表。」
 *
 * 拆成可断言的六件事：
 *   ① 批准 = 请假状态变已批准 **且** 班表退回草稿（state='draft' + withdrawnAt）
 *   ② 那个人的那一格真的空出来了（total 减 1，那一格不再有他）
 *   ③ 退回草稿后**不能直接发布**（缺岗拦截 40901），必须先补齐
 *   ④ 补齐后能重新发布，且版本号 +1
 *   ⑤ 驳回不动班表（还是 published）
 *   ⑥ 已审批队列（GET /partner/leave/reviewed）：站员 40301；本人撤回的不入列
 *
 * ⚠️ 时间：用「下一周」当锚点（currentWeekStart + 7 天），不做「今天是星期几」的假设 ——
 *    周日跑也不能崩（周日只读窗口只影响可排时间填报，本文件不填可排时间，直接种库）。
 */

const path = require('path');
const H = require('./harness');
const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib/auth'));
const bj = require(path.join(API, 'lib/bjTime'));
const { currentWeekStart, weekDates, templatesToSlots } = require(path.join(API, 'handlers/partner/_kit'));

const WEEK = currentWeekStart(Date.now() + 7 * bj.DAY_MS);
const DATES = weekDates(WEEK);

const tokens = {};
[1, 2, 3, 4].forEach((id) => {
  tokens[id] = sign({ id, username: `p${id}`, role: id === 1 ? 0 : id === 2 ? 1 : 2 });
});

let checks = 0;
let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  checks++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
};
const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  checks++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
};

const TPL = [
  { day: 0, title: '早会', start: 410, end: 440, dept: '播音部', role: '播音', count: 1 },
  { day: 0, title: '早会', start: 410, end: 440, dept: '主持部', role: '主持', count: 1 },
  { day: 1, title: '午间', start: 730, end: 750, dept: '播音部', role: '播音', count: 1 },
];
const SLOTS = templatesToSlots(TPL);

function seed() {
  const t = new Date('2026-01-01T00:00:00+08:00');
  const admin = [
    { id: 1, role: 0, nickname: '老师', department: '播音部', dutyRoles: ['播音'] },
    { id: 2, role: 1, nickname: '社干', department: '播音部', dutyRoles: ['播音'] },
    { id: 3, role: 2, nickname: '主持甲', department: '主持部', dutyRoles: ['主持'] },
    { id: 4, role: 2, nickname: '播音乙', department: '播音部', dutyRoles: ['播音'] },
  ].map((a) => Object.assign({ _id: `a${a.id}`, username: `p${a.id}`, password: 'x', status: 1, createTime: t, updateTime: t }, a));
  // 四个人本周都可排全部时段（「可排时间」是硬条件，不种就一个人也排不上）
  const available = [1, 2, 3, 4].map((id) => ({
    _id: `avail:${WEEK}:${id}`,
    personId: id,
    weekStart: WEEK,
    slotVersion: 1,
    confirmedAt: new Date(),
    picks: SLOTS.map((s) => ({ slotKey: s.slotKey, can: true })),
  }));
  return {
    admin,
    duty_slot_versions: [{ _id: 'slots1', version: 1, state: 'published', templates: TPL }],
    duty_availability: available,
  };
}

const call = (method, url, body, id = 1) => H.call(H.req(method, url, body || {}, tokens[id] || ''));

/** 当前周的完整视图（含 revision） */
const get = (id = 1) => call('GET', `/partner/schedule?week=${WEEK}`, {}, id);

/** 班表写操作要带 revision */
async function mutate(method, route, body = {}, id = 1) {
  const w = await get(id);
  return call(method, `/partner/schedule/${route}`, Object.assign({ weekStart: WEEK, revision: w.data.revision }, body), id);
}

/** 已发布/草稿里所有「人 × 格」摊平（⚠️ slotKey 在**人**那一行上，桶里只有标题） */
function flatten(week) {
  const out = [];
  (week.days || []).forEach((d) => {
    (d.slots || []).forEach((s) => {
      (s.people || []).forEach((p) => out.push({
        day: d.day, slot: s.slot, slotKey: p.slotKey, personId: p.personId,
      }));
    });
  });
  return out;
}

/** 一格里「应到 / 实到」（桶里没有 count，count 在 groups 上） */
function cellOf(week, slotKey) {
  for (const d of week.days || []) {
    for (const s of d.slots || []) {
      for (const g of s.groups || []) {
        if (g.slotKey === slotKey) return { day: d.day, slot: s.slot, count: g.count, people: g.people };
      }
    }
  }
  return null;
}

(async () => {
  H.reset(seed());

  console.log('\n========== 一、先排出一份已发布班表 ==========');
  let r = await mutate('PUT', 'generate', {}, 2);
  eq('生成草稿', r.code, 0);
  eq('三个人都排上', r.data.generated, 3);
  r = await mutate('POST', 'publish', {}, 2);
  eq('发布成功', r.code, 0);
  eq('发布后 state', r.data.week.state, 'published');
  eq('版本 1', r.data.week.version, 1);

  const published = (await get()).data;
  const cells = flatten(published);
  eq('已发布 3 格', cells.length, 3);

  // 挑两格、两个不同的人：一格用来「批准」，一格用来「驳回」
  const a = cells.find((c) => c.personId === 4) || cells[0];
  const b = cells.find((c) => c.personId !== a.personId);
  ok('两格是不同的人', !!b && b.personId !== a.personId, `${a.personId} vs ${b && b.personId}`);

  console.log('\n========== 二、两条请假：一条批准、一条驳回 ==========');
  const mkLeave = (cell, reason) => call('POST', '/partner/leave', {
    weekStart: WEEK, day: cell.day, slot: cell.slot, reason,
  }, cell.personId);
  const lvA = await mkLeave(a, '家里有事');
  const lvB = await mkLeave(b, '临时加课');
  eq('A 请假提交', lvA.code, 0);
  eq('B 请假提交', lvB.code, 0);
  eq('A 待批', lvA.data.status, 0);

  r = await call('PUT', `/partner/leave/${lvB.data.id}/review`, { approve: false, reason: '这天要录节目' }, 1);
  eq('驳回 B', r.code, 0);
  eq('驳回不改班表（仍 published）', (await get()).data.state, 'published');
  eq('驳回后格子还是满的', flatten((await get()).data).length, 3);

  console.log('\n========== 三、批准 A：格子让开 + 班表退回草稿 ==========');
  r = await call('PUT', `/partner/leave/${lvA.data.id}/review`, { approve: true }, 1);
  eq('批准 A', r.code, 0);
  eq('批准回执带 scheduleWithdrawn', r.data.scheduleWithdrawn, true);
  eq('请假状态 = 已批准', r.data.status, 1);

  const after = (await get()).data;
  eq('班表 state 退回 draft', after.state, 'draft');
  ok('库里有 withdrawnAt（大白卡靠它显示「已撤回」）', !!after.withdrawnAt, String(after.withdrawnAt));
  eq('publishedAt 清空', after.publishedAt, null);
  eq('格子少一个人', after.total, 2);
  eq('那个人的那一格真的空了', flatten(after).some((c) => c.day === a.day && c.slot === a.slot && c.personId === a.personId), false);
  const emptyCell = cellOf(after, a.slotKey);
  ok('那一格还在（不是整格消失）', !!emptyCell, a.slotKey);
  eq('那一格应到 1 人', emptyCell && emptyCell.count, 1);
  eq('那一格实到 0 人（显示空缺）', emptyCell && emptyCell.people.length, 0);
  eq('汇总里缺岗 1', after.summary.missing, 1);

  console.log('\n========== 四、没补齐不能发布（先配置成功才可重新发布） ==========');
  r = await mutate('POST', 'publish', {}, 1);
  eq('缺岗直接发布 → 40901', r.code, 40901);
  ok('拒绝理由说的是缺岗', /缺岗/.test(String(r.message || '')), r.message);
  eq('失败后仍是草稿', (await get()).data.state, 'draft');

  console.log('\n========== 五、补齐 → 能重新发布，版本 +1 ==========');
  /* 补的人必须和这一格的部门 / 岗位对得上（reasonsFor 的硬条件），所以按 TPL 找同样资格的人 */
  const DEPT = {
    1: { dept: '播音部', role: '播音' },
    2: { dept: '播音部', role: '播音' },
    3: { dept: '主持部', role: '主持' },
    4: { dept: '播音部', role: '播音' },
  };
  const def = SLOTS.find((s) => s.slotKey === a.slotKey);
  const spare = [1, 2, 3, 4].find((id) => id !== a.personId
    && DEPT[id].dept === def.dept && DEPT[id].role === def.role
    && !flatten(after).some((c) => c.day === a.day && c.slotKey === a.slotKey && c.personId === id));
  ok('找到同资格的空闲人补位', !!spare, JSON.stringify({ slotKey: a.slotKey, dept: def.dept, role: def.role }));
  r = await mutate('PUT', 'cell', { day: a.day, slotKey: a.slotKey, personIds: [spare], reason: '批准请假后补人' }, 1);
  eq('补齐这一格', r.code, 0);
  r = await mutate('POST', 'publish', {}, 1);
  eq('补齐后发布成功', r.code, 0);
  eq('重新发布 state', r.data.week.state, 'published');
  eq('版本 = 2', r.data.week.version, 2);
  eq('格子补满 3 人', flatten(r.data.week).length, 3);
  eq('重新发布后 withdrawnAt 清空', r.data.week.withdrawnAt, null);

  console.log('\n========== 六、已审批队列 ==========');
  r = await call('GET', '/partner/leave/reviewed', {}, 2);
  eq('社干能读已审批', r.code, 0);
  eq('已审批两条（一批准一驳回）', r.data.list.length, 2);
  eq('倒序：后处理的批准那条在最前', r.data.list[0].id, lvA.data.id);
  eq('批准那条 status=1', r.data.list[0].status, 1);
  eq('驳回那条带理由', r.data.list[1].rejectReason, '这天要录节目');
  eq('站员调用已审批 → 40301', (await call('GET', '/partner/leave/reviewed', {}, 3)).code, 40301);
  eq('超管能读已审批', (await call('GET', '/partner/leave/reviewed', {}, 1)).code, 0);

  /* 本人撤回的那条不进「已审批」：它落在 status=2(已驳回) 但没有 reviewedAt */
  const cells2 = flatten((await get()).data);
  const c = cells2.find((x) => x.personId === 3) || cells2[0];
  const lvC = await mkLeave(c, '想了一下还是去吧');
  eq('C 请假提交', lvC.code, 0);
  eq('C 撤回', (await call('DELETE', `/partner/leave/${lvC.data.id}`, {}, c.personId)).code, 0);
  r = await call('GET', '/partner/leave/reviewed', {}, 2);
  eq('撤回的不出现在已审批里', r.data.list.some((x) => x.id === lvC.data.id), false);
  eq('已审批仍是两条', r.data.list.length, 2);

  console.log('\n========== 七、同一条不能批两次 ==========');
  r = await call('PUT', `/partner/leave/${lvA.data.id}/review`, { approve: true }, 1);
  eq('重复批准 → 40901', r.code, 40901);

  console.log(`\n伙伴端 · 批假联动班表：批准让格 / 退回草稿 / 补齐才能发 / 已审批队列`);
  console.log(`结论：断言 ${checks} 项 / 失败 ${failed} 项`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
