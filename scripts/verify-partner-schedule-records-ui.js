'use strict';
// 原生班表辅助页行为检查；隔离 Page/wx 与请求，不接触真实账号或班表。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'miniprogram', 'pages-partner', 'schedule');
const copy = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
async function test(label, fn) { await fn(); checks += 1; console.log('✓ ' + label); }
function make(name, options = {}) {
  let definition;
  const requests = [], launches = [], backs = [];
  const app = { isAdminLoggedIn: () => options.loggedIn !== false,
    globalData: { statusBarHeight: 28, adminInfo: { id: 7, role: options.role === undefined ? 0 : options.role } } };
  const adminRequest = (url, method, body) => {
    requests.push(copy({ url, method, body }));
    return options.request ? options.request(url, method, body) : Promise.resolve({});
  };
  const file = path.join(root, name, name + '.js');
  const source = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(source, {
    Page: (value) => { definition = value; },
    getApp: () => app, getCurrentPages: () => Array.from({ length: options.depth || 1 }, () => ({})),
    require: (id) => id.endsWith('request.js') ? { adminRequest } : require(path.resolve(path.dirname(file), id)),
    wx: { reLaunch: (value) => launches.push(copy(value)), navigateBack: (value) => backs.push(copy(value)), stopPullDownRefresh() {} },
    console,
  }, { filename: file });
  const instance = { data: copy(definition.data), setData(value) { Object.assign(this.data, copy(value)); } };
  Object.keys(definition).forEach((key) => {
    if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance);
  });
  return { instance, definition, requests, launches, backs };
}
const week = '2026-11-02';
const historyPayload = (snapshot) => ({ weekStart: week, version: 2,
  list: [{ id: 1, action: 'publish', actorName: '测试操作者', createTime: '2026-11-02T00:10:00.000Z',
    reason: '测试原因', version: 2, snapshot }], versions: [{ version: 2, total: 1,
    publishedAt: '2026-11-02T00:10:00.000Z', publishedByName: '测试操作者' }] });

