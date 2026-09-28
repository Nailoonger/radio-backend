'use strict';

/**
 * 云函数同步脚本
 *
 * 为什么需要：微信开发者工具的 `cloudfunctionRoot` 必须位于**项目目录内**（即 miniprogram/ 下），
 * 不接受仓库根目录外的路径。而我们的源文件按规划放在 cloud/cloudfunctions/（与 src/ 平行、便于对照）。
 * 因此用本脚本做单向镜像：cloud/cloudfunctions/ → miniprogram/cloudfunctions/
 *
 * 用法：
 *   node cloud/scripts/sync.js           # 同步（覆盖 + 清理多余文件）
 *   node cloud/scripts/sync.js --check   # 只校验是否一致（CI / 自检用，不一致退出码 1）
 *
 * ⚠️ 只往 miniprogram/cloudfunctions 单向写；**永远不要**手改那边，改完下次同步就没了。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'cloud', 'cloudfunctions');
const DST = path.join(ROOT, 'miniprogram', 'cloudfunctions');

const IGNORE = new Set(['node_modules', '.DS_Store', 'Thumbs.db']);

function walk(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (IGNORE.has(e.name)) return;
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  });
  return out;
}

function run(checkOnly) {
  const srcFiles = walk(SRC);
  const dstFiles = walk(DST);

  const missing = srcFiles.filter((f) => !dstFiles.includes(f));
  const extra = dstFiles.filter((f) => !srcFiles.includes(f));
  const diff = srcFiles.filter((f) => {
    if (!dstFiles.includes(f)) return false;
    const a = fs.readFileSync(path.join(SRC, f));
    const b = fs.readFileSync(path.join(DST, f));
    return !a.equals(b);
  });

  if (checkOnly) {
    const problems = missing.length + extra.length + diff.length;
    if (problems) {
      console.log('[sync:check] 不一致 →');
      if (missing.length) console.log('  缺失：', missing.join(', '));
      if (extra.length) console.log('  多余：', extra.join(', '));
      if (diff.length) console.log('  内容不同：', diff.join(', '));
      console.log('  修复：node cloud/scripts/sync.js');
      process.exit(1);
    }
    console.log(`[sync:check] 一致（${srcFiles.length} 个文件）`);
    return;
  }

  // 同步：先清理多余文件，再覆盖写入
  extra.forEach((f) => {
    try { fs.unlinkSync(path.join(DST, f)); } catch (e) {}
  });

  srcFiles.forEach((f) => {
    const from = path.join(SRC, f);
    const to = path.join(DST, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  });

  // 防止「多余的空目录」长期残留
  const pruneEmpty = (dir) => {
    if (!fs.existsSync(dir)) return false;
    let empty = true;
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory()) {
        if (!pruneEmpty(path.join(dir, e.name))) empty = false;
      } else empty = false;
    });
    if (empty && dir !== DST) { try { fs.rmdirSync(dir); } catch (e) {} }
    return empty;
  };
  pruneEmpty(DST);

  console.log(`[sync] 已同步 ${srcFiles.length} 个文件到 miniprogram/cloudfunctions/`
    + (extra.length ? `，清理多余 ${extra.length} 个` : ''));

  // 同步结果自校验
  const again = run(true);
  return again;
}

// 保证 DST 存在（开发者工具需要目录存在才认 cloudfunctionRoot）
fs.mkdirSync(DST, { recursive: true });

run(process.argv.includes('--check'));
