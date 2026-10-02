'use strict';

/**
 * 路由 ↔ handler 就绪性守门测试（阶段 7 收尾新增）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-admin-routes.js
 *
 * ═══════════ 为什么需要单独一条（而不是靠权限矩阵）═══════════
 * `test-admin-core.js` 的权限矩阵是这样判的：
 *   · 超管专属路由：普管必须 40301
 *   · 普管可调路由：**只需要「不是 40101 / 40301」**（业务错 40001/40401 都算过）
 *
 * ⚠️ 于是有一个洞：如果某个**普管可调**的 handler 因为「模块忘了登记」或
 *    「导出名写错」而根本加载不出来，`resolveHandler` 会回退到 todoHandler，
 *    调用时抛 **50001**——而 50001 既不是 40101 也不是 40301，**矩阵照样全绿**。
 *    这类故障在线上表现为「这个接口一直 500」，却没有任何断言拦得住。
 *
 * 本脚本把「就绪性」单独钉死，判据只有三条：
 *   ① `handlers/` 目录下每个业务文件都必须在 `handlers/index.js` 的 REGISTRY 里登记
 *      （漏登记 = 打包器不会收它 → 线上 Cannot find module）
 *   ② 路由表里每个 handlerKey 都能解析到**真实导出函数**（不是 todoHandler）
 *   ③ `resolveHandler` 的诊断文案契约（未登记 / 未导出 能一眼分辨），
 *      这条与移植进度无关，永远不会因为「接口都做完了」而失效
 */

const path = require('path');
const fs = require('fs');

require('./harness'); // stub 掉 wx-server-sdk，纯结构检查

const API_DIR = process.env.HARNESS_API_DIR || path.join(__dirname, '..', 'cloudfunctions', 'api');
const HANDLERS_DIR = path.join(API_DIR, 'handlers');

/**
 * ⚠️ 本脚本是**源码目录的结构检查**（要逐个 require handlers/*.js 文件）。
 *    打包产物是**单文件** index.js，没有 handlers 目录，跑不了。
 *    「产物里模块有没有打进去」由 `test-bundle.js` 用功能级判据覆盖
 *    （未登录 → 40101 而不是 50001），两者不重叠。
 */
if (!fs.existsSync(HANDLERS_DIR)) {
  console.log(`[skip] 目标不是源码目录（没有 handlers/）：${API_DIR}`);
  console.log('[skip] 本脚本只对源码目录有意义；产物请跑 test-bundle.js');
  process.exit(0);
}

