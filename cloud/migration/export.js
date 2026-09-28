'use strict';

/**
 * 阶段 8 · 导出（**只读原库**）
 *
 * ⚠️⚠️ 铁律：本文件**只 SELECT，绝不写原库**。
 *     不含 sync / INSERT / UPDATE / DELETE 中的任何一个 —— 这不是洁癖，
 *     是「随时可切回原后端」的前提：迁移过程一旦改了源库，切回去就回不到原来的状态。
 *
 * 用法：
 *   node cloud/migration/export.js                        # 按 .env / 环境变量连库
 *   DB_DIALECT=sqlite DB_STORAGE=./data/_shot.db node cloud/migration/export.js   # 拿本地库试跑
 *   node cloud/migration/export.js --out /tmp/mig --shard 2000
 *
 * 产物（默认 `cloud/migration/out/`）：
 *   <collection>.jsonl       控制台导入用（JSON Lines，时间用 { $date } 包装）
 *   <collection>-2.jsonl …   超过 --shard 行时的后续分片
 *   unique_keys.jsonl        唯一键补登记
 *   sequence.jsonl           计数器预置
 *   _snapshot.json           双向校验基线
 *   _report.json             本次的 warning / error
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const { TABLES, SKIPPED } = require('./tables');
const { transformTable } = require('./transform');
const { buildUniqueKeys } = require('./unique-keys');
const { buildSequence } = require('./sequence');
const { toJsonLines, toWire } = require('./wire');

function arg(k, d) {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && process.argv[i + 1][0] !== '-' ? process.argv[i + 1] : d;
}

/**
 * 模型里「属性名 ≠ 列名」的映射 → `[snake, camel]`
 *
 * ⚠️ 为什么需要：`findAll({ raw: true })` 会把 `create_time AS createTime` 和**裸的 `create_time`**
 *    两份一起选出来（模型既有显式属性、又开了 timestamps）。带进云库就违反「字段名一律驼峰」，
 *    而且控制台导入时键名歧义极难排查。实测 admin 表就同时出现了这两份。
 */
function snakeDupesOf(Model) {
  const raw = (Model && Model.rawAttributes) || {};
  return Object.keys(raw)
    .map((k) => [raw[k] && raw[k].field, k])
    .filter(([f, k]) => f && f !== k);
}

/** Sequelize 属性 → 需要归一化成 Date 的字段名（DATEONLY 排除，它必须是 'YYYY-MM-DD' 字符串） */
function dateFieldsOf(Model) {
  const raw = (Model && Model.rawAttributes) || {};
  return Object.keys(raw).filter((k) => {
    const t = raw[k] && raw[k].type;
    return t && t.key === 'DATE';
  });
}

function shardWrite(dir, base, docs, shard) {
  const files = [];
  if (!docs.length) {
    const p = path.join(dir, `${base}.jsonl`);
    fs.writeFileSync(p, '');
    return [{ file: `${base}.jsonl`, count: 0 }];
  }
  const n = Math.max(1, Number(shard) || 5000);
  for (let i = 0, part = 1; i < docs.length; i += n, part++) {
    const slice = docs.slice(i, i + n);
    const fname = part === 1 ? `${base}.jsonl` : `${base}-${part}.jsonl`;
    fs.writeFileSync(path.join(dir, fname), toJsonLines(slice));
    files.push({ file: fname, count: slice.length });
  }
  return files;
}

