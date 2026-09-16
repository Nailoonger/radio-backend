'use strict';

const { buildApp } = require('./app');
const request = require('supertest');
const { sequelize, resetDB, seedAdmin, loginAdmin } = require('./helpers');

let app;
beforeAll(async () => {
  app = buildApp();
  await resetDB();
  await seedAdmin();
});
afterAll(async () => {
  await sequelize.close();
});

describe('管理员登录 & 当前账号', () => {
  test('默认超管登录成功', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'teacher', password: 'admin123456' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.admin.role).toBe(0);
  });

  test('错误密码返回 401', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'teacher', password: 'wrong' });
    expect(res.body.code).toBe(40101);
  });

  test('空账号密码返回参数错误', async () => {
    const res = await request(app).post('/api/admin/login').send({});
    expect(res.body.code).toBe(40001);
  });

  test('拿 token 调 /profile', async () => {
    const token = await loginAdmin(app);
    const res = await request(app)
      .get('/api/admin/profile')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.username).toBe('teacher');
  });

  test('不带 token 401', async () => {
    const res = await request(app).get('/api/admin/profile');
    expect(res.body.code).toBe(40101);
  });

  test('错误 token 401', async () => {
    const res = await request(app)
      .get('/api/admin/profile')
      .set('Authorization', 'Bearer not.a.valid.jwt');
    expect(res.body.code).toBe(40101);
  });
});
