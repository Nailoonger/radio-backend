'use strict';

/**
 * 阶段 8 · 行 → 云文档（**纯函数，无 IO**，故可被测试直接断言）
 *
 * 输入：Sequelize `findAll({ raw: true })` 的裸行（字段名已是驼峰）
 * 输出：可直接写进云数据库的文档 + warning / error 清单
 *
 * ⚠️ 本函数**不吞任何异常**：能修的修（记 warning），不能修的记 error 并**跳过该行**。
 *    「跳过」必须显式计数 —— 静默少搬几行的代价远大于导出时多打印几行红字。
 */

const { missingKeyParts, buildId } = require('./tables');
const { show } = require('./wire');

function isBlank(v) { return v === null || v === undefined || v === ''; }

/**
 * @param {object} spec  tables.js 的表规则（可由 export.js 补上 `dateFields`）
 * @param {Array}  rows  源行
 * @returns {{ collection:string, docs:Array, warnings:Array, errors:Array,
 *             stats:{ in:number, out:number, skipped:number, maxId:number } }}
 */
function transformTable(spec, rows) {
  const warnings = [];
  const errors = [];
  const docs = [];
  const seenId = new Map();     // _id -> 行号（业务键表查重）
  const seenNum = new Map();    // id  -> 行号（所有表查重）
  let maxId = 0;

  const dateFields = spec.dateFields || [];
  const jsonFields = spec.jsonFields || [];
  const snakeDupes = spec.snakeDupes || [];   // [[snake, camel], ...]

  (rows || []).forEach((raw, i) => {
    const at = `#${i + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push({ table: spec.name, at, id: null, message: '行不是对象' });
      return;
    }

    const row = Object.assign({}, raw);

    // ── 1. 数字主键归一 ────────────────────────────────────────────────
    // ⚠️ notice_ack.id / cleanup_log.id 在 MySQL 是 BIGINT UNSIGNED，
    //    mysql2 默认把它返回成**字符串**。不归一 → 前端按 id 查详情恒 404，且不报错。
    const numId = Number(row.id);
    if (!Number.isInteger(numId) || numId <= 0) {
      errors.push({ table: spec.name, at, id: row.id, message: `id 不是正整数（${show(row.id)}）` });
      return;
    }
    row.id = numId;
    if (numId > maxId) maxId = numId;

    if (seenNum.has(numId)) {
      errors.push({ table: spec.name, at, id: numId, message: `id 与第 ${seenNum.get(numId)} 行重复` });
      return;
    }
    seenNum.set(numId, at);

    // ── 2. `_id`：业务键 or 交给云端 ────────────────────────────────────
    let _id = null;
    if (spec.idRule.kind === 'business') {
      const missing = missingKeyParts(spec.idRule, row);
      if (missing.length) {
        // 拼出 `setting:null` 会让所有空键行塌成一条 —— 静默丢数据，必须拦
        errors.push({
          table: spec.name, at, id: numId,
          message: `业务键字段 ${missing.join(',')} 为空，无法拼 _id（跳过，避免塌成同一条）`,
        });
        return;
      }
      _id = buildId(spec.idRule, row);
      if (seenId.has(_id)) {
        errors.push({ table: spec.name, at, id: numId, message: `_id "${_id}" 与第 ${seenId.get(_id)} 行重复` });
        return;
      }
      seenId.set(_id, at);
    }

    // ── 3. JSON 文本字段反序列化 ────────────────────────────────────────
    jsonFields.forEach((f) => {
      const v = row[f];
      if (typeof v !== 'string' || !v.trim()) return;
      try {
        row[f] = JSON.parse(v);
      } catch (e) {
        // 解析失败**保留原串**并告警 —— 绝不静默置空（那是真丢数据）
        warnings.push({ table: spec.name, at, id: numId, field: f, message: `JSON 解析失败，保留原字符串：${e.message}` });
      }
    });

    // ── 4. 时间字段归一 ────────────────────────────────────────────────
    // ⚠️ 只处理 key==='DATE' 的字段。DATEONLY（weekly_schedule.weekStartDate）
    //    必须是 'YYYY-MM-DD' 字符串，转成 Date 会让 _id 变成 "week:Mon Sep 28 2026..."。
    dateFields.forEach((f) => {
      const v = row[f];
      if (v === null || v === undefined) return;
      if (v instanceof Date) return;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        warnings.push({ table: spec.name, at, id: numId, field: f, message: `时间字段无法解析（${show(v)}），保留原值` });
        return;
      }
      row[f] = d;
    });

    // ── 5. 去掉 Sequelize raw 多带出来的**裸下划线列名** ──────────────────
    //    `findAll({ raw: true })` 会把 `create_time AS createTime` 和 `create_time`
    //    两份都选出来（模型里既有显式属性、又开了 timestamps）。
    //    带进云库就违反「字段名一律驼峰」，且控制台导入时键名歧义更难排查。
    //    ⚠️ 只在**驼峰版本确实存在**时才删 —— 否则有可能是真的业务字段，删了就丢数据。
    snakeDupes.forEach(([snake, camel]) => {
      if (snake in row && camel in row) delete row[snake];
    });

    // ── 6. 去掉 undefined（JSON 序列化会直接丢键，不如这里显式处理）──────
    Object.keys(row).forEach((k) => { if (row[k] === undefined) delete row[k]; });

    docs.push(_id ? Object.assign({ _id }, row) : row);
  });

  return {
    collection: spec.name,
    docs,
    warnings,
    errors,
    stats: { in: (rows || []).length, out: docs.length, skipped: (rows || []).length - docs.length, maxId },
  };
}

module.exports = { transformTable };