(async () => {
  for (const name of ['workload', 'history']) {
    await test(name + '：未登录仅返回伙伴登录页，不查询数据', async () => {
      const p = make(name, { loggedIn: false }); await p.instance.onLoad({});
      assert.equal(p.requests.length, 0); assert.equal(p.launches[0].url, '/pages-partner/login/login');
    });
    await test(name + '：站员不能越权进入管理辅助页', async () => {
      const p = make(name, { role: 2 }); await p.instance.onLoad({});
      assert.equal(p.requests.length, 0); assert.equal(p.launches[0].url, '/pages-partner/schedule/index/index');
    });
    await test(name + '：社干可查询且只通过独立 adminRequest 读接口', async () => {
      const p = make(name, { role: 1 }); await p.instance.onLoad({});
      assert.ok(p.requests.length); assert.ok(p.requests.every((req) => req.method === 'GET' && !req.url.startsWith('/api/')));
      assert.equal(p.instance.data.statusBarHeight, 28); assert.equal(p.instance.data.loadError, '');
    });
    await test(name + '：请求失败可重试，不伪装为零数据', async () => {
      let failed = true;
      const p = make(name, { request: () => failed ? Promise.reject({ message: '临时不可用' }) : Promise.resolve({}) });
      await p.instance.onLoad({}); assert.equal(p.instance.data.loadError, '临时不可用'); assert.equal(p.instance.data.loading, false);
      failed = false; await p.instance.load(); assert.equal(p.instance.data.loadError, '');
    });
    await test(name + '：失效 token 返回伙伴登录，不涉及学生登录态', async () => {
      const p = make(name, { request: () => Promise.reject({ code: 40101, message: '请登录' }) });
      await p.instance.onLoad({}); assert.equal(p.launches[0].url, '/pages-partner/login/login');
    });
    await test(name + '：保留上一级返回栈，直接打开则回班表', () => {
      const p = make(name, { depth: 2 }); p.instance.goBack(); assert.deepEqual(p.backs, [{ delta: 1 }]);
      const direct = make(name); direct.instance.goBack(); assert.equal(direct.launches[0].url, '/pages-partner/schedule/index/index');
    });
    await test(name + '：页面关闭后的迟到响应不会改页面', async () => {
      const waiting = [];
      const p = make(name, { request: () => new Promise((done) => { waiting.push(done); }) });
      const loading = p.instance.onLoad({}); p.instance.onUnload(); const before = copy(p.instance.data);
      waiting.forEach((resolve) => resolve({ list: [] })); await loading; assert.deepEqual(p.instance.data, before);
    });
    await test(name + '：WXML 绑定均存在且无微信不支持的函数表达式', () => {
      const p = make(name); const wxml = fs.readFileSync(path.join(root, name, name + '.wxml'), 'utf8');
      for (const binding of wxml.matchAll(/\b(?:bind|catch)(?::)?[a-z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g)) assert.equal(typeof p.definition[binding[1]], 'function', binding[1]);
      for (const expr of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) assert.doesNotMatch(expr[1], /[A-Za-z_$][\w$.]*\s*\(/);
      JSON.parse(fs.readFileSync(path.join(root, name, name + '.json'), 'utf8'));
    });
  }

  await test('轮值合并全员，保留零场次与服务端历史成员，不伪造场次', async () => {
    const p = make('workload', { request: (url) => Promise.resolve(url.endsWith('/people')
      ? { list: [{ personId: 7, name: '当前伙伴' }, { personId: 8, name: '零场成员' }] }
      : { month: '2026-11', list: [{ personId: 7, personName: '当前伙伴', count: 3 }, { personId: 9, personName: '历史成员', count: 2 }], total: 5 }) });
    await p.instance.onLoad({});
    assert.equal(p.instance.data.peopleCount, 3); assert.equal(p.instance.data.total, 5); assert.equal(p.instance.data.monthLabel, '11 月');
    assert.equal(p.instance.data.list.find((x) => x.personId === 8).count, 0);
    assert.equal(p.instance.data.list.find((x) => x.personId === 7).mine, true);
    assert.ok(p.instance.data.list.every((x) => x.percent >= 0 && x.percent <= 100));
  });
  await test('轮值支持场次与最近值班排序，两种排序保持全部成员', async () => {
    const p = make('workload', { request: (url) => Promise.resolve(url.endsWith('/people') ? { list: [] } : { list: [
      { personId: 7, personName: '甲', count: 3, lastDay: '2026-11-02' },
      { personId: 8, personName: '乙', count: 1, lastDay: '2026-11-05' },
      { personId: 9, personName: '丙', count: 0 },
    ] }) });
    await p.instance.onLoad({}); assert.equal(p.instance.data.list[0].personId, 7);
    p.instance.toggleSort(); assert.equal(p.instance.data.list[0].personId, 8); assert.equal(p.instance.data.list.length, 3);
    p.instance.toggleSort(); assert.equal(p.instance.data.list[0].personId, 7);
  });
  await test('首次查询不自行推算手机本周，历史页沿用服务端返回的周', async () => {
    const p = make('history', { request: () => Promise.resolve(historyPayload()) });
    await p.instance.onLoad({}); assert.deepEqual(p.requests[0].body, {}); assert.equal(p.instance.data.weekStart, week);
    await p.instance.load(); assert.equal(p.requests[1].body.week, week);
  });
  await test('从工作台携带周锚点时保持查询同周', async () => {
    const p = make('history', { request: () => Promise.resolve(historyPayload()) });
    await p.instance.onLoad({ week }); assert.equal(p.requests[0].body.week, week);
  });
  await test('记录渲染服务端操作人、原因、版本，时间按北京时间显示', async () => {
    const p = make('history', { request: () => Promise.resolve(historyPayload()) }); await p.instance.onLoad({});
    const row = p.instance.data.list[0];
    assert.equal(row.actor, '测试操作者'); assert.equal(row.reason, '测试原因'); assert.equal(row.version, 2);
    assert.equal(row.timeText, '11/02 08:10'); assert.equal(row.actionText, '发布本周班表');
    assert.equal(p.instance.data.publishedText, '11/02 08:10 发布');
  });
  await test('社干未获后台快照时不显示入口，也不拼造当前草稿', async () => {
    const p = make('history', { role: 1, request: () => Promise.resolve(historyPayload()) });
    await p.instance.onLoad({}); assert.equal(p.instance.data.hasSnapshots, false);
    p.instance.openLatestSnapshot(); assert.equal(p.instance.data.snapshotOpen, false);
    p.instance.openSnapshot({ currentTarget: { dataset: { index: 0 } } }); assert.equal(p.instance.data.snapshotOpen, false);
  });
  await test('快照弹层保留整周岗位与空缺，关闭时返回原列表', async () => {
    const snapshot = { weekStart: week, days: [{ day: week, dayName: '周一', slots: [{ slot: '午间', timeText: '12:10-12:30',
      groups: [{ slotKey: '0-1', department: '播音部', count: 1, people: [] }] }] }] };
    const p = make('history', { request: () => Promise.resolve(historyPayload(snapshot)) });
    await p.instance.onLoad({}); const before = copy(p.instance.data.list); p.instance.openLatestSnapshot();
    assert.equal(p.instance.data.snapshotOpen, true); assert.deepEqual(p.instance.data.snapshot, snapshot);
    assert.equal(p.instance.data.snapshotTitle, '第 2 版完整快照');
    p.instance.closeSnapshot(); assert.equal(p.instance.data.snapshotOpen, false); assert.deepEqual(p.instance.data.list, before);
  });
  await test('兼容 assignment 快照与旧日志字段，不丢人员', async () => {
    const payload = { weekStart: week, version: 1, list: [{ id: 'old-1', actionText: '手动补位', operatorName: '兼容操作者',
      createdAt: '2026-11-02T00:00:00Z', snapshot: { assignments: [{ day: week, slot: '午间', timeText: '12:10-12:30',
        slotKey: '0-1', department: '播音部', personId: 7, personName: '当前伙伴' }] } }] };
    const p = make('history', { request: () => Promise.resolve(payload) }); await p.instance.onLoad({});
    assert.equal(p.instance.data.list[0].actor, '兼容操作者'); p.instance.openLatestSnapshot();
    assert.equal(p.instance.data.snapshot.days.length, 5);
    assert.equal(p.instance.data.snapshot.days[0].slots[0].groups[0].people[0].personName, '当前伙伴');
  });
  await test('实际后端模板快照保留所有空缺与并行部门岗位', async () => {
    const snapshot = { weekStart: week, slotVersion: 4,
      templates: [
        { day: 0, title: '早会', start: 410, end: 440, dept: '主持部', role: '主持', count: 1 },
        { day: 0, title: '午间', start: 730, end: 750, dept: '播音部', role: '播音', count: 2 },
        { day: 0, title: '午间', start: 730, end: 750, dept: '编辑部', role: '编辑', count: 1 },
        { day: 1, title: '午间', start: 730, end: 750, dept: '播音部', role: '播音', count: 1 },
      ],
      assignments: [{ day: week, slot: '午间', timeText: '12:10-12:30', slotKey: '0-3',
        department: '编辑部', role: '编辑', personId: 7, personName: '当前伙伴' }],
    };
    const payload = historyPayload(snapshot);
    payload.list[0].summary = { needed: 5, filled: 1, missing: 4, fixed: 1 };
    const p = make('history', { request: () => Promise.resolve(payload) }); await p.instance.onLoad({});
    p.instance.openLatestSnapshot(); const days = p.instance.data.snapshot.days;
    assert.equal(days[0].slots.length, 2); assert.equal(days[0].slots[0].timeText, '06:50-07:20');
    assert.equal(days[0].slots[0].groups[0].people.length, 0);
    const noon = days[0].slots[1]; assert.equal(noon.groups.length, 2);
    assert.equal(noon.groups[0].count, 2); assert.equal(noon.groups[0].people.length, 0);
    assert.equal(noon.groups[1].slotKey, '0-3'); assert.equal(noon.groups[1].people[0].personId, 7);
    assert.equal(days[1].slots[0].groups[0].slotKey, '1-1');
    assert.equal(days[1].slots[0].groups[0].people.length, 0);
    assert.equal(p.instance.data.list[0].summaryText, '已安排 1/5 个岗位·缺岗 4');
  });
  await test('过期响应不能覆盖较新的轮值查询', async () => {
    const waiting = [];
    const p = make('workload', { request: () => new Promise((resolve) => waiting.push(resolve)) });
    const first = p.instance.onLoad({}); const second = p.instance.load();
    waiting[2]({ list: [{ personId: 7, personName: '新数据', count: 1 }] }); waiting[3]({ list: [] }); await second;
    waiting[0]({ list: [{ personId: 7, personName: '旧数据', count: 9 }] }); waiting[1]({ list: [] }); await first;
    assert.equal(p.instance.data.list[0].personName, '新数据'); assert.equal(p.instance.data.total, 1);
  });
  console.log(`\n${checks} 项原生班表辅助页行为检查通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
