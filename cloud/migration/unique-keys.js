'use strict';

/**
 * 阶段 8 · `unique_keys` 补登记（**纯函数**）
 *
 * ⭐ 这是整个阶段最容易漏的一步。
 * 云数据库没有 UNIQUE 索引，唯一性靠 `unique_keys` 集合里「固定 `_id` 占位」模拟
 * （见 `lib/db.js` 的 `reserveUnique`）。存量数据搬过去之后这个集合**是空的** ——
 * 不补登记的后果：云端还能再建一个同名管理员 / 同学号用户，**而且不报错**。
 *
 * ⚠️⚠️ **NULL 一律不登记**：
 *   MySQL 的 UNIQUE 允许**多行 NULL**（学生账号 openid 为 NULL；老微信用户 username 为 NULL）。
 *   若把 `user_openid:null` 登记进去，就只剩一行能占这个键 —— 与原语义相反。
 *
 * ⚠️ 字段名是 **snake_case**（`owner_id` / `create_time`）—— 与 `lib/db.js` 里
 *    `reserveUnique` 实际写入的形状逐字一致。这里是全项目极少数不按驼峰的地方，
 *    别"顺手改整齐"，改了就与运行时写的不一致。
 */

const { TABLES } = require('./tables');

function isBlank(v) { return v === null || v === undefined || v === ''; }

/**
 * @param {Object<string, Array>} docsByCollection  集合名 → 迁移后的文档数组
 * @param {Date} [now]
 * @returns {{ docs:Array, warnings:Array, errors:Array, stats:{ total:number } }}
 */
function buildUniqueKeys(docsByCollection, now) {
  const docs = [];
  const warnings = [];
  const errors = [];
  const seen = new Map();
  const when = now instanceof Date ? now : new Date(now || Date.now());

  TABLES.forEach((spec) => {
    const rows = docsByCollection[spec.name] || [];
    (spec.uniques || []).forEach((rule) => {
      rows.forEach((row) => {
        // 任一构成字段为空 → 跳过（MySQL UNIQUE 允许多个 NULL）
        if (rule.parts.some((p) => isBlank(row[p]))) return;
        const key = rule.parts.map((p) => String(row[p])).join(':');
        const _id = `${rule.scope}:${key}`;
        if (seen.has(_id)) {
          errors.push({
            table: spec.name, id: row.id, scope: rule.scope, key,
            message: `唯一键重复：${_id}（已有 id=${seen.get(_id)}，又遇 id=${row.id}）—— 源库数据本身违反 UNIQUE`,
          });
          return;
        }
        seen.set(_id, row.id);
        docs.push({ _id, scope: rule.scope, key, owner_id: row.id, create_time: when });
      });
    });
  });

  return { docs, warnings, errors, stats: { total: docs.length } };
}

module.exports = { buildUniqueKeys };
