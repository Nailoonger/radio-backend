'use strict';

/**
 * 调剂选址成本表（《V1 规格》第 10 节）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 把「候补的人该被调到哪一格」从「周内下标距离最小」换成显式成本表：
 *
 *   同一天其他时段        10
 *   前 / 后一天相同时段    20
 *   前 / 后一天其他时段    30
 *   更远日期              50
 *   不可接受              ∞
 *   —— 选 cost 最小的那个格子
 *
 * 与下标距离的差别（这正是之前对不上规格的地方）：
 *   下标差把「周一晚 → 周二早」(差 1) 与「周一晚 → 周一午」(差 1) 当成一样近，
 *   而按成本表应当是 周一午 10 < 周二早 30 —— 跨天的相邻时段不该被当成同天邻近。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 时段值形如 `2026-09-21 午间 12:20`（日期 + 时段名 + 时刻），由
 * `broadcastSlotService` 派生，这里只做纯字符串解析，不碰数据库。
 */

const DAY_MS = 86400000;

/** 成本档位（对外导出，便于接口/文档引用同一份数字） */
const COST = {
  SELF: 0,                      // 就是首选的这一格
  SAME_DAY: 10,                 // 同一天的其他时段
  ADJACENT_SAME_PERIOD: 20,     // 前 / 后一天的同一时段
  ADJACENT_OTHER_PERIOD: 30,    // 前 / 后一天的其他时段
  FARTHER: 50,                  // 更远的日期（同一播出周内）
  UNACCEPTABLE: Infinity,       // 不可接受（跨周 / 解析不出来）
};

const COST_LABEL = {
  0: '首选时段',
  10: '同一天其他时段',
  20: '前后一天相同时段',
  30: '前后一天其他时段',
  50: '更远日期',
  Infinity: '不可接受',
};

/** `2026-09-21 午间 12:20` → { date, period, time }；解析不出返回 null */
function parseSlot(value) {
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(\d{1,2}:\d{2})$/);
  if (!m) return null;
  return { date: m[1], period: m[2], time: m[3] };
}

/** 北京日期串 → 第几天（用于算天差，不受时区影响） */
function dayNumber(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/**
 * 两个时段之间的调剂成本。
 *
 * 判据用的是「相隔天数 + 是否同一时段（时段名与时刻都相同）」，
 * 而**不是**周内格子下标 —— 下标会把跨天相邻与同天相邻混为一谈。
 *
 * 本系统的可选时段固定是**下一周的周一到周五**（`broadcastSlotService`），
 * 所以同周内天差最多 4；天差 ≥ 5 必然是跨周 → 不可接受。
 *
 * @returns {number} 0 / 10 / 20 / 30 / 50 / Infinity
 */
function costBetween(fromValue, toValue) {
  const a = parseSlot(fromValue);
  const b = parseSlot(toValue);
  if (!a || !b) return COST.UNACCEPTABLE;

  const days = Math.abs(dayNumber(b.date) - dayNumber(a.date));
  if (days >= 5) return COST.UNACCEPTABLE;                 // 跨周

  const samePeriod = a.period === b.period && a.time === b.time;
  if (days === 0) return samePeriod ? COST.SELF : COST.SAME_DAY;
  if (days === 1) return samePeriod ? COST.ADJACENT_SAME_PERIOD : COST.ADJACENT_OTHER_PERIOD;
  return COST.FARTHER;
}

/** 成本的中文说明（接口 / 日志 / 预览用） */
function describeCost(fromValue, toValue) {
  const c = costBetween(fromValue, toValue);
  return { cost: c === Infinity ? null : c, text: COST_LABEL[c] || '' };
}

/**
 * 从一组候选格子里挑 cost 最小的那个。
 * cost 相同时按周内下标升序 —— 保证同样输入永远得到同样结果（可复现），
 * 否则排序不稳定会让「手动重跑排期」的结果飘。
 *
 * @param {string[]} options 可选的目标格
 * @param {string}   want    首选格
 * @param {Map<string,number>} indexOf 格子 → 周内下标
 * @returns {string} 选中的格子
 */
function pickBest(options, want, indexOf) {
  const list = options.slice();
  list.sort((x, y) => {
    const cx = costBetween(want, x);
    const cy = costBetween(want, y);
    if (cx !== cy) {
      if (cx === Infinity) return 1;
      if (cy === Infinity) return -1;
      return cx - cy;
    }
    return (indexOf.get(x) ?? 999) - (indexOf.get(y) ?? 999);
  });
  return list[0];
}

/** 用于 sort 比较：Infinity 不能直接相减（Infinity - Infinity = NaN） */
function compareCost(a, b) {
  if (a === b) return 0;
  if (a === Infinity) return 1;
  if (b === Infinity) return -1;
  return a - b;
}

module.exports = {
  COST,
  COST_LABEL,
  DAY_MS,
  parseSlot,
  dayNumber,
  costBetween,
  describeCost,
  pickBest,
  compareCost,
};
