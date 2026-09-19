'use strict';

/**
 * 北京时间工具
 *
 * 为什么单独抽出来：后端容器没设 TZ（进程是 UTC），而 MySQL 容器是 Asia/Shanghai，
 * 时间字段由 MySQL 写。任何「按天 / 按周 / 下周」的计算如果直接用 dayjs()，
 * 日切点会落到北京时间早上 8 点。所以统一按固定 +08:00 偏移算，与进程 TZ 无关。
 *
 * 用法：拿到的 Date 是「真实 UTC 时刻」，可直接交给 Sequelize
 * （连接配置里 timezone: '+08:00'，会正确序列化）；要读「北京日历值」就配 shifted()。
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
