'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { buildApp } = require('./app');
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
  userToken = await loginUser(app, { code: 'mock_member_user' });
});

afterAll(async () => {
  await sequelize.close();
});

// 创建一个测试用头像 URL（不真的上传文件，简化 AC 测试）
const FAKE_AVATAR = '/uploads/avatars/test/avatar.jpg';

describe('AC1：管理端菜单可见（接口 403/200 验证）', () => {
  test('社员访问 member/list 返回 403', async () => {
    const bcrypt = require('bcryptjs');
    const { Admin } = require('../src/models');
    const hash = await bcrypt.hash('staff123456', 10);
    await Admin.create({ username: 'staff1', password: hash, role: 1, status: 1 });
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: 'staff1', password: 'staff123456' });
    const staffToken = res.body.data.token;

    const r = await request(app)
      .get('/api/admin/member/list')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(r.body.code).toBe(40301);
  });
  test('超管访问 member/list 返回 200', async () => {
    const r = await request(app)
      .get('/api/admin/member/list')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.code).toBe(0);
  });
});

describe('AC2：新增成员', () => {
  let createdId;
  test('POST /api/admin/member/create', async () => {
    const r = await request(app)
      .post('/api/admin/member/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: '张三',
        role: '社长',
        grade: '高三(1)班',
        programs: '午间音乐汇,晚安故事',
        avatar: FAKE_AVATAR,
        motto: '用声音温暖校园',
        sort: 100,
      });
    expect(r.body.code).toBe(0);
    expect(r.body.data.id).toBeGreaterThan(0);
    expect(r.body.data.name).toBe('张三');
    createdId = r.body.data.id;
  });
  test('管理端列表能查到', async () => {
    const r = await request(app)
      .get('/api/admin/member/list')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.data.list.some(m => m.name === '张三')).toBe(true);
  });
});

describe('AC3：模糊搜索', () => {
  beforeAll(async () => {
    // 再加几个成员测试搜索
    await request(app)
      .post('/api/admin/member/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '李四', role: '主播', grade: '高二(2)班', avatar: FAKE_AVATAR });
    await request(app)
      .post('/api/admin/member/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '王五', role: '编辑', grade: '高二(3)班', avatar: FAKE_AVATAR });
  });
  test('搜索"社长"返回张三', async () => {
    const r = await request(app)
      .get('/api/admin/member/list')
      .query({ keyword: '社长' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.data.list.every(m => m.role.includes('社长'))).toBe(true);
  });
  test('搜索"高二"返回 2 人', async () => {
    const r = await request(app)
      .get('/api/admin/member/list')
      .query({ keyword: '高二' })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.body.data.list.length).toBe(2);
  });
});

describe('AC4：上传 5MB 头像被拒', () => {
  test('multer LIMIT_FILE_SIZE 触发', async () => {
    // 5MB 文件
    const big = Buffer.alloc(5 * 1024 * 1024, 0);
    const r = await request(app)
      .post('/api/admin/upload/avatar')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', big, { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(r.body.code).toBe(40001);
    expect(r.body.message).toMatch(/过大|2MB/);
  });
});

describe('AC5：非图片类型被拒', () => {
  test('txt 文件被拒', async () => {
    const txt = Buffer.from('hello world');
    const r = await request(app)
      .post('/api/admin/upload/avatar')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', txt, { filename: 'a.txt', contentType: 'text/plain' });
    expect(r.body.code).toBe(40001);
    expect(r.body.message).toMatch(/类型/);
  });
  test('合法 jpg 上传成功', async () => {
    // 1x1 像素 jpg（最小可用）
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
      0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
      0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xd9,
    ]);
    const r = await request(app)
      .post('/api/admin/upload/avatar')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', jpg, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(r.body.code).toBe(0);
    expect(r.body.data.url).toMatch(/^\/uploads\/avatars\//);
  });
});

describe('AC6：小程序 tab 第 4 项（接口公开）', () => {
  test('GET /api/user/member/list 不需登录', async () => {
    const r = await request(app).get('/api/user/member/list');
    expect(r.body.code).toBe(0);
    expect(r.body.data.groups.length).toBeGreaterThan(0);
  });
});

describe('AC7：按职务筛选', () => {
  test('?role=社长 只返回社长', async () => {
    const r = await request(app).get('/api/user/member/list').query({ role: '社长' });
    expect(r.body.code).toBe(0);
    expect(r.body.data.groups.length).toBe(1);
    expect(r.body.data.groups[0].role).toBe('社长');
    expect(r.body.data.groups[0].list.every(m => m.role === '社长')).toBe(true);
  });
});

describe('AC8：详情页', () => {
  test('GET /api/user/member/:id 返回详情', async () => {
    const list = await request(app).get('/api/user/member/list');
    const id = list.body.data.groups[0].list[0].id;
    const r = await request(app).get(`/api/user/member/${id}`);
    expect(r.body.code).toBe(0);
    expect(r.body.data.id).toBe(id);
    expect(r.body.data.name).toBeTruthy();
  });
});

describe('AC9：下架后小程序不显示', () => {
  let toggleId;
  test('超管切换 isShow 后小程序列表减少', async () => {
    // 先拿一个 id
    const before = await request(app).get('/api/user/member/list');
    const beforeTotal = before.body.data.total;
    toggleId = before.body.data.groups[0].list[0].id;

    // 切到 0
    const tog = await request(app)
      .put(`/api/admin/member/${toggleId}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(tog.body.code).toBe(0);
    expect(tog.body.data.isShow).toBe(0);

    // 再查用户端
    const after = await request(app).get('/api/user/member/list');
    expect(after.body.data.total).toBe(beforeTotal - 1);
    // 该 id 不在结果中
    const allIds = after.body.data.groups.flatMap(g => g.list.map(m => m.id));
    expect(allIds.includes(toggleId)).toBe(false);
  });
  test('详情页 404', async () => {
    const r = await request(app).get(`/api/user/member/${toggleId}`);
    expect(r.body.code).toBe(40401);
  });
});

describe('AC10：静态文件可访问', () => {
  test('GET /uploads/<path> 返回 200 或 404', async () => {
    // 上传一张测试 jpg
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
      0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
      0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xd9,
    ]);
    const up = await request(app)
      .post('/api/admin/upload/avatar')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', jpg, { filename: 't.jpg', contentType: 'image/jpeg' });
    const url = up.body.data.url;

    const r = await request(app).get(url);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image/);
  });
});
