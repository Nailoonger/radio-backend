'use strict';

/**
 * 点歌「读路径 + 展示」门面 —— 从 src/services/songQueueService.js 移植
 *
 * ⚠️ 本文件在协议版里**不再承载任何算法**。
 *   旧版「提交即占位 + 全局 FIFO 候补队列」已作废：
 *     · 容量判定不再是「提交那一刻」，而是「审核通过后的第一轮排期」；
 *     · 候补不再是跨时段的一条 FIFO，而是「原位递补 + 全局调剂（三级排序）」。
 *   算法与状态都搬走了：
 *     → 排期 / 调剂 / 锁定 / 播放标记：`scheduling`
 *     → 三维状态 + 派生镜像 + 状态日志：`songStatus`
 *
 * 这里只留：
 *   ① 容量与格子（转发 broadcastSlot）
 *   ② 占用统计、候补快照、学生端状态卡（读路径，宽容失败）
 *
 * ═══════════════ 云化改动 ═══════════════
 * ① **不移植进程内定时器**（`startScheduler` / `stopScheduler` / `tick`）。
 *    云函数没有常驻进程，原来那个「每分钟 sweep + 标记播放」的 setInterval 必须改成
 *    **云开发定时触发器**（阶段 6）。保留同名的空壳会让部署者误以为兜底还在跑 ——
 *    所以干脆不导出，改为在阶段 6 建触发器函数来调 `scheduling.sweep`。
 * ② **不移植一批 `@deprecated` 兼容壳**（decideSeat / promote / closeQueueIfFull /
 *    runAfterRelease / finalizeDueWeeks / sweepAll / queuePosOf / countQueued）。
 *    源文件自己标注「旧调用点还没改完时不至于崩，新代码一律直接调 songSchedulingService」；
 *    云版是全新代码，没有「旧调用点」，搬过去只会把 v2 语义留在云上。
 * ③ 三处 `Submit.findAll({ group })` → countByField；普通全量 → findAllPaged。
 */

const { C, count } = require('../lib/db');
const bj = require('../lib/bjTime');
const slotSvc = require('./broadcastSlot');
const songWindow = require('./songWindow');
const S = require('./songStatus');
const sched = require('./scheduling');

const DAYS_PER_WEEK = sched.DAYS_PER_WEEK;
const ST = S.ST;
/** 占正式位的状态（镜像口径）：已排期 / 已播放 */
const SEATED_STATUS = [ST.SCHEDULED, ST.PLAYED];
/** @deprecated 协议版没有全局候补人数上限（审核通过的人就该能排队） */
const KV_QUEUE_LIMIT = 'song_queue_limit';
const KV_GATE = 'song_finalize_gate';
/** @deprecated 协议版由 songStatus.SYSTEM_REASON 与 scheduling 接管 */
const SYSTEM_REASON = S.SYSTEM_REASON;

/* ------------------------------------------------------------------ *
 * 转发：时间 / 周 / 格子 / 容量
 * ------------------------------------------------------------------ */
const datePartOf = sched.datePartOf;
const weekStartOfValue = sched.weekStartOfValue;
const weekStartOfRow = sched.weekStartOfRow;
const slotValuesOfWeek = sched.slotValuesOfWeek;
const getCapacity = sched.getCapacity;
const weekCapacity = sched.weekCapacity;
const isSeated = sched.isSeated;

/** 该播出周的排期锁定时刻（原 v2 的「窗口结束 = 审核截止」，协议版挪到锁定时刻） */
async function lockAtOfWeek(weekStartMs, now = Date.now()) {
  const week = await sched.ensureWeek(weekStartMs, { now });
  return week.scheduleLockAt ? new Date(+new Date(week.scheduleLockAt)) : null;
}

/** @deprecated 保留旧名，语义改为「锁定时刻（= 审核截止）」 */
async function windowEndOfWeek(cfg, weekStartMs) {
  const week = await sched.ensureWeek(weekStartMs, Date.now());
  if (week.scheduleLockAt) return new Date(+new Date(week.scheduleLockAt));
  const rng = await songWindow.anchorRangeAt(cfg, weekStartMs - 1000);
  return rng.reviewAt;
}

/* ------------------------------------------------------------------ *
 * 计数 / 快照
 * ------------------------------------------------------------------ */
const countSeated = sched.countSeated;
const countSeatedBySlot = sched.countSeatedBySlot;

/** 候补人数：审核通过但还没拿到位置 */
async function countWaiting() {
  return count(C.SUBMIT, { type: 1, reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.WAITING });
}

/**
 * 一个格子的实时占用（学生端时段列表 / 管理端矩阵用）
 * 读路径，失败按空处理，不能让列表整个挂掉
 */
async function slotUsage(values = [], now = Date.now()) {
  const capacity = await getCapacity();
  let seatedMap = {};
  try { seatedMap = await countSeatedBySlot(values); } catch (e) { seatedMap = {}; }
  const out = {};
  values.forEach((v) => {
    const seated = seatedMap[v] || 0;
    out[v] = {
      capacity,
      seated,
      left: capacity > 0 ? Math.max(0, capacity - seated) : null,
      full: capacity > 0 && seated >= capacity,
    };
  });
  return out;
}

