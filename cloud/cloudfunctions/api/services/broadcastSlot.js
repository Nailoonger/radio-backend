'use strict';

/**
 * 点歌播出时段 —— 从 src/services/broadcastSlotService.js 移植（**只读部分**）
 *
 * 规则（用户 2026-09-18 要求）：
 *   1. 不允许用户手输播出时间，改成从系统给的可选列表里挑；
 *   2. 可选范围**只有下一周的周一到周五**（严格下一周：今天是周一也跳到下周一）；
 *   3. 每天的可选时段来自系统设置 `broadcast_schedule`，解析不出来时退回默认三个时段。
 *
 * 提交时服务端用 isValidSlot() 再校验一次 —— 前端的下拉框只是交互，
 * 真正的约束必须在服务端（否则直接调接口就能存任意时间）。
 *
 * ═══════════════ 云化改动 ═══════════════
 * ① 去掉 `scheduleMatrix()` / `sweepFullSlots()`：源文件自己标注「v2 起仅为兼容保留，
 *    新代码不要用」（占用口径已改成 scheduledSlot，判满由 songSchedulingService 负责）。
 *    移植这些死代码只会把 v1 口径带进云版，故不搬。
 * ② 三处 `GROUP BY` 改成 countByField / findAllPaged（云数据库没有云端 GROUP BY，
 *    且单次 get 上限 100 条）—— 结果集相同，只是聚合挪到 JS 里做。
 * ③ 读缓存 TTL 30s 降级为「实例内」。
 *
 * ⚠️ getSlots() 返回的 `picked` / `full` 是 **v1 口径**（数的是 `wantBroadcastTime` = 首选时段），
 *    源文件已注明「调用方请用 songQueue.slotUsage() 覆盖，别直接信任」。学生端 timeslots
 *    走的就是这条路径 —— 保持原样，不要「顺手修正」，否则前端展示会变。
 */

const bj = require('../lib/bjTime');
const kv = require('./kv');
const { C, _, countByField, findAllPaged } = require('../lib/db');

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

/** 生成 slot 的规范值：`2026-09-21 午间 12:20`（存进 submit.wantBroadcastTime） */
function slotValue(dateStr, period, time) {
  return `${dateStr} ${period} ${time}`;
}

/**
 * 可选时段列表
 * @returns {Promise<{weekStart, weekEnd, rangeText, periods, list}>}
 *
 * list 里每项额外带：
 *   picked —— 该时段已占用的点歌数（待审 + 已通过）【v1 口径，见文件头】
 *   full   —— 是否已排满（每场上限取自 KV song_slot_capacity，0 / 未设置 = 不限）
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
    const values = list.map((s) => s.value);
    // 原 SQL: WHERE type=1 AND status IN (0,1) AND want_broadcast_time IN (values) GROUP BY want_broadcast_time
    const used = await countByField(
      C.SUBMIT,
      { type: 1, status: _.in([0, 1]), wantBroadcastTime: _.in(values) },
      'wantBroadcastTime'
    );
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

/** 该时段值是否属于「严格下一周」的播出范围（校验用，等价 isValidSlot 但更省） */
const SLOT_FULL_REASON = '该播出时段已排满，系统自动驳回';

/**
 * 本周（当前播出周）周一~周五的「已排期」点歌视图 —— 小程序首页展示用（2026-09-21）
 *
 * 口径：
 *   · 只算 status=1（已排期）且 scheduledSlot 落在本周格子里的点歌；
 *     待审 / 候补 / 驳回一律不上首页。
 *   · **不带点歌人信息**（学生姓名 / 班级不下发）。
 *   · 开关 home_song_schedule 由调用方（handlers/user/submit.weekSchedule）把关，这里只管数据。
 */
async function currentWeekSchedule(now = Date.now()) {
  const periods = await getPeriods();
  const { start } = bj.weekRange(now);          // 本周一 00:00（北京）
  const todayKey = bj.dayKey(now);
  const days = [];
  const values = [];

  for (let i = 0; i < 5; i++) {
    const d = new Date(start.getTime() + i * bj.DAY_MS);
    const dateStr = bj.ymd(bj.shifted(d.getTime()));
    const wd = bj.WEEKDAY_CN[bj.weekdayOf(d.getTime())];
    const md = dateStr.slice(5);
    days.push({
      date: dateStr,
      weekday: '周' + wd,
      monthDay: md,
      isToday: dateStr === todayKey,
      slots: periods.map((p) => slotValue(dateStr, p.period, p.time)),
    });
    days[days.length - 1].slots.forEach((v) => values.push(v));
  }

  // fail-open：读路径，查询失败按「无排期」展示，不影响首页其它内容
  const songsBySlot = {};
  try {
    const rows = await findAllPaged(
      C.SUBMIT,
      { type: 1, status: 1, scheduledSlot: _.in(values) },
      { orderBy: [['id', 'asc']] }
    );
    rows.forEach((r) => {
      if (!r.scheduledSlot || !r.songName) return;
      (songsBySlot[r.scheduledSlot] = songsBySlot[r.scheduledSlot] || []).push(r.songName);
    });
  } catch (e) {
    console.warn(`[broadcastSlot] currentWeekSchedule 查询失败：${e.message}`);
  }

  const out = days.map((day) => {
    const songs = [];
    day.slots.forEach((value) => {
      const parts = value.split(' ');           // `2026-09-21 午间 12:20` → [日期, 时段, 时刻]
      (songsBySlot[value] || []).forEach((title) => {
        songs.push({ time: parts[2], period: parts[1], title });
      });
    });
    return {
      date: day.date,
      weekday: day.weekday,
      monthDay: day.monthDay,
      isToday: day.isToday,
      songs,
    };
  });

  const first = days[0];
  const last = days[days.length - 1];
  return { rangeText: first && last ? `${first.monthDay} ~ ${last.monthDay}` : '', days: out };
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
  slotValue,
  SLOT_FULL_REASON,
  currentWeekSchedule,
};
