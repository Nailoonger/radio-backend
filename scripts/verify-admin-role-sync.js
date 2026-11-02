'use strict';

// 管理端「切角色实时同步」—— 前后端两侧的结构守卫（2026-11-02 陛下报的 bug）
//
// 用法：node scripts/verify-admin-role-sync.js
//
// 行为层面已由 `cloud/scripts/test-admin-role-sync.js`（19 项，真路由 + 内存云库）覆盖；
// 这里只钉**改法还在不在**，防止以后重构时把某一条悄悄退回去：
//   · 云端入口查 admin 表、requireAdmin 用库里的 role（不是 token 里的快照）
//   · 直连侧 adminAuth 同口径覆盖 req.admin.role
//   · update 接口三档都能写、非法值报错、最后一位超管不许降级
//   · 前端：store 有 ensureFresh、路由守卫会 await 它、MainLayout 30 秒轮询、账号页改自己后刷新 store
//
// ⚠️ 为什么要有这条：这四层里任何一层被"简化"掉，现象都回到「改了角色不生效」，
//    而且不报错 —— 只有人肉点了才会发现。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** 只看代码，不看注释 —— 注释里会写「原来写的是 [0, 1].includes」这种说明 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
let checks = 0;
function test(label, fn) { fn(); checks += 1; console.log('✓ ' + label); }

