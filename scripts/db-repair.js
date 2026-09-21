'use strict';

/**
 * 一次性修表脚本：把线上旧库缺的「列」和「索引」补上。
 *
 * 背景（2026-09-21 服务器实况）：
 *   服务器 MySQL 的 submit 表还是点歌 v2 之前的旧结构，没有 scheduled_slot /
 *   queue_at / promoted_at；user 表也缺学生账号体系那批列（grade / class_no /
 *   pwd_changed_at / import_batch_id …）。启动时 sync({alter:true}) 在建
 *   idx_sched_status 索引时因列不存在炸掉，之后每次重启都重复报错。
 *
 * 做法：按各模型 rawAttributes 的 field 名逐一 describeTable 比对，缺的列用
 * queryInterface.addColumn 补（类型/可空/默认值取自模型定义）；再补缺失索引。
 * **只加不改不删**，幂等，可重复执行。
 *
 * 用法（在项目根目录）：
 *   node scripts/db-repair.js                     # 走环境变量里的库
 *   docker compose exec radio-backend node scripts/db-repair.js
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const models = require('../src/models');
const sequelize = models.sequelize;
const logger = require('../src/utils/logger');

async function main() {
  const qi = sequelize.getQueryInterface();
  let addedColumns = 0;
  let addedIndexes = 0;

  for (const model of sequelize.modelManager.models) {
    const table = model.getTableName();
    let desc;
    try {
      desc = await qi.describeTable(table);
    } catch (e) {
      console.log(`[skip] ${model.name}: 表还不存在（启动 sync 会创建）`);
      continue;
    }

    // ── 补缺失的列 ──
    const missing = Object.entries(model.rawAttributes)
      .filter(([, a]) => a.field && desc[a.field] === undefined);

    for (const [, a] of missing) {
      try {
        await qi.addColumn(table, a.field, {
          type: a.type,
          allowNull: a.allowNull === true ? true : (a.allowNull === false ? false : true),
          defaultValue: a.defaultValue,
          comment: a.comment,
        });
        console.log(`[column +] ${table}.${a.field}`);
        addedColumns += 1;
      } catch (e) {
        console.error(`[column !!] ${table}.${a.field}: ${e.message}`);
      }
    }

    // ── 补缺失的索引 ──
    let existing = new Set();
    try {
      existing = new Set((await qi.showIndex(table)).map((i) => i.name));
    } catch (e) { /* 个别方言不支持就跳过索引检查 */ }

    for (const idx of model.options.indexes || []) {
      const fields = (idx.fields || []).map((f) => (typeof f === 'string' ? f : f.name || f.attribute));
      const name = idx.name || `${typeof table === 'string' ? table : table.tableName}_${fields.join('_')}`;
      if (existing.has(name)) continue;
      try {
        await qi.addIndex(table, fields, {
          name,
          unique: !!idx.unique,
          where: idx.where,
        });
        console.log(`[index  +] ${name} (${fields.join(', ')})`);
        addedIndexes += 1;
      } catch (e) {
        console.error(`[index  !!] ${name}: ${e.message}`);
      }
    }

    if (!missing.length) console.log(`[ok] ${model.name} 列齐全`);
  }

  console.log(`\n完成：补列 ${addedColumns} 个，补索引 ${addedIndexes} 个。`);
  console.log('补完列后建议重启一次服务，让启动 sync 把剩余的差异跑完。');
  await sequelize.close();
}

main().catch((e) => {
  logger.error('[db-repair] 执行失败:', e.message);
  console.error(e);
  process.exit(1);
});
