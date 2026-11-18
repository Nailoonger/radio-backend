'use strict';

const { buildApp } = require('./app');
const request = require('supertest');
const {
  sequelize, resetDB, seedAdmin,
  loginAdmin, createProgram, createNotice,
} = require('./helpers');

let app;
let adminToken;
beforeAll(async () => {
  app = buildApp();
  await resetDB();
  await seedAdmin();
  adminToken = await loginAdmin(app);
});
afterAll(async () => {
  await sequelize.close();
});

describe('节目 CRUD', () => {
  test('新建节目', async () => {
    const res = await request(app)
      .post('/api/admin/program/create')
      .set('Authorization', `Bearer ${adminToken}`)
      // 2026-11-19 起：不再填具体日期，改成 周几 + 时段 + 第几档
      .send({ title: '测试节目', host: '小王', weekdays: '1,3', slotLabel: '午间', slotIndex: 2 });
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBeGreaterThan(0);
    // 默认编排：午间 12:10-12:30 分 3 档 ⇒ 第 2 档 12:17-12:24
    expect(res.body.data.broadcastTime).toBe('12:17-12:24');
    expect(res.body.data.isSpecial).toBe(0);
    expect(res.body.data.broadcastDate).toBeNull();
  });

  test('常规栏目的日期由周几投影出来（本周节目单）', async () => {
    const res = await request(app).get('/api/user/program/weekly');
    expect(res.body.code).toBe(0);
    const hits = res.body.data.list.filter((p) => p.title === '测试节目');
    // weekdays='1,3' ⇒ 本周应出现两次（周一、周三），且各带一个具体日期
    expect(hits.length).toBe(2);
    expect(hits[0].broadcastDate).not.toBe(hits[1].broadcastDate);
    hits.forEach((p) => {
      const wd = new Date(p.broadcastDate + 'T00:00:00').getDay();
      expect([1, 3]).toContain(wd === 0 ? 7 : wd);
    });
  });

  test('节目列表', async () => {
    await createProgram({ title: '节目A' });
    await createProgram({ title: '节目B' });
    const res = await request(app)
      .get('/api/admin/program/list')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.list.length).toBeGreaterThanOrEqual(2);
  });

  test('切换正在直播：唯一性', async () => {
    const p1 = await createProgram({ title: '直播A' });
    const p2 = await createProgram({ title: '直播B' });
    await request(app)
      .put(`/api/admin/program/${p1.id}/live`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isLive: 1 });
    await request(app)
      .put(`/api/admin/program/${p2.id}/live`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isLive: 1 });
    const list = await request(app)
      .get('/api/admin/program/list')
      .set('Authorization', `Bearer ${adminToken}`);
    const livePrograms = list.body.data.list.filter(p => p.isLive === 1);
    expect(livePrograms.length).toBe(1);
    expect(livePrograms[0].id).toBe(p2.id);
  });

  test('用户端：正在直播只取到一个', async () => {
    const res = await request(app).get('/api/user/program/current');
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBeGreaterThan(0);
  });
});

describe('公告 CRUD', () => {
  test('发布公告', async () => {
    const res = await request(app)
      .post('/api/admin/notice/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '校园活动通知', content: '本周五有文艺汇演' });
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBeGreaterThan(0);
  });

  test('用户端只看到 isShow=1', async () => {
    await createNotice({ title: '隐藏公告', isShow: 0 });
    await createNotice({ title: '公开公告', isShow: 1 });
    const res = await request(app).get('/api/user/notice/list');
    expect(res.body.code).toBe(0);
    const titles = res.body.data.list.map(n => n.title);
    expect(titles).toContain('公开公告');
    expect(titles).not.toContain('隐藏公告');
  });

  test('切换显示状态', async () => {
    const notice = await createNotice({ title: '待切换', isShow: 1 });
    const res = await request(app)
      .put(`/api/admin/notice/${notice.id}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.isShow).toBe(0);
  });
});
