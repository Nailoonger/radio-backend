'use strict';
// 排班规则入口按角色分派检查（2026-11-02）
//
// 起因（陛下原话）：「你把超管的排班工作台里面的排班规则也做成弹窗干啥，
//   那这样超管怎么修改排班规则」
//
// 判据：
//   role=0 超管        → 必须 navigateTo 进规则编辑页（加减号 / 开关 / 保存都在那一页）
//   role=1 社干 / 2 站员 → 只开只读弹层（ruleOpen），不许进编辑页
//   缓存里 adminInfo 缺 role → 先问一次 GET /partner/me，按服务端角色再分派
//
// 隔离 Page / wx / 请求，不碰真实账号与班表。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'miniprogram');
const PARTNER = path.join(root, 'pages-partner');
const RULES_URL = '/pages-partner/rules/rules';

let checks = 0;
async function test(label, fn) { await fn(); checks += 1; console.log('✓ ' + label); }

/**
 * 造一个页面环境：@param options.role 角色号；adminInfo 传 undefined 表示「缓存里没有 role」
 */
function make(relFile, options = {}) {
  const calls = { requests: [], nav: [], relaunch: [], modal: [] };
  const storage = Object.assign({}, options.storage || {});
  const app = {
    isAdminLoggedIn: () => options.loggedIn !== false,
    globalData: {
      statusBarHeight: 28,
      adminInfo: 'adminInfo' in options ? options.adminInfo : { id: 7, role: options.role },
    },
  };
  const adminRequest = (url, method, body) => {
    calls.requests.push({ url, method, body });
    if (options.request) return options.request(url, method, body);
    return Promise.resolve({});
  };
  const permStub = {
    load: () => Promise.resolve({ schedule: true, text: {} }),
    startPolling() {}, stopPolling() {},
  };
  const todoStub = { fetchBadges: () => Promise.resolve({}), emptyBadges: () => ({}) };
  const wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    navigateTo: (o) => calls.nav.push(o.url),
    reLaunch: (o) => calls.relaunch.push(o.url),
    navigateBack: (o) => calls.modal.push(o),
    showModal: (o) => calls.modal.push(o),
    showToast: (o) => calls.modal.push(o),
    stopPullDownRefresh() {},
  };

  // utils/partnerRole 必须在同一个沙箱里跑（它要读 wx / getApp），不能走 Node 的 require
  const roleFile = path.join(root, 'utils', 'partnerRole.js');
  const roleModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(roleFile, 'utf8'), {
    module: roleModule, exports: roleModule.exports, require: () => ({ adminRequest }),
    getApp: () => app, wx, console,
  }, { filename: roleFile });

  const file = path.join(PARTNER, relFile);
  let definition = null;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: (value) => { definition = value; applyDefault(value); },
    getApp: () => app,
    getCurrentPages: () => [{}],
    require: (id) => {
      if (id.indexOf('partnerRole') >= 0) return roleModule.exports;
      if (id.indexOf('utils/perm') >= 0) return permStub;
      if (id.indexOf('partnerTodo') >= 0) return todoStub;
      if (id.endsWith('request') || id.endsWith('request.js')) return { adminRequest };
      return require(path.resolve(path.dirname(file), id));
    },
    wx, console,
  }, { filename: file });
  assert.ok(definition, relFile + ' 没有调用 Page()');

  const instance = {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(value) { Object.assign(this.data, JSON.parse(JSON.stringify(value))); },
  };
  Object.keys(definition).forEach((key) => {
    if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance);
  });
  return { instance, calls, storage, definition };
  // Page({...}) 里的 data 可能是函数？本项目一律是对象，这里只兜住对象
  function applyDefault() { /* 占位，保持 Page 回调签名稳定 */ }
}

