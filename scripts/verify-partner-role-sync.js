'use strict';

// 伙伴端「角色实时同步」检查（2026-11-02 陛下：管理端 web 改完角色，伙伴端要跟上）
//
// 用法：node scripts/verify-partner-role-sync.js
//
// 病根：伙伴端所有页的 roleKey 都是 onLoad 时从缓存 `adminInfo.role` 抄的。
//   超管在电脑端把人改成站员之后，那人切回小程序 —— 底栏还是 5 格、审核入口还在，
//   点进去才被后端 40301 拦住。接口侧已经以库为准（cloud/lib/auth.requireAdmin），
//   差的是**界面**这一半。
//
// 这里钉两件事：
//   ① utils/partnerRole.sync 的口径：15 秒 TTL 内不重复打接口，但本地角色被别人写新了要重拉
//   ② 四个 tab 页的 syncRole：站点角色变了就重排底栏；站员不该留在审核页
//
// 隔离 Page / wx / 请求，不碰真实账号。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'miniprogram');
const PARTNER = path.join(root, 'pages-partner');

let checks = 0;
async function test(label, fn) { await fn(); checks += 1; console.log('✓ ' + label); }

/** 造一个页面环境；request 收到 (url, method) 自己决定回什么 */
function make(relFile, options = {}) {
  const calls = { requests: [], nav: [], relaunch: [], toast: [] };
  const storage = Object.assign({}, options.storage || {});
  if (!('adminInfo' in storage) && options.role !== undefined) storage.adminInfo = { id: 7, role: options.role };
  const app = {
    isAdminLoggedIn: () => options.loggedIn !== false,
    globalData: { statusBarHeight: 28, adminInfo: storage.adminInfo || null },
  };
  const adminRequest = (url, method, body) => {
    calls.requests.push({ url, method, body });
    if (options.request) return options.request(url, method, body);
    return Promise.resolve({});
  };
  const permStub = {
    load: () => Promise.resolve({ schedule: true, review: true, text: {} }),
    startPolling() {}, stopPolling() {},
  };
  const todoStub = { fetchBadges: () => Promise.resolve({}), emptyBadges: () => ({}) };
  const wx = {
    getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    navigateTo: (o) => calls.nav.push(o.url),
    reLaunch: (o) => calls.relaunch.push(o.url),
    navigateBack() {},
    showToast: (o) => calls.toast.push(o.title),
    showModal() {},
    stopPullDownRefresh() {},
  };

  // partnerRole 必须在同一个沙箱里跑（它要读 wx / getApp）
  const roleFile = path.join(root, 'utils', 'partnerRole.js');
  const roleModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(roleFile, 'utf8'), {
    module: roleModule, exports: roleModule.exports, require: () => ({ adminRequest }),
    getApp: () => app, wx, console,
  }, { filename: roleFile });

  const file = path.join(PARTNER, relFile);
  let definition = null;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: (value) => { definition = value; },
    getApp: () => app,
    getCurrentPages: () => [{}],
    require: (id) => {
      if (id.indexOf('partnerRole') >= 0) return roleModule.exports;
      if (id.indexOf('utils/perm') >= 0) return permStub;
      if (id.indexOf('partnerTodo') >= 0) return todoStub;
      if (id.endsWith('request') || id.endsWith('request.js')) return { adminRequest, isConflict: () => false };
      return require(path.resolve(path.dirname(file), id));
    },
    wx, console,
  }, { filename: file });
  assert.ok(definition, relFile + ' 没有调用 Page()');

  const instance = {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(value, cb) { Object.assign(this.data, JSON.parse(JSON.stringify(value))); if (cb) cb(); },
  };
  Object.keys(definition).forEach((key) => {
    if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance);
  });
  return { instance, calls, storage, role: roleModule.exports };
}

/** /partner/me 的标准回包 */
const meOf = (role, extra) => Object.assign({ id: 7, username: 'stu01', nickname: '小明', role }, extra || {});

