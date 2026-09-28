'use strict';

/**
 * 云开发迁移自检脚本
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/selfcheck.js
 *
 * 作用：迁移过程每推进一步就往上加断言，防回归。
 *  - 路由表正确性（尤其「字面量段优先于参数段」这条铁律）
 *  - 原样移植的纯逻辑与 src/ 原实现逐位一致（时间工具等）
 *  - 后续阶段追加：状态机数字口径、成本表、提交规则归一化……
 *
 * ⚠️ 本脚本只读不写，不连数据库、不依赖 wx-server-sdk，随时可跑。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name} :: got=${got} want=${want}`);
}

function info(msg) {
  lines.push(`INFO ${msg}`);
}

// ============ 1. 路由表 ============
const { match, RAW_ROUTES } = require(path.join(API_DIR, 'router'));

// 字面量段必须优先于参数段（原 Express 的注册顺序铁律）
eq('字面量 /user/submit/week', match('GET', '/user/submit/week').handlerKey, 'user.submit.weekSchedule');
eq('字面量 /user/submit/quota', match('GET', '/user/submit/quota').handlerKey, 'user.submit.quota');
eq('字面量 /user/submit/window', match('GET', '/user/submit/window').handlerKey, 'user.submit.windowStatus');
eq('字面量 /user/submit/timeslots', match('GET', '/user/submit/timeslots').handlerKey, 'user.submit.timeslots');
eq('字面量 /user/submit/notice', match('GET', '/user/submit/notice').handlerKey, 'user.submit.notice');
eq('参数段兜底 /user/submit/:id', match('GET', '/user/submit/123').handlerKey, 'user.submit.detail');
eq('params 解析', match('GET', '/user/submit/123').params.id, '123');
eq('参数路由兜底 DELETE week（与原 Express 同语义）', match('DELETE', '/user/submit/week').handlerKey, 'user.submit.cancel');

eq('字面量 /admin/submit/list', match('GET', '/admin/submit/list').handlerKey, 'admin.submit.list');
eq('字面量 /admin/submit/quota/sweep', match('POST', '/admin/submit/quota/sweep').handlerKey, 'admin.submit.sweepQueue');
eq('字面量 /admin/submit/schedule/preview', match('POST', '/admin/submit/schedule/preview').handlerKey, 'admin.submit.previewSchedule');
eq('字面量 /admin/submit/:id/approve', match('PUT', '/admin/submit/88/approve').handlerKey, 'admin.submit.approve');
eq('字面量 /admin/submit/:id/status-logs', match('GET', '/admin/submit/7/status-logs').handlerKey, 'admin.submit.statusLogs');
eq('学生账号 /admin/student/grade/:grade', match('GET', '/admin/student/grade/2024').params.grade, '2024');
eq('三参数路由', match('PUT', '/admin/showcase/staff/5/toggle').handlerKey, 'admin.showcase.toggle');
eq('三参数 params 完整性', JSON.stringify(match('PUT', '/admin/showcase/cadre/5/toggle').params), '{"type":"cadre","id":"5"}');
eq('方法不匹配 → null', match('DELETE', '/user/login'), null);
eq('未知路径 → null', match('GET', '/user/nope/x/y'), null);
eq('健康检查', match('GET', '/health').handlerKey, 'system.health');

const userCount = RAW_ROUTES.filter(([k]) => k.includes(' /user/')).length;
const adminCount = RAW_ROUTES.filter(([k]) => k.includes(' /admin/')).length;
eq('用户端路由数', userCount, 32);
eq('管理端路由数', adminCount, 93);

// ============ 2. 纯逻辑移植一致性 ============
const oldT = require(path.join(ROOT, 'src', 'utils', 'bjTime'));
const newT = require(path.join(API_DIR, 'lib', 'bjTime'));

const stamps = [
  Date.UTC(2026, 8, 24, 4, 50, 0),    // 2026-09-24 12:50 北京
  Date.UTC(2026, 8, 20, 16, 0, 0),    // 2026-09-21 00:00 北京（周一零点，点播周锚点临界）
  Date.UTC(2026, 8, 20, 15, 59, 59),  // 2026-09-20 23:59:59 北京（周日末尾）
  Date.UTC(2026, 0, 1, 0, 0, 0),      // 跨年
  Date.UTC(2026, 11, 31, 16, 0, 0),   // 2026-01-01 00:00 北京（ISO 周归属临界）
  Date.UTC(2027, 6, 15, 3, 0, 0),
];
stamps.forEach((ts, i) => {
  eq(`dayKey#${i}`, newT.dayKey(ts), oldT.dayKey(ts));
  eq(`weekKey#${i}`, newT.weekKey(ts), oldT.weekKey(ts));
  eq(`weekRange.start#${i}`, newT.weekRange(ts).start.getTime(), oldT.weekRange(ts).start.getTime());
  eq(`nextWeekRange.start#${i}`, newT.nextWeekRange(ts).start.getTime(), oldT.nextWeekRange(ts).start.getTime());
  eq(`weekdayOf#${i}`, newT.weekdayOf(new Date(ts)), oldT.weekdayOf(new Date(ts)));
});

// 错误码表：两端数值必须完全一致（前端按码分支）
const oldR = require(path.join(ROOT, 'src', 'utils', 'response'));
const newR = require(path.join(API_DIR, 'lib', 'response'));
Object.keys(oldR.Codes).forEach((k) => {
  eq(`错误码 ${k}`, newR.Codes[k], oldR.Codes[k]);
});

// ============ 3. 部署产物（单文件打包）============
// ⚠️⚠️ 2026-09-28 起**不再「镜像目录」**，而是把整个云函数**打包成单文件 index.js**。
// 原因（实测定案）：微信开发者工具 CLI 在 Windows 上会把路径分隔符 `\` 写进压缩包条目名，
//   子目录文件到云端后会变成「文件名里带 `\` 的扁平文件」→ `require('./lib/xxx')` 必然失败。
//   实测 `deploy` / `inc-deploy --file <目录>` / `inc-deploy --file <单文件>` **三种都坏**，
//   只有**根目录下的文件**能正确传输 → 因此把全部模块打成一个 index.js，只传根文件。
//   详见 cloud/scripts/sync.js 文件头、skill `wechat-devtools-cli-deploy`。
const SRC_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');
const DST_DIR = path.join(ROOT, 'miniprogram', 'cloudfunctions', 'api');

function walkFiles(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules') return;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  });
  return out;
}

const dstEntries = fs.existsSync(DST_DIR) ? fs.readdirSync(DST_DIR).sort() : [];
eq('产物目录只有 index.js + package.json', dstEntries.join(','), 'index.js,package.json');

let bundleText = '';
try { bundleText = fs.readFileSync(path.join(DST_DIR, 'index.js'), 'utf8'); } catch (e) { bundleText = ''; }
ok_contains('产物是自动生成的（带 banner）', bundleText, /AUTO-GENERATED by cloud\/scripts\/sync\.js/);

// 产物必须把**每个源文件**都打进去 —— 用模块注册语句计数当探针，防漏文件
const modCount = (bundleText.match(/__mods\["/g) || []).length;
const srcCount = walkFiles(SRC_DIR).filter((f) => f.endsWith('.js')).length;
eq('产物模块数 == 源码 js 文件数', modCount, srcCount);
info('若产物过期/缺失 → 跑 node cloud/scripts/sync.js 重新打包');

// ============ 4. 小程序配置 ============
const projCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram', 'project.config.json'), 'utf8'));
eq('cloudfunctionRoot 已配置', projCfg.cloudfunctionRoot, 'cloudfunctions/');

const appJs = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.js'), 'utf8');
ok_contains('app.js 已填云环境 ID', appJs, /cloudEnvId:\s*'jy-radio-[a-z0-9]+'/);
ok_contains('app.js 保留 direct 模式开关', appJs, /requestMode:\s*'direct'/);

function ok_contains(name, text, re) {
  const hit = re.test(text);
  if (!hit) failed++;
  lines.push(`${hit ? 'OK  ' : 'FAIL'} ${name}`);
}

// ============ 输出 ============
lines.push('');
lines.push(`结论：${lines.length} 行 / 失败 ${failed} 项`);
const text = lines.join('\n');
console.log(text);

const outFile = path.join(ROOT, '_cloud_selfcheck_result.txt');
try { fs.writeFileSync(outFile, text, 'utf8'); } catch (e) { /* 忽略 */ }

process.exit(failed === 0 ? 0 : 1);
