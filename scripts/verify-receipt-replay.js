'use strict';

/**
 * 点歌回执行为验证：执行真实小程序 Page 方法，mock wx / request / windowBar。
 * 不依赖数据库、微信开发者工具或外网。运行：node scripts/verify-receipt-replay.js
 * deferred 请求按指定顺序完成，验证离页、二次提交及旧额度响应的竞态。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const format = require('../miniprogram/utils/format.js');

const pagePath = path.resolve(__dirname, '../miniprogram/pages/submit/submit.js');
const pageSource = fs.readFileSync(pagePath, 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const copy = (value) => JSON.parse(JSON.stringify(value));
const weekly = (limit, remaining, used = 1) => ({ userWeekly: { limit, remaining, used } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  // Promise.allSettled、then/catch 和 async 页面方法均不需要真实计时器。
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

function harness() {
  let definition;
  let timerId = 0;
  const timers = new Map();
  const pending = new Map();
  const calls = [];
  const nav = [];
  const scroll = [];
  const toasts = [];
  const tabbar = { data: {}, selected: null, setSelected(i) { this.selected = i; },
    setData(data) { Object.assign(this.data, data); } };
  const app = {
    globalData: { token: '', statusBarHeight: 20, navBarHeight: 44 },
    login: async () => { app.globalData.token = 'student-token'; },
  };
  const wb = { loads: 0, stops: 0,
    load() { this.loads += 1; return Promise.resolve(); },
    stopTimer() { this.stops += 1; } };
  function enqueue(url, value) {
    const queue = pending.get(url) || [];
    queue.push(value);
    pending.set(url, queue);
  }
  function request(url, method = 'GET', data = {}) {
    calls.push({ url, method, data });
    const queue = pending.get(url);
    if (queue && queue.length) {
      const value = queue.shift();
      return value && value.promise ? value.promise : Promise.resolve(value);
    }
    if (url === '/user/submit/quota') return Promise.resolve(weekly(2, 1));
    if (url === '/user/submit/timeslots') return Promise.resolve({ list: [], capacity: 0 });
    if (url === '/user/submit/notice?type=song') return Promise.resolve({ configured: false });
    if (url === '/user/submit' && method === 'POST') return Promise.resolve({ outcome: 'submitted', id: 7 });
    throw new Error('Unexpected request: ' + method + ' ' + url);
  }
  const context = {
    getApp: () => app,
    Page: (page) => { definition = page; },
    require: (name) => {
      if (name === '../../utils/request.js') return { request };
      if (name === '../../utils/format.js') return format;
      if (name === '../../utils/windowBar.js') return { create: () => wb };
      throw new Error('Unexpected page import: ' + name);
    },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    wx: {
      pageScrollTo: (options) => scroll.push(options),
      switchTab: (options) => nav.push(options),
      navigateTo: (options) => nav.push(options),
      showToast: (options) => toasts.push(options),
      showModal: (options) => options.success && options.success({ confirm: true }),
      nextTick: (fn) => fn(),
      createSelectorQuery: () => ({
        select() { return this; }, boundingClientRect() { return this; },
        exec(fn) { fn([{ height: 200 }, { height: 100 }]); },
      }),
    },
  };
  vm.runInNewContext(pageSource, context, { filename: pagePath });
  const page = Object.assign({}, definition, {
    data: copy(definition.data),
    getTabBar: () => tabbar,
    setData(data, callback) {
      Object.entries(data).forEach(([key, value]) => {
        const pieces = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (let i = 0; i < pieces.length - 1; i += 1) {
          const part = pieces[i];
          if (target[part] == null) target[part] = {};
          target = target[part];
        }
        target[pieces[pieces.length - 1]] = value;
      });
      if (callback) callback();
    },
  });
  // 实际生命周期先建立可见状态；未登录不触发前置请求，然后注入有效学生 token。
  page.onLoad();
  page.onShow();
  app.globalData.token = 'student-token';
  page.checkLogin();
  page.setData({ songName: '遇见', singer: '孙燕姿', wishContent: '祝大家顺利',
    wantBroadcastTime: '2026-10-05 午间 12:20', slotLabel: '周一 午间 12:20' });
  return { page, app, wb, calls, nav, scroll, toasts, tabbar, enqueue,
    count(url) { return calls.filter((call) => call.url === url).length; },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); timer.fn(); }
      }
    } };
}

test('提交成功立即显示回执，额度仍在请求时不猜剩余次数', async () => {
  const h = harness();
  const q = deferred();
  h.enqueue('/user/submit/quota', q);
  h.page.setData({ quotaText: '本周还能点 9 次（上限 9 次）',
    quotaWeekly: { limit: 9, remaining: 9, used: 0 } });
  await h.page.doSubmit();
  assert.ok(h.page.data.receipt);
  assert.equal(h.page.data.receipt.song, '遇见 — 孙燕姿');
  assert.equal(h.page.data.receipt.canReplay, false);
  assert.equal(h.page.data.receipt.leftText, '');
  assert.equal(h.page.data.submitting, false);
  assert.equal(h.count('/user/submit/quota'), 1);
  q.resolve(weekly(2, 1));
  await flush();
  assert.equal(h.page.data.receipt.canReplay, true);
  assert.equal(h.page.data.receipt.leftText, '本周还剩 1 次点歌机会');
});

for (const [name, value, canReplay, leftText] of [
  ['有限次数还有剩余', weekly(2, 1), true, '本周还剩 1 次点歌机会'],
  ['每周限一首且已用完', weekly(1, 0), false, ''],
  ['每周多首且已用完', weekly(2, 0, 2), false, ''],
  ['不限次数 remaining=null', weekly(0, null, 0), true, ''],
  ['不限次数无 remaining 字段', { userWeekly: { limit: 0, used: 0 } }, true, ''],
]) {
  test(name, async () => {
    const h = harness();
    h.enqueue('/user/submit/quota', value);
    h.page.showReceipt({ outcome: 'submitted' });
    await flush();
    assert.equal(h.page.data.receipt.canReplay, canReplay);
    assert.equal(h.page.data.receipt.leftText, leftText);
  });
}

test('额度请求失败仍保留成功回执，隐藏继续入口', async () => {
  const h = harness();
  const q = deferred();
  h.enqueue('/user/submit/quota', q);
  h.page.showReceipt({ outcome: 'submitted' });
  q.reject({ code: -1, message: '网络异常' });
  await flush();
  assert.ok(h.page.data.receipt);
  assert.equal(h.page.data.receipt.canReplay, false);
  assert.equal(h.page.data.receipt.leftText, '');
});

for (const [name, value] of [
  ['空响应', null],
  ['缺 userWeekly', {}],
  ['缺 limit', { userWeekly: { used: 1, remaining: 1 } }],
  ['缺 used', { userWeekly: { limit: 2, remaining: 1 } }],
  ['有限次数缺 remaining', { userWeekly: { limit: 2, used: 1 } }],
  ['limit 为 null', { userWeekly: { limit: null, used: 1, remaining: 1 } }],
  ['limit 负数', weekly(-1, 1)],
  ['limit 非整数', weekly(1.5, 1)],
  ['limit 非数字', weekly('invalid', 1)],
  ['used 负数', weekly(2, 1, -1)],
  ['used 非整数', weekly(2, 1, 0.5)],
  ['有限次数 remaining=null', weekly(2, null)],
  ['remaining 负数', weekly(2, -1)],
  ['remaining 非整数', weekly(2, 0.5)],
  ['remaining 大于 limit', weekly(2, 3)],
]) {
  test('非法额度：' + name, async () => {
    const h = harness();
    h.enqueue('/user/submit/quota', value);
    h.page.showReceipt({ outcome: 'submitted' });
    await flush();
    assert.ok(h.page.data.receipt);
    assert.equal(h.page.data.receipt.canReplay, false);
    assert.equal(h.page.data.receipt.leftText, '');
  });
}

function setDrafts(h) {
  h.page.setData({ articleTitle: '校园故事', articleContent: '这里保留文稿草稿。',
    allowReschedule: false, slotDays: [{ date: '2026-10-05',
      items: [{ value: '2026-10-05 午间 12:20', selected: true }] }] });
}

function assertCleanSong(page) {
  for (const key of ['songName', 'singer', 'wishContent', 'wantBroadcastTime', 'slotLabel']) {
    assert.equal(page.data[key], '', key + ' 应清空');
  }
  assert.equal(page.data.receipt, null);
  assert.equal(page.data.allowReschedule, true);
  assert.equal(page.data.articleTitle, '校园故事');
  assert.equal(page.data.articleContent, '这里保留文稿草稿。');
  assert.ok(page.data.slotDays.every((day) => day.items.every((item) => !item.selected)));
}

test('再点一首清点歌表单和时段选择，保留文稿并刷新全部前置数据', async () => {
  const h = harness();
  setDrafts(h);
  h.page.showReceipt({ outcome: 'submitted' });
  await flush();
  const quotaBefore = h.count('/user/submit/quota');
  h.page.replaySong();
  assertCleanSong(h.page);
  assert.equal(h.page.data.type, 1);
  assert.equal(h.scroll[h.scroll.length - 1].scrollTop, 0);
  await flush();
  assert.equal(h.count('/user/submit/quota'), quotaBefore + 1);
  assert.equal(h.count('/user/submit/timeslots'), 1);
  assert.equal(h.count('/user/submit/notice?type=song'), 1);
  assert.equal(h.wb.loads, 1);
});

test('额度已用完时触发 replaySong 也不会绕过入口判定', async () => {
  const h = harness();
  h.enqueue('/user/submit/quota', weekly(1, 0));
  h.page.showReceipt({ outcome: 'submitted' });
  await flush();
  const receipt = h.page.data.receipt;
  h.page.replaySong();
  assert.equal(h.page.data.receipt, receipt);
  assert.equal(h.page.data.songName, '遇见');
});

test('切页后返回清回执并重新获取服务端额度', async () => {
  const h = harness();
  setDrafts(h);
  h.page.showReceipt({ outcome: 'submitted' });
  await flush();
  h.page.onHide();
  // 撤销不会在前端加次数，返回后完全服从服务端的新额度。
  h.enqueue('/user/submit/quota', weekly(2, 0, 2));
  h.page.onShow();
  assertCleanSong(h.page);
  await flush();
  assert.equal(h.page.data.quotaBlocked, true);
  assert.equal(h.page.data.quotaWeekly.remaining, 0);
  assert.equal(h.tabbar.selected, 1);
});

test('没有成功提交时，切页返回保留点歌与文稿草稿', async () => {
  const h = harness();
  setDrafts(h);
  h.page.onHide();
  h.page.onShow();
  await flush();
  assert.equal(h.page.data.receipt, null);
  assert.equal(h.page.data.songName, '遇见');
  assert.equal(h.page.data.singer, '孙燕姿');
  assert.equal(h.page.data.wishContent, '祝大家顺利');
  assert.equal(h.page.data.wantBroadcastTime, '2026-10-05 午间 12:20');
  assert.equal(h.page.data.articleTitle, '校园故事');
  assert.equal(h.page.data.articleContent, '这里保留文稿草稿。');
  assert.equal(h.page.data.allowReschedule, false);
});

test('查看我的投稿导航正确', async () => {
  const h = harness();
  h.page.goMySubmit();
  assert.equal(h.nav[h.nav.length - 1].url, '/pages/mySubmit/mySubmit');
});

test('提交前额度晚返回不得覆盖成功后的最新额度', async () => {
  const h = harness();
  const before = deferred();
  const after = deferred();
  h.enqueue('/user/submit/quota', before);
  const earlier = h.page.loadQuota();
  h.enqueue('/user/submit/quota', after);
  h.page.showReceipt({ outcome: 'submitted' });
  after.resolve(weekly(2, 0, 2));
  await flush();
  before.resolve(weekly(2, 2, 0));
  await earlier;
  assert.equal(h.page.data.receipt.canReplay, false);
  assert.equal(h.page.data.receipt.leftText, '');
  assert.equal(h.page.data.quotaWeekly.remaining, 0);
});

test('上一份回执的额度晚返回不得写入下一份回执', async () => {
  const h = harness();
  const first = deferred();
  const second = deferred();
  h.enqueue('/user/submit/quota', first);
  h.page.showReceipt({ outcome: 'submitted' });
  h.page.resetSongForm();
  h.page.setData({ songName: '晴天', singer: '周杰伦' });
  h.enqueue('/user/submit/quota', second);
  h.page.showReceipt({ outcome: 'submitted' });
  second.resolve(weekly(2, 0, 2));
  await flush();
  first.resolve(weekly(2, 1));
  await flush();
  assert.equal(h.page.data.receipt.song, '晴天 — 周杰伦');
  assert.equal(h.page.data.receipt.canReplay, false);
  assert.equal(h.page.data.quotaWeekly.remaining, 0);
});

test('回执清除后额度完成，不得重新显示回执', async () => {
  const h = harness();
  const q = deferred();
  h.enqueue('/user/submit/quota', q);
  h.page.showReceipt({ outcome: 'submitted' });
  h.page.resetSongForm();
  q.resolve(weekly(2, 1));
  await flush();
  assert.equal(h.page.data.receipt, null);
});

for (const lifecycle of ['onHide', 'onUnload']) {
  test(lifecycle + ' 后额度完成不得改变隐藏页或新返回页', async () => {
    const h = harness();
    const q = deferred();
    h.enqueue('/user/submit/quota', q);
    h.page.showReceipt({ outcome: 'submitted' });
    h.page[lifecycle]();
    if (lifecycle === 'onHide') {
      h.enqueue('/user/submit/quota', weekly(2, 0, 2));
      h.page.onShow();
      await flush();
    }
    const dataBefore = JSON.stringify(h.page.data);
    q.resolve(weekly(2, 1));
    await flush();
    assert.equal(JSON.stringify(h.page.data), dataBefore);
  });
}

test('额度请求期间更换账号，旧账号额度不得写入', async () => {
  const h = harness();
  const q = deferred();
  h.enqueue('/user/submit/quota', q);
  h.page.showReceipt({ outcome: 'submitted' });
  h.app.globalData.token = 'another-student-token';
  q.resolve(weekly(2, 1));
  await flush();
  assert.equal(h.page.data.receipt.canReplay, false);
  assert.equal(h.page.data.receipt.leftText, '');
});

for (const returnBeforeSuccess of [false, true]) {
  test('离页期间提交成功' + (returnBeforeSuccess ? '（已经返回）' : '（稍后返回）'), async () => {
    const h = harness();
    setDrafts(h);
    const post = deferred();
    h.enqueue('/user/submit', post);
    const submission = h.page.doSubmit();
    await flush();
    assert.equal(h.count('/user/submit'), 1);
    h.page.onHide();
    if (returnBeforeSuccess) {
      h.page.onShow();
      await flush();
    }
    post.resolve({ outcome: 'submitted', id: 7 });
    await submission;
    assert.equal(h.page.data.receipt, null);
    if (!returnBeforeSuccess) h.page.onShow();
    await flush();
    assertCleanSong(h.page);
    assert.equal(h.page.data.submitting, false);
  });
}

test('离页后返回已编辑新歌名，旧提交成功不得清掉新草稿', async () => {
  const h = harness();
  setDrafts(h);
  const post = deferred();
  h.enqueue('/user/submit', post);
  const submission = h.page.doSubmit();
  await flush();
  h.page.onHide();
  h.page.onShow();
  await flush();
  // 用真实 input 处理方法模拟已返回页面的学生输入，其他字段也应随草稿保留。
  h.page.inputSongName({ detail: { value: '晴天' } });
  const draft = ['songName', 'singer', 'wishContent', 'wantBroadcastTime', 'slotLabel',
    'allowReschedule', 'articleTitle', 'articleContent'];
  const before = draft.map((key) => h.page.data[key]);
  post.resolve({ outcome: 'submitted', id: 7 });
  await submission;
  await flush();
  assert.equal(h.page.data.receipt, null);
  assert.deepEqual(draft.map((key) => h.page.data[key]), before);
  assert.equal(h.page.data.songName, '晴天');
  assert.equal(h.page.data.submitting, false);
});

test('文稿提交仍反馈成功并跳转我的投稿', async () => {
  const h = harness();
  h.page.setData({ type: 2, articleTitle: '校园故事', articleContent: '这里是一篇文稿。' });
  await h.page.doSubmit();
  assert.equal(h.page.data.receipt, null);
  assert.equal(h.page.data.submitting, false);
  const call = h.calls.find((item) => item.url === '/user/submit');
  assert.equal(call.data.type, 2);
  assert.equal(call.data.articleTitle, '校园故事');
  assert.ok(h.toasts.some((toast) => toast.title === '提交成功，等待审核'));
  h.runTimers(800);
  assert.equal(h.nav[h.nav.length - 1].url, '/pages/mySubmit/mySubmit');
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; }
    catch (error) { console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log('回执返回行为：' + passed + '/' + tests.length + ' 通过');
  if (passed !== tests.length) process.exitCode = 1;
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
