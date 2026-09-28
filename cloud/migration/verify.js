'use strict';

/**
 * 阶段 8 · 双向校验
 *
 * 「双向」= 两个方向都不留孤儿：
 *   正向（源 → 云）：源库每一行，云库都必须有一份，`_id`/`id` 对得上、**逐字段值相等**（含 NULL）
 *   反向（云 → 源）：云库每一份，源库都必须有对应行 —— 多出来的是孤儿（重复导入 / 手抖补数据）
 *
 * 另外单列两项结构性检查（它们错了不会体现在行数上，但会让线上行为错得很隐蔽）：
 *   - `unique_keys`：存量数据搬过去后这个集合是空的 → 能建重名管理员且不报错
 *   - `sequence`：预置错 → 新建记录与历史 id 撞号
 *
 * ⚠️ `_id` 相同的两份文档字段不同**必须报出来**（Upsert 模式重复导入最容易产生这个）。
 *
 * 用法：
 *   node cloud/migration/verify.js
 *   node cloud/migration/verify.js --snapshot cloud/migration/out/_snapshot.json --cloud cloud/migration/cloud-dump
 */

const fs = require('fs');
const path = require('path');
const { TABLES, byName } = require('./tables');
const { parseDocs, sameValue, show } = require('./wire');

const ROOT = path.resolve(__dirname, '..', '..');
const DEF_SNAPSHOT = path.join(ROOT, 'cloud', 'migration', 'out', '_snapshot.json');
const DEF_CLOUD = path.join(ROOT, 'cloud', 'migration', 'cloud-dump');

/** 该表在源侧的匹配键：业务键表用 `_id`，自增表用数字 `id` */
function matchKeyOf(spec) {
  return spec && spec.idRule && spec.idRule.kind === 'business' ? '_id' : 'id';
}

function indexDocs(docs, key) {
  const m = new Map();
  const dupes = [];
  docs.forEach((d) => {
    const k = String(d[key]);
    if (m.has(k)) dupes.push(k);
    else m.set(k, d);
  });
  return { map: m, dupes };
}

/**
 * @param {object} snapshot  _snapshot.json 的内容
 * @param {Object<string,Array>} cloudByName  集合名 → 云库文档
 * @returns {object} 报告
 */
function verify(snapshot, cloudByName) {
  const tables = [];
  const structural = [];

  (snapshot.tables || []).forEach((t) => {
    const spec = byName[t.name];
    const key = matchKeyOf(spec);
    const src = t.rows || [];
    const cloudDocs = cloudByName[t.name] || [];

    const { map: cloudMap, dupes } = indexDocs(cloudDocs, key);

    const missing = [];   // 源有云无
    const diffs = [];     // 字段级差异
    const seen = new Set();

    src.forEach((s) => {
      const k = String(s[key]);
      seen.add(k);
      const c = cloudMap.get(k);
      if (!c) { missing.push(k); return; }

      Object.keys(s).forEach((f) => {
        if (f === '_id') return;                       // 匹配键本身必然相等
        if (!(f in c)) { diffs.push({ key: k, field: f, kind: 'missing', src: s[f], cloud: undefined }); return; }
        if (!sameValue(s[f], c[f])) {
          diffs.push({ key: k, field: f, kind: 'value', src: s[f], cloud: c[f] });
        }
      });
      // 云端多出来的字段：不该有，但只算提醒（控制台导出可能带 _openid 之类）
      Object.keys(c).forEach((f) => {
        if (f === '_id' || f in s) return;
        diffs.push({ key: k, field: f, kind: 'extra', src: undefined, cloud: c[f] });
      });
    });

    const orphan = [];    // 云有源无
    cloudDocs.forEach((c) => {
      const k = String(c[key]);
      if (!seen.has(k)) orphan.push(k);
    });

    tables.push({
      name: t.name,
      srcCount: src.length,
      cloudCount: cloudDocs.length,
      missingCount: missing.length,
      orphanCount: orphan.length,
      diffCount: diffs.filter((d) => d.kind !== 'extra').length,
      dupeCount: dupes.length,
      missing: missing.slice(0, 20),
      orphan: orphan.slice(0, 20),
      diffs: diffs.slice(0, 20),
      dupes: dupes.slice(0, 20),
    });
  });

  // ── unique_keys ──────────────────────────────────────────────────
  const wantUk = (snapshot.uniqueKeys || []).map((d) => String(d._id));
  const gotUk = new Set((cloudByName.unique_keys || []).map((d) => String(d._id)));
  const ukMissing = wantUk.filter((k) => !gotUk.has(k));
  const ukOrphan = Array.from(gotUk).filter((k) => wantUk.indexOf(k) < 0);
  if (ukMissing.length || ukOrphan.length) {
    structural.push({
      item: 'unique_keys',
      wantCount: wantUk.length,
      gotCount: gotUk.size,
      missing: ukMissing.slice(0, 20),
      orphan: ukOrphan.slice(0, 20),
    });
  }

  // ── sequence ─────────────────────────────────────────────────────
  const seqBad = [];
  (snapshot.sequence || []).forEach((s) => {
    const hit = (cloudByName.sequence || []).find((d) => String(d._id) === String(s._id));
    if (!hit) { seqBad.push({ _id: s._id, want: s.value, got: null }); return; }
    if (Number(hit.value) !== Number(s.value)) seqBad.push({ _id: s._id, want: s.value, got: hit.value });
  });
  if (seqBad.length) structural.push({ item: 'sequence', bad: seqBad.slice(0, 20) });

  const badTables = tables.filter((t) => t.missingCount || t.orphanCount || t.diffCount || t.dupeCount
    || t.srcCount !== t.cloudCount);

  return {
    ok: badTables.length === 0 && structural.length === 0,
    tables,
    structural,
    summary: {
      tablesChecked: tables.length,
      tablesBad: badTables.length,
      rowsSrc: tables.reduce((a, t) => a + t.srcCount, 0),
      rowsCloud: tables.reduce((a, t) => a + t.cloudCount, 0),
      missing: tables.reduce((a, t) => a + t.missingCount, 0),
      orphan: tables.reduce((a, t) => a + t.orphanCount, 0),
      diffs: tables.reduce((a, t) => a + t.diffCount, 0),
      structural: structural.length,
    },
  };
}