(async () => {
  const outDir = path.resolve(arg('out', path.join(ROOT, 'cloud', 'migration', 'out')));
  const shard = Number(arg('shard', 5000)) || 5000;
  fs.mkdirSync(outDir, { recursive: true });

  // ── 连库（只为了读）─────────────────────────────────────────────────
  let models;
  try {
    models = require(path.join(ROOT, 'src', 'models'));
  } catch (e) {
    console.log(`加载源模型失败（DB 配置/依赖问题？）：${e.message}`);
    process.exit(2);
  }

  const now = new Date();
  const results = [];
  const allWarnings = [];
  const allErrors = [];
  const filesWritten = [];

  for (const spec of TABLES) {
    const Model = models[spec.model];
    if (!Model) { allErrors.push({ table: spec.name, message: `源模型 ${spec.model} 不存在` }); continue; }

    // ⚠️ user 的 defaultScope 排除 password；迁移必须显式带哈希，否则存量账号全部登不上
    const q = spec.scope ? Model.scope(spec.scope) : Model;
    let rows = [];
    try {
      rows = await q.findAll({ raw: true });
    } catch (e) {
      allErrors.push({ table: spec.name, message: `读取失败：${e.message}` });
      continue;
    }

    const r = transformTable({ ...spec, dateFields: dateFieldsOf(Model), snakeDupes: snakeDupesOf(Model) }, rows);
    results.push(r);
    r.warnings.forEach((w) => allWarnings.push(w));
    r.errors.forEach((e) => allErrors.push(e));

    shardWrite(outDir, spec.name, r.docs, shard).forEach((f) => filesWritten.push({ table: spec.name, ...f }));
  }

  // ── 辅助集合 ────────────────────────────────────────────────────────
  const docsByCollection = {};
  results.forEach((r) => { docsByCollection[r.collection] = r.docs; });

  const uk = buildUniqueKeys(docsByCollection, now);
  uk.errors.forEach((e) => allErrors.push(e));
  uk.warnings.forEach((w) => allWarnings.push(w));
  fs.writeFileSync(path.join(outDir, 'unique_keys.jsonl'), toJsonLines(uk.docs));

  const seq = buildSequence(results);
  fs.writeFileSync(path.join(outDir, 'sequence.jsonl'), toJsonLines(seq));

  // ── 快照（双向校验基线）────────────────────────────────────────────
  const snapshot = {
    generatedAt: now.toISOString(),
    source: {
      dialect: process.env.DB_DIALECT || 'sqlite',
      database: process.env.DB_NAME || process.env.DB_STORAGE || '',
    },
    skipped: SKIPPED,
    tables: results.map((r) => ({ name: r.collection, count: r.stats.in, rows: toWire(r.docs) })),
    uniqueKeys: toWire(uk.docs),
    sequence: toWire(seq),
  };
  fs.writeFileSync(path.join(outDir, '_snapshot.json'), JSON.stringify(snapshot, null, 2));

  const report = {
    generatedAt: now.toISOString(),
    tables: results.map((r) => ({
      table: r.collection, in: r.stats.in, out: r.stats.out, skipped: r.stats.skipped, maxId: r.stats.maxId,
    })),
    files: filesWritten,
    uniqueKeys: uk.stats.total,
    sequence: seq,
    warnings: allWarnings,
    errors: allErrors,
  };
  fs.writeFileSync(path.join(outDir, '_report.json'), JSON.stringify(report, null, 2));

  // ── 打印 ────────────────────────────────────────────────────────────
  const L = [];
  L.push('══════ 阶段 8 · 导出 ══════');
  L.push(`输出目录：${outDir}`);
  L.push('');
  results.forEach((r) => {
    L.push(`${r.errors.length || r.stats.skipped ? 'WARN' : 'OK  '} ${r.collection.padEnd(20)} `
      + `读 ${String(r.stats.in).padStart(5)} → 写 ${String(r.stats.out).padStart(5)}  maxId=${r.stats.maxId}`);
  });
  L.push('');
  L.push(`unique_keys 补登记 ${uk.stats.total} 条 → unique_keys.jsonl`);
  L.push(`sequence 预置 ${seq.length} 条 → sequence.jsonl`);
  SKIPPED.forEach((s) => L.push(`跳过 ${s.name} —— ${s.reason}`));
  if (allWarnings.length) {
    L.push('');
    L.push(`warning ${allWarnings.length} 条：`);
    allWarnings.slice(0, 20).forEach((w) => L.push(`  · [${w.table}] id=${w.id} ${w.field || ''} ${w.message}`));
  }
  if (allErrors.length) {
    L.push('');
    L.push(`error ${allErrors.length} 条（**这些行没有导出**，必须处理）：`);
    allErrors.slice(0, 40).forEach((e) => L.push(`  · [${e.table}] ${e.at || ''} id=${e.id} ${e.message}`));
  }
  L.push('');
  L.push(`结论：表 ${results.length} 张 / 行 ${results.reduce((a, r) => a + r.stats.out, 0)} 条`
    + ` / warning ${allWarnings.length} / error ${allErrors.length}`);
  console.log(L.join('\n'));

  if (models.sequelize) { try { await models.sequelize.close(); } catch (e) { /* 只读脚本，关闭失败无所谓 */ } }
  process.exit(allErrors.length ? 1 : 0);
})();
