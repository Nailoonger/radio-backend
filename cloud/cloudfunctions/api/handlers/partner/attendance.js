'use strict';

/**
 * 伙伴端 · 考勤（按场点名）
 *
 *   GET  /partner/attendance/week      某周每天每场的值班人 + 点名结果（社干）
 *   PUT  /partner/attendance           点名 body: { weekStart, day, slot, records:[{personId,status}] }
 *   GET  /partner/attendance/mine      我的考勤（本人，只读）
 *   GET  /partner/attendance/overview  全站总览（社干 / 超管）
 *
 * ═══════════ 口径 ═══════════
 *   status：1 到岗 / 0 缺岗 / 2 请假（已批准的请假自动记成请假，不必手点）
 *   「应到人次」= 当周班表上的所有岗位数；实到 = status=1；请假 = status=2。
 *   **没有班表就没有考勤**：先有 assignment 才能点名，所以这里读班表、不回写班表。
 *
 * ═══════════ 为什么按「周」整批读 ═══════════
 *   点名的交互是「点某一天 → 看那天几场 → 逐场点」，
 *   一次给整周能避免每点一天就发一次请求（且切换不闪）。
 */

const { C, findMany, findOne, insertOne, updateWhere, removeWhere } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asPartner, asManager, assertWeekStart, currentWeekStart, weekDates } = require('./_kit');
const { nextId } = require('../../lib/db');
const { approvedSet } = require('./leave');
const { isPublished, publishedRows, filterPublishedRows } = require('./_published');

const ST = { ABSENT: 0, PRESENT: 1, LEAVE: 2 };
const ST_TEXT = { 0: '缺岗', 1: '到岗', 2: '请假' };

function keyOf(day, slot, personId) {
  return `${day}|${slot}|${Number(personId) || 0}`;
}

/** 周几的中文名（weekDates 只给日期，显示名在这里补） */
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];

/**
 * 读某周班表 → 按天/场分组，附带已有点名与已批请假
 * ⚠️ 天的键统一用**日期字符串**（'2026-10-26'）：weekDates 返回的就是这个，
 *    周几只在展示层补。用「周一」当键会在跨周时撞车（表里靠 weekStart 区分，但读代码容易错）。
 */
async function buildWeek(weekStart) {
  const [assignments, marks, leaves] = await Promise.all([
    publishedRows(weekStart),
    findMany(C.DUTY_ATTENDANCE, { weekStart }, { limit: 500 }),
    approvedSet(weekStart),
  ]);
  const markMap = {};
  marks.forEach((m) => { markMap[keyOf(m.day, m.slot, m.personId)] = Number(m.status); });

  const byDay = {};
  const days = weekDates(weekStart);
  days.forEach((d) => { byDay[d] = {}; });

  assignments.forEach((a) => {
    const day = a.day || '';
    const slot = a.slot || '';
    if (!byDay[day]) byDay[day] = {};
    if (!byDay[day][slot]) byDay[day][slot] = [];
    const pid = Number(a.personId) || 0;
    const mk = markMap[keyOf(day, slot, pid)];
    const isLeave = !!leaves[keyOf(day, slot, pid)];
    const status = mk === undefined ? (isLeave ? ST.LEAVE : null) : mk;
    byDay[day][slot].push({
      personId: pid,
      personName: a.personName || '',
      department: a.department || '',
      status,                       // null = 还没点
      statusText: status === null ? '未点' : ST_TEXT[status],
      onLeave: isLeave,
    });
  });

  return days.map((date, i) => ({
    day: date,
    dayName: DAY_NAMES[i] || '',
    slots: Object.keys(byDay[date] || {}).map((slot) => ({
      slot,
      people: byDay[date][slot],
    })),
    total: Object.keys(byDay[date] || {}).reduce((n, sl) => n + byDay[date][sl].length, 0),
  }));
}

