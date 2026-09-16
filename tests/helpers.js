'use strict';

/**
 * 测试辅助：
 *  - resetDB：清空所有表（保留 schema）以便每个测试套件独立
 *  - seedAdmin：建超管
 *  - loginAdmin：登录拿 token
 *  - loginUser：mock 微信登录拿 token（需在调用前确保 MOCK_WECHAT=1）
 *  - registerProgram / registerNotice：方便审核流程测试
 */
const { sequelize, Admin, User, Program, Notice } = require('../src/models');
const request = require('supertest');
const bcrypt = require('bcryptjs');

async function resetDB() {
  // 内存 SQLite：直接 DROP & RECREATE 最干净
  await sequelize.drop();
  await sequelize.sync();
}

async function seedAdmin({ username = 'teacher', password = 'admin123456', role = 0, nickname = '指导老师' } = {}) {
  const hash = await bcrypt.hash(password, 10);
  return Admin.create({ username, password: hash, nickname, role, status: 1 });
}

async function loginAdmin(app, { username = 'teacher', password = 'admin123456' } = {}) {
  const res = await request(app)
    .post('/api/admin/login')
    .send({ username, password });
  if (res.body.code !== 0) throw new Error(`loginAdmin failed: ${res.body.message}`);
  return res.body.data.token;
}

async function loginUser(app, { code = `mock_${Date.now()}`, nickname = '测试同学' } = {}) {
  const res = await request(app)
    .post('/api/user/login')
    .send({ code, nickname });
  if (res.body.code !== 0) throw new Error(`loginUser failed: ${res.body.message}`);
  return res.body.data.token;
}

async function createProgram(overrides = {}) {
  return Program.create({
    title: '午间音乐汇',
    host: '小李',
    broadcastTime: '周一 12:30-13:00',
    broadcastDate: '2099-12-31',
    isShow: 1,
    sort: 1,
    ...overrides,
  });
}

async function createNotice(overrides = {}) {
  return Notice.create({
    title: '欢迎使用菁悠广播站',
    content: '欢迎提交点歌和文稿。',
    isTop: 0,
    isShow: 1,
    ...overrides,
  });
}

module.exports = {
  resetDB,
  seedAdmin,
  loginAdmin,
  loginUser,
  createProgram,
  createNotice,
  // 暴露常用工具
  request,
  sequelize,
};
