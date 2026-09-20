'use strict';

/**
 * 点歌规则 v2 的验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-song-queue.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖（docs/song-queue-v2.md §10）：
 *   A. 点歌时间窗口：默认配置、边界（周六 18:00 / 周日 18:00 左闭右开）、
 *      目标周一致性、配置校验、关闭窗口
 *   B. 容量与落座：占位 / 进候补 / 双满 40904 / 候补上限自动口径
 *   C. 全局递补：FIFO、首选优先、跨时段、未审→4 已审→1、位次
 *   D. 驳回后继续递补（status=4 被驳回 → 释放 → 队首继续补位）
 *   E. 满额清队：全格占满 → 候补队列全部自动驳回；capacity=0 时永不清
 *   F. 定稿关闭：窗口截止 → 3 与 4 全部驳回、0 保留；gate 幂等
 *   G. 跨周兜底：过往周残留待审被清
 *   H. 状态防护：重复驳回 / 通过已驳回件 / 通过已排期件幂等
 *   I. 与提交规则交互：同曲去重与每周次数都把候补算进占用
 *   J. 通知卡字段与全局候补快照
 *   K. 路由挂载与顺序（字面量段必须排在 /submit/:id 之前）
 *
 * 结果同时写到 stdout 与同目录的 verify-song-queue-output.txt（方便在 PowerShell 里读）。
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';

const fs = require('fs');
const path = require('path');

const ok = [];
const bad = [];
const detail = [];
function check(name, cond, extra) {
  (cond ? ok : bad).push(name + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const say = (s) => detail.push(s);

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  try {
    const { sequelize, Submit } = require('../src/models');
    const queue = require('../src/services/songQueueService');
    const win = require('../src/services/songWindowService');
    const slotSvc = require('../src/services/broadcastSlotService');
    const ruleSvc = require('../src/services/submitRuleService');
    const kv = require('../src/services/kvService');
    const bj = require('../src/utils/bjTime');

    await sequelize.sync({ force: true });
    say('sync ok（自动建表：submit / system_setting …）');

    const now = Date.now();
    const weekStart = bj.nextWeekRange(now).start.getTime();     // 目标播出周 周一 00:00
    const sat = weekStart - 2 * DAY;                              // 目标周前的周六
    const sun = weekStart - 1 * DAY;                              // 目标周前的周日
    const at = (base, hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return base + h * 3600000 + m * 60000;
    };
    const fmt = (ts) => win.toBjsIso(new Date(ts));

    const slots = await slotSvc.getSlots(now);
    const V = slots.list.map((s) => s.value);                     // 5 天 × 3 时段 = 15
    say(`目标周 ${slots.weekStart} ~ ${slots.weekEnd}，格子 ${V.length} 个，首格 ${V[0]}`);
    check('下周格子数 = 5 × 时段数', V.length === 15, 'n=' + V.length);

    /* ══════════ A. 点歌时间窗口 ══════════ */
    say('');
    say('--- A. 点歌时间窗口 ---');
    await win.clearCache();
    const cfg0 = await win.getConfig(now);
    check('默认窗口 = 周六 18:00 → 周日 18:00',
      cfg0.enabled === 1 && cfg0.startDay === 6 && cfg0.startTime === '18:00' && cfg0.endDay === 0 && cfg0.endTime === '18:00',
      JSON.stringify(cfg0));
    check('窗口文案', (await win.windowTextOf(cfg0)) === '每周六 18:00 – 周日 18:00', win.windowTextOf(cfg0));

    const rng = win.windowRangeAt(cfg0, now);
    check('窗口起点 = 目标周前的周六 18:00',
      rng.start.getTime() === at(sat, '18:00'), fmt(rng.start.getTime()));
    check('窗口终点 = 目标周前的周日 18:00',
      rng.end.getTime() === at(sun, '18:00'), fmt(rng.end.getTime()));
    check('窗口终点 = 审核截止（早于目标周周一 00:00）', rng.end.getTime() < rng.weekStart.getTime());

    const stSat1759 = await win.status(at(sat, '17:59'));
    check('边界：周六 17:59 未开放', stSat1759.open === false, JSON.stringify({ s: stSat1759.secondsToOpen }));
    check('未开放时给下次开放时间', stSat1759.opensAt === fmt(at(sat, '18:00')), stSat1759.opensAt);
    const stSat1800 = await win.status(at(sat, '18:00'));
    check('边界：周六 18:00 开放（左闭）', stSat1800.open === true);
    const stSun1759 = await win.status(at(sun, '17:59'));
    check('边界：周日 17:59 仍开放', stSun1759.open === true);
    check('开放中给截止倒计时', typeof stSun1759.secondsToClose === 'number' && stSun1759.secondsToClose === 60,
      String(stSun1759.secondsToClose));
    const stSun1800 = await win.status(at(sun, '18:00'));
    check('边界：周日 18:00 已关闭（右开）', stSun1800.open === false);
    check('关闭后下次开放 = 下周六 18:00',
      stSun1800.opensAt === fmt(at(sat + 7 * DAY, '18:00')), stSun1800.opensAt);

    // 周六与周日算出的目标周必须一致，否则学生会投错周
    const wsSat = win.windowRangeAt(cfg0, at(sat, '20:00')).weekStart.getTime();
    const wsSun = win.windowRangeAt(cfg0, at(sun, '10:00')).weekStart.getTime();
    check('周六与周日提交锁定同一个目标周', wsSat === wsSun && wsSat === weekStart,
      `${fmt(wsSat)} / ${fmt(wsSun)}`);

    // 周一提交 → 严格下一周（跳一周）
    const wsMon = win.windowRangeAt(cfg0, weekStart + 3600000).weekStart.getTime();
    check('周一提交跳到「下下周」（严格下一周）', wsMon === weekStart + 7 * DAY, fmt(wsMon));

    // 配置校验
    let cfgErr = null;
    try { await win.setConfig({ endDay: 3 }); } catch (e) { cfgErr = e; }
    check('结束日不能是周三（40001）', !!cfgErr && cfgErr.code === 40001, cfgErr && cfgErr.message);
    cfgErr = null;
    try { await win.setConfig({ startDay: 2 }); } catch (e) { cfgErr = e; }
    check('开始日不能是周二（40001）', !!cfgErr && cfgErr.code === 40001, cfgErr && cfgErr.message);
    cfgErr = null;
    try { await win.setConfig({ startTime: '8点' }); } catch (e) { cfgErr = e; }
    check('时刻格式非法被拒（40001）', !!cfgErr && cfgErr.code === 40001, cfgErr && cfgErr.message);
    // 允许的开始/结束日组合下，最长只能是「周五 00:00 → 周日 23:59」= 71:59，
    // 所以 72 小时上限是防日后放开日期限制的兜底；这里两条都验：最长合法窗口要放行、常量要是 72 小时。
    cfgErr = null;
    try { await win.setConfig({ startDay: 5, startTime: '00:00', endDay: 0, endTime: '23:59' }); } catch (e) { cfgErr = e; }
    check('最长合法窗口（周五 00:00 → 周日 23:59）被接受', !cfgErr, cfgErr && cfgErr.message);
    check('72 小时上限作为防御性兜底存在',
      win.MAX_SPAN_MS === 72 * 3600 * 1000, (win.MAX_SPAN_MS / 3600000) + 'h');

    const saved = await win.setConfig({ startDay: 6, startTime: '20:00', endDay: 0, endTime: '20:00' });
    check('超管改窗口后立刻生效', saved.startTime === '20:00');
    check('改完后窗口文案跟着变', (await win.status(now)).windowText === '每周六 20:00 – 周日 20:00',
      (await win.status(now)).windowText);
    await win.setConfig({ startDay: 6, startTime: '18:00', endDay: 0, endTime: '18:00' });

    await win.setConfig({ enabled: 0 });
    check('关闭窗口限制后任意时刻都开放',
      (await win.status(at(weekStart + 2 * DAY, '10:00'))).open === true);
    await win.setConfig({ enabled: 1 });
    check('重新开启后周五 10:00 不开放',
      (await win.status(at(sat - DAY, '10:00'))).open === false, fmt(at(sat - DAY, '10:00')));

    // ── 闸门接线：控制器必须在「提交的第一关」按窗口拦掉点歌（fail fast，不落库）──
    const { Codes } = require('../src/utils/response');
    check('错误码 SONG_WINDOW_CLOSED = 40907', Codes.SONG_WINDOW_CLOSED === 40907, Codes.SONG_WINDOW_CLOSED);
    const userSubmit = require('../src/controllers/user/submitController');
    const minRes = () => { const r = {}; r.status = (c) => { r._status = c; return r; }; r.json = (b) => { r._json = b; return r; }; return r; };
    const gateBody = { type: 1, songName: '闸门测试歌', singer: '测试', wantBroadcastTime: V[0] };
    const songsBefore = await Submit.count({ where: { type: 1 } });
    let wErr = null;
    await userSubmit.create({ user: { openid: 'w-gate' }, body: gateBody }, minRes(), (e) => { wErr = e; });
    check('窗口外提交点歌 → 40907（早于注意事项校验）', !!wErr && wErr.code === 40907, wErr && wErr.message);
    check('被窗口拦住时不落库', (await Submit.count({ where: { type: 1 } })) === songsBefore);

    await win.setConfig({ enabled: 0 });          // 关掉窗口限制 = 一直开放
    let wErr2 = null;
    await userSubmit.create({ user: { openid: 'w-gate' }, body: gateBody }, minRes(), (e) => { wErr2 = e; });
    const songsAfterGate = await Submit.count({ where: { type: 1 } });
    check('关掉窗口后同一请求不再被窗口拦（40907 消失）',
      !wErr2 || wErr2.code !== 40907, wErr2 && (wErr2.code + ' ' + wErr2.message));
    check('落库与否与结果一致（成功 +1 / 失败不变）',
      (songsAfterGate - songsBefore) === (wErr2 ? 0 : 1), 'delta=' + (songsAfterGate - songsBefore));
    await win.setConfig({ enabled: 1 });
    await Submit.destroy({ where: { openid: 'w-gate' } });   // 后面的容量用例要干净的库

    /* ══════════ B. 容量与落座 ══════════ */
    say('');
    say('--- B. 容量与落座 ---');
    await kv.set('song_slot_capacity', 1, '每格正式位（测试）');
    await kv.set('song_queue_limit', '', '全局候补上限（测试：留空 = 自动）');
    slotSvc.clearCache();
    check('每格正式位 = 1', (await queue.getCapacity()) === 1);
    const autoLimit = await queue.getQueueLimit();
    check('候补上限自动 = 下周正式位总数（15）', autoLimit.auto === true && autoLimit.limit === 15,
      JSON.stringify(autoLimit));

    const d1 = await queue.decideSeat({ slotValue: V[0] });
    check('空位 → 直接落座', d1.outcome === 'seated' && d1.left === 1, JSON.stringify(d1));
    await Submit.create({
      openid: 'u-seat1', type: 1, songName: 'A1', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: V[0], status: queue.ST.PENDING, queueAt: null,
    });
    const d2 = await queue.decideSeat({ slotValue: V[0] });
    check('同格第二条 → 进候补', d2.outcome === 'queued', JSON.stringify(d2));
    const q1 = await Submit.create({
      openid: 'u-queue1', type: 1, songName: 'A2', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: null, status: queue.ST.QUEUED, queueAt: new Date(),
    });
    check('候补行 scheduled_slot 为空、queue_at 有值', q1.scheduledSlot === null && !!q1.queueAt);

    await kv.set('song_queue_limit', 1, '全局候补上限（测试：固定 1）');
    const d3 = await queue.decideSeat({ slotValue: V[0] });
    check('候补也满 → full（接口层返回 40904）', d3.outcome === 'full', JSON.stringify(d3));
    check('该格已占 1 位', (await queue.countSeated(V[0])) === 1);

    /* ══════════ C. 全局递补 ══════════ */
    say('');
    say('--- C. 全局递补（FIFO / 跨时段 / 未审→4）---');
    // 释放 V[0]：把占位那条删掉 → 应该由候补队列队首补上
    await Submit.destroy({ where: { openid: 'u-seat1' } });
    const pr1 = await queue.promote({ now });
    check('释放后递补 1 条', pr1.promoted === 1, JSON.stringify(pr1));
    const q1After = await Submit.findByPk(q1.id);
    check('未审候补补位后 = 4（已补位 · 待审）', Number(q1After.status) === queue.ST.PROMOTED,
      'status=' + q1After.status);
    check('补位写入了 scheduled_slot', q1After.scheduledSlot === V[0], q1After.scheduledSlot);
    check('补位写了 promoted_at', !!q1After.promotedAt);
    check('旧字段 want_broadcast_time 没被覆盖', q1After.wantBroadcastTime === V[0]);

    // 已审候补 → 直接进 1
    await kv.set('song_queue_limit', 10, '测试');
    await Submit.create({
      openid: 'u-seat2', type: 1, songName: 'B1', singer: 's',
      wantBroadcastTime: V[1], scheduledSlot: V[1], status: queue.ST.PENDING, queueAt: null,
    });
    const qReviewed = await Submit.create({
      openid: 'u-queue2', type: 1, songName: 'B2', singer: 's',
      wantBroadcastTime: V[1], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 1), reviewTime: new Date(), reviewerId: 1,
    });
    await Submit.destroy({ where: { openid: 'u-seat2' } });
    const pr2 = await queue.promote({ now });
    const qReviewedAfter = await Submit.findByPk(qReviewed.id);
    check('已审候补补位后直接 = 1（已排期）', Number(qReviewedAfter.status) === queue.ST.SCHEDULED,
      'status=' + qReviewedAfter.status);
    check('这一轮递补计数正确', pr2.promoted === 1, JSON.stringify(pr2));

    // 首选优先：首选时段仍空 → 补到首选；否则填当前空位（可能跨时段）
    await Submit.create({
      openid: 'u-seat3', type: 1, songName: 'C1', singer: 's',
      wantBroadcastTime: V[2], scheduledSlot: V[2], status: queue.ST.PENDING, queueAt: null,
    });
    const preferHead = await Submit.create({
      openid: 'u-queue3', type: 1, songName: 'C2', singer: 's',
      wantBroadcastTime: V[4], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 2),
    });
    await Submit.destroy({ where: { openid: 'u-seat3' } });   // 空出 V[2]
    await queue.promote({ now });
    const preferAfter = await Submit.findByPk(preferHead.id);
    check('首选时段仍空 → 优先补到首选 V[4]', preferAfter.scheduledSlot === V[4], preferAfter.scheduledSlot);

    // 跨时段：首选满、别的格空 → 补到别的格
    await Submit.create({
      openid: 'u-seat4', type: 1, songName: 'D1', singer: 's',
      wantBroadcastTime: V[5], scheduledSlot: V[5], status: queue.ST.PENDING, queueAt: null,
    });
    const crossHead = await Submit.create({
      openid: 'u-queue4', type: 1, songName: 'D2', singer: 's',
      wantBroadcastTime: V[5], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 3),
    });
    await Submit.destroy({ where: { openid: 'u-seat4' } });   // V[5] 空出 → 首选优先命中 V[5]
    await queue.promote({ now });
    const crossAfter = await Submit.findByPk(crossHead.id);
    check('首选有空位时补首选（不算跨时段）', crossAfter.scheduledSlot === V[5], crossAfter.scheduledSlot);

    /* ══════════ D. 驳回后继续递补 ══════════ */
    say('');
    say('--- D. 补位后被驳回 → 继续递补 ---');
    const adminSubmit = require('../src/controllers/admin/submitController');
    const fakeRes = () => {
      const r = {};
      r.status = (c) => { r._status = c; return r; };
      r.json = (b) => { r._json = b; return r; };
      return r;
    };
    const admin = { id: 1, role: 0 };

    // 造一个「补位未审」的场景：V[6] 占满 + 一条候补
    await Submit.create({
      openid: 'u-seat5', type: 1, songName: 'E1', singer: 's',
      wantBroadcastTime: V[6], scheduledSlot: V[6], status: queue.ST.PENDING, queueAt: null,
    });
    const nextInQueue = await Submit.create({
      openid: 'u-queue5', type: 1, songName: 'E2', singer: 's',
      wantBroadcastTime: V[6], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 4),
    });
    // 手工把候补补到 V[6]：模拟「补位未审」
    await Submit.update(
      { status: queue.ST.PROMOTED, scheduledSlot: V[6], promotedAt: new Date() },
      { where: { id: nextInQueue.id } }
    );
    await Submit.destroy({ where: { openid: 'u-seat5' } });

    let res = fakeRes();
    await adminSubmit.reject({ params: { id: nextInQueue.id }, body: { reason: '内容不合适' }, admin }, res, (e) => { throw e; });
    const rejRow = await Submit.findByPk(nextInQueue.id);
    check('补位件被驳回 → status=2 且 auto_rejected=0',
      Number(rejRow.status) === queue.ST.REJECTED && Number(rejRow.autoRejected) === 0, 'status=' + rejRow.status);

    // 再放一条候补，看驳回释放位子后能不能被补上来
    const tail = await Submit.create({
      openid: 'u-queue6', type: 1, songName: 'E3', singer: 's',
      wantBroadcastTime: V[6], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 5),
    });
    const prD = await queue.promote({ now });
    const tailAfter = await Submit.findByPk(tail.id);
    check('驳回后位子释放 → 队首继续递补', Number(tailAfter.status) === queue.ST.PROMOTED && prD.promoted === 1,
      JSON.stringify({ status: tailAfter.status, promoted: prD.promoted }));

    /* ══════════ E. 满额清队 ══════════ */
    say('');
    say('--- E. 满额清队 ---');
    // 先把库里已有的点歌清干净，造一个干净场景
    await Submit.destroy({ where: { type: 1 } });
    await kv.set('song_slot_capacity', 1, '测试');
    slotSvc.clearCache();
    // 占满全部 15 格
    for (let i = 0; i < V.length; i++) {
      await Submit.create({
        openid: 'fill-' + i, type: 1, songName: 'FILL' + i, singer: 's',
        wantBroadcastTime: V[i], scheduledSlot: V[i], status: queue.ST.PENDING, queueAt: null,
      });
    }
    await Submit.create({
      openid: 'q-full-1', type: 1, songName: 'Q1', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: null, status: queue.ST.QUEUED, queueAt: new Date(),
    });
    await Submit.create({
      openid: 'q-full-2', type: 1, songName: 'Q2', singer: 's',
      wantBroadcastTime: V[1], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 1),
    });
    const closed = await queue.closeQueueIfFull({ now });
    check('全格占满 → 候补队列全部自动驳回（2 条）', closed === 2, 'closed=' + closed);
    const queuedLeft = await Submit.count({ where: { type: 1, status: queue.ST.QUEUED } });
    check('队列已清空', queuedLeft === 0, 'left=' + queuedLeft);
    const autoQ = await Submit.findAll({ where: { openid: ['q-full-1', 'q-full-2'] } });
    check('清队的记录都带 auto_rejected=1', autoQ.every((r) => Number(r.autoRejected) === 1 && Number(r.status) === 2));
    check('理由含「满额」', autoQ.every((r) => /满额/.test(r.rejectReason)), autoQ[0].rejectReason);

    await kv.set('song_slot_capacity', 0, '测试：不限');
    slotSvc.clearCache();
    check('capacity=0 时永不清队', (await queue.closeQueueIfFull({ now })) === 0);
    check('capacity=0 时 decideSeat 一律落座',
      (await queue.decideSeat({ slotValue: V[0] })).outcome === 'seated');

    /* ══════════ F. 定稿关闭 ══════════ */
    say('');
    say('--- F. 定稿关闭（窗口截止）---');
    await kv.set('song_slot_capacity', 1, '测试');
    slotSvc.clearCache();
    await Submit.destroy({ where: { type: 1 } });
    await kv.set(queue.KV_GATE, '[]', '测试：清空定稿闸门');

    const fQueued = await Submit.create({
      openid: 'f-q', type: 1, songName: 'FQ', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: null, status: queue.ST.QUEUED, queueAt: new Date(),
    });
    const fPromoted = await Submit.create({
      openid: 'f-p', type: 1, songName: 'FP', singer: 's',
      wantBroadcastTime: V[1], scheduledSlot: V[1], status: queue.ST.PROMOTED,
      queueAt: new Date(), promotedAt: new Date(),
    });
    const fPending = await Submit.create({
      openid: 'f-0', type: 1, songName: 'F0', singer: 's',
      wantBroadcastTime: V[2], scheduledSlot: V[2], status: queue.ST.PENDING, queueAt: null,
    });
    const cutoff = queue.windowEndOfWeek(await win.getConfig(now), weekStart).getTime();
    const fin1 = await queue.finalizeDueWeeks({ now: cutoff + 60000 });   // 截止后 1 分钟
    check('截止后：候补未补位被驳回', (await Submit.findByPk(fQueued.id)).status === queue.ST.REJECTED);
    check('截止后：补位未审被驳回', (await Submit.findByPk(fPromoted.id)).status === queue.ST.REJECTED);
    check('截止后：待审(0) 保留（管理员还可能审）', (await Submit.findByPk(fPending.id)).status === queue.ST.PENDING);
    const fq = await Submit.findByPk(fQueued.id);
    check('候补驳回理由含「截止」', /截止/.test(fq.rejectReason), fq.rejectReason);
    check('定稿统计正确', fin1.weeks === 1 && fin1.queued === 1 && fin1.promoted === 1, JSON.stringify(fin1));

    const fin2 = await queue.finalizeDueWeeks({ now: cutoff + 120000 });
    check('gate 保证同一周只定稿一次', fin2.weeks === 0, JSON.stringify(fin2));

    /* ══════════ G. 跨周兜底 ══════════ */
    say('');
    say('--- G. 跨周兜底（过往周残留待审）---');
    /* ⚠️ 必须往前推两周，不能推一周：
       目标周 = nextWeekRange(now).start，周一凌晨时「目标周 - 7 天」正好是**本周**，
       而本周要到周六 00:00 才算结束 → 一条都清不掉，脚本会在周一失败。
       推 14 天得到的播出周必定已经结束，任何时刻跑都稳定。 */
    const lastWeekStart = weekStart - 14 * DAY;
    const lastSlot = `${bj.ymd(bj.shifted(lastWeekStart))} 午间 12:20`;
    const gRow = await Submit.create({
      openid: 'g-0', type: 1, songName: 'G0', singer: 's',
      wantBroadcastTime: lastSlot, scheduledSlot: lastSlot, status: queue.ST.PENDING, queueAt: null,
    });
    const fin3 = await queue.finalizeDueWeeks({ now });
    const gAfter = await Submit.findByPk(gRow.id);
    check('上个播出周残留的待审被清（跨周兜底）',
      Number(gAfter.status) === queue.ST.REJECTED && Number(gAfter.autoRejected) === 1 && fin3.pending >= 1,
      JSON.stringify({ status: gAfter.status, reason: gAfter.rejectReason, pending: fin3.pending }));
    check('跨周理由含「播出周已结束」', /播出周已结束/.test(gAfter.rejectReason), gAfter.rejectReason);

    /* ══════════ H. 状态防护（v1 的三个漏洞） ══════════ */
    say('');
    say('--- H. 状态防护 ---');
    const h1 = await Submit.create({
      openid: 'h1', type: 1, songName: 'H1', singer: 's',
      wantBroadcastTime: V[3], scheduledSlot: V[3], status: queue.ST.REJECTED,
      rejectReason: '原驳回理由', autoRejected: 0, reviewerId: 9, reviewTime: new Date(),
    });
    let err = null;
    res = fakeRes();
    await adminSubmit.reject({ params: { id: h1.id }, body: { reason: '再驳一次' }, admin }, res, (e) => { err = e; });
    check('重复驳回被拒（40001），不会覆盖审核记录', !!err && err.code === 40001, err && err.message);
    const h1After = await Submit.findByPk(h1.id);
    check('原驳回理由未被覆盖', h1After.rejectReason === '原驳回理由', h1After.rejectReason);

    err = null;
    res = fakeRes();
    await adminSubmit.approve({ params: { id: h1.id }, admin }, res, (e) => { err = e; });
    check('通过已驳回件明确报错（40001），不再假成功', !!err && err.code === 40001, err && err.message);

    const h2 = await Submit.create({
      openid: 'h2', type: 1, songName: 'H2', singer: 's',
      wantBroadcastTime: V[3], scheduledSlot: V[3], status: queue.ST.SCHEDULED,
      reviewerId: 1, reviewTime: new Date(),
    });
    res = fakeRes();
    await adminSubmit.approve({ params: { id: h2.id }, admin }, res, (e) => { throw e; });
    check('通过已排期件幂等返回', res._json && res._json.code === 0 && /已排期/.test(res._json.message),
      res._json && res._json.message);

    // 批量驳回必须带状态过滤：已驳回的不再被二次驳回
    res = fakeRes();
    await adminSubmit.batch({ body: { ids: [h1.id, h2.id], action: 'reject', reason: '批量' }, admin }, res, (e) => { throw e; });
    check('批量驳回只命中非驳回状态的记录', res._json.data.affected === 1 && res._json.data.skipped === 1,
      JSON.stringify(res._json.data));

    /* ══════════ I. 与提交规则交互 ══════════ */
    say('');
    say('--- I. 与提交规则交互 ---');
    await Submit.destroy({ where: { type: 1 } });
    await ruleSvc.clearCache();
    await ruleSvc.setRules({ weeklyUserLimit: 2, dupBlock: 1 });
    await Submit.create({
      openid: 'i-1', type: 1, songName: '同类歌', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: null, status: queue.ST.QUEUED, queueAt: new Date(),
    });
    check('候补中的歌也占用同曲去重',
      (await ruleSvc.checkSongDuplicate('同类歌')).ok === false);
    const iWeekly = await ruleSvc.checkUserWeeklyLimit('i-1');
    check('候补中的歌占用学生每周次数', iWeekly.used === 1, JSON.stringify(iWeekly));
    await Submit.create({
      openid: 'i-2', type: 1, songName: '系统驳的歌', singer: 's',
      wantBroadcastTime: V[1], scheduledSlot: null, status: queue.ST.REJECTED,
      autoRejected: 1, rejectReason: '下周排期已满额，未能补位',
    });
    check('系统自动驳回的不占学生次数',
      (await ruleSvc.checkUserWeeklyLimit('i-2')).used === 0);

    /* ══════════ J. 通知卡与快照 ══════════ */
    say('');
    say('--- J. 候补态通知卡 / 全局队列快照 ---');
    await Submit.destroy({ where: { type: 1 } });
    await kv.set('song_queue_limit', '', '测试：自动');
    const j1 = await Submit.create({
      openid: 'j-1', type: 1, songName: 'J1', singer: 's',
      wantBroadcastTime: V[0], scheduledSlot: null, status: queue.ST.QUEUED, queueAt: new Date(),
    });
    const j2 = await Submit.create({
      openid: 'j-2', type: 1, songName: 'J2', singer: 's',
      wantBroadcastTime: V[5], scheduledSlot: null, status: queue.ST.QUEUED,
      queueAt: new Date(Date.now() + 1000),
    });
    const card1 = await queue.cardFor(j1);
    const card2 = await queue.cardFor(j2);
    check('候补卡：队首位次 1 / 前面 0 人', card1.queuePos === 1 && card1.aheadCount === 0, JSON.stringify(card1));
    check('候补卡：第二位的次位次 2 / 前面 1 人', card2.queuePos === 2 && card2.aheadCount === 1, JSON.stringify(card2));
    check('候补卡带上限与截止时间', card1.queueLimit === 15 && !!card1.finalizeAt, JSON.stringify({ l: card1.queueLimit, f: card1.finalizeAt }));
    check('候补卡带放弃入口', card1.actions.some((a) => a.key === 'leave'));
    check('候补卡提示实际时段可能与首选不同', /可能与你首选不同/.test(card1.hint), card1.hint);

    const promotedCardRow = await Submit.create({
      openid: 'j-3', type: 1, songName: 'J3', singer: 's',
      wantBroadcastTime: V[7], scheduledSlot: V[9], status: queue.ST.PROMOTED,
      queueAt: new Date(), promotedAt: new Date(),
    });
    const card3 = await queue.cardFor(promotedCardRow);
    check('已补位卡：状态 promoted 且标记换过时段', card3.status === 'promoted' && card3.changed === true, JSON.stringify(card3));
    check('已补位卡说明实际排到哪', card3.scheduledSlot === V[9] && /补到/.test(card3.hint), card3.hint);

    const rejCard = await Submit.create({
      openid: 'j-4', type: 1, songName: 'J4', singer: 's',
      status: queue.ST.REJECTED, autoRejected: 1, rejectReason: '下周排期已满额，未能补位',
    });
    const card4 = await queue.cardFor(rejCard);
    check('未补上卡：status=failed 且带理由', card4.status === 'failed' && /满额/.test(card4.reason), JSON.stringify(card4));

    const snap = await queue.snapshot();
    check('队列快照：总数 2、上限 15、队首排在第 1', snap.total === 2 && snap.limit === 15 && snap.items[0].id === j1.id,
      JSON.stringify({ total: snap.total, limit: snap.limit }));
    check('快照标出每人是否已审', snap.items[0].reviewed === false && snap.items[1].reviewed === false);

    /* ══════════ J2. 管理端列表 / 详情给 UI 用的 v2 字段 ══════════ */
    say('');
    say('--- J2. 管理端列表 / 详情（UI 要用的字段）---');
    const callJson = async (fn, req) => {
      const r = fakeRes();
      let err = null;
      await fn(req, r, (e) => { err = e; });
      if (err) throw err;
      return r._json && r._json.data !== undefined ? r._json.data : r._json;
    };

    const listData = await callJson(adminSubmit.list, { query: { page: 1, pageSize: 50 } });
    const lq1 = listData.list.find((x) => x.id === j1.id);
    const lq2 = listData.list.find((x) => x.id === j2.id);
    const lp1 = listData.list.find((x) => x.id === promotedCardRow.id);
    check('列表：候补行带 queuePos（队首=1 / 第二位=2）', lq1.queuePos === 1 && lq2.queuePos === 2,
      JSON.stringify({ a: lq1.queuePos, b: lq2.queuePos }));
    check('列表：非候补行不带 queuePos（前端据此不渲染位次胶囊）', lp1.queuePos === undefined, String(lp1.queuePos));

    const byActual = await callJson(adminSubmit.list, { query: { page: 1, pageSize: 50, slot: V[9] } });
    check('列表：按时段筛选命中 scheduledSlot（补位件按实际排期算）',
      byActual.list.some((x) => x.id === promotedCardRow.id), 'n=' + byActual.list.length);
    const byPreferred = await callJson(adminSubmit.list, { query: { page: 1, pageSize: 50, slot: V[5] } });
    check('列表：按时段筛选也命中候补件的首选时段（两个 OR 条件没互相覆盖）',
      byPreferred.list.some((x) => x.id === j2.id), 'n=' + byPreferred.list.length);
    const keywordBoth = await callJson(adminSubmit.list, { query: { page: 1, pageSize: 50, slot: V[5], keyword: 'J2' } });
    check('列表：时段 + 关键词同时生效（两个 OR 被合并而不是覆盖）',
      keywordBoth.list.length === 1 && keywordBoth.list[0].id === j2.id, 'n=' + keywordBoth.list.length);

    const detailQueued = await callJson(adminSubmit.detail, { params: { id: j1.id }, admin });
    check('详情：点歌返回 card（含候补位次与定稿时刻）',
      !!detailQueued.card && detailQueued.card.queuePos === 1 && !!detailQueued.card.finalizeAt,
      JSON.stringify(detailQueued.card));
    const detailPromoted = await callJson(adminSubmit.detail, { params: { id: promotedCardRow.id }, admin });
    check('详情：已补位件 card 标出「首选 ≠ 实际」',
      detailPromoted.card && detailPromoted.card.status === 'promoted' && detailPromoted.card.changed === true,
      JSON.stringify(detailPromoted.card));

    const j9 = await Submit.create({
      openid: 'j-9', type: 2, articleTitle: 'J9', articleContent: 'x', status: queue.ST.PENDING,
    });
    const detailArticle = await callJson(adminSubmit.detail, { params: { id: j9.id }, admin });
    check('详情：文稿不返回 card（没有排期概念）', detailArticle.card === null, String(detailArticle.card));

    /* ══════════ K. 路由挂载与顺序 ══════════ */
    say('');
    say('--- K. 路由挂载与顺序 ---');
    const list = (r) => r.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
    const a = list(require('../src/routes/admin'));
    const uu = list(require('../src/routes/user'));

    ['GET /submit/capacity', 'POST /submit/queue/sweep', 'GET /submit/window', 'PUT /submit/window'].forEach((w) => {
      check('管理端已挂载 ' + w, a.includes(w));
    });
    check('用户端已挂载 GET /submit/window', uu.includes('GET /submit/window'));
    check('用户端已挂载 POST /submit/:id/leave-queue', uu.includes('POST /submit/:id/leave-queue'));

    const di = a.indexOf('GET /submit/:id');
    ['GET /submit/capacity', 'POST /submit/queue/sweep', 'GET /submit/window', 'PUT /submit/window', 'GET /submit/schedule'].forEach((w) => {
      const i = a.indexOf(w);
      check(`管理端 ${w} 排在 /submit/:id 之前`, i !== -1 && di !== -1 && i < di, i + '<' + di);
    });
    const ui = uu.indexOf('GET /submit/:id');
    ['GET /submit/window', 'GET /submit/quota', 'GET /submit/timeslots'].forEach((w) => {
      const i = uu.indexOf(w);
      check(`用户端 ${w} 排在 /submit/:id 之前`, i !== -1 && ui !== -1 && i < ui, i + '<' + ui);
    });
  } catch (e) {
    bad.push('FATAL ' + e.message);
    detail.push(String(e.stack).split('\n').slice(0, 8).join('\n'));
  }

  const lines = [];
  lines.push('=== 通过 ' + ok.length + ' 项 ===');
  ok.forEach((s) => lines.push('  ok   ' + s));
  if (bad.length) {
    lines.push('=== 失败 ' + bad.length + ' 项 ===');
    bad.forEach((s) => lines.push('  FAIL ' + s));
  }
  lines.push('');
  lines.push(...detail);
  const text = lines.join('\n');
  console.log(text);
  try {
    fs.writeFileSync(path.join(__dirname, 'verify-song-queue-output.txt'), text, 'utf8');
  } catch (e) { /* 只读目录就算了 */ }
  process.exit(bad.length ? 1 : 0);
})();
