'use strict';

const request = require('supertest');
const { buildApp, initTestEnv, nextWeekSlotValues } = require('./app');
const {
  sequelize, resetDB, seedAdmin, loginAdmin, loginUser,
} = require('./helpers');

let app;
let adminToken;
let userToken;

beforeAll(async () => {
  app = buildApp();
  await resetDB();
  await seedAdmin();
  adminToken = await loginAdmin(app);
  userToken = await loginUser(app, { code: 'mock_switch_user' });
  // seed 默认开关 + 预热缓存（每次 resetDB 后都要重做）
  await initTestEnv();
});
afterAll(async () => { await sequelize.close(); });

describe('AC2：默认 4 条 seed 全为 on', () => {
  test('user switch/list 返回 4 条', async () => {
    const r = await request(app).get('/api/user/switch/list');
    expect(r.body.code).toBe(0);
    expect(r.body.data.list.length).toBe(4);
    expect(r.body.data.list.every(s => s.value === 'on')).toBe(true);
  });
});

describe('AC3 + AC4：切换开关生效 + 用户端看到 off', () => {
  test('超管 PUT switch/submit_song off → 用户端看到 off', async () => {
    const r = await request(app)
      .put('/api/admin/switch/submit_song')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'off' });
    expect(r.body.code).toBe(0);
    expect(r.body.data.value).toBe('off');

    const u = await request(app).get('/api/user/switch/submit_song');
    expect(u.body.data.value).toBe('off');

    const list = await request(app).get('/api/user/switch/list');
    const song = list.body.data.list.find(s => s.key === 'submit_song');
    expect(song.value).toBe('off');
  });

  test('非超管访问 403', async () => {
    const bcrypt = require('bcryptjs');
    const { Admin } = require('../src/models');
    const hash = await bcrypt.hash('staff123456', 10);
    await Admin.create({ username: 'staff2', password: hash, role: 1, status: 1 });
    const r = await request(app).post('/api/admin/login').send({ username: 'staff2', password: 'staff123456' });
    const staffToken = r.body.data.token;
    const r2 = await request(app)
      .put('/api/admin/switch/submit_song')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ value: 'on' });
    expect(r2.body.code).toBe(40301);
  });

  test('参数非法返回 400', async () => {
    const r = await request(app)
      .put('/api/admin/switch/submit_song')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'maybe' });
    expect(r.body.code).toBe(40001);
  });
});

describe('AC5：点歌关闭 → submit type=1 返回 40302', () => {
  // 此时 submit_song 应已 off
  test('40302 + 提示文案', async () => {
    const r = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: 'a', singer: 'b' });
    expect(r.body.code).toBe(40302);
    expect(r.body.message).toMatch(/关闭/);
  });
});

describe('AC6：文稿关闭 → submit type=2 返回 40302', () => {
  test('先关闭再测', async () => {
    await request(app)
      .put('/api/admin/switch/submit_article')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'off' });
    const r = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 2, articleTitle: 't', articleContent: 'c' });
    expect(r.body.code).toBe(40302);
  });
});

describe('AC7：留言关闭 → message 返回 40302', () => {
  test('先关闭再测', async () => {
    await request(app)
      .put('/api/admin/switch/message')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'off' });
    const r = await request(app)
      .post('/api/user/message')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ content: 'hi' });
    expect(r.body.code).toBe(40302);
  });
});

describe('AC8：风采关闭 → member/list 仍返回（不拦截读）', () => {
  test('关 member 后 list 不报错', async () => {
    await request(app)
      .put('/api/admin/switch/member')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'off' });
    const r = await request(app).get('/api/user/member/list');
    expect(r.body.code).toBe(0);
  });
});

describe('AC11：恢复后接口可用', () => {
  test('把 submit_song 改回 on → 提交成功', async () => {
    await request(app)
      .put('/api/admin/switch/submit_song')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'on' });
    // 因为有 1 分钟防重复，重复 songName 会被 409。换一个名字
    // v2 起点歌必须带 wantBroadcastTime（时间窗口已由 initTestEnv → openSongWindowForTest 放开）
    const [slot] = await nextWeekSlotValues();
    const r = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '恢复测试', singer: '测试', wantBroadcastTime: slot });
    expect(r.body.code).toBe(0);
  });
});