(async () => {
  // ── 一、排班工作台：超管必须进编辑页 ───────────────────────────────
  await test('工作台 · 超管点「排班规则」进编辑页，不弹只读层', async () => {
    const p = make('schedule/planning/planning.js', { role: 0 });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.isSuper, true);
    await p.instance.goRules();
    assert.deepEqual(p.calls.nav, [RULES_URL]);
    assert.equal(p.instance.data.ruleOpen, false);
  });

  await test('工作台 · 社干点「排班规则」只开只读弹层，不进编辑页', async () => {
    const p = make('schedule/planning/planning.js', { role: 1 });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.isSuper, false);
    await p.instance.goRules();
    assert.deepEqual(p.calls.nav, []);
    assert.equal(p.instance.data.ruleOpen, true);
  });

  await test('工作台 · 站员进不来：直接退回班表页', async () => {
    const p = make('schedule/planning/planning.js', { role: 2 });
    await p.instance.onLoad({});
    assert.deepEqual(p.calls.relaunch, ['/pages-partner/schedule/index/index']);
    assert.equal(p.calls.requests.length, 0);
  });

  await test('工作台 · 缓存缺 role 的超管：问一次 /partner/me 后进编辑页', async () => {
    const p = make('schedule/planning/planning.js', {
      adminInfo: { id: 7, username: 't' },          // 老缓存：有 id、没有 role
      request: (url) => (url === '/partner/me'
        ? Promise.resolve({ id: 7, username: 't', nickname: '老师', role: 0 })
        : Promise.resolve({})),
    });
    assert.equal(p.instance.data.isSuper, false);
    await p.instance.goRules();
    assert.ok(p.calls.requests.some((r) => r.url === '/partner/me'));
    assert.deepEqual(p.calls.nav, [RULES_URL]);
    assert.equal(p.instance.data.ruleOpen, false);
    // 顺手把服务端角色写回缓存，下一个点进来的人不用再问
    assert.equal(p.storage.adminInfo.role, 0);
  });

  await test('工作台 · 缺 role 又查不到服务端：退回只读弹层，不伪造权限', async () => {
    const p = make('schedule/planning/planning.js', {
      adminInfo: { id: 7 },
      request: () => Promise.reject({ code: 50001, message: '网络不给力' }),
    });
    await p.instance.goRules();
    assert.deepEqual(p.calls.nav, []);
    assert.equal(p.instance.data.ruleOpen, true);
  });

  // ── 二、班表页：同一个入口也不能把超管做成弹窗 ────────────────────
  await test('班表页 · 超管点「排班规则」进编辑页', async () => {
    const p = make('schedule/index/index.js', { role: 0 });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.roleKey, 'super');
    await p.instance.openRules();
    assert.deepEqual(p.calls.nav, [RULES_URL]);
    assert.equal(p.instance.data.ruleOpen, false);
  });

  await test('班表页 · 社干只开只读弹层', async () => {
    const p = make('schedule/index/index.js', { role: 1 });
    await p.instance.onLoad({});
    await p.instance.openRules();
    assert.deepEqual(p.calls.nav, []);
    assert.equal(p.instance.data.ruleOpen, true);
  });

  await test('班表页 · 站员只开只读弹层', async () => {
    const p = make('schedule/index/index.js', { role: 2 });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.isMember, true);
    await p.instance.openRules();
    assert.deepEqual(p.calls.nav, []);
    assert.equal(p.instance.data.ruleOpen, true);
  });

  await test('班表页 · 缓存缺 role 的超管：确认后进编辑页，不当社干', async () => {
    const p = make('schedule/index/index.js', {
      adminInfo: { id: 7 },
      request: (url) => (url === '/partner/me' ? Promise.resolve({ id: 7, nickname: '老师', role: 0 }) : Promise.resolve({})),
    });
    await p.instance.openRules();
    assert.deepEqual(p.calls.nav, [RULES_URL]);
  });

  // ── 三、规则编辑页本身：超管不能被自己的页面锁成只读 ──────────────
  await test('规则页 · 超管可改（加减号 / 开关 / 保存）', async () => {
    const p = make('rules/rules.js', { role: 0 });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.canEdit, true);
  });

  await test('规则页 · 社干 / 站员只读', async () => {
    for (const role of [1, 2]) {
      const p = make('rules/rules.js', { role });
      await p.instance.onLoad({});
      assert.equal(p.instance.data.canEdit, false, 'role=' + role);
    }
  });

  await test('规则页 · 缓存缺 role 的超管：确认后自动解锁编辑', async () => {
    const p = make('rules/rules.js', {
      adminInfo: { id: 7 },
      request: (url) => (url === '/partner/me' ? Promise.resolve({ id: 7, nickname: '老师', role: 0 }) : Promise.resolve({ items: [] })),
    });
    await p.instance.onLoad({});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(p.instance.data.canEdit, true);
  });

  await test('规则页 · 只读时不给拨开关（原生 switch 会自己动）', async () => {
    const wxml = fs.readFileSync(path.join(PARTNER, 'rules', 'rules.wxml'), 'utf8');
    assert.ok(wxml.includes('disabled="{{!canEdit}}"'), 'switch 必须 disabled 绑定 canEdit');
    assert.ok(!/wx:if="\{\{canEdit\}\}"[\s\S]*<switch/.test(wxml) || wxml.includes('disabled'), 'switch 不能只靠 wx:if');
  });

  // ── 四、结构守卫：入口与弹层还在，别被顺手删掉 ────────────────────
  await test('结构 · 工作台保留「排班规则」行 + 只读弹层组件', async () => {
    const wxml = fs.readFileSync(path.join(PARTNER, 'schedule', 'planning', 'planning.wxml'), 'utf8');
    assert.ok(wxml.includes('bindtap="goRules"'));
    assert.ok(wxml.includes('<rules-sheet open="{{ruleOpen}}"'));
    const js = fs.readFileSync(path.join(PARTNER, 'schedule', 'planning', 'planning.js'), 'utf8');
    assert.ok(/goRules\(\)[\s\S]{0,400}navigateTo\(\{ url: '\/pages-partner\/rules\/rules' \}\)/.test(js), 'goRules 必须保留进编辑页的分支');
  });

  await test('结构 · 班表页的规则行只给站员（社干 / 超管走工作台那一行）', async () => {
    const wxml = fs.readFileSync(path.join(PARTNER, 'schedule', 'index', 'index.wxml'), 'utf8');
    const at = wxml.indexOf('bindtap="openRules"');
    assert.ok(at > 0, '班表页仍有排班规则入口');
    const head = wxml.slice(0, at);
    assert.ok(head.lastIndexOf('wx:if="{{isMember}}"') > head.lastIndexOf('</block>'), '入口必须在站员块里');
  });

  await test('结构 · 只读弹层里一个可控件都没有', async () => {
    const wxml = fs.readFileSync(path.join(PARTNER, 'components', 'rules-sheet', 'index.wxml'), 'utf8');
    assert.ok(!wxml.includes('<switch'), '只读弹层不许摆开关');
    assert.ok(!wxml.includes('bindtap="step"'), '只读弹层不许摆加减号');
  });

  console.log(`\n${checks} 项排班规则入口分派检查通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