(async () => {
  /* ───────── ① partnerRole.sync 本身 ───────── */
  await test('sync：服务端换了角色 → changed，并写回缓存', async () => {
    const p = make('desk/desk.js', { role: 1, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(2)) : Promise.resolve({})) });
    const r = await p.role.sync(true);
    assert.equal(r.changed, true);
    assert.equal(r.prev, 1);
    assert.equal(r.next, 2);
    assert.equal(p.storage.adminInfo.role, 2, '缓存必须写回新角色');
    assert.equal(p.role.role(), 2, 'role() 之后读到的就是新值');
  });

  await test('sync：角色没变 → changed=false，不算打扰', async () => {
    const p = make('desk/desk.js', { role: 1, request: () => Promise.resolve(meOf(1)) });
    const r = await p.role.sync(true);
    assert.equal(r.changed, false);
  });

  await test('sync：15 秒内不重复打接口', async () => {
    const p = make('desk/desk.js', { role: 1, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(1)) : Promise.resolve({})) });
    await p.role.sync(true);
    const n = p.calls.requests.filter((x) => x.url === '/partner/me').length;
    await p.role.sync();
    await p.role.sync();
    assert.equal(p.calls.requests.filter((x) => x.url === '/partner/me').length, n, 'TTL 内不该再打');
  });

  await test('sync：本地 role 被别处写新了 → 不吃旧缓存，重新问', async () => {
    const p = make('desk/desk.js', { role: 1, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(1)) : Promise.resolve({})) });
    await p.role.sync(true);
    p.role.remember({ id: 7, role: 0 });               // 「我的」页 fetchMe 刚把新值写进缓存（两处一起写）
    const r = await p.role.sync();                      // 不带 force
    assert.ok(p.calls.requests.filter((x) => x.url === '/partner/me').length >= 2, '必须重新问一次');
    assert.equal(r.changed, true, '从 0 变回服务端的 1，也得报 changed');
  });

  await test('sync：接口失败 → 不改本地、不报 changed', async () => {
    const p = make('desk/desk.js', { role: 1, request: () => Promise.reject({ code: 40101, message: '登录已过期' }) });
    const r = await p.role.sync(true);
    assert.equal(r.changed, false);
    assert.equal(p.storage.adminInfo.role, 1, '失败时不许把界面打回默认角色');
  });

  /* ───────── ② 四个 tab 页都接上了 ───────── */
  await test('工作台：角色变了重排底栏（站员 tab 从 desk 换 home）', async () => {
    const p = make('desk/desk.js', { role: 1, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(2)) : Promise.resolve({})) });
    p.instance.data.ready = true;
    await p.instance.syncRole();
    assert.equal(p.instance.data.roleKey, 'member');
    assert.equal(p.instance.data.roleTag, '站员');
    assert.equal(p.instance.data.tabActive, 'home');
    assert.ok(p.calls.toast.includes('权限已更新'));
  });

  await test('审核页：降到站员必须离开（那一页不属于他）', async () => {
    const p = make('review/review.js', { role: 0, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(2)) : Promise.resolve({})) });
    p.instance.data.ready = true;
    p.instance.data.roleManager = false;
    await p.instance.syncRole();
    assert.deepEqual(p.calls.relaunch, ['/pages-partner/desk/desk']);
  });

  await test('审核页：超管降成社干留在原地，只重排角色（审核仍可做）', async () => {
    const p = make('review/review.js', { role: 0, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(1)) : Promise.resolve({})) });
    p.instance.data.ready = true;
    await p.instance.syncRole();
    assert.deepEqual(p.calls.relaunch, [], '社干仍然能审核，不该被踢走');
    assert.equal(p.instance.data.roleKey, 'manager');
    assert.equal(p.instance.data.roleManager, true);
  });

  await test('稿件页：三档都能进，只换底栏不跳转', async () => {
    const p = make('work/work.js', { role: 2, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(1)) : Promise.resolve({})) });
    p.instance.data.ready = true;
    await p.instance.syncRole();
    assert.deepEqual(p.calls.relaunch, []);
    assert.equal(p.instance.data.roleKey, 'manager');
  });

  await test('班表页：roleKey / isMember / tabId 一起换', async () => {
    const p = make('schedule/index/index.js', { role: 1, request: (url) => (url === '/partner/me' ? Promise.resolve(meOf(2)) : Promise.resolve({})) });
    p.instance.data.ready = true;
    p.instance.data.roleKey = 'manager';
    p.instance.data.isMember = false;
    p.instance.data.tabId = 'scheduling';
    await p.instance.syncRole();
    assert.equal(p.instance.data.roleKey, 'member');
    assert.equal(p.instance.data.isMember, true);
    assert.equal(p.instance.data.tabId, 'schedule');
  });

  /* ───────── ③ 结构守卫：别在重构时把 onShow 那一句删了 ───────── */
  await test('结构：四个 tab 页的 onShow 都会对账一次角色', () => {
    const pages = ['desk/desk.js', 'review/review.js', 'work/work.js', 'schedule/index/index.js'];
    pages.forEach((f) => {
      const src = fs.readFileSync(path.join(PARTNER, f), 'utf8');
      assert.ok(/syncRole\([^)]*\)\s*\{/.test(src), f + ' 缺少 syncRole 方法');
      const onShow = src.slice(src.indexOf('onShow()'), src.indexOf('onShow()') + 600);
      assert.ok(/this\.syncRole\(\)/.test(onShow), f + ' 的 onShow 没有调 syncRole');
      assert.ok(/partnerRole\.sync\(/.test(src), f + ' 没有走 partnerRole.sync');
    });
  });

  await test('结构：底栏按 roleKey 渲染（角色一变格数就变）', () => {
    const wxml = fs.readFileSync(path.join(PARTNER, 'components', 'partner-tabbar', 'index.js'), 'utf8');
    assert.ok(/TABS\s*=\s*\{[\s\S]*member:[\s\S]*manager:/.test(wxml), '底栏必须按身份出两套 tab');
    assert.ok(/TABS\.super\s*=\s*TABS\.manager/.test(wxml), '超管与社干同一套底栏');
  });

  console.log(`\n${checks} 项伙伴端角色同步检查通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
