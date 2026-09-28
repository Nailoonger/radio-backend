#!/usr/bin/env node
'use strict';

/**
 * 本地全量回归（一键跑完，可复现）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/regression.js            # 源码 + 打包产物各跑一遍
 *   node cloud/scripts/regression.js --source   # 只跑源码
 *   node cloud/scripts/regression.js --bundle   # 只跑打包产物
 *   node cloud/scripts/regression.js --selftest # 只自检「结论行解析器」
 *
 * ═══════════ 为什么要跑两遍 ═══════════
 * 线上跑的是 `sync.js` 打包出来的**单文件**产物，不是源码目录。
 * 打包器是我们自己写的（靠正则静态分析 require），它出故障的方式非常隐蔽：
 * 某条 `require` 没被扫到 → 线上 `Cannot find module` → 只能看到笼统的 500。
 * 所以同一批断言必须在**两种加载方式**下都通过，才算真的通过。
 *
 * ⚠️ 不含 `verify-cloud.js` / `verify-user.js` —— 那两个要 `miniprogram-automator`
 *    连真实微信开发者工具，属于联调脚本，不是本地回归。
 *
 * ⚠️ 本脚本靠**创建子进程**逐个跑套件（只有子进程才能给每个套件干净的模块实例，
 *    而 `HARNESS_API_DIR` 是 harness 加载时读一次的 —— 同进程里切不了源码/产物）。
 *    某些受限沙箱会禁止创建子进程（`EBUSY`）→ 本脚本会**明确说明**并列出需要
 *    手工执行的命令，而不是打出一片 `??` 让人误判。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_DIR = path.join(ROOT, 'miniprogram', 'cloudfunctions', 'api');

/**
 * 套件清单。[脚本, 是否支持指向打包产物]
 * `test-bundle` / `selfcheck` 自己就会去看产物，再指一遍没意义，故只在源码那一轮跑。
 */
const SUITE = [
  ['test-system.js', true],
  ['test-user-auth.js', true],
  ['test-user-readonly.js', true],
  ['test-user-submit.js', true],
  ['test-scheduling-cost.js', true],
  ['test-scheduling.js', true],
  ['test-admin-core.js', true],
  ['test-admin-submit.js', true],
  ['test-admin-student.js', true],
  ['test-admin-routes.js', true],
  ['test-gateway.js', true],
  ['test-bundle.js', false],
  ['selfcheck.js', false],
];

/** 从脚本输出里抠出「结论：… N 项 / 失败 M 项」（两种格式都见过：`断言 263 项` / `27 行`） */
function parseConclusion(text) {
  const m = String(text).match(/结论：\D*?(\d+)\s*(?:项|行)\s*\/\s*失败\s*(\d+)/);
  return m ? { checked: Number(m[1]), failed: Number(m[2]) } : null;
}

/* ────────────────── 解析器自检（不依赖子进程，随时可跑） ────────────────── */
if (process.argv.indexOf('--selftest') >= 0) {
  const cases = [
    ['结论：断言 263 项 / 失败 0 项', { checked: 263, failed: 0 }],
    ['结论：27 行 / 失败 0 项', { checked: 27, failed: 0 }],
    ['结论：1340 行 / 失败 3 项', { checked: 1340, failed: 3 }],
    ['\n\n结论：断言 19 项 / 失败 0 项\n', { checked: 19, failed: 0 }],
    ['[api] GET /x 0ms -\n结论：断言 5 项 / 失败 1 项', { checked: 5, failed: 1 }],
    ['没有任何结论行', null],
    // 各脚本的收尾文案不统一（有的写「断言 N 项」、有的写「N 行」），**两种单位都接受**
    ['结论：断言 12 行 / 失败 0 项', { checked: 12, failed: 0 }],
  ];
  let bad = 0;
  cases.forEach(([input, want]) => {
    const got = parseConclusion(input);
    const okv = JSON.stringify(got) === JSON.stringify(want);
    if (!okv) bad += 1;
    console.log(`${okv ? 'OK  ' : 'FAIL'} parse(${JSON.stringify(input).slice(0, 40)}) → ${JSON.stringify(got)}`);
  });
  console.log(`\n结论：断言 ${cases.length} 项 / 失败 ${bad} 项`);
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
const onlySource = args.indexOf('--bundle') < 0 && args.indexOf('--source') >= 0;
const onlyBundle = args.indexOf('--bundle') >= 0;
const modes = [];
if (!onlyBundle) modes.push('source');
if (!onlySource) modes.push('bundle');

/** 先探一次「能不能创建子进程」，不能就直说 */
function canSpawn() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  return r.status === 0;
}

