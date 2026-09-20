'use strict';

/**
 * 点歌播出时段（系统下发，用户只能选）
 *
 * 规则（用户 2026-09-18 要求）：
 *   1. 不允许用户手输播出时间，改成从系统给的可选列表里挑；
 *   2. 可选范围**只有下一周的周一到周五**（严格下一周：今天是周一也跳到下周一）；
 *   3. 每天的可选时段来自系统设置 `broadcast_schedule`（例如「07:20 / 12:20 / 17:30」），
 *      解析不出来时退回到默认的三个时段，保证功能不会因为设置没配而不可用。
 *
 * 提交时服务端会用 isValidSlot() 再校验一次 —— 前端的下拉框只是交互，
 * 真正的约束必须在服务端（否则直接调接口就能存任意时间）。
 */

const bj = require('../utils/bjTime');
const kv = require('./kvService');

const KV_SCHEDULE = 'broadcast_schedule';
const KV_SLOT_TIMES = 'song_slot_times';   // 后台发布的时段列表（JSON），优先于 broadcast_schedule
const KV_CAPACITY = 'song_slot_capacity';  // 每个时段可排的点歌数，0 / 未设置 = 不限
const DEFAULT_TIMES = ['07:20', '12:20', '17:30'];
const MAX_SLOTS = 6;
const CACHE_TTL = 30 * 1000;

let cache = null;
let cacheAt = 0;

function clearCache() { cache = null; cacheAt = 0; }

