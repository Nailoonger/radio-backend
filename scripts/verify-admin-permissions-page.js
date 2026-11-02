'use strict';

// 管理端 web「权限管理」页 —— 结构守卫（2026-11-02 陛下要求补上）
//
// 用法：node scripts/verify-admin-permissions-page.js
//
// 行为层面已由 `cloud/scripts/test-partner-permissions.js`（71 项）覆盖后端；
// 小程序端那页由 `scripts/verify-partner-permissions.js` 覆盖。
// 这里只钉**管理端 web 这份**别被悄悄改回去，钉的都是踩过的坑：
//   ① 路由 / 菜单被摘掉 —— 2026-10-31 那 9 条 /partner/* 就是这么消失的，页面还在但没人进得去
//   ② 页面自己另写一套权限位文案 —— 后端 `_kit.PERM_TEXT` 才是唯一源头，抄一份必然两边叫法不一样
//   ③ 用一把全局 `saving` 布尔拦所有格 —— 连点第二位会被静默吞掉，表现成「点不亮」
//   ④ 保存失败不回滚 —— 界面在骗人
//   ⑤ 生效值口径自己发明第三版 —— 必须是「单独设过用单独的，没设过跟全局」
//
// ⚠️ 为什么必须有：前端这几条坏了**不会报错**，页面照常打开，
//    只有真点下去才发现「点了没反应」或「权限对不上」。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** 只看代码，不看注释 —— 注释里会写「不要在页面里硬编码排班权限」这类说明 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
let checks = 0;
function test(label, fn) { fn(); checks += 1; console.log('✓ ' + label); }

const PAGE = 'admin-web/src/views/PartnerPermissions.vue';

/* ══════════ A. 入口：路由 + 菜单 ══════════ */
test('路由：/permissions 指向 PartnerPermissions.vue，且是超管专属', () => {
  const src = read('admin-web/src/router/index.js');
  assert.ok(/path:\s*'permissions'/.test(src), '少了 /permissions 路由，页面写了也没人进得去');
  assert.ok(/name:\s*'PartnerPermissions'/.test(src), '路由名要对上');
  assert.ok(/@\/views\/PartnerPermissions\.vue/.test(src), '组件路径要对上');
  const line = src.split('\n').find((l) => /name:\s*'PartnerPermissions'/.test(l)) || '';
  assert.ok(/superAdmin:\s*true/.test(line), 'meta 必须带 superAdmin（社干不该看到这一页）');
});

test('菜单：系统管理组里有「权限管理」，图标是钥匙', () => {
  const src = read('admin-web/src/layouts/MainLayout.vue');
  assert.ok(/path:\s*'\/permissions',\s*title:\s*'权限管理'/.test(src), '菜单项不见了');
  const line = src.split('\n').find((l) => /path:\s*'\/permissions'/.test(l)) || '';
  assert.ok(/superAdmin:\s*true/.test(line), '菜单项要带 superAdmin，否则社干能看到入口');
  assert.ok(/icon:\s*IconKey/.test(line), '图标要用 IconKey');
  assert.ok(/IconKey,/.test(src), 'IconKey 要真的 import 进来（漏了就渲染空白）');
});

/* ══════════ B. 接口：和小程序端同一套 ══════════ */
test('页面调的是 /partner/permissions 那三个口子（不新造接口）', () => {
  const src = codeOf(read(PAGE));
  assert.ok(/http\.get\('\/partner\/permissions'\)/.test(src), '读页面数据走 GET /partner/permissions');
  assert.ok(/http\.put\('\/partner\/permissions'/.test(src), '总开关走 PUT /partner/permissions');
  assert.ok(/http\.put\(`\/partner\/permissions\/person\/\$\{/.test(src), '按人走 PUT /partner/permissions/person/:id');
  assert.ok(/buildNeeded/.test(src), '权限表没建时要提示，不能白屏（云开发查不存在的集合是抛错）');
});

/* ══════════ C. 文案：只吃接口的 meta ══════════ */
test('权限位文案不在页面里硬编码（唯一源头是 _kit.PERM_TEXT）', () => {
  const code = codeOf(read(PAGE));
  ['排班权限', '审核权限', '代录权限'].forEach((w) => {
    assert.ok(code.indexOf(w) < 0, `页面里出现了硬编码的「${w}」，应该用接口返回的 meta`);
  });
  assert.ok(/meta\.value\s*=\s*\(d\s*&&\s*d\.meta\)/.test(code), 'meta 必须从接口拿');
  assert.ok(/v-for="m in meta"/.test(code), '三位要按 meta 循环渲染，不是写死三块');
  assert.ok(/m\.short\s*\|\|\s*m\.name/.test(code), '列头用接口的 short（自己截字符串的话，后端改名就坏了）');
});

/* ══════════ D. 并发：每格各自一把小锁 ══════════ */
test('每格一把小锁，不是一把全局 saving（否则连点第二位被静默吞掉）', () => {
  const code = codeOf(read(PAGE));
  assert.ok(/const busy = reactive\(\{\}\)/.test(code), '按格/按位记保存中，别用一个布尔');
  assert.ok(/\$\{a\}:\$\{k\}/.test(code), '锁的键是「对象:权限位」');
  assert.ok(/delete busy\[/.test(code), '存完要把锁清掉');
  assert.ok(!/const saving = ref\(/.test(code), '不许再有全局 saving 布尔当闸门');
  assert.ok(/if\s*\(isBusy\(/.test(code), '重复点击要按格拦，不能整页拦');
});

/* ══════════ E. 失败回滚 + 三态口径 ══════════ */
test('保存失败必须把开关拨回去（否则界面在骗人）', () => {
  const code = codeOf(read(PAGE));
  assert.ok(/global\.value\s*=\s*\{\s*\.\.\.global\.value,\s*\[key\]:\s*prev\s*\}/.test(code), '全局失败要回滚到 prev');
  assert.ok(/row\.over\s*=\s*prevOver/.test(code), '按人失败要回滚到 prevOver');
  assert.ok(/saveError\.value\s*=\s*`保存失败/.test(code), '失败要留常驻提示，不能只弹 1.5 秒 toast');
  assert.ok(/ElMessage\.error/.test(code), '同时也要弹一下（手在按钮上的人先看到）');
  assert.ok(/开关已经拨回原来的位置|已经恢复原样/.test(code), '提示里要说清「已经拨回去了」，否则人会以为没反应');
});

test('生效值口径与后端 effectivePerm 一致（三态：true / false / 跟随全局）', () => {
  const code = codeOf(read(PAGE));
  assert.ok(/\(v === true \|\| v === false\)\s*\?\s*v\s*:\s*!!g\[k\]/.test(code), 'true/false 用单人的，其它跟全局');
  assert.ok(/const BLANK_OVER = \{ schedule: null, review: null, proxy: null \}/.test(code), '缺省三位都是 null（跟随）');
  assert.ok(/\[key\]:\s*null/.test(code), '「跟回全局」要把这一位写成 null');
});

/* ══════════ F. 后端那三个口子还在（被删了页面就空转）══════════ */
test('后端 handler 仍导出 get / saveGlobal / savePerson / mine', () => {
  const src = read('cloud/cloudfunctions/api/handlers/partner/permissions.js');
  ['get', 'saveGlobal', 'savePerson', 'mine'].forEach((fn) => {
    assert.ok(new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${fn}\\b`).test(src), `少了 ${fn}`);
  });
  assert.ok(/asSuperPartner/.test(src), '四个口子都必须过超管校验');
});

console.log(`\n${checks} 项管理端权限管理页结构检查通过`);
