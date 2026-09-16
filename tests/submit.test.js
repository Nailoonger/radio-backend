'use strict';

const { buildApp } = require('./app');
const request = require('supertest');
const {
  sequelize, resetDB, seedAdmin,
  loginAdmin, loginUser,
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

describe('用户端：投稿', () => {
  let userToken;
  let adminToken;
  let submitId;

  beforeAll(async () => {
    userToken = await loginUser(app, { code: 'mock_song_user' });
    adminToken = await loginAdmin(app);
  });

  test('提交点歌', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '起风了', singer: '买辣椒也用券', wishContent: '毕业快乐' });
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBeGreaterThan(0);
    submitId = res.body.data.id;
  });

  test('提交文稿', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 2, articleTitle: '高三随想', articleContent: '这是我的高三...' });
    expect(res.body.code).toBe(0);
  });

  test('type 非法返回参数错误', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 99 });
    expect(res.body.code).toBe(40001);
  });

  test('点歌缺歌手返回参数错误', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '起风了' });
    expect(res.body.code).toBe(40001);
  });

  test('1 分钟内同 song 重复提交被拒', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '起风了', singer: '买辣椒也用券' });
    expect(res.body.code).toBe(40901);
  });

  test('不带 token 401', async () => {
    const res = await request(app)
      .post('/api/user/submit')
      .send({ type: 1, songName: 'a', singer: 'b' });
    expect(res.body.code).toBe(40101);
  });

  test('查询我的投稿', async () => {
    const res = await request(app)
      .get('/api/user/submit/my')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.total).toBeGreaterThanOrEqual(2);
    expect(res.body.data.list.length).toBeGreaterThan(0);
  });

  test('查询自己的投稿详情', async () => {
    const res = await request(app)
      .get(`/api/user/submit/${submitId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.songName).toBe('起风了');
  });

  test('别人的投稿 404', async () => {
    const otherToken = await loginUser(app, { code: 'mock_other_user' });
    const res = await request(app)
      .get(`/api/user/submit/${submitId}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.body.code).toBe(40401);
  });
});

describe('管理端：审核', () => {
  let userToken;
  let adminToken;

  beforeAll(async () => {
    userToken = await loginUser(app, { code: 'mock_audit_user' });
    adminToken = await loginAdmin(app);
  });

  let pendingId;
  test('用户提交 -> 管理员列表看得到', async () => {
    const sub = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '晴天', singer: '周杰伦' });
    expect(sub.body.code).toBe(0);
    pendingId = sub.body.data.id;

    const list = await request(app)
      .get('/api/admin/submit/list')
      .query({ status: 0 })
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.code).toBe(0);
    expect(list.body.data.list.find(s => s.id === pendingId)).toBeTruthy();
    expect(list.body.data.list[0].nickname).toBeTruthy();
  });

  test('管理员通过', async () => {
    const res = await request(app)
      .put(`/api/admin/submit/${pendingId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe(1);
  });

  test('管理员驳回必须填写理由', async () => {
    const sub = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '搁浅', singer: '周杰伦' });
    const id = sub.body.data.id;
    const res = await request(app)
      .put(`/api/admin/submit/${id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.body.code).toBe(40001);
  });

  test('管理员驳回 + 理由', async () => {
    const sub = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 1, songName: '夜曲', singer: '周杰伦' });
    const id = sub.body.data.id;
    const res = await request(app)
      .put(`/api/admin/submit/${id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '不符合校园主题' });
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe(2);
    expect(res.body.data.rejectReason).toBe('不符合校园主题');
  });

  test('批量审核', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const sub = await request(app)
        .post('/api/user/submit')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ type: 1, songName: `批量歌曲${i}`, singer: '测试' });
      ids.push(sub.body.data.id);
    }
    const res = await request(app)
      .post('/api/admin/submit/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids, action: 'approve' });
    expect(res.body.code).toBe(0);
    expect(res.body.data.affected).toBe(3);
  });

  test('统计：投稿概览', async () => {
    const res = await request(app)
      .get('/api/admin/stats/overview')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.code).toBe(0);
    expect(res.body.data.submit.total).toBeGreaterThan(0);
    expect(res.body.data.submit.approved).toBeGreaterThan(0);
  });
});