/** 管理端候补队列快照（当前目标周） */
async function snapshot(now = Date.now()) {
  const { start } = bj.nextWeekRange(now);
  const capacity = await getCapacity();
  const week = await sched.ensureWeek(start.getTime(), { now });
  const waiting = await sched.waitingSnapshot(start.getTime(), now)
    .catch(() => ({ total: 0, items: [], freeSlots: [], hasFree: false }));
  const head = waiting.items[0];
  return {
    capacity,
    weekId: week.id,
    weekStartDate: week.weekStartDate,
    week: sched.weekView(week, now),
    // 协议版没有候补人数上限
    limit: 0,
    limitAuto: true,
    weekCapacity: await weekCapacity(now),
    total: waiting.total,
    full: false,
    freeSlots: waiting.freeSlots,
    hasFree: waiting.hasFree,
    headWaitMinutes: head && head.submittedAt
      ? Math.max(0, Math.round((now - +new Date(head.submittedAt)) / 60000))
      : null,
    items: waiting.items,
  };
}

/** 全量快照（管理端 /capacity 用）：目标周 + 候补 + 锁定时刻 */
async function capacitySnapshot(now = Date.now()) {
  const slots = await slotSvc.getSlots(now);
  const weekStartMs = slots.list.length
    ? weekStartOfValue(slots.list[0].value).getTime()
    : bj.nextWeekRange(now).start.getTime();
  const week = await sched.ensureWeek(weekStartMs, { now });
  const [snap, win] = await Promise.all([snapshot(now), songWindow.status(now)]);
  const lockAt = week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null;
  return {
    capacity: snap.capacity,
    weekCapacity: snap.weekCapacity,
    queue: snap,
    week: sched.weekView(week, now),
    window: win,
    lockAt,
    /** @deprecated 旧字段名（= 锁定时刻），前端改造前先用着 */
    finalizeAt: lockAt,
  };
}

/* ------------------------------------------------------------------ *
 * 学生端状态卡（候补中 / 已排期 / 被调剂 / 已驳回）
 * ------------------------------------------------------------------ */
/**
 * 每条点歌一张卡；不需要卡的状态返回 null（普通行渲染）
 * 与旧版三形态卡的差别：现在是**四形态** —— 多一个「已通过 · 待排期」。
 */
async function cardFor(row, now = Date.now()) {
  const review = Number(row.reviewStatus) || 0;
  const schedule = Number(row.scheduleStatus) || 0;
  const play = Number(row.playStatus) || 0;

  const win = await songWindow.status(now).catch(() => null);
  void win;
  const ws = weekStartOfRow(row);
  let lockAt = null;
  if (ws) {
    const week = await sched.ensureWeek(ws.getTime(), { now }).catch(() => null);
    if (week && week.scheduleLockAt) lockAt = songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt)));
  }

  // ① 审核通过 · 还没排期（短暂中间态）
  if (review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.UNASSIGNED) {
    return {
      type: 'schedule',
      status: 'pending_schedule',
      preferred: row.wantBroadcastTime || null,
      lockAt,
      hint: '审核已通过，等待排期——排期按「首选时段 + 提交时间先后」自动分配正式位置',
      actions: [],
    };
  }

  // ② 候补中
  if (review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.WAITING) {
    const { pos, ahead, total } = await sched.waitingPosOf(row).catch(() => ({ pos: 1, ahead: 0, total: 1 }));
    return {
      type: 'queue',
      status: 'waiting',
      queuePos: pos,
      aheadCount: ahead,
      queueUsed: total,
      queueLimit: 0,
      preferred: row.wantBroadcastTime || null,
      allowReschedule: Number(row.allowReschedule) !== 0,
      lockAt,
      finalizeAt: lockAt,
      hint: Number(row.allowReschedule) !== 0
        ? '首选时段已满，正在候补。有空位时按提交先后自动补位，也允许被调剂到别的时段'
        : '首选时段已满，正在候补。你不接受调剂，只有首选时段出现空位时才会补上',
      actions: [{ key: 'leave', label: '放弃候补' }],
    };
  }

  // ③ 已排期 / 已播放
  if (review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.APPROVED) {
    const target = row.scheduledSlot || row.wantBroadcastTime;
    const changed = !!(row.wantBroadcastTime && row.scheduledSlot && row.wantBroadcastTime !== row.scheduledSlot);
    return {
      type: 'schedule',
      status: play === S.PLAY.PLAYED ? 'played' : 'scheduled',
      scheduledSlot: target,
      preferred: row.wantBroadcastTime || null,
      changed,
      lockAt,
      hint: changed
        ? `你首选的是「${row.wantBroadcastTime}」，该时段已满，系统把你调剂到了「${target}」`
        : (play === S.PLAY.PLAYED ? '已安排播出' : '已排期，等待播出'),
      actions: [],
    };
  }

  // ④ 未排上 / 被驳回（系统或人工）
  if (review === S.REVIEW.REJECTED || schedule === S.SCHEDULE.AUTO_REJECTED) {
    return {
      type: 'schedule',
      status: 'failed',
      systemRejected: review !== S.REVIEW.REJECTED || Number(row.autoRejected) === 1,
      reason: row.rejectReason || '本次未排上',
      preferred: row.wantBroadcastTime || null,
      actions: [],
    };
  }

  // ⑤ 待审核：不特殊渲染
  return null;
}

/** @deprecated 协议版候补无上限 */
async function getQueueLimit() { return { limit: 0, auto: true }; }

module.exports = {
  ST,
  SEATED_STATUS,
  KV_QUEUE_LIMIT,
  KV_GATE,
  SYSTEM_REASON,
  DAYS_PER_WEEK,
  // 时间与格子
  datePartOf,
  weekStartOfValue,
  weekStartOfRow,
  slotValuesOfWeek,
  lockAtOfWeek,
  windowEndOfWeek,
  // 容量
  getCapacity,
  weekCapacity,
  getQueueLimit,
  // 计数
  countSeated,
  countSeatedBySlot,
  countWaiting,
  slotUsage,
  isSeated,
  // 快照 / 卡片
  snapshot,
  capacitySnapshot,
  cardFor,
};