/* ══════════ A. 云端（线上真正跑的那份）══════════ */
test('云端入口：admin token 才查 admin 表，并把结果放进 ctx.adminLive', () => {
  const src = read('cloud/cloudfunctions/api/index.js');
  assert.ok(/pl\.id\s*&&\s*!pl\.openid/.test(src), '必须只对 admin token 生效（有 id、无 openid）');
  assert.ok(/services\/adminLive'\)\.resolve\(pl\)/.test(src), '入口必须调 adminLive.resolve');
  assert.ok(/ctx\.adminLive\s*=/.test(src), '结果要挂在 ctx.adminLive 上，handler 才读得到');
});

test('云端 requireAdmin：用库里的 role 覆盖 token 里的快照', () => {
  const src = read('cloud/cloudfunctions/api/lib/auth.js');
  assert.ok(/ctx\.adminLive/.test(src), 'requireAdmin 必须读 ctx.adminLive');
  assert.ok(/role:\s*live\.role/.test(src), '必须用 live.role 覆盖 payload.role');
  // 没查到行时退回 payload（保持既有行为），不能写成「一律 401」
  assert.ok(/\?\s*Object\.assign\(\{\},\s*payload/.test(src), '查不到行时退回 payload.role');
});

test('云端 adminLive：只覆盖角色，查不到行返回 null（不越权拦人、不改停用契约）', () => {
  const src = read('cloud/cloudfunctions/api/services/adminLive.js');
  assert.ok(/if\s*\(!row\)\s*return null/.test(src), '查不到行返回 null，交给鉴权层保持原逻辑');
  assert.ok(!/ApiError/.test(src), '停用由业务层按 40301 拦，这里不抛 40101（改契约）');
  assert.ok(!/\.password\b/.test(src), '这个服务不许碰密码字段');
});

test('云端 update：三档 + 非法值报错 + 最后一位超管不许降级', () => {
  const src = read('cloud/cloudfunctions/api/handlers/admin/adminMgr.js');
  assert.ok(/\[0,\s*1,\s*2\]\.includes\(nextRole\)/.test(src), '三档写满');
  assert.ok(/rawRole === ''/.test(src), "挡住 Number('') === 0 冒充超管");
  assert.ok(/至少保留一个超级管理员，不能把最后一位超管改成别的角色/.test(src), '最后一位超管保护');
  assert.ok(/学生档案/.test(src), '改成站员要先挂学生档案');
});

/* ══════════ B. 直连后端（src，随时可切回的那份）══════════ */
test('直连 adminAuth：角色以库为准，覆盖 req.admin.role', () => {
  const src = read('src/middlewares/auth.js');
  assert.ok(/adminLive\.resolve\(payload\)/.test(src), 'adminAuth 必须查一次库');
  assert.ok(/role:\s*live\.role/.test(src), '必须覆盖 req.admin.role');
});

test('直连 adminController.update：三档写满（原来只有 [0,1]，站员被静默丢弃）', () => {
  const src = read('src/controllers/admin/adminController.js');
  const code = codeOf(src);
  assert.ok(!/\[0,\s*1\]\.includes/.test(code), '不能再出现两档白名单');
  assert.ok(/\[0,\s*1,\s*2\]\.includes\(nextRole\)/.test(code), '三档写满');
  assert.ok(/rawRole === ''/.test(code), "挡住 Number('') === 0 冒充超管");
  assert.ok(/至少保留一个超级管理员/.test(src), '最后一位超管保护');
  assert.ok(/学生档案/.test(src), '改成站员要先挂学生档案');
});

test('直连 adminLiveService：与云端同源同口径', () => {
  const src = read('src/services/adminLiveService.js');
  assert.ok(/Admin\.findByPk/.test(src), '按 id 查 admin 行');
  assert.ok(/if\s*\(!row\)\s*return null/.test(src), '查不到行返回 null');
  assert.ok(!/ApiError/.test(src), '停用照旧交给业务层 40301，这里不抛 401');
});

/* ══════════ C. 前端 admin-web ══════════ */
test('auth store：ensureFresh 会拉 /admin/profile 并写回 localStorage', () => {
  const src = read('admin-web/src/stores/auth.js');
  assert.ok(/async ensureFresh\(/.test(src), '要有 ensureFresh');
  assert.ok(/http\.get\('\/admin\/profile'\)/.test(src), '对账接口是 /admin/profile');
  assert.ok(/localStorage\.setItem\('admin_info'/.test(src), '变了要写回 localStorage（刷新页面也生效）');
  assert.ok(/freshPending/.test(src), '并发去重：路由守卫 + 轮询会撞在同一拍');
  assert.ok(/FRESH_TTL/.test(src), '要有 TTL，别每次跳转都打接口');
});

test('路由守卫：先对账再判 superAdmin', () => {
  const src = read('admin-web/src/router/index.js');
  assert.ok(/async \(to,\s*from,\s*next\)/.test(src), '守卫必须是 async');
  assert.ok(/await auth\.ensureFresh\(\)/.test(src), '必须先对账');
  const iFresh = src.indexOf('await auth.ensureFresh');
  const iSuper = src.indexOf('to.meta.superAdmin && !auth.isSuperAdmin');
  assert.ok(iFresh > 0 && iSuper > iFresh, 'superAdmin 判定必须在对账之后');
  assert.ok(/权限已被调整/.test(src), '被降权时要给人一句话，别让人以为页面坏了');
});

test('MainLayout：30 秒轮询 + 定时器成对清', () => {
  const src = read('admin-web/src/layouts/MainLayout.vue');
  assert.ok(/setInterval\(syncRole,\s*30000\)/.test(src), '停在页面不动时也要同步');
  assert.ok(/ensureFresh\(true\)/.test(src), '轮询要强制跳过 TTL');
  assert.ok(/clearInterval\(roleTimer\)/.test(src), '卸载时必须清定时器');
  assert.ok(/route\.meta\.superAdmin/.test(src), '降权后还停在系统管理页要退回');
});

test('账号页：改完自己立刻刷新 store；改别人提示「下一次操作生效」', () => {
  const src = read('admin-web/src/views/Account.vue');
  assert.ok(/editingSelf/.test(src), '要区分改自己 / 改别人');
  assert.ok(/await auth\.fetchProfile\(\)/.test(src), '改自己后必须刷新 store');
  assert.ok(/下一次操作即按新角色生效/.test(src), '改别人的提示要说清什么时候生效');
});

/* ══════════ D. 产物 ══════════ */
test('云函数产物里确实打进了 adminLive（sync 漏了就等于没改）', () => {
  const bundle = path.join(root, 'miniprogram', 'cloudfunctions', 'api', 'index.js');
  if (!fs.existsSync(bundle)) return;      // mini 范围不构建产物时跳过
  const src = fs.readFileSync(bundle, 'utf8');
  assert.ok(/adminLive/.test(src), '产物里没有 adminLive');
  assert.ok(/ctx\.adminLive/.test(src), '产物里入口没注入 adminLive');
});

console.log(`\n${checks} 项管理端角色同步结构检查通过`);
