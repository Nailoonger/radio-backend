'use strict';

// 跑真实云函数 handler；撤回保留的旧 assignment 不再成为正式值班依据。
const assert = require('assert/strict');
const H = require('./harness');
const { sign } = require('../cloudfunctions/api/lib/auth');
const WEEK = '2026-11-02';
const tokens = {
  manager: sign({ id: 1, username: 'manager', role: 1 }),
  member: sign({ id: 2, username: 'member', role: 2 }),
};
let checks = 0;
const eq = (got, want, message) => { assert.deepEqual(got, want, message); checks += 1; };
const call = (method, path, body, role) => H.call(H.req(method, path, body || {}, tokens[role || 'manager']));

function seed(state) {
  H.reset({
    admin: [
      { _id: 'a1', id: 1, username: 'manager', nickname: '社干', role: 1, status: 1, department: '播音部', dutyRoles: ['播音'] },
      { _id: 'a2', id: 2, username: 'member', nickname: '伙伴', role: 2, status: 1, department: '播音部', dutyRoles: ['播音'] },
    ],
    duty_weeks: [{ _id: WEEK, weekStart: WEEK, state, version: 1 }],
    duty_assignments: [
      { _id: 'row1', id: 1, weekStart: WEEK, day: WEEK, slot: '午间', slotKey: '0-1', personId: 1, personName: '社干', department: '播音部' },
      { _id: 'row2', id: 2, weekStart: WEEK, day: WEEK, slot: '午间', slotKey: '0-1', personId: 2, personName: '伙伴', department: '播音部' },
    ],
    duty_leaves: [{ _id: 'l1', id: 1, weekStart: WEEK, day: WEEK, slot: '午间', personId: 2, personName: '伙伴', status: 0, reason: '课程冲突' }],
    duty_attendance: [{ _id: 't1', id: 1, weekStart: WEEK, day: WEEK, slot: '午间', personId: 2, status: 1 }],
  });
}

(async () => {
  for (const state of ['draft', 'withdrawn', 'empty']) {
    seed(state);
    const week = await call('GET', `/partner/attendance/week?week=${WEEK}`);
    eq(week.code, 0, `${state} 考勤可读取空态`);
    eq(week.data.summary.posts, 0, `${state} 不暴露旧班次`);
    const mine = await call('GET', `/partner/attendance/mine?week=${WEEK}`, {}, 'member');
    eq(mine.data.weekShifts, 0, `${state} 本人周场次不含旧班次`);
    eq(mine.data.monthShifts, 0, `${state} 本人月场次不含旧班次`);
    const overview = await call('GET', `/partner/attendance/overview?week=${WEEK}`);
    eq(overview.data.summary.posts, 0, `${state} 总览不含旧班次`);
    const mark = await call('PUT', '/partner/attendance', { weekStart: WEEK, day: WEEK, slot: '午间', records: [{ personId: 2, status: 0 }] });
    eq(mark.code, 40901, `${state} 不允许点名`);
    eq(H.dump().duty_attendance[0].status, 1, `${state} 拒绝后保留原考勤`);
    const leave = await call('POST', '/partner/leave', { weekStart: WEEK, day: WEEK, slot: '午间', reason: '课程冲突' }, 'manager');
    eq(leave.code, 40901, `${state} 不允许对撤回班次新建请假`);
    const review = await call('PUT', '/partner/leave/1/review', { approve: true });
    eq(review.code, 40901, `${state} 不允许按旧班次批假`);
    const impact = await call('GET', '/partner/leave/1/impact');
    eq(impact.data.willEmpty, null, `${state} 批假预览无正式缺岗`);
    eq(impact.data.candidates, [], `${state} 不生成补位候选`);
    const peers = await call('GET', `/partner/feedback/pending?week=${WEEK}`, {}, 'member');
    eq(peers.data.total, 0, `${state} 旧班次不生成待互评`);
    const feedback = await call('POST', '/partner/feedback', { weekStart: WEEK, day: WEEK, slot: '午间', targetId: 1, text: '声音清楚' }, 'member');
    eq(feedback.code, 40301, `${state} 不允许旧班次提交互评`);
    const fOverview = await call('GET', `/partner/feedback/overview?week=${WEEK}`);
    eq(fOverview.data.onDuty, 0, `${state} 互评总览无正式值班人次`);
    eq(H.dump().duty_assignments.length, 2, `${state} 旧人选保留用于修订`);
  }

  seed('published');
  const week = await call('GET', `/partner/attendance/week?week=${WEEK}`);
  eq(week.data.summary.posts, 2, '已发布周正常点名');
  const mine = await call('GET', `/partner/attendance/mine?week=${WEEK}`, {}, 'member');
  eq(mine.data.weekShifts, 1, '已发布本人场次正常');
  eq(mine.data.monthShifts, 1, '已发布月场次正常');
  const mark = await call('PUT', '/partner/attendance', { weekStart: WEEK, day: WEEK, slot: '午间', records: [{ personId: 2, status: 0 }] });
  eq(mark.code, 0, '已发布正常保存点名');
  eq(H.dump().duty_attendance[0].status, 0, '已发布点名写入');
  const leave = await call('POST', '/partner/leave', { weekStart: WEEK, day: WEEK, slot: '午间', reason: '课程冲突' });
  eq(leave.code, 0, '已发布本人班次可新建请假');
  const fakeLeave = await call('POST', '/partner/leave', { weekStart: WEEK, day: WEEK, slot: '下午', reason: '课程冲突' });
  eq(fakeLeave.code, 40901, '正式班表没有本人的场次不可凭空请假');
  const peers = await call('GET', `/partner/feedback/pending?week=${WEEK}`, {}, 'member');
  eq(peers.data.total, 1, '已发布正常生成搭班互评');
  const feedback = await call('POST', '/partner/feedback', { weekStart: WEEK, day: WEEK, slot: '午间', targetId: 1, text: '声音清楚' }, 'member');
  eq(feedback.code, 0, '已发布搭班可互评');
  await require('../cloudfunctions/api/handlers/partner/schedule').withWeekLock(WEEK, async () => {
    const locked = await call('PUT', '/partner/leave/1/review', { approve: true });
    eq(locked.code, 40901, '班表发布持锁期间不可交错批准请假');
    eq(H.dump().duty_leaves[0].status, 0, '锁冲突不改变请假状态');
  });
  const review = await call('PUT', '/partner/leave/1/review', { approve: true });
  eq(review.code, 0, '已发布本人班次可审批');
  console.log(`伙伴正式班表隔离：${checks} 项通过。`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
