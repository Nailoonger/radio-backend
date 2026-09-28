'use strict';

/**
 * 北京时间工具 —— 从 src/utils/bjTime.js **原样移植**（零依赖，不含任何 Sequelize 引用）
 *
 * 为什么不能省：云函数运行环境同样是 UTC，而「按天 / 按周 / 点播周锚点」全部按北京时间算。
 * 直接用 new Date() 取日历日会落到错误的切点。
 *
 * 用法：拿到的 Date 是「真实 UTC 时刻」，写入云数据库即可；
 *       要读「北京日历值」就配 shifted()。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 把时间戳平移 +8h：对这个 Date 用 getUTC* 读到的就是北京时间 */
function shifted(ts = Date.now()) {
  return new Date(ts + TZ_OFFSET_MS);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间日历日：2026-09-18 */
function ymd(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 日 key：2026-09-18 */
function dayKey(ts) {
  return ymd(shifted(ts));
}

/** 周 key：2026-W38（ISO 周，周一为第一天） */
function weekKey(ts) {
  const d = shifted(ts);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;      // 周一 = 0
  t.setUTCDate(t.getUTCDate() - dow + 3);   // 移到本周四：ISO 周归属看周四
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDow + 3);
  const week = 1 + Math.round((t - firstThursday) / (7 * DAY_MS));
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/** 北京时间「今天」的起止（真实 UTC 时刻，左闭右开） */
function dayRange(ts) {
  const d = shifted(ts);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

/** 北京时间本周（周一 00:00 起）的起止 */
function weekRange(ts) {
  const d = shifted(ts);
  const dow = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - TZ_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 7 * DAY_MS) };
}

/** 北京时间「下一周」的起止（严格下一周：本周 +7 天，即使今天就是周一） */
function nextWeekRange(ts) {
  const r = weekRange(ts);
  return { start: new Date(r.start.getTime() + 7 * DAY_MS), end: new Date(r.end.getTime() + 7 * DAY_MS) };
}

/** 北京时间某个日期是周几（0=周日 … 6=周六） */
function weekdayOf(d) {
  return shifted(d).getUTCDay();
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

module.exports = {
  TZ_OFFSET_MS,
  DAY_MS,
  shifted,
  pad2,
  ymd,
  dayKey,
  weekKey,
  dayRange,
  weekRange,
  nextWeekRange,
  weekdayOf,
  WEEKDAY_CN,
};
