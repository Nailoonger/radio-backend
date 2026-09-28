'use strict';

/**
 * 阶段 8 · `sequence` 计数器预置（**纯函数**）
 *
 * 为什么必须预置：历史数据的 `id` 是 MySQL 自增产出的，而云端 `nextId()` 从 1 开始。
 * 云数据库只保证 `_id` 唯一、**不校验业务 `id`** —— 撞号是静默的：
 * 前端按 id 跳详情会拿到错的那一條，排查代价极高。
 *
 * ⚠️⚠️ **预置值 = max(id)，不是 max(id)+1**：
 *   `nextId()` 的语义是「`sequence.value` = 已发出的最后一个 id」，取号时**先 inc 再返回**：
 *       await seq.doc(scope).update({ value: _.inc(1) });   return value;   // 返回自增后的值
 *   所以预置 `max(id)` 时，第一次取号得到 `max(id)+1` ✅；
 *   若预置成 `max(id)+1`，第一次取号会得到 `max(id)+2`，白跳一个号（不致命但说明口径搞错了）。
 *   空表预置 `0` → 第一次取号得到 `1` ✅。
 *
 * > `lib/db.js` 的 `nextId()` 里还有一层兜底（首次建计数器时取「现有 max(id)+1」），
 * >   所以即使忘了预置也不会撞号。但**显式预置**把它变成可断言的产物，不依赖运行时兜底。
 */

const { TABLES } = require('./tables');

/**
 * @param {Array<{collection:string, stats:{maxId:number}}>} results  transformTable 的结果数组
 * @returns {Array<{_id:string, value:number}>}
 */
function buildSequence(results) {
  const out = [];
  const seen = new Set();
  TABLES.forEach((spec) => {
    if (seen.has(spec.name)) return;
    seen.add(spec.name);
    const hit = (results || []).find((r) => r.collection === spec.name);
    const maxId = hit && hit.stats ? Number(hit.stats.maxId) || 0 : 0;
    out.push({ _id: spec.name, value: maxId });
  });
  return out;
}

module.exports = { buildSequence };
