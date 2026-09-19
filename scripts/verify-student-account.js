'use strict';

/**
 * 学生账号体系验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-student-account.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖：
 *   A. 归一化与账号生成规则（纯函数矩阵）
 *   B. 真实名册格式解析（4 列含姓名 / 尾随空行 / 右侧空列）
 *   C. 无表头与脏数据容错
 *   D. 导入落库、重复导入幂等、已激活保护
 *   E. 账号登录 / 改密 / 重置密码 / 旧 token 失效
 *   F. 导出数据结构（已改密行的初始密码列必须为空）
 *   G. 统计、批次撤销、改账号迁移投稿、删除保护
 *   G2. 按年级查询、整届清理（一键删除该年级账号 · safe/disable/purge 三种模式）
 *   H. 微信登录守卫 + 路由顺序
 *
 * 结果同时写到 stdout 与同目录的 verify-student-output.txt（方便在 PowerShell 里读）。
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-student-secret';
process.env.MOCK_WECHAT = '1';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const ok = [];
const bad = [];
const detail = [];
function check(name, cond, extra) {
  (cond ? ok : bad).push(name + (extra !== undefined && extra !== '' ? '  [' + extra + ']' : ''));
}
const say = (s) => detail.push(s);

/* 初始密码规则（2026-09-18 改版）：user + 学号 */
const initPwdOf = (u) => 'user' + String(u);

/* ── 用户给的真实名册：4 列（第 4 列姓名）+ 右侧空列 + 尾部 3 个空行 ── */
const REAL_ROWS = [
  ['年级', '班级', '序号', '姓名', ''],
  ['2024', '01', '01', '张三', ''],
  ['2024', '02', '02', '李二', ''],
  ['2024', '03', '22', '李四', ''],
  ['2024', '04', '33', '莉莉', ''],
  ['2024', '07', '45', '小米', ''],
  ['2024', '10', '54', '李三', ''],
  ['2024', '13', '32', '蔡徐', ''],
  ['', '', '', '', ''],
  ['', '', '', '', ''],
  ['', '', '', '', ''],
];

const EXPECTED_USERNAMES = [
  '20240101',
  '20240202',
  '20240322',
  '20240433',
  '20240745',
  '20241054',
  '20241332',
];