/** 每场名额上限（0 = 不限）；读不到按不限处理 */
async function getCapacity() {
  try {
    const n = parseInt(await kv.get(KV_CAPACITY, '0'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/** 设置每场名额上限（0 = 不限） */
async function setCapacity(n) {
  const v = Math.max(parseInt(n, 10) || 0, 0);
  await kv.set(KV_CAPACITY, v, '每个播出时段可排的点歌数（0=不限）');
  return v;
}

/** 早间 / 午间 / 晚间：按时段起点的小时判断，够用且不依赖配置文案 */
function periodOf(hour) {
  if (hour < 10) return '早间';
  if (hour < 15) return '午间';
  return '晚间';
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 把后台传进来的时段列表归一化；非法项直接丢掉，全非法则返回空数组 */
function normalizeTimes(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((item) => {
    const time = String((item && item.time) || item || '').trim();
    if (!HHMM.test(time) || seen.has(time)) return;
    seen.add(time);
    const label = String((item && item.label) || '').trim().slice(0, 8);
    out.push({ time, label: label || periodOf(parseInt(time.slice(0, 2), 10)) });
  });
  out.sort((a, b) => (a.time < b.time ? -1 : 1));
  return out.slice(0, MAX_SLOTS);
}

function parseCustom(raw) {
  if (!raw) return [];
  try {
    return normalizeTimes(JSON.parse(String(raw)));
  } catch (e) {
    return [];      // 手工改坏了就退回下一级来源，不要让功能挂掉
  }
}

/** 解析 broadcast_schedule 里的 HH:mm（兼容「07:20 / 12:20 / 17:30」这种写法） */
async function fromSchedule() {
  try {
    const raw = await kv.get(KV_SCHEDULE, '');
    return normalizeTimes(
      (String(raw).match(/\b\d{1,2}:\d{2}\b/g) || []).map((t) => {
        const [h, m] = t.split(':');
        return { time: bj.pad2(parseInt(h, 10)) + ':' + m };
      })
    );
  } catch (e) {
    return [];
  }
}

/**
 * 时段来源：① 后台发布的 song_slot_times → ② broadcast_schedule → ③ 默认三个
 * @returns {Promise<{list:Array<{time,label}>, source:'custom'|'schedule'|'default'}>}
 */
async function getSlotSource() {
  const custom = parseCustom(await kv.get(KV_SLOT_TIMES, ''));
  if (custom.length) return { list: custom, source: 'custom' };
  const sched = await fromSchedule();
  if (sched.length) return { list: sched, source: 'schedule' };
  return { list: normalizeTimes(DEFAULT_TIMES.map((t) => ({ time: t }))), source: 'default' };
}

async function getPeriods() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;
  const { list } = await getSlotSource();
  cache = list.map((x) => ({ time: x.time, period: x.label }));
  cacheAt = now;
  return cache;
}

/** 后台发布 / 修改时段（用户 2026-09-18 要求可在后台维护） */
async function setSlotTimes(list, capacity) {
  const norm = normalizeTimes(list);
  if (!norm.length) {
    const err = new Error('至少要有一个合法时段，格式 HH:mm，最多 ' + MAX_SLOTS + ' 个');
    err.code = 40001;
    throw err;
  }
  await kv.set(KV_SLOT_TIMES, JSON.stringify(norm), '点歌可选时段（后台发布，JSON）');
  if (capacity !== undefined && capacity !== null && capacity !== '') {
    await setCapacity(capacity);
  }
  clearCache();
  return getAdminConfig();
}

/** 后台读取：当前生效的时段 + 来源 + 每天可选日期范围文案 */
async function getAdminConfig(now = Date.now()) {
  const { list, source } = await getSlotSource();
  const slots = await getSlots(now);
  return {
    times: list,
    source,                    // custom = 已由后台发布；schedule = 取自 broadcast_schedule；default = 默认值
    maxSlots: MAX_SLOTS,
    capacity: slots.capacity,  // 每场名额上限（0 = 不限）
    weekStart: slots.weekStart,
    weekEnd: slots.weekEnd,
    rangeText: slots.rangeText,
    count: slots.list.length,
    fullCount: slots.list.filter((s) => s.full).length,
  };
}

/** 生成 slot 的规范值：`2026-09-21 午间 12:20`（存进 submit.want_broadcast_time） */
function slotValue(dateStr, period, time) {
  return `${dateStr} ${period} ${time}`;
}

/**
 * 可选时段列表
 * @returns {Promise<{weekStart, weekEnd, rangeText, periods, list}>}
 *
 * list 里每项额外带：
 *   picked —— 该时段已占用的点歌数（待审 + 已通过）
 *   full   —— 是否已排满（每场上限取自 KV song_slot_capacity，0 / 未设置 = 不限）
 * 用户端弹层据此把「已排满」的场次划掉、不可选（v8 方案 ④ 的要求）。
 */
async function getSlots(now = Date.now()) {
  const periods = await getPeriods();
  const { start } = bj.nextWeekRange(now);
  const list = [];

  // 下一周的周一 ~ 周五
  for (let i = 0; i < 5; i++) {
    const d = new Date(start.getTime() + i * bj.DAY_MS);
    const dateStr = bj.ymd(bj.shifted(d.getTime()));
    const wd = bj.WEEKDAY_CN[bj.weekdayOf(d.getTime())];
    const md = dateStr.slice(5);                       // 09-21
    periods.forEach((p) => {
      list.push({
        key: `${dateStr}_${p.time}`,
        date: dateStr,
        weekday: '周' + wd,
        monthDay: md,
        period: p.period,
        time: p.time,
        label: `周${wd} ${md} · ${p.period} ${p.time}`,
        shortLabel: `周${wd} ${p.period}`,
        value: slotValue(dateStr, p.period, p.time),
      });
    });
  }

  // ── 占用统计（fail-open：统计失败不影响可选列表本身）──
  const capacity = await getCapacity();
  try {
    const { Submit } = require('../models');
    const { Op, fn, col } = require('sequelize');
    const values = list.map((s) => s.value);
    const rows = await Submit.findAll({
      where: { type: 1, status: { [Op.in]: [0, 1] }, wantBroadcastTime: { [Op.in]: values } },
      attributes: ['wantBroadcastTime', [fn('COUNT', col('id')), 'n']],
      group: ['wantBroadcastTime'],
      raw: true,
    });
    const used = {};
    rows.forEach((r) => { used[r.wantBroadcastTime] = Number(r.n) || 0; });
    list.forEach((s) => {
      s.picked = used[s.value] || 0;
      s.full = capacity > 0 && s.picked >= capacity;
    });
  } catch (e) {
    list.forEach((s) => { s.picked = 0; s.full = false; });
  }

  const first = list[0];
  const last = list[list.length - 1];
  return {
    weekStart: first ? first.date : '',
    weekEnd: last ? last.date : '',
    rangeText: first && last ? `${first.monthDay} ~ ${last.monthDay}` : '',
    periods: periods.map((p) => ({ period: p.period, time: p.time })),
    capacity,
    list,
  };
}

/** 校验用户选的值是不是系统下发过的（服务端硬约束） */
async function isValidSlot(value, now = Date.now()) {
  if (!value) return false;
  const { list } = await getSlots(now);
  return list.some((s) => s.value === String(value).trim());
}

/* ==================================================================== *
 * 审核即排期（用户 2026-09-19 定稿的机制）
 *
 * ⚠️ v2（2026-09-20，docs/song-queue-v2.md）起：
 *   · 每格的占用口径改成 **scheduled_slot（实际排期）**，不再数 want_broadcast_time；
 *   · 容量校验、满格自动驳回、排期矩阵都搬到了 `songQueueService`
 *     （promote / closeQueueIfFull / finalizeDueWeeks / slotUsage）；
 *   · 本节的 scheduleMatrix() 与 sweepFullSlots() 仅为兼容保留，**新代码不要用**；
 *   · getSlots() 里的 picked / full 是 v1 口径（数的是首选时段），
 *     调用方请用 songQueueService.slotUsage() 覆盖，别直接信任。
 *
 * 背景：学生投稿时 want_broadcast_time 就被锁定为「严格的下一周周一~周五」，
 * 所以每首待审点歌自带排期目标。管理员只要在本周周末把待审池清完，
 * 下一周的排期表就自动完整 —— 不需要一天天审。
 *
 * 本节补上缺的三环：
 *   ① scheduleMatrix()   下周排期矩阵（5 天 × N 时段，每格 已排/待审/容量）
 *   ② sweepFullSlots()   时段排满 → 该时段剩余待审自动驳回（幂等，与名额
 *                        sweep 同构；auto_rejected=1 天然不占学生周次数，
 *                        因为周次数是实时 COUNT 且排除 auto_rejected）
 *   ③ 通过时的容量校验放在 submitController.approveOne（事务内 COUNT）
 *
 * 并发权衡（写在这里，别拍脑袋改）：
 *   容量判定数的是 submit 表里 status=1 的实数（自然键 want_broadcast_time），
 *   不建计数行表 —— 因为学生端「待审+已通过都算占位」已经把同一时段的
 *   投稿源头掐住了，管理员双击同一格最后两个空位的窗口极小，且 sweep
 *   会把满格时段的剩余待审立刻清掉。真实源就是 submit 本身，没有双写。
 * ==================================================================== */

const SLOT_FULL_REASON = '该播出时段已排满，系统自动驳回';

/**
 * 下周排期矩阵：每格分开统计 已通过(approved) / 待审(pending)
 * getSlots 的 picked 是 0+1 合计，排期视图需要分开 → 这里自己 GROUP BY
 * @returns {{weekStart, weekEnd, rangeText, capacity, totalPending, days}}
 */
async function scheduleMatrix(now = Date.now()) {
  const { list, capacity, weekStart, weekEnd, rangeText } = await getSlots(now);
  const values = list.map((s) => s.value);

  // fail-open：统计挂了按 0 处理，不影响矩阵结构
  const approvedMap = {};
  const pendingMap = {};
  try {
    const { Submit } = require('../models');
    const { Op, fn, col, literal } = require('sequelize');
    const rows = await Submit.findAll({
      where: { type: 1, status: { [Op.in]: [0, 1] }, wantBroadcastTime: { [Op.in]: values } },
      attributes: [
        'wantBroadcastTime',
        [literal(`SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END)`), 'approved'],
        [literal(`SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END)`), 'pending'],
      ],
      group: ['wantBroadcastTime'],
      raw: true,
    });
    rows.forEach((r) => {
      approvedMap[r.wantBroadcastTime] = Number(r.approved) || 0;
      pendingMap[r.wantBroadcastTime] = Number(r.pending) || 0;
    });
  } catch (e) {
    // 静默：矩阵是读路径
  }

  // 按天分组（list 本身就是按天顺序生成的）
  const days = [];
  let byDate = null;
  list.forEach((s) => {
    if (!byDate || byDate.date !== s.date) {
      byDate = { date: s.date, weekday: s.weekday, monthDay: s.monthDay, slots: [] };
      days.push(byDate);
    }
    const approved = approvedMap[s.value] || 0;
    const pending = pendingMap[s.value] || 0;
    byDate.slots.push({
      value: s.value,
      time: s.time,
      period: s.period,
      label: s.label,
      approved,
      pending,
      capacity,
      full: capacity > 0 && approved >= capacity,
      // 排满后剩余待审会被 sweep 自动驳回，这里直接给管理员预期提示
      willAutoReject: capacity > 0 && approved >= capacity && pending > 0,
    });
  });

  const totalPending = Object.values(pendingMap).reduce((a, b) => a + b, 0);
  return { weekStart, weekEnd, rangeText, capacity, totalPending, days };
}

/**
 * 时段排满 → 把满格时段的待审点歌自动驳回（幂等：WHERE status=0）
 * 与名额 sweep 同构：只改 status=0 的行，重复跑只命中更少行。
 * auto_rejected=1 → 不占学生周次数（周次数实时 COUNT 且排除 auto_rejected）。
 * @returns {Promise<number>} 驳回条数
 */
async function sweepFullSlots(now = Date.now()) {
  try {
    const capacity = await getCapacity();
    if (!(capacity > 0)) return 0;          // 0 / 未设置 = 不限，永不 sweep
    const { list } = await getSlots(now);
    const values = list.map((s) => s.value);
    if (!values.length) return 0;

    const { Submit } = require('../models');
    const { Op, fn, col } = require('sequelize');
    const rows = await Submit.findAll({
      where: { type: 1, status: 1, wantBroadcastTime: { [Op.in]: values } },
      attributes: ['wantBroadcastTime', [fn('COUNT', col('id')), 'n']],
      group: ['wantBroadcastTime'],
      raw: true,
    });
    const fullValues = rows
      .filter((r) => (Number(r.n) || 0) >= capacity)
      .map((r) => r.wantBroadcastTime);
    if (!fullValues.length) return 0;

    const [affected] = await Submit.update(
      {
        status: 2,
        rejectReason: SLOT_FULL_REASON,
        autoRejected: 1,
        reviewerId: null,
        reviewTime: new Date(),
      },
      {
        where: {
          type: 1,
          status: 0,                        // 只动还没审的 → 幂等
          wantBroadcastTime: { [Op.in]: fullValues },
        },
      }
    );
    return affected;
  } catch (e) {
    // 读路径宽容：sweep 失败只记日志，不影响审核主流程（下次通过时会重跑）
    console.warn(`[broadcastSlot] sweepFullSlots 失败：${e.message}`);
    return 0;
  }
}

module.exports = {
  KV_SCHEDULE,
  KV_SLOT_TIMES,
  KV_CAPACITY,
  DEFAULT_TIMES,
  MAX_SLOTS,
  getPeriods,
  getSlots,
  getSlotSource,
  getAdminConfig,
  getCapacity,
  setCapacity,
  setSlotTimes,
  isValidSlot,
  clearCache,
  SLOT_FULL_REASON,
  scheduleMatrix,
  sweepFullSlots,
};
