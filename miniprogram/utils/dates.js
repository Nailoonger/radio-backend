// utils/dates.js —— 纯日期字符串工具（'YYYY-MM-DD'）
//
// ⚠️⚠️ 只做「日期 → 日期」的加减与显示，**不回答「今天是哪一周」**。
//    周的锚点一律由云函数给（`currentWeekStart()` / `weekStart` 字段）：
//    小程序端自己 `new Date().getDay()` 算周一，在跨时区、跨月、系统时间被改过的手机上
//    会和后端差一周，而**班表错一周是无声的** —— 界面不会报错，只是内容不对。
//    （2026-10-31 起后端口径还多一条：周日 00:00 就算下一周，前端更不该自己算。）
//
// 全部走 UTC 的日历字段：'2026-11-02' 当作 UTC 零点解析，加减天数后再取回日历值，
// 这样夏令时、时区偏移都掺不进来。

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** '2026-11-02' ± n 天 → 'YYYY-MM-DD'；格式不对就原样返回（宁可显示错日期，也不抛异常） */
function addDays(ymd, n) {
  const m = YMD_RE.exec(String(ymd || ''));
  if (!m) return ymd || '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + (Number(n) || 0) * 86400000;
  const d = new Date(t);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** '2026-11-02' → '11/02' */
function md(ymd) {
  const m = YMD_RE.exec(String(ymd || ''));
  return m ? `${m[2]}/${m[3]}` : '';
}

/**
 * 一周的日期区间文案：'10/26 – 10/30'
 * @param {string} weekStart 周一（云函数给的，不要自己算）
 * @param {number} days      值班日数（默认 5：周一到周五）
 * ⚠️ 不要在这里拼「本周」两个字 —— 本周 / 非本周由页面上的 .wk-tag 胶囊负责，
 *    两处都写就会出现「非本周 11/02 – 11/06 本周」这种自相矛盾的双重标注。
 */
function rangeText(weekStart, days) {
  if (!weekStart) return '';
  const last = addDays(weekStart, (Number(days) || 5) - 1);
  return `${md(weekStart)} – ${md(last)}`;
}

module.exports = { addDays, md, rangeText };
