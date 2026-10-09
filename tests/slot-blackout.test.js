'use strict';

/**
 * 「可接收点歌日期」（关闭下一播出周某一天）回归
 *
 * 需求（2026-10-08）：节日/活动当天要播专题，提前把下一周的某一天关掉，
 * 学生端那天整组不出现，且服务端必须同步拒绝（前端只是交互）。
 *
 * ⚠️ 判据是「行为」不是「实现」：只断言对外可见的结果（格子集合 / 校验结果 / 接口码）。
 */

const { buildApp, openSongWindowForTest } = require('./app');
const request = require('supertest');
const {
  sequelize, resetDB, seedAdmin, loginAdmin, loginUser,
} = require('./helpers');
const broadcastSlot = require('../src/services/broadcastSlotService');

let app;

beforeAll(async () => {
  app = buildApp();
  await resetDB();
  await seedAdmin();
  await openSongWindowForTest();
});
afterAll(async () => {
  await sequelize.close();
});

/** 每个用例都从「全开」开始，避免互相污染 */
beforeEach(async () => {
  await broadcastSlot.setBlackout([]);
});

describe('播出日期：关闭某天不接收点歌', () => {
  test('默认全开：5 天框架、5 天都有格子、无关闭日期', async () => {
    const s = await broadcastSlot.getSlots();
    expect(s.days).toHaveLength(5);
    expect(s.days.every((d) => d.closed === false)).toBe(true);
    expect(s.closedDates).toEqual([]);
    expect(new Set(s.list.map((x) => x.date)).size).toBe(5);
  });

  test('关掉一天：那天的格子全没，其余 4 天不受影响，范围文案不变', async () => {
    const before = await broadcastSlot.getSlots();
    const target = before.days[2].date; // 周三
    const targetCells = before.list.filter((x) => x.date === target).length;
    expect(targetCells).toBeGreaterThan(0);

    await broadcastSlot.setBlackout([target]);
    const after = await broadcastSlot.getSlots();

    // 日期框架仍是 5 天（后台那张表要照常显示 5 行）
    expect(after.days).toHaveLength(5);
    expect(after.days.find((d) => d.date === target).closed).toBe(true);
    // 可选格子里那天整组消失
    expect(after.list.some((x) => x.date === target)).toBe(false);
    expect(new Set(after.list.map((x) => x.date)).size).toBe(4);
    expect(after.list).toHaveLength(before.list.length - targetCells);
    // 范围文案 / 起止日期不受影响
    expect(after.rangeText).toBe(before.rangeText);
    expect(after.weekStart).toBe(before.weekStart);
    expect(after.weekEnd).toBe(before.weekEnd);
    expect(after.closedDates).toEqual([target]);
  });

  test('isValidSlot 对关闭日期返回 false（服务端硬闸）', async () => {
    const before = await broadcastSlot.getSlots();
    const target = before.days[1].date;
    const val = before.list.find((x) => x.date === target).value;

    expect(await broadcastSlot.isValidSlot(val)).toBe(true);
    await broadcastSlot.setBlackout([target]);
    expect(await broadcastSlot.isValidSlot(val)).toBe(false);
    // 其它日期仍然合法（只关一天，不是全关）
    const other = before.list.find((x) => x.date !== target).value;
    expect(await broadcastSlot.isValidSlot(other)).toBe(true);
  });

  test('直接调接口提交到被关闭的日期 → 40001（前端绕不过）', async () => {
    const before = await broadcastSlot.getSlots();
    const target = before.days[3].date;
    const val = before.list.find((x) => x.date === target).value;
    await broadcastSlot.setBlackout([target]);

    const token = await loginUser(app, { code: 'mock_blackout_user' });
    const res = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 1, songName: '测试歌', singer: '测试', wantBroadcastTime: val });
    expect(res.body.code).toBe(40001);

    // 对照组：没被关的那天能正常提交（证明拒绝的原因确实是「那天被关」）
    const okVal = before.list.find((x) => x.date !== target).value;
    const okRes = await request(app)
      .post('/api/user/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 1, songName: '正常歌', singer: '测试', wantBroadcastTime: okVal });
    expect(okRes.body.code).toBe(0);
  });

  test('全关 5 天：list 为空，但范围文案仍在（不塌成空串）', async () => {
    const before = await broadcastSlot.getSlots();
    await broadcastSlot.setBlackout(before.days.map((d) => d.date));
    const after = await broadcastSlot.getSlots();

    expect(after.list).toHaveLength(0);
    expect(after.closedDates).toHaveLength(5);
    // 这是「先算日期框架再剔格子」的用意：全关时仍要知道这一周是哪几天
    expect(after.rangeText).toBe(before.rangeText);
    expect(after.weekStart).toBe(before.weekStart);
    expect(after.weekEnd).toBe(before.weekEnd);
  });

  test('归一化：非日期 / 重复项被丢弃', async () => {
    const s = await broadcastSlot.getSlots();
    const d0 = s.days[0].date;
    await broadcastSlot.setBlackout([d0, d0, 'not-a-date', '', '2026/10/14']);
    expect(await broadcastSlot.getBlackout()).toEqual([d0]);
  });
});

describe('后台接口：关闭日期', () => {
  test('PUT /admin/submit/slot-dates 保存 → GET /admin/submit/timeslots 能读回', async () => {
    const adminToken = await loginAdmin(app);

    const put = await request(app)
      .put('/api/admin/submit/slot-dates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closedDates: ['2026-10-14', '2026-10-15'] });
    expect(put.body.code).toBe(0);
    expect(put.body.data.closedDates).toEqual(['2026-10-14', '2026-10-15']);

    const get = await request(app)
      .get('/api/admin/submit/timeslots')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.body.code).toBe(0);
    expect(get.body.data.days).toHaveLength(5);
    expect(get.body.data.closedDates).toEqual(['2026-10-14', '2026-10-15']);
  });

  test('传非数组 → 40001', async () => {
    const adminToken = await loginAdmin(app);
    const res = await request(app)
      .put('/api/admin/submit/slot-dates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closedDates: '2026-10-14' });
    expect(res.body.code).toBe(40001);
  });

  test('传空数组 = 全部恢复', async () => {
    const adminToken = await loginAdmin(app);
    await broadcastSlot.setBlackout(['2026-10-14']);
    const res = await request(app)
      .put('/api/admin/submit/slot-dates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ closedDates: [] });
    expect(res.body.code).toBe(0);
    expect(res.body.data.closedDates).toEqual([]);
    expect(await broadcastSlot.getBlackout()).toEqual([]);
  });

  test('未登录 → 不被允许', async () => {
    const res = await request(app)
      .put('/api/admin/submit/slot-dates')
      .send({ closedDates: ['2026-10-14'] });
    expect(res.body.code).not.toBe(0);
  });
});