if (!canSpawn()) {
  console.log('\n══════ 本地全量回归 ══════\n');
  console.log('⚠️  当前环境**不允许创建子进程**，本脚本无法工作（不是套件失败）。');
  console.log('    受限沙箱（如智能体沙箱）常见，请在普通终端里重跑本脚本。');
  console.log('    也可以手工逐条执行下面这些命令（首行是源码轮，注释行是产物轮）：\n');
  for (const [file] of SUITE) console.log(`  node cloud/scripts/${file}`);
  console.log('\n  # 打包产物轮（同样的断言，换加载方式）：');
  for (const [file, cap] of SUITE) {
    if (!cap) continue;
    console.log(`  HARNESS_API_DIR=$(pwd)/miniprogram/cloudfunctions/api node cloud/scripts/${file}`);
  }
  console.log('\n  # PowerShell 里等价写法：');
  console.log('  $env:HARNESS_API_DIR="$PWD/miniprogram/cloudfunctions/api"; node cloud/scripts/test-admin-student.js');
  process.exit(2);
}

const rows = [];
let grandChecked = 0;
let grandFailed = 0;
let badScripts = 0;

for (const mode of modes) {
  for (const [file, bundleCapable] of SUITE) {
    if (mode === 'bundle' && !bundleCapable) continue;
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) { rows.push({ mode, file, note: '文件不存在' }); badScripts++; continue; }

    const env = Object.assign({}, process.env);
    if (mode === 'bundle') env.HARNESS_API_DIR = BUNDLE_DIR;
    else delete env.HARNESS_API_DIR;

    const res = spawnSync(process.execPath, [full], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = String(res.stdout || '');
    const con = parseConclusion(out);
    const exit = res.status;

    if (!con) {
      rows.push({ mode, file, note: `无「结论」行（exit=${exit}${res.error ? ' ' + res.error.code : ''}）` });
      badScripts++;
      continue;
    }
    rows.push({ mode, file, checked: con.checked, failed: con.failed, exit });
    grandChecked += con.checked;
    grandFailed += con.failed;
    if (con.failed || exit !== 0) badScripts++;
  }
}

const W = 24;
console.log('\n══════ 本地全量回归 ══════\n');
let curMode = null;
for (const r of rows) {
  if (r.mode !== curMode) {
    curMode = r.mode;
    console.log(`—— ${curMode === 'source' ? '源码目录' : '打包产物'} ——`);
  }
  if (r.checked === undefined) {
    console.log(`  ??   ${r.file.padEnd(W)} ${r.note}`);
  } else {
    console.log(`  ${r.failed === 0 && r.exit === 0 ? 'OK  ' : 'FAIL'} ${r.file.padEnd(W)} 断言 ${String(r.checked).padStart(4)} 项 / 失败 ${r.failed} 项`);
  }
}

console.log('\n──────────────────────────');
console.log(`合计：断言 ${grandChecked} 项 / 失败 ${grandFailed} 项`);
console.log(badScripts ? `有 ${badScripts} 个脚本未全绿或跑不起来` : '全部通过 ✅');
process.exit(badScripts ? 1 : 0);