(async () => {
  let app;
  let models;
  let roster;
  let account;
  let adminToken;

  try {
    models = require('../src/models');
    roster = require('../src/services/studentRosterService');
    account = require('../src/services/studentAccountService');

    const { sequelize } = models;
    await sequelize.sync({ force: true });
    say('sync ok（自动建表：user / import_batch / submit / message / notice_ack …）');

    /* ══════════ A. 归一化矩阵 ══════════ */
    say('');
    say('--- A. 归一化与账号生成 ---');

    const gradeCases = [
      ['2024', '2024'],
      ['2024级', '2024'],
      ['2024届', '2024'],
      ['24', '2024'],
      ['24级', '2024'],
      ['２０２４', '2024'],   // 全角
      ['  2024  ', '2024'],   // 空格
      ["'2024", '2024'],      // Excel 撇号
    ];
    gradeCases.forEach(([input, want]) => {
      let got = null;
      try { got = roster.normalizeGrade(input); } catch (e) { got = 'ERR:' + e.message; }
      check(`年级「${input}」→ ${want}`, got === want, String(got));
    });

    let gradeErr = '';
    try { roster.normalizeGrade('高一'); } catch (e) { gradeErr = e.message; }
    check('年级「高一」被拒（无年份）', gradeErr.includes('无法识别'), gradeErr);

    const partCases = [
      ['1', '01'], ['01', '01'], ['1班', '01'], ['高一(1)班', '01'],
      ['5号', '05'], ['第5', '05'], ['１２', '12'], [' 99 ', '99'],
    ];
    partCases.forEach(([input, want]) => {
      let got = null;
      try { got = roster.normalizePart(input, '班级'); } catch (e) { got = 'ERR:' + e.message; }
      check(`班级 / 序号「${input}」→ ${want}`, got === want, String(got));
    });

    let partErr = '';
    try { roster.normalizePart('100', '序号', 99); } catch (e) { partErr = e.message; }
    check('序号 100 超范围被拒', partErr.includes('超出范围'), partErr);

    const combinedCases = [
      ['20240101', ['2024', '01', '01']],
      ['2024-01-01', ['2024', '01', '01']],
      ['2024级1班1号', ['2024', '1', '1']],
      ['2024 01 01', ['2024', '01', '01']],
    ];
    combinedCases.forEach(([input, want]) => {
      const got = roster.splitCombined(input);
      check(`单列合并「${input}」→ ${want.join('+')}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    });

    check('账号拼接 2024+01+01 = 20240101', roster.buildUsername('2024', '01', '01') === '20240101');

    /* ══════════ B. 真实名册解析 ══════════ */
    say('');
    say('--- B. 真实名册（4 列 + 空行 + 右侧空列）---');

    const parsed = roster.parseSheet(REAL_ROWS);
    check('识别为有表头模式', parsed.mode === 'header', parsed.mode);
    check('表头在第 1 行', parsed.headerRowIndex === 0, String(parsed.headerRowIndex));
    check('列映射 年级=0 班级=1 序号=2 姓名=3',
      parsed.columns.grade === 0 && parsed.columns.class === 1 &&
      parsed.columns.seat === 2 && parsed.columns.name === 3,
      JSON.stringify(parsed.columns));
    check('7 行数据（尾部空行已跳过）', parsed.totalRows === 7, 'totalRows=' + parsed.totalRows);
    check('7 行全部解析成功', parsed.dataRows.every((r) => r.valid),
      parsed.dataRows.filter((r) => !r.valid).map((r) => `第${r.rowNo}行 ${r.error}`).join('; '));

    const gotNames = parsed.dataRows.map((r) => r.username);
    check('账号与预期完全一致', JSON.stringify(gotNames) === JSON.stringify(EXPECTED_USERNAMES), gotNames.join(','));
    check('姓名正确提取（第 4 列）', parsed.dataRows[0].name === '张三' && parsed.dataRows[6].name === '蔡徐',
      parsed.dataRows.map((r) => r.name).join(','));
    check('行号 = 表格真实行号（第 2 行是第一条数据）', parsed.dataRows[0].rowNo === 2, 'rowNo=' + parsed.dataRows[0].rowNo);
    check('右侧空列被忽略（没有多余列报错）', parsed.dataRows.length === 7);

    /* ══════════ C. 无表头 + 脏数据 ══════════ */
    say('');
    say('--- C. 无表头 / 脏数据容错 ---');

    const noHeader = roster.parseSheet([
      ['2024', '01', '01'],
      ['2024', '01', '02'],
    ]);
    check('无表头 → 按列序解析', noHeader.mode === 'position' && noHeader.totalRows === 2, noHeader.mode);
    check('无表头时账号正确', noHeader.dataRows.map((r) => r.username).join(',') === '20240101,20240102');

    const singleCol = roster.parseSheet([
      ['学号'],
      ['20240101'],
      ['2024级2班3号'],
    ]);
    check('单列 20240101 可拆三段', singleCol.dataRows[0].username === '20240101', String(singleCol.dataRows[0].username));
    check('单列 2024级2班3号 可拆三段', singleCol.dataRows[1].username === '20240203', String(singleCol.dataRows[1].username));

    const dirty = roster.parseSheet([
      ['年级', '班级', '序号', '姓名'],
      ['2024级', '1班', '5号', '甲'],
      ['24', '02', '第6', '乙'],
      ['2024', '', '07', '缺班级'],
      ['2024', '08', '100', '序号超范围'],
      ['2024', '08', '01', '戊'],
      ['2024', '08', '01', '己'],
    ]);
    check('2024级 / 1班 / 5号 → 20240105', dirty.dataRows[0].username === '20240105', String(dirty.dataRows[0].username));
    check('24 / 02 / 第6 → 20240206', dirty.dataRows[1].username === '20240206', String(dirty.dataRows[1].username));
    check('缺班级 → 标异常', !dirty.dataRows[2].valid && dirty.dataRows[2].error.includes('班级'), dirty.dataRows[2].error);
    check('序号 100 → 标异常', !dirty.dataRows[3].valid && dirty.dataRows[3].error.includes('超出范围'), dirty.dataRows[3].error);
    check('本批重复 → 后一行标异常', dirty.dataRows[4].valid && !dirty.dataRows[5].valid &&
      dirty.dataRows[5].error.includes('重复'), dirty.dataRows[5].error);

    let emptyErr = '';
    try { roster.parseSheet([['', ''], ['', '']]); } catch (e) { emptyErr = e.message; }
    check('全空表被拒', emptyErr.includes('没有读到任何数据行'), emptyErr);

    /* ══════════ D. 导入落库 ══════════ */
    say('');
    say('--- D. 导入落库 / 幂等 / 已激活保护 ---');

    const pv = await roster.preview(REAL_ROWS);
    check('预览 7 条全部 new', pv.summary.new === 7 && pv.summary.invalid === 0, JSON.stringify(pv.summary));

    const c1 = await roster.commit(REAL_ROWS, { filename: '名册.xlsx', operator: 'teacher', operatorId: 1 });
    check('首次导入新建 7 个', c1.created === 7 && c1.updated === 0, JSON.stringify(c1));
    check('落库后 count 复核 = 7', c1.total === 7, 'total=' + c1.total);
    check('库里确实是 7 个学生账号', (await models.User.count({ where: { username: { [require('sequelize').Op.ne]: null } } })) === 7);
    check('账号 20240101 存在且姓名为张三',
      (await models.User.findOne({ where: { username: '20240101' } })).remark === '张三');

    const c2 = await roster.commit(REAL_ROWS, { filename: '名册.xlsx', operator: 'teacher' });
    check('重复导入不产生新账号（created=0）', c2.created === 0, JSON.stringify(c2));
    check('重复导入 7 条走「覆盖更新」', c2.updated === 7, 'updated=' + c2.updated);
    check('重复导入后总数仍是 7',
      (await models.User.count({ where: { username: { [require('sequelize').Op.ne]: null } } })) === 7);

    // 标记一个账号「已激活」（模拟学生改过密码）
    await models.User.update({ pwdChangedAt: new Date() }, { where: { username: '20240101' } });
    const c3pre = await roster.preview(REAL_ROWS);
    check('已激活账号进入 active（受保护）', c3pre.summary.active === 1 && c3pre.summary.update === 6, JSON.stringify(c3pre.summary));
    const c3 = await roster.commit(REAL_ROWS, { filename: '名册.xlsx' });
    check('默认导入跳过已激活账号', c3.skipped === 1 && c3.updated === 6, JSON.stringify(c3));

    const c4 = await roster.commit(REAL_ROWS, { filename: '名册.xlsx', force: true });
    check('force 导入可覆盖已激活账号（updated=7）', c4.updated === 7, JSON.stringify(c4));
    const keptUser = await models.User.scope('withPassword').findOne({ where: { username: '20240101' } });
    check('force 覆盖不碰密码（仍能用初始密码登录）',
      await require('bcryptjs').compare(initPwdOf('20240101'), keptUser.password));
    await models.User.update({ pwdChangedAt: null }, { where: { username: '20240101' } });

    /* ══════════ E. 登录 / 改密 / 重置 ══════════ */
    say('');
    say('--- E. 登录 / 改密 / 重置密码 ---');

    app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/user', require('../src/routes/user'));
    app.use('/api/admin', require('../src/routes/admin'));
    app.use((err, req, res, next) => {
      res.status(err.httpStatus || 500).json({ code: err.code || 50001, message: err.message, data: null });
    });

    const adminAuth = require('../src/utils/jwt').sign({ id: 1, username: 'teacher', role: 0 });
    adminToken = adminAuth;

    const loginRes = await request(app).post('/api/user/login/account').send({ username: '20240101', password: initPwdOf('20240101') });
    check('账号密码登录成功', loginRes.body.code === 0, JSON.stringify(loginRes.body).slice(0, 120));
    check('返回年级班级信息', loginRes.body.data?.user?.className === '2024 级 1 班', loginRes.body.data?.user?.className);
    check('标记 isDefaultPwd=true', loginRes.body.data?.user?.isDefaultPwd === true);
    const token1 = loginRes.body.data?.token;
    check('返回 token', typeof token1 === 'string' && token1.length > 20);

    const meAfterLogin = await models.User.findOne({ where: { username: '20240101' } });
    check('记录最近登录时间', !!meAfterLogin.lastLoginAt);
    check('登录次数 +1', Number(meAfterLogin.loginCount) === 1, String(meAfterLogin.loginCount));

    const badPwd = await request(app).post('/api/user/login/account').send({ username: '20240101', password: 'wrong-password' });
    const noUser = await request(app).post('/api/user/login/account').send({ username: '29990101', password: initPwdOf('29990101') });
    // 注意：本项目约定「业务错误走 HTTP 200 + body.code」，所以这里断言 body.code
    check('密码错误 → 40101', badPwd.body.code === 40101, `code=${badPwd.body.code} http=${badPwd.status}`);
    check('账号不存在 → 40101', noUser.body.code === 40101, `code=${noUser.body.code} http=${noUser.status}`);
    check('两种失败的文案一致（防账号枚举）', badPwd.body.message === noUser.body.message, badPwd.body.message);

    const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token1}`);
    check('带 token 可访问 /user/me', meRes.body.code === 0, JSON.stringify(meRes.body).slice(0, 120));
    check('/user/me 返回账号与班级', meRes.body.data?.username === '20240101' && meRes.body.data?.grade === '2024');
    check('/user/me 不返回 password 字段', meRes.body.data?.password === undefined);

    const noToken = await request(app).get('/api/user/me');
    check('无 token 访问 → 401', noToken.status === 401, String(noToken.status));

    const weak = await request(app).put('/api/user/change-password')
      .set('Authorization', `Bearer ${token1}`).send({ oldPassword: initPwdOf('20240101'), newPassword: '12345678' });
    check('改密：纯数字被拒', weak.body.code === 40001 && weak.body.message.includes('字母'), weak.body.message);

    const wrongOld = await request(app).put('/api/user/change-password')
      .set('Authorization', `Bearer ${token1}`).send({ oldPassword: 'nope', newPassword: 'abc123456' });
    check('改密：原密码错误被拒', wrongOld.body.code === 40001 && wrongOld.body.message.includes('原密码'), wrongOld.body.message);

    const changed = await request(app).put('/api/user/change-password')
      .set('Authorization', `Bearer ${token1}`).send({ oldPassword: initPwdOf('20240101'), newPassword: 'abc123456' });
    check('改密成功并返回新 token', changed.body.code === 0 && typeof changed.body.data?.token === 'string', changed.body.message);
    check('改密后 isDefaultPwd=false', changed.body.data?.user?.isDefaultPwd === false);
    const token2 = changed.body.data?.token;

    const oldTokenAfter = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token1}`);
    check('改密后旧 token 立刻失效', oldTokenAfter.status === 401, String(oldTokenAfter.status));
    const newTokenAfter = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token2}`);
    check('改密后新 token 可用', newTokenAfter.body.code === 0);

    const reloginOld = await request(app).post('/api/user/login/account').send({ username: '20240101', password: initPwdOf('20240101') });
    check('改密后旧密码登录失败', reloginOld.body.code === 40101, `code=${reloginOld.body.code}`);
    const reloginNew = await request(app).post('/api/user/login/account').send({ username: '20240101', password: 'abc123456' });
    check('改密后新密码登录成功', reloginNew.body.code === 0);

    // 停用 → 登录被拒 + 已登录的 token 被踢
    const target = await models.User.findOne({ where: { username: '20240101' } });
    const disable = await request(app).put(`/api/admin/student/${target.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`).send({ status: 0 });
    check('管理员停用账号', disable.body.code === 0, disable.body.message);
    const loginDisabled = await request(app).post('/api/user/login/account').send({ username: '20240101', password: 'abc123456' });
    check('停用后无法登录（40301）', loginDisabled.body.code === 40301, String(loginDisabled.body.code));
    const kicked = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token2}`);
    check('停用后已发放的 token 被踢（401）', kicked.status === 401, String(kicked.status));

    await request(app).put(`/api/admin/student/${target.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`).send({ status: 1 });

    // 管理员重置密码
    const reset = await request(app).put(`/api/admin/student/${target.id}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`).send({});
    check('管理员重置为初始密码', reset.body.code === 0 && reset.body.data?.initPassword === initPwdOf('20240101'), reset.body.message);
    const afterResetLogin = await request(app).post('/api/user/login/account').send({ username: '20240101', password: initPwdOf('20240101') });
    check('重置后可用初始密码登录', afterResetLogin.body.code === 0);
    const resetStudent = await models.User.findOne({ where: { username: '20240101' } });
    check('重置后 isDefaultPwd 回到 true', !resetStudent.pwdChangedAt);

    // 微信登录守卫
    const wx = await request(app).post('/api/user/login').send({ code: 'mock_xyz' });
    check('测试环境微信登录仍放行（保护既有 56 条用例）', wx.body.code === 0, wx.body.message);
    check('生产环境 + 开关 on → 拦截微信登录', account.isWechatLoginBlocked('production', true) === true);
    check('生产环境 + 开关 off → 放行微信登录', account.isWechatLoginBlocked('production', false) === false);
    check('测试环境永远放行（避免连锁失败）', account.isWechatLoginBlocked('test', true) === false);

    // 头像机制：全站「姓名首字圆形」，用户不允许换头像 —— 客户端传了也不收
    const avRes = await request(app).post('/api/user/login')
      .send({ code: 'mock_avatar_test', nickname: '测试昵称', avatar: 'https://evil.example.com/x.png' });
    check('微信登录对带 avatar 的老客户端仍放行（兼容）', avRes.body.code === 0, avRes.body.message);
    const avUser = await models.User.findOne({ where: { openid: 'mock_mock_avatar_test' } });
    check('客户端传的 avatar 不会入库（头像只能姓作图）', (avUser?.avatar || '') === '', String(avUser?.avatar));
    const meAv = await request(app).get('/api/user/me').set('Authorization', `Bearer ${avRes.body.data?.token}`);
    check('/user/me 返回的 avatar 恒为空', meAv.body.data?.avatar === '', String(meAv.body.data?.avatar));
    const reAv = await request(app).post('/api/user/login')
      .send({ code: 'mock_avatar_test', nickname: '测试昵称', avatar: 'https://evil.example.com/y.png' });
    const avUser2 = await models.User.findOne({ where: { openid: 'mock_mock_avatar_test' } });
    check('重复登录也不会把头像写进去', (avUser2?.avatar || '') === '', String(avUser2?.avatar));
    check('重复登录返回码正常', reAv.body.code === 0);

    /* ══════════ F. 导出 ══════════ */
    say('');
    say('--- F. 导出 ---');

    // 造一个「已改密」的账号，验证导出不会把初始密码带给已经改过密码的学生
    await models.User.update({ pwdChangedAt: new Date() }, { where: { username: '20240322' } });

    const exp = await roster.exportData({});
    check('导出列 9 列', exp.columns.length === 9, String(exp.columns.length));
    check('导出 7 行', exp.rows.length === 7, String(exp.rows.length));
    const rowActive = exp.rows.find((r) => r[4] === '20240322');
    const rowInit = exp.rows.find((r) => r[4] === '20240101');
    check('未改密的行带初始密码', rowInit[5] === initPwdOf(rowInit[4]), String(rowInit[5]));
    check('已改密的行初始密码列为空（导不出哈希）', rowActive[5] === '', String(rowActive[5]));
    check('已改密行标记为已激活', rowActive[7] === '已激活', String(rowActive[7]));
    check('导出列顺序 年级/班级/序号/姓名/账号/初始密码',
      exp.columns[0].header === '年级' && exp.columns[4].header === '账号' && exp.columns[5].header === '初始密码');

    const exportHttp = await request(app).get('/api/admin/student/export?grade=2024')
      .set('Authorization', `Bearer ${adminToken}`);
    check('导出接口返回 200', exportHttp.status === 200, String(exportHttp.status));
    check('导出响应带 xlsx 类型', String(exportHttp.headers['content-type']).includes('spreadsheetml'),
      exportHttp.headers['content-type']);
    check('导出文件名含中文年级', decodeURIComponent(String(exportHttp.headers['content-disposition'])).includes('2024级'),
      String(exportHttp.headers['content-disposition']).slice(0, 80));

    const templateRes = await request(app).get('/api/admin/student/template')
      .set('Authorization', `Bearer ${adminToken}`);
    check('模板下载 200', templateRes.status === 200, String(templateRes.status));

    /* ══════════ G. 列表 / 统计 / 批次 / 迁移 / 删除 ══════════ */
    say('');
    say('--- G. 列表 / 统计 / 批次撤销 / 投稿迁移 / 删除保护 ---');

    const listRes = await request(app).get('/api/admin/student/list?pageSize=50')
      .set('Authorization', `Bearer ${adminToken}`);
    check('列表返回 7 条', listRes.body.data?.total === 7, JSON.stringify(listRes.body.data?.total));
    check('列表按年级班级序号排序（第一条 20240101）', listRes.body.data?.list?.[0]?.username === '20240101',
      listRes.body.data?.list?.[0]?.username);
    const kwRes = await request(app).get('/api/admin/student/list?keyword=张三')
      .set('Authorization', `Bearer ${adminToken}`);
    check('关键词搜姓名命中 1 条', kwRes.body.data?.total === 1, String(kwRes.body.data?.total));

    const statsRes = await request(app).get('/api/admin/student/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    const stats = statsRes.body.data;
    check('统计总数为 7', stats?.overall?.total === 7, JSON.stringify(stats?.overall));
    check('统计按班级分组 7 组', stats?.classes?.length === 7, String(stats?.classes?.length));
    check('统计里 已激活 + 未激活 = 总数',
      stats?.overall?.activated + stats?.overall?.inactive === stats?.overall?.total,
      JSON.stringify(stats?.overall));

    // 投稿归属迁移：改班后「我的投稿」不能变空
    await models.Submit.create({ openid: '20240202', type: 1, songName: '测试歌', singer: 'x', status: 0 });
    const stu2 = await models.User.findOne({ where: { username: '20240202' } });
    const upd = await request(app).put(`/api/admin/student/${stu2.id}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ classNo: '05' });
    check('改班级后账号重算为 20240502', upd.body.data?.username === '20240502', upd.body.data?.username);
    const movedSubmit = await models.Submit.findOne({ where: { songName: '测试歌' } });
    check('投稿记录跟着迁到新账号', movedSubmit.openid === '20240502', movedSubmit.openid);

    const dupUpdate = await request(app).put(`/api/admin/student/${stu2.id}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ classNo: '01', seatNo: '01' });
    check('改到已存在的账号被拒（40901）', dupUpdate.body.code === 40901, String(dupUpdate.body.code));

    const delGuarded = await request(app).delete(`/api/admin/student/${stu2.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    check('有投稿的账号不硬删，改为停用', delGuarded.body.data?.deleted === false && delGuarded.body.data?.disabled === true,
      JSON.stringify(delGuarded.body.data));
    check('该账号确实还在库里', (await models.User.count({ where: { username: '20240502' } })) === 1);

    // 批次撤销
    const batch2 = await roster.commit(
      [['年级', '班级', '序号', '姓名'], ['2025', '01', '01', '新生甲'], ['2025', '01', '02', '新生乙']],
      { filename: '2025级.xlsx' }
    );
    check('第二个批次新建 2 个', batch2.created === 2, JSON.stringify(batch2));
    const batchesRes = await request(app).get('/api/admin/student/batches')
      .set('Authorization', `Bearer ${adminToken}`);
    check('批次列表非空且最新的在最前',
      Array.isArray(batchesRes.body.data?.list) && batchesRes.body.data.list.length >= 3 &&
      batchesRes.body.data.list[0].filename === '2025级.xlsx',
      `count=${batchesRes.body.data?.list?.length} first=${batchesRes.body.data?.list?.[0]?.filename}`);

    const rb = await request(app).post(`/api/admin/student/batch/${batch2.batchId}/rollback`)
      .set('Authorization', `Bearer ${adminToken}`);
    check('撤销批次删掉 2 个未激活账号', rb.body.data?.removed === 2, JSON.stringify(rb.body.data));
    check('撤销后 2025 级账号已不在库里',
      (await models.User.count({ where: { grade: '2025' } })) === 0);

    // 批量重置的范围保护
    const noScope = await request(app).post('/api/admin/student/reset-password/batch')
      .set('Authorization', `Bearer ${adminToken}`).send({});
    check('批量重置不给范围被拒（防手滑全量）', noScope.body.code === 40001, String(noScope.body.code));

    const byClass = await request(app).post('/api/admin/student/reset-password/batch')
      .set('Authorization', `Bearer ${adminToken}`).send({ grade: '2024', classNo: '01' });
    check('按班级批量重置生效', byClass.body.code === 0 && byClass.body.data?.affected >= 1, JSON.stringify(byClass.body.data));

    /* ══════════ G2. 按年级查询 / 整届清理（毕业清理） ══════════ */
    say('');
    say('--- G2. 按年级查询与整届清理 ---');

    const gradesRes = await request(app).get('/api/admin/student/grades')
      .set('Authorization', `Bearer ${adminToken}`);
    const grades = gradesRes.body.data;
    check('年级汇总：1 个年级 / 共 7 个账号',
      grades?.overall?.gradeCount === 1 && grades?.overall?.total === 7, JSON.stringify(grades?.overall));
    check('年级卡片字段齐全（年级名 / 班级数 / 已激活 / 停用）',
      grades?.list?.[0]?.name === '2024 级' && grades.list[0].classCount === 7 &&
      grades.list[0].activated === 1 && grades.list[0].disabled === 1,
      JSON.stringify(grades?.list?.[0]));

    const gd = await request(app).get('/api/admin/student/grade/2024')
      .set('Authorization', `Bearer ${adminToken}`);
    check('年级明细试算：6 个可删 / 1 个只停用',
      gd.body.data?.canDelete === 6 && gd.body.data?.withSubmit === 1,
      `canDelete=${gd.body.data?.canDelete} withSubmit=${gd.body.data?.withSubmit}`);
    check('年级明细带 7 个班的分布', gd.body.data?.classes?.length === 7, String(gd.body.data?.classes?.length));
    check('试算是只读的，一行都没改', (await models.User.count({ where: { grade: '2024' } })) === 7);

    const gdShort = await request(app).get('/api/admin/student/grade/24级')
      .set('Authorization', `Bearer ${adminToken}`);
    check('年级参数支持「24级」简写', gdShort.body.data?.grade === '2024', gdShort.body.data?.grade);

    const gdEmpty = await request(app).get('/api/admin/student/grade/2029')
      .set('Authorization', `Bearer ${adminToken}`);
    check('不存在的年级 → 40401', gdEmpty.body.code === 40401, String(gdEmpty.body.code));

    const purgeNoConfirm = await request(app).delete('/api/admin/student/grade/2024')
      .set('Authorization', `Bearer ${adminToken}`).send({ mode: 'purge' });
    check('purge 不给确认串被拒（40001）', purgeNoConfirm.body.code === 40001, purgeNoConfirm.body.message);
    check('被拒后 2024 届数据一行没动', (await models.User.count({ where: { grade: '2024' } })) === 7);

    // 造 2026 届：1 个有投稿记录（只能停用）、1 个没有（可硬删）
    await roster.commit(
      [['年级', '班级', '序号', '姓名'], ['2026', '01', '01', '毕业甲'], ['2026', '02', '03', '毕业乙']],
      { filename: '2026级.xlsx' }
    );
    await models.Submit.create({ openid: '20260101', type: 1, songName: '毕业歌', singer: 'x', status: 0 });
    await models.User.update({ pwdChangedAt: new Date() }, { where: { username: '20260203' } });

    // 先登录一个，验证「整届清理后登录态立刻失效」
    const login26 = await request(app).post('/api/user/login/account').send({ username: '20260101', password: initPwdOf('20260101') });
    const token26 = login26.body.data?.token;
    check('2026 届学生可正常登录', login26.body.code === 0 && typeof token26 === 'string');

    const g26 = await request(app).get('/api/admin/student/grade/2026')
      .set('Authorization', `Bearer ${adminToken}`);
    check('2026 届试算：1 可删 / 1 只停用',
      g26.body.data?.canDelete === 1 && g26.body.data?.withSubmit === 1,
      JSON.stringify({ canDelete: g26.body.data?.canDelete, withSubmit: g26.body.data?.withSubmit }));

    const del26 = await request(app).delete('/api/admin/student/grade/2026')
      .set('Authorization', `Bearer ${adminToken}`).send({});
    check('一键清理 2026 届：删 1 停 1',
      del26.body.code === 0 && del26.body.data?.deleted === 1 && del26.body.data?.disabled === 1,
      JSON.stringify(del26.body.data));
    check('有投稿记录的账号只停用、仍能查到',
      Number((await models.User.findOne({ where: { username: '20260101' } }))?.status) === 0);
    check('无投稿记录的账号被真正删除',
      (await models.User.count({ where: { username: '20260203' } })) === 0);
    const kicked26 = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token26}`);
    check('整届清理后被停用账号的 token 立刻失效（不等 30 秒缓存）', kicked26.status === 401, String(kicked26.status));
    const goneLogin = await request(app).post('/api/user/login/account').send({ username: '20260203', password: initPwdOf('20260203') });
    check('被删账号无法再登录', goneLogin.body.code === 40101, String(goneLogin.body.code));

    const gradesAfter = await request(app).get('/api/admin/student/grades')
      .set('Authorization', `Bearer ${adminToken}`);
    check('清理后年级列表还留着 2026（停用账号仍在档）',
      gradesAfter.body.data?.list?.some((g) => g.grade === '2026'),
      JSON.stringify(gradesAfter.body.data?.list?.map((g) => g.grade)));

    // disable 模式：一个不删，整届停用
    await roster.commit([['年级', '班级', '序号'], ['2027', '01', '01'], ['2027', '01', '02']], { filename: '2027级.xlsx' });
    const dis27 = await request(app).delete('/api/admin/student/grade/2027')
      .set('Authorization', `Bearer ${adminToken}`).send({ mode: 'disable' });
    check('disable 模式：一个不删、全部停用',
      dis27.body.data?.deleted === 0 && dis27.body.data?.disabled === 2 &&
      (await models.User.count({ where: { grade: '2027' } })) === 2,
      JSON.stringify(dis27.body.data));

    // purge 模式：确认串不对不放行，对了才全清
    const purgeWrong = await request(app).delete('/api/admin/student/grade/2027')
      .set('Authorization', `Bearer ${adminToken}`).send({ mode: 'purge', confirm: '2028' });
    check('purge 确认串写错被拒', purgeWrong.body.code === 40001, purgeWrong.body.message);
    const purgeOk = await request(app).delete('/api/admin/student/grade/2027')
      .set('Authorization', `Bearer ${adminToken}`).send({ mode: 'purge', confirm: '2027' });
    check('purge 确认串正确 → 整届清空',
      purgeOk.body.data?.deleted === 2 && (await models.User.count({ where: { grade: '2027' } })) === 0,
      JSON.stringify(purgeOk.body.data));

    // 清理用不到的 2026 残留，避免影响后面的统计类断言
    await models.User.destroy({ where: { grade: '2026' } });

    /* ══════════ H. 路由顺序 / 鉴权 ══════════ */
    say('');
    say('--- H. 路由顺序与鉴权 ---');

    const adminRouter = require('../src/routes/admin');
    const paths = adminRouter.stack.filter((l) => l.route).map((l) => l.route.path);
    const idxParam = paths.indexOf('/student/:id');
    const literalPaths = ['/student/import/preview', '/student/import/commit', '/student/template',
      '/student/list', '/student/stats', '/student/export', '/student/batches',
      '/student/grades', '/student/grade/:grade'];
    check('/student/:id 已注册', idxParam > -1, String(idxParam));
    literalPaths.forEach((p) => {
      const i = paths.indexOf(p);
      check(`字面量路由 ${p} 排在 /student/:id 之前`, i > -1 && i < idxParam, `index=${i} param=${idxParam}`);
    });

    const noAuth = await request(app).get('/api/admin/student/list');
    check('学生账号接口未登录 → 401', noAuth.status === 401, String(noAuth.status));

    const studentTokenAsAdmin = await request(app).get('/api/admin/student/list')
      .set('Authorization', `Bearer ${token1}`);
    check('拿学生 token 调管理端接口 → 401', studentTokenAsAdmin.status === 401, String(studentTokenAsAdmin.status));

    // 上传接口的文件类型校验
    const badFile = await request(app).post('/api/admin/student/import/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    check('上传 .txt 被拒', badFile.body.code === 40001, badFile.body.message);

    const noFile = await request(app).post('/api/admin/student/import/preview')
      .set('Authorization', `Bearer ${adminToken}`);
    check('不传文件被拒', noFile.body.code === 40001, noFile.body.message);

  } catch (e) {
    bad.push('脚本异常中断：' + e.message);
    detail.push('');
    detail.push('STACK: ' + (e.stack || '').split('\n').slice(0, 6).join('\n'));
  }

  const lines = [];
  lines.push('学生账号体系验证结果');
  lines.push('='.repeat(60));
  lines.push(...detail);
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push(`通过 ${ok.length} 项，失败 ${bad.length} 项`);
  if (bad.length) {
    lines.push('');
    lines.push('失败明细：');
    bad.forEach((b, i) => lines.push(`  ${i + 1}. ${b}`));
  } else {
    lines.push('全部通过 ✅');
  }
  lines.push('');
  lines.push('通过的断言：');
  ok.forEach((o, i) => lines.push(`  ${String(i + 1).padStart(3, ' ')}. ${o}`));

  const out = lines.join('\n');
  console.log(out);
  try {
    fs.writeFileSync(path.join(__dirname, 'verify-student-output.txt'), out, 'utf8');
  } catch (e) {
    console.log('（写结果文件失败：' + e.message + '）');
  }

  try { await require('../src/models').sequelize.close(); } catch (e) { /* ignore */ }
  process.exit(bad.length ? 1 : 0);
})();
