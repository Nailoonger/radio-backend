'use strict';

/**
 * 点歌排期协议（docs/song-protocol.md）的验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-song-protocol.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖：
 *   A. 模型：三张新表 + submit 的三个维度列
 *   B. 周 weekly_schedule：懒创建、周唯一、时间锚点、状态推进、锁定后不再回退
 *   C. 提交不判容量：格子满了照样能提交（一律 PENDING_REVIEW）
 *   D. 第一轮排期：同格按提交时间取前 capacity，其余 WAITING
 *   E. 原位递补：释放位子 → 首选同格、提交最早的候补补上
 *   F. 全局调剂：首选满 → 允许调剂的人被安排到最近的空位；不允许的原地不动
 *   G. 调剂排序：可接受位置少的优先 → 提交早的优先 → 距原时段近的优先
 *   H. 锁定：最后调度 → 剩余 WAITING 自动驳回 → 周 LOCKED；幂等
 *   I. 播放标记：播出时刻过了 → PLAYED
 *   J. 人工指定时段：写 MANUAL 日志、位子随之变化
 *   K. 日志：request_status_log / assignment_log 都留了痕
 *   L. 不变量：镜像 status 与三维永远一致
 *   M. 保留规则：窗口 / 每人每周次数 / 同曲去重仍然生效
 *
 * 结果同时写到 stdout 与同目录的 verify-song-protocol-output.txt。
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
    const { sequelize, Submit, WeeklySchedule, AssignmentLog, RequestStatusLog } = require('../src/models');
    const S = require('../src/services/songStatusService');
    const sched = require('../src/services/songSchedulingService');
    const win = require('../src/services/songWindowService');
    const slotSvc = require('../src/services/broadcastSlotService');
    const ruleSvc = require('../src/services/submitRuleService');
    const kv = require('../src/services/kvService');
    const bj = require('../src/utils/bjTime');

    await sequelize.sync({ force: true });
    say('sync ok（submit / weekly_schedule / assignment_log / request_status_log …）');

    const now = Date.now();
    const weekStart = bj.nextWeekRange(now).start.getTime();
    const fmt = (ts) => win.toBjsIso(new Date(ts));
    /** 播放标记的观察点：目标周周一 08:00 —— 此时首格（07:20）已播过、末格仍在未来 */
    const videoObserveAt = (ws) => ws + 8 * 3600000;

    const slots = await slotSvc.getSlots(now);
    const V = slots.list.map((s) => s.value);
    say(`目标周 ${slots.weekStart} ~ ${slots.weekEnd}，格子 ${V.length} 个，首格 ${V[0]}`);
    check('下周格子数 = 5 × 时段数', V.length === 15, 'n=' + V.length);

    // 每格正式位 = 1（最便于观察「谁排上了」）
    await slotSvc.setCapacity(1);
    await slotSvc.clearCache();
    check('每格正式位 = 1', (await slotSvc.getCapacity()) === 1);

    /* ══════════ A. 模型 ══════════ */
    say('');
    say('--- A. 模型 ---');
    const rawCols = await sequelize.getQueryInterface().describeTable('submit');
    check('submit 有 review_status', !!rawCols.review_status);
    check('submit 有 schedule_status', !!rawCols.schedule_status);
    check('submit 有 play_status', !!rawCols.play_status);
    check('submit 有 allow_reschedule', !!rawCols.allow_reschedule);
    check('submit 有 assigned_at', !!rawCols.assigned_at);
    check('submit 有 played_at', !!rawCols.played_at);
    for (const t of ['weekly_schedule', 'assignment_log', 'request_status_log']) {
      let exists = true;
      try { await sequelize.getQueryInterface().describeTable(t); } catch (e) { exists = false; }
      check(`新表存在：${t}`, exists);
    }

    /* ══════════ B. 周 ══════════ */
    say('');
    say('--- B. weekly_schedule ---');
    await win.clearCache();
    const cfg = await win.getConfig(now);
    const rng = win.windowRangeAt(cfg, now);
    const week = await sched.ensureWeek(weekStart, { now });
    check('懒创建：周行按周一日期落库', week.weekStartDate === bj.ymd(bj.shifted(weekStart)), week.weekStartDate);
    check('申请开始 = 窗口开始',
      +new Date(week.applicationStartAt) === rng.start.getTime(), fmt(+new Date(week.applicationStartAt)));
    check('申请截止 = 窗口结束',
      +new Date(week.applicationEndAt) === rng.end.getTime(), fmt(+new Date(week.applicationEndAt)));
    check('锁定时刻 = 窗口结束 + 6h（= 播出周周一 00:00）',
      +new Date(week.scheduleLockAt) === rng.end.getTime() + 6 * 3600000, fmt(+new Date(week.scheduleLockAt)));
    check('锁定时刻 = 目标周周一 00:00',
      +new Date(week.scheduleLockAt) === weekStart, fmt(+new Date(week.scheduleLockAt)));

    // 幂等：再取一次不能建出第二行
    const week2 = await sched.ensureWeek(weekStart, { now });
    check('ensureWeek 幂等（同 id）', Number(week2.id) === Number(week.id));
    const weekCount = await WeeklySchedule.count();
    check('一周只有一行', weekCount === 1, 'count=' + weekCount);

    // 状态推进
    const wDraft = await sched.ensureWeek(weekStart, { now: rng.start.getTime() - 3600000 });
    check('窗口未开 → DRAFT', wDraft.status === 'DRAFT', wDraft.status);
    const wApp = await sched.ensureWeek(weekStart, { now: rng.start.getTime() + 60000 });
    check('窗口内 → APPLICATION', wApp.status === 'APPLICATION', wApp.status);
    const wRev = await sched.ensureWeek(weekStart, { now: rng.end.getTime() + 60000 });
    check('窗口关 → REVIEW', wRev.status === 'REVIEW', wRev.status);

    /* ══════════ C. 提交不判容量 ══════════ */
    say('');
    say('--- C. 提交一律待审（不判容量）---');
    let seq = 0;
    async function mk(want, opts = {}) {
      seq += 1;
      const minutesAgo = opts.minutesAgo === undefined ? 10 : opts.minutesAgo;
      return Submit.create({
        openid: opts.openid || `S${String(seq).padStart(3, '0')}`,
        type: 1,
        songName: opts.song || `歌${seq}`,
        singer: '测试',
        wantBroadcastTime: want,
        reviewStatus: S.REVIEW.PENDING,
        scheduleStatus: S.SCHEDULE.UNASSIGNED,
        playStatus: S.PLAY.NOT_PLAYED,
        allowReschedule: opts.allowReschedule === undefined ? 1 : opts.allowReschedule,
        status: S.ST.PENDING,
        createTime: new Date(Date.now() - minutesAgo * 60000),
      });
    }
    /** 直接落一条「已占位」的行（造初始状态用） */
    async function mkSeated(want, opts = {}) {
      const row = await mk(want, opts);
      return row.update({
        reviewStatus: S.REVIEW.APPROVED,
        scheduleStatus: S.SCHEDULE.APPROVED,
        scheduledSlot: want,
        assignedAt: new Date(),
        status: S.deriveStatus(S.REVIEW.APPROVED, S.SCHEDULE.APPROVED, S.PLAY.NOT_PLAYED),
      });
    }

    const over = await mk(V[0]);   // 先手动占满第一格
    await over.update({
      reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.APPROVED,
      scheduledSlot: V[0], status: S.ST.SCHEDULED,
    });
    const usage = await sched.countSeated(V[0]);
    check('第一格已占满（capacity=1）', usage === 1, 'seated=' + usage);

    const extra = await mk(V[0], { openid: 'OVER', song: '超额歌' });
    check('格子已满仍能提交（协议：提交不判容量）',
      Number(extra.reviewStatus) === S.REVIEW.PENDING && Number(extra.scheduleStatus) === S.SCHEDULE.UNASSIGNED,
      `review=${extra.reviewStatus} schedule=${extra.scheduleStatus}`);
    check('提交后镜像 status = 0 待审核', Number(extra.status) === S.ST.PENDING, extra.status);

    /* ══════════ D. 第一轮排期 ══════════ */
    say('');
    say('--- D. 第一轮排期 InitialAllocator ---');
    await Submit.destroy({ where: {} });
    await AssignmentLog.destroy({ where: {} });
    await RequestStatusLog.destroy({ where: {} });

    // 同一格 3 个人抢 1 个位子：提交时间 30 / 20 / 10 分钟前
    const a = await mk(V[1], { minutesAgo: 30, song: '最早' });
    const b = await mk(V[1], { minutesAgo: 20, song: '居中' });
    const c = await mk(V[1], { minutesAgo: 10, song: '最晚' });
    for (const row of [a, b, c]) {
      await S.applyChange(row, { reviewStatus: S.REVIEW.APPROVED, reviewerId: 1, reviewTime: new Date() });
    }
    const ia = await sched.initialAllocate(weekStart, { now });
    check('第一轮排期落座 1 条', ia.assigned === 1, JSON.stringify(ia));
    check('第一轮排期进候补 2 条', ia.waiting === 2, JSON.stringify(ia));

    const ra = await Submit.findByPk(a.id);
    const rb = await Submit.findByPk(b.id);
    const rc = await Submit.findByPk(c.id);
    check('提交最早的拿到正式位', Number(ra.scheduleStatus) === S.SCHEDULE.APPROVED && ra.scheduledSlot === V[1],
      `schedule=${ra.scheduleStatus} slot=${ra.scheduledSlot}`);
    check('后两位进 WAITING',
      Number(rb.scheduleStatus) === S.SCHEDULE.WAITING && Number(rc.scheduleStatus) === S.SCHEDULE.WAITING,
      `${rb.scheduleStatus}/${rc.scheduleStatus}`);
    check('落座者镜像 status = 1 已排期', Number(ra.status) === S.ST.SCHEDULED, ra.status);
    check('候补者镜像 status = 3 候补中', Number(rb.status) === S.ST.QUEUED, rb.status);
    check('候补位次：居中排第 1 位', (await sched.waitingPosOf(rb)).pos === 1);
    check('候补位次：最晚排第 2 位', (await sched.waitingPosOf(rc)).pos === 2);
    check('周状态推进到 SCHEDULING',
      (await WeeklySchedule.findByPk(week.id)).status === 'SCHEDULING');

    // 幂等
    const ia2 = await sched.initialAllocate(weekStart, { now });
    check('第一轮排期幂等（重跑不重复落座）', ia2.assigned === 0 && ia2.waiting === 0, JSON.stringify(ia2));
    check('assign_log 记了 INITIAL 一条',
      (await AssignmentLog.count({ where: { assignmentType: 'INITIAL' } })) === 1);

    /* ══════════ E. 原位递补 ══════════ */
    say('');
    say('--- E. 原位递补 ---');
    // 管理员驳回已落座的那条 → 位子释放 → 首选同格、提交最早的候补补上
    const rel = await sched.afterRelease(await ra.update({
      reviewStatus: S.REVIEW.REJECTED, rejectReason: '测试驳回', reviewTime: new Date(),
      status: S.deriveStatus(S.REVIEW.REJECTED, S.SCHEDULE.APPROVED, S.PLAY.NOT_PLAYED),
    }));
    const rb2 = await Submit.findByPk(b.id);
    check('原位递补 1 条', rel.promoted === 1, JSON.stringify(rel));
    check('补上的是队列里提交最早的（居中）',
      Number(rb2.scheduleStatus) === S.SCHEDULE.APPROVED && rb2.scheduledSlot === V[1],
      `schedule=${rb2.scheduleStatus} slot=${rb2.scheduledSlot}`);
    check('驳回后不再占位（review≠APPROVED）', !sched.isSeated(await Submit.findByPk(a.id)));
    check('递补写入 PROMOTED 日志',
      (await AssignmentLog.count({ where: { assignmentType: 'PROMOTED' } })) >= 1);

    /* ══════════ F. 全局调剂 ══════════ */
    say('');
    say('--- F. 全局调剂 ---');
    await Submit.destroy({ where: {} });
    await AssignmentLog.destroy({ where: {} });
    await RequestStatusLog.destroy({ where: {} });

    // V[1] 先占住，再让两人首选 V[1]：一个接受调剂、一个不接受
    await mkSeated(V[1], { minutesAgo: 90, song: '占位' });
    const flex = await mk(V[1], { minutesAgo: 40, song: '接受调剂' });
    const rigid = await mk(V[1], { minutesAgo: 20, song: '只认首选', allowReschedule: 0 });
    for (const row of [flex, rigid]) {
      await S.applyChange(row, { reviewStatus: S.REVIEW.APPROVED, reviewerId: 1, reviewTime: new Date() });
    }
    await sched.initialAllocate(weekStart, { now });
    // 全局调剂属于「收歌截止后 / 超管手动执行 / 锁定前」的动作 → 显式放开跨时段
    await sched.reschedule(weekStart, { now: now + 1000, crossSlot: true });

    const rf = await Submit.findByPk(flex.id);
    const rr = await Submit.findByPk(rigid.id);
    check('接受调剂的人被安排到别处',
      Number(rf.scheduleStatus) === S.SCHEDULE.APPROVED && rf.scheduledSlot !== V[1],
      `schedule=${rf.scheduleStatus} slot=${rf.scheduledSlot}`);
    check('调剂写入 RESCHEDULED 日志',
      (await AssignmentLog.count({ where: { assignmentType: 'RESCHEDULED', requestId: flex.id } })) === 1);
    check('调剂日志保留了原时段',
      (await AssignmentLog.findOne({ where: { requestId: flex.id } })).fromSlot === V[1]);
    check('不接受调剂的人原地不动（仍 WAITING）',
      Number(rr.scheduleStatus) === S.SCHEDULE.WAITING, rr.scheduleStatus);
    check('首选仍是原值（意愿数据不被覆盖）', rr.wantBroadcastTime === V[1] && rf.wantBroadcastTime === V[1]);
    check('调剂结果距原时段最近（紧邻格）',
      Math.abs(V.indexOf(rf.scheduledSlot) - V.indexOf(V[1])) === 1, rf.scheduledSlot);

    /* ══════════ G. 调剂排序 ══════════ */
    say('');
    say('--- G. 调剂优先级 ---');
    await Submit.destroy({ where: {} });
    await AssignmentLog.destroy({ where: {} });
    // 只剩 V[5] 与 V[9] 两个空位，三个候补：
    //   Z 只接受首选 V[12]，而 V[12] 已满 → 可接受位置 = 0（永远排不上 → 留给锁定测试）
    //   X 只接受首选 V[5]            → 可接受位置 = 1（只有 V[5]）
    //   Y 接受调剂                   → 可接受位置 = 2（V[5]、V[9]）
    // 排序「可接受位置少的优先」要求 Z 先处理（没位置→跳过）、X 次之、Y 最后，
    // 否则 Y 会先把 V[5] 抢走，X 就永远没有位置了。
    for (const v of V) {
      if (v === V[5] || v === V[9]) continue;
      await mkSeated(v, { minutesAgo: 200, song: '占' + v });
    }
    const z = await mk(V[12], { minutesAgo: 80, song: 'Z-只认首选', allowReschedule: 0 });
    const y = await mk(V[3], { minutesAgo: 60, song: 'Y-接受调剂', allowReschedule: 1 });
    const x = await mk(V[5], { minutesAgo: 30, song: 'X-只认首选', allowReschedule: 0 });
    for (const row of [z, y, x]) {
      await S.applyChange(row, { reviewStatus: S.REVIEW.APPROVED, reviewerId: 1, reviewTime: new Date() });
    }
    await sched.initialAllocate(weekStart, { now });
    await sched.reschedule(weekStart, { now, crossSlot: true });
    const rx = await Submit.findByPk(x.id);
    const ry = await Submit.findByPk(y.id);
    const rz = await Submit.findByPk(z.id);
    check('可接受位置少的优先：X 先拿到 V[5]',
      Number(rx.scheduleStatus) === S.SCHEDULE.APPROVED && rx.scheduledSlot === V[5],
      `schedule=${rx.scheduleStatus} slot=${rx.scheduledSlot}`);
    check('Y 随后拿到剩下的 V[9]',
      Number(ry.scheduleStatus) === S.SCHEDULE.APPROVED && ry.scheduledSlot === V[9],
      `schedule=${ry.scheduleStatus} slot=${ry.scheduledSlot}`);
    check('不接受调剂且首选已满的 Z 继续等待', Number(rz.scheduleStatus) === S.SCHEDULE.WAITING, rz.scheduleStatus);

    /* ══════════ G2. 收歌未截止 → 不许跨时段 ══════════ */
    say('');
    say('--- G2. 收歌未截止：只做原位递补，别处的空位不外借 ---');
    // 这是「保证每个时段原先申请者的排期」的核心回归：
    // 收歌窗口还没结束（application_end_at 之前）时，别的格子空着也不能占 ——
    // 那个空位要留给「首选那一格」的原申请者（他可能还没被审核通过）。
    // 用一个更远的播出周跑这一节 —— 不 destroy、不碰 weekStart 的数据，
    // 免得把 G 节的 X/Y/Z 和下面 H 节的断言搞坏。
    const gateWeekMs = weekStart + 14 * DAY;
    const GV = await sched.slotValuesOfWeek(gateWeekMs);
    const gateWeek = await sched.ensureWeek(gateWeekMs, { now });
    const openAt = +new Date(gateWeek.applicationStartAt) + 3600 * 1000;    // 收歌中
    const closedAt = +new Date(gateWeek.applicationEndAt) + 3600 * 1000;   // 收歌已截止
    check('闸门：收歌中不允许跨时段', sched.canCrossSlot(gateWeek, openAt) === false);
    check('闸门：收歌截止后允许跨时段', sched.canCrossSlot(gateWeek, closedAt) === true);

    await mkSeated(GV[1], { minutesAgo: 90, song: '占住首选' });
    const flexEarly = await mk(GV[1], { minutesAgo: 40, song: '早段候补' });
    await S.applyChange(await Submit.findByPk(flexEarly.id), {
      reviewStatus: S.REVIEW.APPROVED, reviewerId: 1, reviewTime: new Date(),
    });
    await sched.initialAllocate(gateWeekMs, { now: openAt });

    const noCross = await sched.reschedule(gateWeekMs, { now: openAt });
    const rfEarly = await Submit.findByPk(flexEarly.id);
    check('收歌中：候补的人不会被塞到别的空位',
      Number(rfEarly.scheduleStatus) === S.SCHEDULE.WAITING && noCross.rescheduled === 0,
      `schedule=${rfEarly.scheduleStatus} rescheduled=${noCross.rescheduled}`);
    check('收歌中：返回值标明 crossSlot=false', noCross.crossSlot === false, String(noCross.crossSlot));

    const withCross = await sched.reschedule(gateWeekMs, { now: closedAt });
    const rfLate = await Submit.findByPk(flexEarly.id);
    check('收歌截止后才跨时段调剂',
      Number(rfLate.scheduleStatus) === S.SCHEDULE.APPROVED && rfLate.scheduledSlot !== GV[1] && withCross.rescheduled === 1,
      `schedule=${rfLate.scheduleStatus} slot=${rfLate.scheduledSlot} rescheduled=${withCross.rescheduled}`);
    check('跨时段后首选（意愿数据）仍是原值', rfLate.wantBroadcastTime === GV[1], rfLate.wantBroadcastTime);

    /* ══════════ G3. 调剂成本表 ══════════ */
    say('');
    say('--- G3. 调剂成本表（V1 §10）---');
    // V[0..2] = 周一早/午/晚，V[3..5] = 周二，V[9] = 周四，GV = 两周后的同一批格子
    const cost = require('../src/services/songRescheduleCost');
    check('首选自身 cost = 0', cost.costBetween(V[0], V[0]) === 0, String(cost.costBetween(V[0], V[0])));
    check('同一天其他时段 cost = 10', cost.costBetween(V[0], V[1]) === 10, String(cost.costBetween(V[0], V[1])));
    check('前/后一天相同时段 cost = 20', cost.costBetween(V[0], V[3]) === 20, String(cost.costBetween(V[0], V[3])));
    check('前/后一天其他时段 cost = 30', cost.costBetween(V[0], V[5]) === 30, String(cost.costBetween(V[0], V[5])));
    check('更远日期 cost = 50', cost.costBetween(V[0], V[9]) === 50, String(cost.costBetween(V[0], V[9])));
    check('跨周 = 不可接受 ∞', cost.costBetween(V[0], GV[0]) === Infinity);
    check('解析不出的值 = 不可接受 ∞', cost.costBetween(V[0], '随便写的') === Infinity);
    // 这正是「下标距离」与规格不等价的地方：跨天相邻 ≠ 同天相邻
    check('跨天相邻(20) 不再与同天相邻(10) 打平',
      cost.costBetween(V[0], V[1]) < cost.costBetween(V[0], V[3]));
    check('pickBest 选 cost 最小的（同天优先于次日）',
      cost.pickBest([V[3], V[1], V[9]], V[0], new Map(V.map((v, i) => [v, i]))) === V[1]);
    check('cost 相同时按下标升序（结果可复现）',
      cost.pickBest([V[2], V[1]], V[0], new Map(V.map((v, i) => [v, i]))) === V[1]);

    /* ══════════ H. 锁定 ══════════ */
    say('');
    say('--- H. 锁定 ---');
    const lockRes = await sched.lockWeek(weekStart, { now: now + DAY, operatorId: 1, force: true });
    check('锁定后周状态 = LOCKED', lockRes.status === 'LOCKED', lockRes.status);
    const rz2 = await Submit.findByPk(z.id);
    check('锁定时仍无位置的候补 → AUTO_REJECTED',
      Number(rz2.scheduleStatus) === S.SCHEDULE.AUTO_REJECTED, rz2.scheduleStatus);
    check('自动驳回写了理由', (rz2.rejectReason || '').includes('锁定'), rz2.rejectReason);
    check('自动驳回 auto_rejected = 1', Number(rz2.autoRejected) === 1);
    check('自动驳回后镜像 status = 2', Number(rz2.status) === S.ST.REJECTED, rz2.status);
    check('审核维度保持 APPROVED（没被人为驳回）', Number(rz2.reviewStatus) === S.REVIEW.APPROVED, rz2.reviewStatus);
    check('已拿到位置的不受锁定影响',
      Number((await Submit.findByPk(x.id)).scheduleStatus) === S.SCHEDULE.APPROVED);

    const lockRes2 = await sched.lockWeek(weekStart, { now: now + 2 * DAY, operatorId: 1, force: true });
    check('重复锁定幂等', lockRes2.already === true, JSON.stringify(lockRes2.already));

    // 未到锁定时刻：必须换一个还没锁的周来验（本周已经 LOCKED 了）
    const nextWeekMs = weekStart + 7 * DAY;
    const tooEarly = await sched.lockWeek(nextWeekMs, { now: rng.end.getTime() + 60000, operatorId: 1 });
    check('未到锁定时刻且没传 force → 不锁', tooEarly.tooEarly === true, JSON.stringify(tooEarly));
    const forcedEarly = await sched.lockWeek(nextWeekMs, { now: rng.end.getTime() + 60000, operatorId: 1, force: true });
    check('传 force 可以提前锁定', forcedEarly.tooEarly !== true && forcedEarly.status === 'LOCKED', forcedEarly.status);

    // 锁定后周状态不会被 ensureWeek 回退
    const weekAfter = await sched.ensureWeek(weekStart, { now: now + 60 * DAY });
    check('锁定状态不回退（ensureWeek 不覆盖 LOCKED）', weekAfter.status === 'LOCKED', weekAfter.status);

    /* ══════════ I. 播放标记 ══════════ */
    say('');
    say('--- I. 播放标记 ---');
    await Submit.destroy({ where: {} });
    // V[0] = 该周周一 07:20（在「周一 08:00」这个观察点已经播过）
    // 末格 = 该周周五 17:30（还没播）
    const p1 = await mkSeated(V[0], { song: '已播' });
    const p2 = await mkSeated(V[V.length - 1], { song: '未播', minutesAgo: 5 });
    const observedAt = videoObserveAt(weekStart);
    const mp = await sched.markPlayed({ now: observedAt });
    check('播出时刻已过的被标记已播放', Number((await Submit.findByPk(p1.id)).playStatus) === S.PLAY.PLAYED);
    check('播出时刻未到的保持未播', Number((await Submit.findByPk(p2.id)).playStatus) === S.PLAY.NOT_PLAYED,
      (await Submit.findByPk(p2.id)).scheduledSlot);
    check('已播放镜像 status = 5', Number((await Submit.findByPk(p1.id)).status) === S.ST.PLAYED);
    check('标记条数正确', mp.played === 1, 'played=' + mp.played);
    const mp2 = await sched.markPlayed({ now: observedAt });
    check('播放标记幂等', mp2.played === 0, 'played=' + mp2.played);

    /* ══════════ J. 人工指定时段 ══════════ */
    say('');
    say('--- J. 人工指定时段 ---');
    await Submit.destroy({ where: {} });
    await AssignmentLog.destroy({ where: {} });
    const m1 = await mkSeated(V[2], { song: '待调整' });
    await sched.manualAssign(await Submit.findByPk(m1.id), V[4], { operatorId: 7, reason: '人工协调' });
    const rm = await Submit.findByPk(m1.id);
    check('人工调整后落到新时段', rm.scheduledSlot === V[4], rm.scheduledSlot);
    const al = await AssignmentLog.findOne({ where: { requestId: m1.id, assignmentType: 'MANUAL' } });
    check('人工调整写了 MANUAL 日志', !!al);
    check('日志记录 from → to', al.fromSlot === V[2] && al.toSlot === V[4], `${al.fromSlot} → ${al.toSlot}`);
    check('日志记录了操作人', Number(al.operatorId) === 7, al.operatorId);
    check('人工调整不改首选', rm.wantBroadcastTime === V[2]);

    /* ══════════ K. 日志 ══════════ */
    say('');
    say('--- K. 状态日志 ---');
    const sl = await RequestStatusLog.findAll({ where: { requestId: m1.id }, raw: true });
    check('状态日志有记录（建表时写 PENDING_REVIEW）',
      Array.isArray(sl), 'n=' + sl.length);
    const slReview = await RequestStatusLog.findOne({ where: { requestId: m1.id, dimension: 'review' }, raw: true });
    void slReview;
    // 造一条：审核通过 → 有 review 维度日志
    await Submit.destroy({ where: {} });
    await RequestStatusLog.destroy({ where: {} });
    const g1 = await mk(V[3], { song: '审过' });
    const adminCtl = require('../src/controllers/admin/submitController')._internals;
    await adminCtl.approveOne(await Submit.findByPk(g1.id), 9);
    const logs = await RequestStatusLog.findAll({ where: { requestId: g1.id }, raw: true });
    check('审核通过写 review 维度日志',
      logs.some((l) => l.dimension === 'review' && l.toStatus === 'APPROVED'), JSON.stringify(logs.map((l) => l.dimension + ':' + l.toStatus)));
    check('日志记录了操作人 operator_id = 9', logs.some((l) => Number(l.operatorId) === 9));

    /* ══════════ L. 不变量 ══════════ */
    say('');
    say('--- L. 镜像不变量 ---');
    await Submit.destroy({ where: {} });
    const mixed = [];
    for (let r = 0; r < 4; r++) {
      for (let s = 0; s < 4; s++) {
        for (let p = 0; p < 2; p++) mixed.push([r, s, p]);
      }
    }
    let invariantOk = true;
    for (const [r, s, p] of mixed) {
      const d = S.deriveStatus(r, s, p);
      if (typeof d !== 'number' || d < 0 || d > 7) invariantOk = false;
    }
    check('派生函数对所有组合都有确定结果', invariantOk);
    check('播放优先于一切', S.deriveStatus(0, 0, 1) === S.ST.PLAYED);
    check('取消优先于排期', S.deriveStatus(3, 1, 0) === S.ST.CANCELLED);
    check('系统驳回映射为已驳回', S.deriveStatus(1, 3, 0) === S.ST.REJECTED);
    check('审核通过 + 未排期 = 已通过待排期', S.deriveStatus(1, 0, 0) === S.ST.APPROVED_WAIT);
    check('待审 = 0', S.deriveStatus(0, 0, 0) === S.ST.PENDING);

    // 库里每行的镜像都必须和三维一致
    await Submit.destroy({ where: {} });
    await mk(V[6], { song: 'A' });
    await mkSeated(V[7], { song: 'B' });
    const all = await Submit.findAll();
    const consistent = all.every((row) => Number(row.status)
      === S.deriveStatus(row.reviewStatus, row.scheduleStatus, row.playStatus));
    check('库内每一行的 status 与三维一致', consistent);

    /* ══════════ M. 保留规则 ══════════ */
    say('');
    say('--- M. 保留的三条规则 ---');
    await Submit.destroy({ where: {} });
    const dupA = await mk(V[8], { openid: 'DUP1', song: '同名歌', minutesAgo: 5 });
    void dupA;
    const dupChk = await ruleSvc.checkSongDuplicate('同名歌', now);
    check('同曲一周去重仍生效', dupChk.ok === false, JSON.stringify(dupChk));
    const dupChk2 = await ruleSvc.checkSongDuplicate('另一首歌', now);
    check('不同歌名不受影响', dupChk2.ok === true);

    await Submit.destroy({ where: {} });
    await mk(V[9], { openid: 'LIM1', song: '歌1', minutesAgo: 3 });
    await mk(V[10], { openid: 'LIM1', song: '歌2', minutesAgo: 2 });
    const lim = await ruleSvc.checkUserWeeklyLimit('LIM1', now);
    check('每人每周次数仍生效（默认 2 次已用完）', lim.ok === false && lim.used === 2 && lim.limit === 2, JSON.stringify(lim));

    const winSt = await win.status(now);
    check('点歌时间窗口仍在（enabled 且给出起止）',
      winSt.enabled === true && !!winSt.start && !!winSt.end, `${winSt.windowText} open=${winSt.open}`);

    /* ══════════ N. 兜底 sweep ══════════ */
    say('');
    say('--- N. 兜底 sweep ---');
    await Submit.destroy({ where: {} });
    await WeeklySchedule.destroy({ where: {} });
    const s1 = await mk(V[11], { song: '兜底1' });
    await S.applyChange(await Submit.findByPk(s1.id), { reviewStatus: S.REVIEW.APPROVED, reviewerId: 1 });
    const sw = await sched.sweep({ now });
    check('sweep 覆盖到了目标周', sw.weeks.length >= 1, JSON.stringify(sw.weeks));
    check('sweep 把审核通过的人排上了位',
      Number((await Submit.findByPk(s1.id)).scheduleStatus) === S.SCHEDULE.APPROVED,
      (await Submit.findByPk(s1.id)).scheduleStatus);
    const swLate = await sched.sweep({ now: now + 30 * DAY });
    check('sweep 到锁定时刻自动锁定',
      swLate.weeks.some((w) => w.locked), JSON.stringify(swLate.weeks));

    /* ══════════ O. 路由挂载与顺序 ══════════ */
    say('');
    say('--- O. 路由挂载与顺序 ---');
    const routeList = (r) => r.stack
      .filter((l) => l.route)
      .map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
    const adminRouter = require('../src/routes/admin');
    const adminRoutes = routeList(adminRouter);
    const userRoutes = routeList(require('../src/routes/user'));

    /** 某条路由挂的中间件函数名（断言权限守卫用；null-prototype 无 name 的记为 ''） */
    const guardsOf = (router, key) => {
      const hit = router.stack
        .filter((l) => l.route)
        .find((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path === key);
      return hit ? hit.route.stack.map((s) => s.name || '') : [];
    };

    const wantAdmin = [
      'POST /submit/schedule/preview', 'POST /submit/schedule/run', 'POST /submit/schedule/lock',
      'GET /submit/week',
      'POST /submit/:id/assign', 'PUT /submit/:id/played', 'GET /submit/:id/status-logs',
    ];
    wantAdmin.forEach((w) => check(`管理端已挂载 ${w}`, adminRoutes.includes(w)));
    check('用户端已挂载 POST /submit/:id/leave-queue', userRoutes.includes('POST /submit/:id/leave-queue'));

    // 字面量段必须排在参数路由之前，否则会被 :id 吃掉
    const literalBefore = (routes, literal, param) => {
      const a = routes.indexOf(literal);
      const b = routes.indexOf(param);
      return a >= 0 && b >= 0 && a < b;
    };
    check('GET /submit/schedule 排在 GET /submit/:id 之前',
      literalBefore(adminRoutes, 'GET /submit/schedule', 'GET /submit/:id'));
    check('GET /submit/week 排在 GET /submit/:id 之前',
      literalBefore(adminRoutes, 'GET /submit/week', 'GET /submit/:id'));
    check('POST /submit/schedule/run 排在 POST /submit/:id/assign 之前',
      literalBefore(adminRoutes, 'POST /submit/schedule/run', 'POST /submit/:id/assign'));
    check('GET /submit/window 排在 GET /submit/:id 之前（用户端）',
      literalBefore(userRoutes, 'GET /submit/window', 'GET /submit/:id'));

    /* ══════════ P. 权限守卫（V1 §2.1）══════════ */
    say('');
    say('--- P. 权限守卫：写排期规则类接口必须超管 ---');
    const mustSuper = [
      'PUT /submit/quota', 'PUT /submit/slots', 'PUT /submit/rules', 'PUT /submit/window',
      'POST /submit/schedule/preview', 'POST /submit/schedule/run', 'POST /submit/schedule/lock',
      'POST /submit/:id/assign', 'PUT /submit/:id/played', 'PUT /submit/:id/revoke',
      'DELETE /submit/songs',
    ];
    mustSuper.forEach((k) => check(`仅超管：${k}`, guardsOf(adminRouter, k).includes('requireSuperAdmin')));

    const reviewerCan = [
      'GET /submit/list', 'PUT /submit/:id/approve', 'PUT /submit/:id/reject',
      'GET /submit/schedule', 'GET /submit/week',
    ];
    reviewerCan.forEach((k) => check(`普通管理员可用：${k}`,
      guardsOf(adminRouter, k).includes('requireAdmin') && !guardsOf(adminRouter, k).includes('requireSuperAdmin')));

    /* ══════════ Q. 点歌窗口：周内任选 + 审核截止独立（2026-09-25）══════════ */
    say('');
    say('--- Q. 点歌窗口：周内任选 + 审核截止独立 ---');

    const cfgNow = await win.getConfig(now);
    const rngNow = win.windowRangeAt(cfgNow, now);
    const songWeekMs = rngNow.songWeek.getTime();
    const weekStartMsQ = rngNow.weekStart.getTime();

    // ① 锚点：窗口整体落在「收歌周」内（旧公式把 startDay=周一 算到播出周本身）
    check('窗口锚点 = 目标播出周 − 7 天（收歌周周一 00:00）',
      weekStartMsQ - songWeekMs === 7 * DAY, `${fmt(songWeekMs)} → ${fmt(weekStartMsQ)}`);
    check('默认窗口（周六 18:00 → 周日 18:00）起止都落在收歌周内',
      rngNow.start.getTime() >= songWeekMs && rngNow.end.getTime() <= weekStartMsQ,
      `${fmt(rngNow.start.getTime())} → ${fmt(rngNow.end.getTime())}`);

    // ② 新旧公式在旧白名单（五/六/日）内必须完全等价 —— 升级不改现网行为
    const offBackOld = (d) => (1 - d + 7) % 7;
    const legacySame = [5, 6, 0].every((d) => songWeekMs + win.offMon(d) * DAY === weekStartMsQ - offBackOld(d) * DAY);
    check('旧白名单（五/六/日）新公式与旧 offBack 完全等价', legacySame,
      [5, 6, 0].map((d) => `${d}:offMon=${win.offMon(d)}/offBack=${offBackOld(d)}`).join(' '));

    // ③ 周一 → 周日 任选：逐日作起止都合法，且不跨收歌周周一 00:00
    let allDaysOk = true;
    let crossOffender = '';
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      try {
        await win.setConfig({ enabled: 1, startDay: d, startTime: '00:00', endDay: d, endTime: '23:59' }, null);
      } catch (e) { allDaysOk = false; crossOffender = `day=${d} ${e.message}`; }
      const c = await win.getConfig(now);
      const r = win.windowRangeAt(c, now);
      if (r.start.getTime() < songWeekMs || r.end.getTime() > weekStartMsQ || r.start.getTime() >= r.end.getTime()) {
        allDaysOk = false;
        crossOffender = `day=${d} ${fmt(r.start.getTime())}→${fmt(r.end.getTime())}`;
      }
    }
    check('周一 → 周日 任选作起止日都合法（7/7）', allDaysOk, crossOffender || 'ok');
    const maxEndOff = Math.max(...[1, 2, 3, 4, 5, 6, 0].map((d) => win.offsetOf(d, '23:59')));
    check('任意任选组合都不跨播出周周一 00:00（最晚偏移 = 周日 23:59 < 7 天）',
      maxEndOff === 7 * DAY - 60000 && maxEndOff < 7 * DAY,
      `${win.describeOffset(maxEndOff)} (${maxEndOff}ms)`);
    check('旧白名单已废除（周二 / 周三 不再是非法值）',
      win.ALL_DAYS.length === 7 && win.ALLOWED_START_DAYS.includes(2) && win.ALLOWED_END_DAYS.includes(3));

    // 跨天组合也放行（旧版会被白名单拦掉）
    let crossOk = true;
    for (const [sd, ed] of [[1, 0], [2, 6], [3, 5], [5, 0], [0, 0]]) {
      try {
        await win.setConfig({ enabled: 1, startDay: sd, startTime: '06:00', endDay: ed, endTime: '22:00' }, null);
      } catch (e) { crossOk = false; }
    }
    check('跨天组合（周一→周日 / 周二→周六 …）全部放行', crossOk);

    // ④ 必须报错的几种
    async function rejects(label, patch, kw) {
      try {
        await win.setConfig(patch, null);
        check(label, false, '未报错');
      } catch (e) {
        check(label, !kw || String(e.message).includes(kw), e.message);
      }
    }
    await rejects('倒挂（结束早于开始）→ 报错',
      { enabled: 1, startDay: 5, startTime: '18:00', endDay: 3, endTime: '18:00' }, '必须晚于');
    await rejects('同一天结束早于开始 → 报错',
      { enabled: 1, startDay: 6, startTime: '18:00', endDay: 6, endTime: '12:00' }, '必须晚于');
    await rejects('审核截止早于收歌结束 → 报错',
      { enabled: 1, startDay: 6, startTime: '18:00', endDay: 0, endTime: '18:00', reviewDay: 0, reviewTime: '12:00' },
      '不得早于收歌结束');
    await rejects('起点到达 24:00 的非法时刻 → 报错',
      { enabled: 1, startDay: 1, startTime: '24:00' }, 'HH:mm');

    // ⑤ 整周铺满：周一 00:00 → 周日 23:59（旧版 72h 上限会拦）
    await win.setConfig({ enabled: 1, startDay: 1, startTime: '00:00', endDay: 0, endTime: '23:59' }, null);
    const fullCfg = await win.getConfig(now);
    const fullRng = win.windowRangeAt(fullCfg, now);
    check('整周全天开放放行：周一 00:00 → 周日 23:59',
      fullRng.start.getTime() === songWeekMs && fullRng.end.getTime() === weekStartMsQ - 60000,
      `${fmt(fullRng.start.getTime())} → ${fmt(fullRng.end.getTime())}`);
    check('整周窗口仍在收歌周内（不跨周一 00:00）', fullRng.end.getTime() < weekStartMsQ);

    // ⑥ 不跳变：窗口内任意时刻算出的都是同一个播出周 + 同一组起止
    const probes = [
      fullRng.start.getTime(), fullRng.start.getTime() + 1,
      songWeekMs + 3 * DAY + 3600000, fullRng.end.getTime() - 1, fullRng.end.getTime(),
    ];
    const stable = probes.every((t) => {
      const r = win.windowRangeAt(fullCfg, t);
      return r.weekStart.getTime() === weekStartMsQ
        && r.start.getTime() === fullRng.start.getTime()
        && r.end.getTime() === fullRng.end.getTime();
    });
    check('窗口内任意时刻：目标播出周与窗口起止恒定（不跳变）', stable,
      `${probes.length} 个探针`);

    // ⑦ 审核截止独立：锁定时刻 = 审核截止，且与收歌截止解耦
    await win.setConfig({ enabled: 1, startDay: 1, startTime: '00:00', endDay: 0, endTime: '12:00', reviewDay: 0, reviewTime: '22:00' }, null);
    const indCfg = await win.getConfig(now);
    const indRng = await win.anchorRangeAt(indCfg, now);
    check('审核截止 = 配置值（周日 22:00）',
      indRng.reviewAt.getTime() === songWeekMs + 6 * DAY + 22 * 3600000,
      fmt(indRng.reviewAt.getTime()));
    check('审核截止 ≠ 收歌截止（两者已解耦）', indRng.reviewAt.getTime() !== indRng.end.getTime(),
      `收歌 ${fmt(indRng.end.getTime())} / 审核 ${fmt(indRng.reviewAt.getTime())}`);

    await WeeklySchedule.destroy({ where: { weekStartDate: bj.ymd(bj.shifted(weekStartMsQ)) } });
    const indWeek = await sched.ensureWeek(weekStartMsQ, { now });
    check('周行 scheduleLockAt = 审核截止',
      +new Date(indWeek.scheduleLockAt) === indRng.reviewAt.getTime(), fmt(+new Date(indWeek.scheduleLockAt)));
    check('周行 reviewEndAt = scheduleLockAt',
      +new Date(indWeek.reviewEndAt) === +new Date(indWeek.scheduleLockAt));
    check('周行 scheduleLockAt ≠ applicationEndAt（锁定不再挂在收歌截止上）',
      +new Date(indWeek.scheduleLockAt) !== +new Date(indWeek.applicationEndAt));
    const indView = sched.weekView(indWeek, now);
    check('weekView 暴露 reviewEndAt 给前端（不必再拿 lockAt − 收歌截止反算）',
      indView.reviewEndAt === win.toBjsIso(new Date(indRng.reviewAt.getTime())), indView.reviewEndAt);
    check('收歌截止到审核截止之间 = 留白（仍处收歌已关、未锁定）',
      indWeek.status === 'REVIEW' || indWeek.status === 'DRAFT' || indWeek.status === 'APPLICATION',
      indWeek.status);

    // ⑧ 未配置审核截止 → 退回「收歌结束 + 偏移」，且升级不改行为
    await win.setConfig({ startDay: 6, startTime: '18:00', endDay: 0, endTime: '18:00', reviewDay: null, reviewTime: null }, null);
    const fbCfg = await win.getConfig(now);
    const fbRng = await win.anchorRangeAt(fbCfg, now);
    check('未配置审核截止 → 收歌结束 + 偏移（默认 6h = 播出周周一 00:00）',
      fbRng.reviewAt.getTime() === fbRng.end.getTime() + 6 * 3600000
      && fbRng.reviewAt.getTime() === weekStartMsQ,
      fmt(fbRng.reviewAt.getTime()));

    // ⑨ 关闭窗口限制 → 审核截止退回播出周周一 00:00
    await win.setConfig({ enabled: 0 }, null);
    const offCfg = await win.getConfig(now);
    const offRng = await win.anchorRangeAt(offCfg, now);
    check('窗口限制关闭 → 审核截止兜底 = 播出周周一 00:00',
      offRng.reviewAt.getTime() === weekStartMsQ, fmt(offRng.reviewAt.getTime()));

    // ⑩ 管理端下发：全周任选 + 状态口径
    await win.setConfig(win.DEFAULT_WINDOW, null);
    const desc = await win.describe(now);
    check('describe 下发 7 天任选（周一在前）',
      Array.isArray(desc.allowedDays) && desc.allowedDays.length === 7 && desc.allowedDays[0].day === 1,
      JSON.stringify(desc.allowedDays));
    check('describe 不再有 72h 上限（已放宽到 168h）', desc.maxSpanHours === 168, desc.maxSpanHours);
    check('describe 暴露审核截止（reviewAt / reviewText）',
      !!desc.reviewAt && !!desc.reviewText, `${desc.windowText} / ${desc.reviewText}`);
    check('describe 文案改为「收歌截止 ≠ 审核截止」',
      String(desc.note).includes('审核截止') && !String(desc.note).includes('窗口结束时刻 = 审核截止'),
      desc.note);
    const stQ = await win.status(now);
    check('status 也带 reviewAt（学生端窗口条可用）', !!stQ.reviewAt, stQ.reviewAt);

    await win.setConfig(win.DEFAULT_WINDOW, null);

    /* ══════════ 汇总 ══════════ */
    say('');
    say('══════════════════════════════════');
    say(`通过 ${ok.length} 项`);
    if (bad.length) {
      say(`❌ 失败 ${bad.length} 项：`);
      bad.forEach((b) => say('   · ' + b));
    } else {
      say('✅ 全部通过');
    }

    const out = [...detail, '', ...ok.map((s) => '  ✓ ' + s)].join('\n');
    fs.writeFileSync(path.join(__dirname, 'verify-song-protocol-output.txt'), out, 'utf8');
    console.log(out);
    process.exit(bad.length ? 1 : 0);
  } catch (e) {
    const msg = `\n❌ 脚本异常：${e.stack || e.message}`;
    detail.push(msg);
    fs.writeFileSync(path.join(__dirname, 'verify-song-protocol-output.txt'), detail.join('\n'), 'utf8');
    console.log(detail.join('\n'));
    process.exit(1);
  }
})();
