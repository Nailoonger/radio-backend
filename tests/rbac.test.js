'use strict';

const { buildApp } = require('./app');
const request = require('supertest');
const {
  sequelize, resetDB, seedAdmin, loginAdmin,
} = require('./helpers');

let app;
beforeAll(async () => {
  app = buildApp();
  await resetDB();
  await seedAdmin();
});
afterAll(async () => {
  await sequelize.close();
});

describe('权限分级', () => {
  test('非超管访问 /admin/list 返回 403', async () => {
    await resetDB();
    await seedAdmin(); // 超管 teacher
    // 新增一个普通社员
    const bcrypt = require('bcryptjs');
    const { Admin } = require('../src/models');
    const hash = await bcrypt.hash('staff123456', 10);
    await Admin.create({ username: 'staff', password: hash, role: 1, status: 1, nickname: '社员A' });
    const staffToken = await loginAdmin(app, { username: 'staff', password: 'staff123456' });

    const res = await request(app)
      .get('/api/admin/admin/list')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.body.code).toBe(40301);
  });

  test('社员可以审核投稿', async () => {
    // 接着上面的状态
    const bcrypt = require('bcryptjs');
    const { Admin, Submit } = require('../src/models');
    const hash = await bcrypt.hash('staff123456', 10);
    const staff = await Admin.findOne({ where: { username: 'staff' } });
    const staffToken = await loginAdmin(app, { username: 'staff', password: 'staff123456' });

    const sub = await Submit.create({
      openid: 'mock_x', type: 1, songName: 's', singer: 'sg', status: 0,
    });

    const res = await request(app)
      .put(`/api/admin/submit/${sub.id}/approve`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.body.code).toBe(0);
  });

  test('不能删除自己', async () => {
    const { Admin } = require('../src/models');
    const me = await Admin.findOne({ where: { username: 'teacher' } });
    const token = await loginAdmin(app);
    const res = await request(app)
      .delete(`/api/admin/admin/${me.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(40301);
  });

  test('不能删除最后一个超管', async () => {
    const { Admin } = require('../src/models');
    // 当前系统只有 teacher 一个超管
    const teacher = await Admin.findOne({ where: { username: 'teacher' } });
    const token = await loginAdmin(app);
    const res = await request(app)
      .delete(`/api/admin/admin/${teacher.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(40301);
  });
});