async function week(ctx) {
  await asManager(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const days = await buildWeek(weekStart);
  const flat = [];
  days.forEach((d) => d.slots.forEach((s) => s.people.forEach((p) => flat.push(p))));
  return {
    weekStart,
    days,
    summary: {
      posts: flat.length,
      marked: flat.filter((p) => p.status !== null).length,
      present: flat.filter((p) => p.status === ST.PRESENT).length,
      absent: flat.filter((p) => p.status === ST.ABSENT).length,
      leave: flat.filter((p) => p.status === ST.LEAVE).length,
    },
  };
}

/** PUT /partner/attendance  body: { weekStart, day, slot, records:[{personId,status}] } */
async function mark(ctx) {
  const p = await asManager(ctx);
  const b = ctx.body || {};
  const weekStart = assertWeekStart(b.weekStart);
  const day = String(b.day || '').trim();
  const slot = String(b.slot || '').trim();
  const records = Array.isArray(b.records) ? b.records : [];
  if (!day || !slot) throw new ApiError(Codes.PARAM_ERROR, '请指定哪一天哪一场');
  if (!records.length) throw new ApiError(Codes.PARAM_ERROR, '没有要点的人');
  if (!(await isPublished(weekStart))) {
    throw new ApiError(Codes.CONFLICT, '本周班表未发布或已撤回，暂不能录入考勤');
  }

  const now = new Date();
  const name = (p.admin && (p.admin.nickname || p.admin.username)) || '';
  let n = 0;
  for (const r of records) {
    const pid = Number(r && r.personId);
    const status = Number(r && r.status);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (![ST.ABSENT, ST.PRESENT, ST.LEAVE].includes(status)) continue;
    // 只能给当周班表上这个人点（防止乱写进不存在的岗位）
    const onDuty = await findOne(C.DUTY_ASSIGNMENT, { weekStart, day, slot, personId: pid });
    if (!onDuty) continue;
    const exist = await findOne(C.DUTY_ATTENDANCE, { weekStart, day, slot, personId: pid });
    if (exist) {
      await updateWhere(C.DUTY_ATTENDANCE, { id: exist.id }, {
        status, checkedBy: p.id, checkedByName: name, checkedAt: now,
      });
    } else {
      await insertOne(C.DUTY_ATTENDANCE, {
        id: await nextId(C.DUTY_ATTENDANCE),
        weekStart, day, slot,
        personId: pid,
        personName: onDuty.personName || '',
        department: onDuty.department || '',
        status,
        checkedBy: p.id,
        checkedByName: name,
        checkedAt: now,
        createTime: now,
      });
    }
    n += 1;
  }
  const days = await buildWeek(weekStart);
  return { marked: n, days };
}

/** 我的考勤（本人视角，只读） */
async function mine(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const [assignments, marks] = await Promise.all([
    publishedRows(weekStart, { personId: p.id }, 100),
    findMany(C.DUTY_ATTENDANCE, { weekStart, personId: p.id }, { limit: 100 }),
  ]);
  const markMap = {};
  marks.forEach((m) => { markMap[keyOf(m.day, m.slot, m.personId)] = Number(m.status); });
  const list = assignments.map((a) => {
    const k = keyOf(a.day, a.slot, a.personId);
    const st = markMap[k];
    return {
      day: a.day || '',
      slot: a.slot || '',
      department: a.department || '',
      status: st === undefined ? null : st,
      statusText: st === undefined ? '未点' : ST_TEXT[st],
    };
  });
  // 本月场次（按周起点归月，跨月按周一归属，口径写死别猜）
  const all = await filterPublishedRows(await findMany(C.DUTY_ASSIGNMENT, { personId: p.id }, { limit: 500 }));
  const monthPrefix = String(weekStart).slice(0, 7);
  const monthShifts = all.filter((x) => String(x.weekStart || '').slice(0, 7) === monthPrefix).length;
  return { weekStart, list, monthShifts, weekShifts: list.length };
}

/** 全站总览 */
async function overview(ctx) {
  await asManager(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const days = await buildWeek(weekStart);
  const per = {};
  let posts = 0; let present = 0; let absent = 0; let leave = 0; let unmarked = 0;
  days.forEach((d) => d.slots.forEach((s) => s.people.forEach((x) => {
    posts += 1;
    if (x.status === ST.PRESENT) present += 1;
    else if (x.status === ST.ABSENT) absent += 1;
    else if (x.status === ST.LEAVE) leave += 1;
    else unmarked += 1;
    const k = x.personName || ('#' + x.personId);
    if (!per[k]) per[k] = { name: k, posts: 0, present: 0, absent: 0, leave: 0, unmarked: 0 };
    per[k].posts += 1;
    if (x.status === ST.PRESENT) per[k].present += 1;
    else if (x.status === ST.ABSENT) per[k].absent += 1;
    else if (x.status === ST.LEAVE) per[k].leave += 1;
    else per[k].unmarked += 1;
  })));
  const people = Object.keys(per).map((k) => per[k])
    .sort((a, b) => b.posts - a.posts || b.present - a.present);
  return { weekStart, summary: { posts, present, absent, leave, unmarked }, people };
}

module.exports = { week, mark, mine, overview, ST };