const { resolveHandler, registeredModules } = require(path.join(HANDLERS_DIR, 'index.js'));
const { RAW_ROUTES } = require(path.join(API_DIR, 'router.js'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (!okv) failed++;
  lines.push(`${okv ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

/** 递归列出 handlers 下的所有 .js（排除 index.js 自己） */
function listHandlerFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listHandlerFiles(p, base, out);
    else if (name.endsWith('.js')) out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/** 文件名 → REGISTRY 的模块 key（`admin/auth.js` → `admin.auth`；`system.js` → `system`） */
const fileToModKey = (rel) => rel.replace(/\.js$/, '').replace(/\//g, '.');
/** 模块 key → 磁盘相对路径（`admin.adminMgr` → `admin/adminMgr.js`） */
const modKeyToFile = (key) => key.replace(/\./g, '/') + '.js';

(async () => {
  const REG = registeredModules();

  /* ══════════════ A. handlers 目录 ↔ REGISTRY 双向一致 ══════════════ */
  section('A. handlers 目录 ↔ REGISTRY（防「新文件忘了登记」）');

  // 说明：以下划线开头的文件是**共享辅助件**（不是路由目标），不需要登记；
  //      `index.js` 是注册表本身，也不算业务模块。
  const files = listHandlerFiles(HANDLERS_DIR)
    .filter((f) => !path.basename(f).startsWith('_') && f !== 'index.js');
  const fileKeys = files.map(fileToModKey).sort();

  const notRegistered = fileKeys.filter((k) => REG.indexOf(k) < 0);
  ok('handlers 下的每个业务文件都已登记进 REGISTRY', notRegistered.length === 0, notRegistered.join(', '));

  const notOnDisk = REG.filter((k) => fileKeys.indexOf(k) < 0);
  ok('REGISTRY 里每个 key 都能落到磁盘上的文件', notOnDisk.length === 0, notOnDisk.join(', '));

  eq('★ 双向刚好一一对应（数量相等）', REG.length, fileKeys.length);
  eq('REGISTRY 条数（含招新：1 system + 11 user + 14 admin）', REG.length, 26);

  // 辅助件必须真的是辅助件（没有被路由引用）
  const routeModKeys = [...new Set(RAW_ROUTES.map(([, hk]) => {
    const dot = hk.lastIndexOf('.');
    return dot < 0 ? hk : hk.slice(0, dot);
  }))];
  const helpers = listHandlerFiles(HANDLERS_DIR)
    .filter((f) => path.basename(f).startsWith('_'))
    .map(fileToModKey);
  eq('下划线辅助件清单', helpers.sort(), ['admin._kit', 'admin._people']);
  ok('辅助件没有被任何路由直接引用', helpers.every((h) => routeModKeys.indexOf(h) < 0), helpers.join(', '));

  /* ══════════════ B. 每条路由都能解析到真实导出 ══════════════ */
  section('B. 路由表 × handlerKey 全量解析');

  const seen = new Set();
  const unresolved = [];
  for (const [routeKey, hk] of RAW_ROUTES) {
    const dot = hk.lastIndexOf('.');
    const modKey = dot < 0 ? hk : hk.slice(0, dot);
    const method = dot < 0 ? hk : hk.slice(dot + 1);

    if (REG.indexOf(modKey) < 0) { unresolved.push(`${routeKey} → 模块未登记 ${modKey}`); continue; }
    let mod = null;
    try {
      mod = require(path.join(HANDLERS_DIR, modKeyToFile(modKey)));
    } catch (e) {
      unresolved.push(`${routeKey} → 加载失败 ${e.message}`);
      continue;
    }
    if (!mod || typeof mod[method] !== 'function') {
      unresolved.push(`${routeKey} → 未导出 ${method}`);
      continue;
    }
    seen.add(hk);
  }
  ok('★ 路由表里每一条都能落到真实导出的函数', unresolved.length === 0, unresolved.slice(0, 12).join(' | '));

  // 路由 key 形如 `'GET /admin/submit/list'`，先切出路径再判归属
  const pathOf = (k) => k.slice(k.indexOf(' ') + 1);
  const adminRoutes = RAW_ROUTES.filter(([k]) => pathOf(k).startsWith('/admin/'));
  const userRoutes = RAW_ROUTES.filter(([k]) => pathOf(k).startsWith('/user/'));
  const systemRoutes = RAW_ROUTES.filter(([, hk]) => hk.startsWith('system.'));
  eq('★ admin 路由 110 条（含招新）', adminRoutes.length, 110);
  eq('user 路由 38 条（含招新）', userRoutes.length, 38);
  eq('system 路由 2 条（/health + /system/init-collections）',
    systemRoutes.map(([k]) => k), ['GET /health', 'POST /system/init-collections']);
  eq('路由总数 = admin + user + system（没有第四种前缀）',
    RAW_ROUTES.length, adminRoutes.length + userRoutes.length + systemRoutes.length);
  eq('★ 去重后的 handlerKey 数', seen.size, new Set(RAW_ROUTES.map(([, hk]) => hk)).size);

  /* ══════════════ C. 诊断文案契约（与移植进度无关） ══════════════ */
  section('C. resolveHandler 的诊断契约');

  async function invoke(key) {
    try {
      await resolveHandler(key)({ params: {}, query: {}, body: {}, token: '' });
      return { code: 0, message: 'ok' };
    } catch (e) {
      return { code: e && e.code, message: String((e && e.message) || e) };
    }
  }

  let r = await invoke('admin.noSuchModule.noSuchMethod');
  eq('未登记模块 → 50001', r.code, 50001);
  ok('且点名「模块未登记」+ 具体模块名',
    /模块未登记：admin\.noSuchModule（尚未移植）/.test(r.message), r.message);

  r = await invoke('user.noSuchModule.noSuchMethod');
  ok('user 侧同款诊断', /模块未登记：user\.noSuchModule/.test(r.message), r.message);

  r = await invoke('admin.submit.nopeMethod');
  ok('已登记模块但方法不存在 → 点名「未导出」',
    /模块 admin\.submit 未导出 nopeMethod/.test(r.message), r.message);

  r = await invoke('admin.submit');
  ok('key 里没有点（方法名缺失）也不炸，仍给 50001 人话', r.code === 50001, r.message);

  /* ══════════════ D. 幂等 / 缓存 ══════════════ */
  section('D. 解析缓存');

  const h1 = resolveHandler('admin.submit.list');
  const h2 = resolveHandler('admin.submit.list');
  ok('同一 handlerKey 重复解析返回同一引用（有缓存，省 require）', h1 === h2);
  ok('不同 handlerKey 返回不同函数', resolveHandler('admin.submit.list') !== resolveHandler('admin.submit.detail'));

  /* ══════════════ 输出 ══════════════ */
  const checked = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  lines.push('');
  lines.push(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { fs.writeFileSync(path.join(__dirname, '..', '..', '_cloud_admin_routes_test.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
