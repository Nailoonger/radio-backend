#!/usr/bin/env node
'use strict';

/**
 * 云函数部署（v3 · 2026-09-28 —— **只传根文件**）
 *
 * ═══════════ 为什么只传根文件 ═══════════
 * 微信开发者工具 CLI 在 Windows 上会把路径分隔符 `\` 写进压缩包条目名，
 * 云端（Linux）解压后得到「文件名里带 `\` 的扁平文件」→ 子目录 require 全废。
 * **实测三种方式都坏**：
 *   · `deploy`                        → 子目录文件带 `\`
 *   · `inc-deploy --file <目录>`       → 同上（含二级目录更坏）
 *   · `inc-deploy --file <单文件>`     → **同样带 `\`**
 * 只有**根目录下的文件**能正确传输。
 *
 * ✅ 因此流程固定为两步：
 *   1) `node cloud/scripts/sync.js` —— 把整个云函数打成**单文件** index.js
 *   2) `deploy --names api ... -r`  —— 只传 index.js + package.json
 * 这样不再依赖人工在 GUI 点上传，也不会再踩反斜杠缺陷。
 *
 * ⚠️ 本机 node 调 cli.bat 会报 `spawnSync cmd.exe EBUSY`，所以**默认只打印命令**，
 *    复制到 Git Bash 执行即可；加 `--run` 才尝试直接跑。
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/deploy-cloud.js [函数名=api]          # 打印命令
 *   node cloud/scripts/deploy-cloud.js api --run             # 尝试直接执行
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLI = 'D:\\dev\\wx-devtools\\cli.bat';
const ENV_ID = 'jy-radio-d1gdwmptl816ee6a9';
const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT = path.join(ROOT, 'miniprogram');
const PROJECT_POSIX = PROJECT.replace(/\\/g, '/');
const FN = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'api';
const RUN = process.argv.includes('--run');

const FN_DIR = path.join(PROJECT, 'cloudfunctions', FN);

// ---- 前置检查：产物必须是打包好的单文件 ----
let entries = [];
try { entries = fs.readdirSync(FN_DIR).sort(); } catch (e) { entries = []; }
const bundleOk = entries.includes('index.js') && entries.includes('package.json');

console.log(`[deploy] 目标函数：${FN}`);
console.log(`[deploy] 产物目录内容：${entries.join(', ') || '(空)'}`);

if (!bundleOk) {
  console.error('');
  console.error('❌ 产物不完整（应只有 index.js + package.json）。');
  console.error('   先跑：node cloud/scripts/sync.js');
  process.exit(1);
}

// 产物应为 index.js + package.json（+ config.json 定时触发器配置，sync.js 会原样带上）
const EXPECTED_FILES = ['index.js', 'package.json', 'config.json'];
const extras = entries.filter((n) => !EXPECTED_FILES.includes(n));
if (extras.length) {
  console.warn('');
  console.warn(`⚠️  产物目录里有预期外的文件：${extras.join(', ')}`);
  console.warn('   多余文件不致命，但可能带上旧代码 → 建议重跑：node cloud/scripts/sync.js（清空后重建）');
}

const cmd =
  `cd /d/dev/wx-devtools\n` +
  `./cli.bat cloud functions deploy --env ${ENV_ID} --names ${FN} --project "${PROJECT_POSIX}" -r </dev/null`;

console.log('');
console.log('──── 复制以下命令到 Git Bash 执行 ────');
console.log(cmd);
console.log('────────────────────────────────────');
console.log('');
console.log('⚠️ 部署返回成功后**等 1~2 分钟**（云端 npm install 未完成时调用会报 Cannot find module）。');
console.log('⚠️ 验证：MSYS_NO_PATHCONV=1 \\');
console.log('        NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules" \\');
console.log('        node cloud/scripts/verify-user.js ws://127.0.0.1:9420');

if (!RUN) {
  console.log('');
  console.log('[deploy] 未加 --run，仅打印命令。');
  process.exit(0);
}

try {
  execSync(cmd.replace(/\n/, ' && '), { stdio: 'inherit', shell: 'bash.exe' });
  console.log('[deploy] 执行完成');
} catch (e) {
  console.error('[deploy] 直接执行失败（Windows EBUSY 属已知问题）→ 请手动复制上方命令到 Git Bash 跑。');
  console.error('        ' + ((e && e.message) || e));
  process.exit(1);
}