/** 从一个目录读云库导出：文件名（去扩展名）= 集合名 */
function loadCloudDump(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((f) => {
    if (!/\.(json|jsonl|txt)$/i.test(f)) return;
    const name = f.replace(/\.(json|jsonl|txt)$/i, '');
    if (!byName[name] && name !== 'unique_keys' && name !== 'sequence') return; // 忽略无关文件
    out[name] = parseDocs(fs.readFileSync(path.join(dir, f), 'utf8'));
  });
  return out;
}

function render(report) {
  const L = [];
  L.push('══════ 阶段 8 · 双向校验 ══════');
  L.push('');
  report.tables.forEach((t) => {
    const bad = t.missingCount || t.orphanCount || t.diffCount || t.dupeCount || t.srcCount !== t.cloudCount;
    L.push(`${bad ? 'FAIL' : 'OK  '} ${t.name.padEnd(20)} 源 ${String(t.srcCount).padStart(5)} / 云 ${String(t.cloudCount).padStart(5)}`
      + `${t.missingCount ? `  缺 ${t.missingCount}` : ''}`
      + `${t.orphanCount ? `  孤 ${t.orphanCount}` : ''}`
      + `${t.diffCount ? `  字段差 ${t.diffCount}` : ''}`
      + `${t.dupeCount ? `  重复键 ${t.dupeCount}` : ''}`);
    if (t.missing.length) L.push(`       · 云库缺失：${t.missing.slice(0, 5).join(', ')}${t.missingCount > 5 ? ' …' : ''}`);
    if (t.orphan.length) L.push(`       · 云库多余：${t.orphan.slice(0, 5).join(', ')}${t.orphanCount > 5 ? ' …' : ''}`);
    t.diffs.slice(0, 5).forEach((d) => {
      L.push(`       · ${d.key} 字段 ${d.field} [${d.kind}] 源=${show(d.src)} 云=${show(d.cloud)}`);
    });
    if (t.dupes.length) L.push(`       · 云库重复匹配键：${t.dupes.slice(0, 5).join(', ')}`);
  });
  L.push('');
  report.structural.forEach((s) => {
    L.push(`FAIL 结构检查 ${s.item}`);
    if (s.item === 'unique_keys') {
      L.push(`       应有 ${s.wantCount} / 实有 ${s.gotCount}`);
      if (s.missing.length) L.push(`       · 缺登记：${s.missing.slice(0, 5).join(', ')}${s.missing.length > 5 ? ' …' : ''}`);
      if (s.orphan.length) L.push(`       · 多登记：${s.orphan.slice(0, 5).join(', ')}${s.orphan.length > 5 ? ' …' : ''}`);
    } else {
      s.bad.slice(0, 10).forEach((b) => L.push(`       · ${b._id} 应为 ${b.want}，实为 ${show(b.got)}`));
    }
  });
  const s = report.summary;
  L.push('');
  L.push(`结论：表 ${s.tablesChecked} 张 / 失败表 ${s.tablesBad} 张；`
    + `行 源 ${s.rowsSrc} / 云 ${s.rowsCloud}；缺 ${s.missing} / 孤 ${s.orphan} / 字段差 ${s.diffs} / 结构问题 ${s.structural}`);
  L.push(report.ok ? '全部一致 ✅' : '存在不一致 ❌ —— 见上面明细');
  return L.join('\n');
}

module.exports = { verify, loadCloudDump, render, matchKeyOf };

/* ────────────────── CLI ────────────────── */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const snapPath = path.resolve(get('snapshot', DEF_SNAPSHOT));
  const cloudDir = path.resolve(get('cloud', DEF_CLOUD));

  if (!fs.existsSync(snapPath)) {
    console.log(`找不到源快照：${snapPath}\n请先跑：node cloud/migration/export.js`);
    process.exit(2);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  // 快照里的 Date 已用 $date 包装，必须 revive 成 Date 才能与云库导出同口径比较
  const revived = {
    ...snapshot,
    tables: (snapshot.tables || []).map((t) => ({ ...t, rows: parseDocs(JSON.stringify(t.rows || [])) })),
  };
  const cloud = loadCloudDump(cloudDir);
  if (!Object.keys(cloud).length) {
    console.log(`云库导出目录为空或不存在：${cloudDir}\n请在云开发控制台逐集合「导出」JSON 放进去（文件名 = 集合名）`);
    process.exit(2);
  }
  const report = verify(revived, cloud);
  console.log(render(report));
  process.exit(report.ok ? 0 : 1);
}
