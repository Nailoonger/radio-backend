'use strict';

/**
 * 点歌排期算法（协议文档「十六、执行第一轮排期」「十七、执行全局调剂」「十八、正式锁定」）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一句话：**审核通过 ≠ 拿到位置**。
 *
 *   用户提交      → PENDING_REVIEW（不看容量，谁都能投）
 *   审核通过      → review=APPROVED / schedule=UNASSIGNED（进排期候选池）
 *   第一轮排期    → 按「首选时段」分组，组内 submitted_at 早的占前 capacity 个
 *                   占上的 → schedule=APPROVED（assigned_slot = 首选）
 *                   没占上 → schedule=WAITING（候补）
 *   原位递补      → 首选时段出现空位 → WAITING 按提交时间递补
 *   全局调剂      → 首选已满，但别处有空位 → 允许调剂的人被安排过去
 *   锁定          → 跑最后一次调度，仍是 WAITING 的 → AUTO_REJECTED
 *
 * 算法全部集中在本文件，**不许散落到 Controller 里**（协议 §23）：
 * 想改「提交时间早的优先」为「每天最多一首」，只动这里。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 与协议的两处**有意偏离**（写清楚，别被后人当 bug 改回去）：
 *   ① 没有 `schedule_slots` 表和 `schedule_slot_id` 外键 —— 格子由
 *      `broadcastSlotService` 从 KV 配置派生，slot 的身份就是它的**值字符串**
 *      （`2026-09-21 午间 12:20`）。再建一张配置表 = 又多一本账，
 *      而 v1 的名额泄漏正是「两本账」造成的。
 *   ② 每格容量沿用全局 KV（`song_slot_capacity`），不做「每格单独容量」。
 *      协议示例里的 capacity=3 是同一语义，只是没有按格拆分。
 */

const { Op } = require('sequelize');
const { Submit, WeeklySchedule, AssignmentLog } = require('../models');
const bj = require('../utils/bjTime');
const kv = require('./kvService');
const slotSvc = require('./broadcastSlotService');
const songWindow = require('./songWindowService');
const costCalc = require('./songRescheduleCost');
const S = require('./songStatusService');
const logger = require('../utils/logger');

const DAYS_PER_WEEK = 5;                    // 周一到周五
const KV_LOCK_OFFSET = 'song_lock_offset_minutes';
const DEFAULT_LOCK_OFFSET_MINUTES = 360;    // 窗口结束后 6h → 播出周周一 00:00

const WEEK_STATUS = {
  DRAFT: 'DRAFT',
  APPLICATION: 'APPLICATION',
  REVIEW: 'REVIEW',
  SCHEDULING: 'SCHEDULING',
  LOCKED: 'LOCKED',
  CANCELLED: 'CANCELLED',
};
const WEEK_STATUS_CN = {
  DRAFT: '未发布',
  APPLICATION: '收歌中',
  REVIEW: '审核中',
  SCHEDULING: '排期已生成',
  LOCKED: '已锁定',
  CANCELLED: '已取消',
};

const ASSIGN = {
  INITIAL: 'INITIAL',
  PROMOTED: 'PROMOTED',
  RESCHEDULED: 'RESCHEDULED',
  MANUAL: 'MANUAL',
  RELEASED: 'RELEASED',
};
const ASSIGN_REASON = {
  INITIAL: 'INITIAL_ALLOCATION',
  originalFull: 'ORIGINAL_SLOT_FULL',
  slotReleased: 'SLOT_RELEASED',
  manual: 'MANUAL',
};

/* ------------------------------------------------------------------ *
 * 时间 / 周 / 格子
 * ------------------------------------------------------------------ */
/** 从 "2026-09-21 午间 12:20" 里取出日期串 */
function datePartOf(value) {
  const m = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

/** 时段值 → 绝对时刻（播出时间点），解析不出返回 null */
function instantOfValue(value) {
  const d = datePartOf(value);
  if (!d) return null;
  const tm = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!tm) return null;
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day, Number(tm[1]), Number(tm[2])) - bj.TZ_OFFSET_MS;
}

/** 某个时段值所属播出周的周一 00:00（北京时间，绝对时刻） */
function weekStartOfValue(value) {
  const d = datePartOf(value);
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  // Date.UTC(y,m-1,day) = 北京时间当天 08:00，落在同一天，weekRange 归属正确
  return bj.weekRange(Date.UTC(y, m - 1, day)).start;
}

/** 某行的归属周：优先实际排期时段，退回首选时段，最后退回提交时刻所在周的下一周 */
function weekStartOfRow(row) {
  return weekStartOfValue(row.scheduledSlot)
    || weekStartOfValue(row.wantBroadcastTime)
    || bj.nextWeekRange(row.queueAt ? +new Date(row.queueAt) : (row.createTime ? +new Date(row.createTime) : Date.now())).start;
}

/** 周内全部格子值（5 天 × N 时段） */
async function slotValuesOfWeek(weekStartMs) {
  const periods = await slotSvc.getPeriods();
  const out = [];
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const dateStr = bj.ymd(bj.shifted(weekStartMs + i * bj.DAY_MS));
    periods.forEach((p) => out.push(`${dateStr} ${p.period} ${p.time}`));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 容量 / 占位口径
 * ------------------------------------------------------------------ */
async function getCapacity() {
  return slotSvc.getCapacity();
}

/** 下周正式位总数（capacity = 0 时为 0，表示不限） */
async function weekCapacity(now = Date.now()) {
  const capacity = await getCapacity();
  if (!(capacity > 0)) return 0;
  const periods = await slotSvc.getPeriods(now);
  return DAYS_PER_WEEK * periods.length * capacity;
}

/** 占位口径：审核通过 **且** 排期通过 —— 只有这样的行才真的占着格子 */
function seatedWhere(extra = {}) {
  return {
    type: 1,
    reviewStatus: S.REVIEW.APPROVED,
    scheduleStatus: S.SCHEDULE.APPROVED,
    ...extra,
  };
}

async function countSeated(slotValue) {
  return Submit.count({ where: seatedWhere({ scheduledSlot: slotValue }) });
}

/** 批量取各格已占数 → { slotValue: n } */
async function countSeatedBySlot(values) {
  if (!values.length) return {};
  const { fn, col } = require('sequelize');
  const rows = await Submit.findAll({
    where: seatedWhere({ scheduledSlot: { [Op.in]: values } }),
    attributes: ['scheduledSlot', [fn('COUNT', col('id')), 'n']],
    group: ['scheduledSlot'],
    raw: true,
  });
  const out = {};
  rows.forEach((r) => { out[r.scheduledSlot] = Number(r.n) || 0; });
  return out;
}

/** 一行是否占着正式位（镜像口径的判据） */
function isSeated(row) {
  return Number(row.reviewStatus) === S.REVIEW.APPROVED
    && Number(row.scheduleStatus) === S.SCHEDULE.APPROVED;
}

/* ------------------------------------------------------------------ *
 * 周（weekly_schedule）：懒创建 + 状态推进
 * ------------------------------------------------------------------ */
async function getLockOffsetMinutes() {
  try {
    const n = parseInt(await kv.get(KV_LOCK_OFFSET, ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOCK_OFFSET_MINUTES;
  } catch (e) {
    return DEFAULT_LOCK_OFFSET_MINUTES;
  }
}

/**
 * 时间锚点全部由 KV 点歌窗口派生 —— 沿用「窗口规则不变」的决定，
 * 不额外引入一套管理员要维护的申请时间配置。
 */
async function anchorOf(weekStartMs, now = Date.now()) {
  const cfg = await songWindow.getConfig(now);
  // 传「周一前 1 秒」，nextWeekRange 正好指向这一周
  const rng = songWindow.windowRangeAt(cfg, weekStartMs - 1000);
  const offset = await getLockOffsetMinutes();
  return {
    applicationStartAt: rng.start,
    applicationEndAt: rng.end,
    reviewStartAt: rng.end,
    scheduleLockAt: new Date(rng.end.getTime() + offset * 60 * 1000),
    reviewEndAt: new Date(rng.end.getTime() + offset * 60 * 1000),
  };
}

/** 按时间派生周状态（只推进「还没进排期」的那些周） */
function deriveWeekStatus(week, now) {
  if ([WEEK_STATUS.LOCKED, WEEK_STATUS.CANCELLED, WEEK_STATUS.SCHEDULING].includes(week.status)) {
    return week.status;
  }
  const start = week.applicationStartAt ? +new Date(week.applicationStartAt) : 0;
  const end = week.applicationEndAt ? +new Date(week.applicationEndAt) : 0;
  if (now < start) return WEEK_STATUS.DRAFT;
  if (now < end) return WEEK_STATUS.APPLICATION;
  return WEEK_STATUS.REVIEW;
}

/**
 * 取（必要时创建）某个播出周的排期行。
 * 懒创建：不需要管理员先「创建下周排期」，第一次有人提到这一周就自动建。
 */
async function ensureWeek(weekStartMs, { now = Date.now(), createdBy = null, transaction } = {}) {
  const dateStr = bj.ymd(bj.shifted(weekStartMs));
  let week = await WeeklySchedule.findOne({ where: { weekStartDate: dateStr }, transaction });
  if (!week) {
    const anchor = await anchorOf(weekStartMs, now);
    try {
      week = await WeeklySchedule.create(
        { weekStartDate: dateStr, ...anchor, status: WEEK_STATUS.DRAFT, createdBy },
        { transaction }
      );
    } catch (e) {
      // 并发下另一个请求刚建好 → 重新取，别报错
      week = await WeeklySchedule.findOne({ where: { weekStartDate: dateStr }, transaction });
      if (!week) throw e;
    }
  }
  const next = deriveWeekStatus(week, now);
  if (next !== week.status) week = await week.update({ status: next }, { transaction });
  return week;
}

/** 按某个时段值拿它所属周的排期行 */
async function ensureWeekOfValue(value, opts = {}) {
  const ws = weekStartOfValue(value);
  if (!ws) return null;
  return ensureWeek(ws.getTime(), opts);
}

/** 周行里的 `week_start_date`（DATEONLY 字符串）→ 该周一 00:00 的绝对时刻 */
function msOfWeekStartDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 北京时间周一 00:00 → UTC 时刻
  return Date.UTC(y, mo - 1, d) - bj.TZ_OFFSET_MS;
}

/** 周状态的中文名 + 展示块（接口直接用） */
function weekView(week, now = Date.now()) {
  const start = week.applicationStartAt ? +new Date(week.applicationStartAt) : null;
  const end = week.applicationEndAt ? +new Date(week.applicationEndAt) : null;
  const lock = week.scheduleLockAt ? +new Date(week.scheduleLockAt) : null;
  return {
    id: week.id,
    weekStartDate: week.weekStartDate,
    status: week.status,
    statusText: WEEK_STATUS_CN[week.status] || week.status,
    applicationStartAt: start ? songWindow.toBjsIso(new Date(start)) : null,
    applicationEndAt: end ? songWindow.toBjsIso(new Date(end)) : null,
    reviewStartAt: week.reviewStartAt ? songWindow.toBjsIso(new Date(+new Date(week.reviewStartAt))) : null,
    scheduleLockAt: lock ? songWindow.toBjsIso(new Date(lock)) : null,
    lockedAt: week.lockedAt ? songWindow.toBjsIso(new Date(+new Date(week.lockedAt))) : null,
    lockText: lock ? songWindow.toBjsIso(new Date(lock)) : null,
    secondsToLock: lock ? Math.max(0, Math.round((lock - now) / 1000)) : null,
    canApply: week.status === WEEK_STATUS.APPLICATION,
    locked: week.status === WEEK_STATUS.LOCKED,
  };
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */
async function logAssignment(requestId, fromSlot, toSlot, type, reason, operatorId = null, transaction) {
  try {
    await AssignmentLog.create(
      { requestId, fromSlot: fromSlot || null, toSlot: toSlot || null, assignmentType: type, reason: reason || null, operatorId },
      { transaction }
    );
  } catch (e) {
    logger.warn(`[songSchedule] 排期日志写入失败 #${requestId}：${e.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * ① 第一轮排期 InitialAllocator
 * ------------------------------------------------------------------ */
/**
 * 对每个时段：取「审核已通过 + 还没排期 + 首选就是这一格」的候选，
 * 按提交时间升序，前 capacity 个拿到正式位，其余进 WAITING。
 *
 * 幂等：候选条件带 scheduleStatus = UNASSIGNED，重复跑只命中更少行。
 * @returns {Promise<{assigned:number, waiting:number, weeks:number}>}
 */
async function initialAllocate(weekStartMs, { now = Date.now(), operatorId = null, transaction, dryRun = false } = {}) {
  const week = await ensureWeek(weekStartMs, { now, transaction });
  const values = await slotValuesOfWeek(weekStartMs);
  const capacity = await getCapacity();
  const res = { weekId: week.id, assigned: 0, waiting: 0, actions: [] };

  const counters = await countSeatedBySlot(values);

  for (const value of values) {
    let left = capacity > 0 ? Math.max(0, capacity - (counters[value] || 0)) : Infinity;

    const candidates = await Submit.findAll({
      where: {
        type: 1,
        reviewStatus: S.REVIEW.APPROVED,
        scheduleStatus: S.SCHEDULE.UNASSIGNED,
        wantBroadcastTime: value,
      },
      order: [['create_time', 'ASC'], ['id', 'ASC']],
      transaction,
    });
    if (!candidates.length) continue;

    for (const row of candidates) {
      if (left > 0) {
        if (dryRun) {
          res.actions.push({ action: 'ASSIGN', id: row.id, songName: row.songName, want: value, to: value, cost: 0 });
        } else {
          const r = await S.applyChange(row, {
            scheduleStatus: S.SCHEDULE.APPROVED,
            scheduledSlot: value,
            assignedAt: new Date(now),
          }, { transaction, operatorId, operatorName: operatorId ? 'ADMIN' : 'SYSTEM', reason: S.SYSTEM_REASON.initial });
          if (r.logs.length) await logAssignment(row.id, null, value, ASSIGN.INITIAL, ASSIGN_REASON.INITIAL, operatorId, transaction);
        }
        res.assigned += 1;
        if (left !== Infinity) left -= 1;
      } else {
        if (dryRun) {
          res.actions.push({ action: 'WAITING', id: row.id, songName: row.songName, want: value, to: null, cost: null });
          res.waiting += 1;
        } else {
          const r = await S.applyChange(row, { scheduleStatus: S.SCHEDULE.WAITING }, {
            transaction, operatorId, operatorName: 'SYSTEM', reason: 'ORIGINAL_SLOT_FULL',
          });
          if (r.logs.length) res.waiting += 1;
        }
      }
    }
  }

  if (!dryRun) {
    if (week.status !== WEEK_STATUS.LOCKED && week.status !== WEEK_STATUS.CANCELLED) {
      await week.update({ status: WEEK_STATUS.SCHEDULING }, { transaction });
    }
    logger.info(`[songSchedule] 第一轮排期 周${week.weekStartDate}：落座 ${res.assigned}、候补 ${res.waiting}`);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * ② 全局调剂 RescheduleAllocator
 * ------------------------------------------------------------------ */
/**
 * 收歌是否已截止 —— 决定这一周能不能**跨时段**调剂。
 *
 * ⚠️ 这是「保证每个时段原先申请者的排期」的关键闸门。
 *   收歌窗口内（`applicationEndAt` 之前）还有新申请在进来、还有人没审完，
 *   此时周内任何一个空位都**可能**属于某个「首选那一格」的原申请者。
 *   若此刻就把候补的人跨时段排过去，等那个人审完就没位置了 ——
 *   而且被挪走的人已变成 APPROVED，再也回不到首选格。
 *   → 收歌截止前只允许**原位递补**，截止后才放开跨时段。
 *
 * `lockWeek()`（锁定前最后调度）与超管手动「执行排期」显式传 `crossSlot: true`，
 * 不受这个闸门限制。
 */
function canCrossSlot(week, now = Date.now()) {
  const end = week && week.applicationEndAt ? +new Date(week.applicationEndAt) : 0;
  return end > 0 && now >= end;
}

/**
 * 协议 §17：执行全局调剂
 *   1. 获取所有空位
 *   2. 候选 = 审核通过 + WAITING
 *   3. 排序：可接受位置少的优先 → 提交时间早的优先 → 距原时段近的优先
 *   4. 分配并写 assignment_logs
 *
 * 「距原时段近」用《V1 规格》第 10 节的**成本表**（`songRescheduleCost`）：
 *   同一天其他时段 10 / 前后一天相同时段 20 / 前后一天其他时段 30 / 更远日期 50。
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.crossSlot] true=允许跨时段，false=只做原位递补，
 *                                   null / 省略 = 按「收歌是否已截止」自动判断
 * @param {boolean} [opts.dryRun]    只算不写库（模拟排期预览），动作清单在 actions 里
 * @returns {Promise<{weekId, promoted, rescheduled, left, crossSlot, actions}>}
 */
async function reschedule(weekStartMs, { now = Date.now(), operatorId = null, transaction, crossSlot = null, dryRun = false } = {}) {
  const week = await ensureWeek(weekStartMs, { now, transaction });
  const values = await slotValuesOfWeek(weekStartMs);
  const capacity = await getCapacity();
  const indexOf = new Map(values.map((v, i) => [v, i]));
  const allowCross = crossSlot === null ? canCrossSlot(week, now) : !!crossSlot;
  const res = { weekId: week.id, promoted: 0, rescheduled: 0, left: 0, crossSlot: allowCross, actions: [] };

  const counters = await countSeatedBySlot(values);
  const free = new Set(
    capacity > 0 ? values.filter((v) => (counters[v] || 0) < capacity) : values
  );

  const candidates = await Submit.findAll({
    where: {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: { [Op.in]: values },
    },
    order: [['create_time', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  if (!candidates.length) return res;

  /**
   * 这一行**可接受**的落点（每次重算，因为 free 在循环里会变小）：
   *   允许跨时段 且 本人接受调剂 → 周内所有空位
   *   否则                       → 只有「首选格还空着」这一个选项（原位递补）
   */
  const acceptableOf = (row) => {
    const want = row.wantBroadcastTime;
    const allow = Number(row.allowReschedule) !== 0;
    if (allow && allowCross) return [...free];
    return free.has(want) ? [want] : [];
  };

  // 排序键用当前 free 快照算；分配过程中 free 会变小，但顺序一次定死，避免不可复现
  const decorated = candidates.map((row) => {
    const want = row.wantBroadcastTime;
    const acceptable = acceptableOf(row);
    const best = acceptable.length
      ? acceptable.reduce((m, v) => Math.min(m, costCalc.costBetween(want, v)), Infinity)
      : Infinity;
    return {
      row,
      want,
      acceptableCount: acceptable.length,
      cost: best,
      at: +new Date(row.createTime || 0),
    };
  });
  decorated.sort((a, b) => {
    if (a.acceptableCount !== b.acceptableCount) return a.acceptableCount - b.acceptableCount; // 可接受位少 → 先安排
    if (a.at !== b.at) return a.at - b.at;                                                      // 提交早 → 先安排
    const c = costCalc.compareCost(a.cost, b.cost);
    if (c) return c;                                                                            // 离原时段近 → 先安排
    return Number(a.row.id) - Number(b.row.id);
  });

  for (const item of decorated) {
    const { row, want } = item;
    const options = acceptableOf(row);
    if (!options.length) {
      res.left += 1;
      if (dryRun) res.actions.push({ action: 'WAITING', id: row.id, songName: row.songName, want, to: null, cost: null });
      continue;
    }

    const target = costCalc.pickBest(options, want, indexOf);
    const isSame = target === want;

    if (dryRun) {
      res.actions.push({
        action: isSame ? 'PROMOTE' : 'RESCHEDULE',
        id: row.id,
        songName: row.songName,
        want,
        to: target,
        cost: costCalc.describeCost(want, target).cost,
      });
    } else {
      const r = await S.applyChange(row, {
        scheduleStatus: S.SCHEDULE.APPROVED,
        scheduledSlot: target,
        assignedAt: new Date(now),
      }, {
        transaction,
        operatorId,
        operatorName: operatorId ? 'ADMIN' : 'SYSTEM',
        reason: isSame ? S.SYSTEM_REASON.rescheduleOk : ASSIGN_REASON.originalFull,
      });
      if (!r.logs.length) continue;              // 并发被别人改过 → 跳过

      await logAssignment(
        row.id, want, target,
        isSame ? ASSIGN.PROMOTED : ASSIGN.RESCHEDULED,
        isSame ? S.SYSTEM_REASON.rescheduleOk : ASSIGN_REASON.originalFull,
        operatorId, transaction
      );
    }
    if (isSame) res.promoted += 1; else res.rescheduled += 1;

    if (capacity > 0) {
      counters[target] = (counters[target] || 0) + 1;
      if (counters[target] >= capacity) free.delete(target);
    }
  }

  if (!dryRun && (res.promoted || res.rescheduled)) {
    logger.info(`[songSchedule] 调剂 周${week.weekStartDate}${allowCross ? '' : '（收歌未截止·仅原位递补）'}：原位递补 ${res.promoted}、跨时段调剂 ${res.rescheduled}、仍未安排 ${res.left}`);
  }
  return res;
}

/** 释放位子之后统一调用：原位递补 + 全局调剂（幂等） */
async function runAllocators(weekStartMs, opts = {}) {
  try {
    const r = await reschedule(weekStartMs, opts);
    return r;
  } catch (e) {
    logger.warn(`[songSchedule] 调剂失败（下次审核 / 手动 sweep 会重试）：${e.message}`);
    return { promoted: 0, rescheduled: 0, left: 0, error: e.message };
  }
}

/** 释放某条记录占的位子 → 对归属周跑一次调剂 */
async function afterRelease(row, opts = {}) {
  const ws = weekStartOfRow(row);
  if (!ws) return { promoted: 0, rescheduled: 0, left: 0 };
  return runAllocators(ws.getTime(), opts);
}

/* ------------------------------------------------------------------ *
 * ③ 锁定 Lock
 * ------------------------------------------------------------------ */
/**
 * 协议 §18：正式锁定
 *   检查是否到锁定时间 → 执行最后一次调度 → WAITING → AUTO_REJECTED → 周 = LOCKED
 *
 * 这样就不会出现「系统还有空位，管理员先点了锁定」的问题（那样会白白浪费位置）。
 * @param {object} opts.force 手动提前锁定（管理员点了「立即锁定」）
 */
async function lockWeek(weekStartMs, { now = Date.now(), operatorId = null, force = false } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  if (week.status === WEEK_STATUS.LOCKED) return { ...weekView(week, now), already: true, rejected: 0 };

  const lockAt = week.scheduleLockAt ? +new Date(week.scheduleLockAt) : 0;
  if (!force && lockAt && now < lockAt) {
    return { ...weekView(week, now), already: false, tooEarly: true, rejected: 0 };
  }

  // 最后一次调度：把还能塞进空位的人都塞进去
  // 锁定时**显式**放开跨时段 —— 到了这一步收歌早已截止，不可能再有新申请者
  await initialAllocate(weekStartMs, { now, operatorId });
  const alloc = await reschedule(weekStartMs, { now, operatorId, crossSlot: true });

  // 剩下仍是 WAITING 的 → AUTO_REJECTED
  const values = await slotValuesOfWeek(weekStartMs);
  const waiting = await Submit.findAll({
    where: {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      [Op.or]: [
        { wantBroadcastTime: { [Op.in]: values } },
        { scheduledSlot: { [Op.in]: values } },
      ],
    },
  });
  let rejected = 0;
  for (const row of waiting) {
    const r = await S.applyChange(row, {
      scheduleStatus: S.SCHEDULE.AUTO_REJECTED,
      rejectReason: S.SYSTEM_REASON.lockedNoSlot,
      autoRejected: 1,
      reviewTime: new Date(now),
    }, { operatorName: 'SYSTEM', reason: 'SCHEDULE_LOCKED_NO_AVAILABLE_SLOT' });
    if (r.logs.length) rejected += 1;
  }

  await week.update({ status: WEEK_STATUS.LOCKED, lockedAt: new Date(now) });
  logger.info(`[songSchedule] 周 ${week.weekStartDate} 已锁定：最后调度 ${alloc.promoted + alloc.rescheduled} 条，无位自动驳回 ${rejected} 条`);
  return { ...weekView(await WeeklySchedule.findByPk(week.id), now), already: false, rejected, lastAlloc: alloc };
}

/** 取消某一周的排期（管理员操作，未开始播出的周） */
async function cancelWeek(weekStartMs, { now = Date.now(), operatorId = null } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  if (week.status === WEEK_STATUS.LOCKED) {
    throw Object.assign(new Error('这一周已经锁定，不能取消'), { code: 40001 });
  }
  await week.update({ status: WEEK_STATUS.CANCELLED });
  return weekView(week, now);
}

/* ------------------------------------------------------------------ *
 * ④ 播放标记
 * ------------------------------------------------------------------ */
/**
 * 播出时刻已过的「已排期」→ 已播放（幂等）
 * 播出时刻 = 时段值里的日期 + 时刻（北京时间）
 */
async function markPlayed({ now = Date.now() } = {}) {
  const rows = await Submit.findAll({
    where: { type: 1, reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.APPROVED, playStatus: S.PLAY.NOT_PLAYED },
    attributes: ['id', 'scheduledSlot'],
    raw: true,
  });
  const due = [];
  rows.forEach((r) => {
    const t = instantOfValue(r.scheduledSlot);
    if (t !== null && now >= t) due.push(r.id);
  });
  if (!due.length) return { played: 0 };
  const [n] = await Submit.update(
    S.patchWithDerivedStatus({
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.APPROVED,
      playStatus: S.PLAY.PLAYED,
      playedAt: new Date(now),
    }),
    { where: { id: { [Op.in]: due } } }
  );
  if (n) logger.info(`[songSchedule] 标记已播放 ${n} 条`);
  return { played: n };
}

/** 管理员手动标记某条为已播放 / 取消已播放 */
async function setPlayed(row, played, { now = Date.now(), operatorId = null } = {}) {
  return S.applyChange(row, {
    playStatus: played ? S.PLAY.PLAYED : S.PLAY.NOT_PLAYED,
    playedAt: played ? new Date(now) : null,
  }, { operatorId, operatorName: played ? 'SYSTEM' : 'ADMIN', reason: 'MANUAL' });
}

/* ------------------------------------------------------------------ *
 * ⑤ 人工调整（协议 §20）
 * ------------------------------------------------------------------ */
/**
 * 管理员手工把某条点歌放到某个时段（不可逆动作不会破坏历史链：照写 assignment_log）
 */
async function manualAssign(row, targetSlot, { now = Date.now(), operatorId = null, reason = ASSIGN_REASON.manual } = {}) {
  const values = await slotValuesOfWeek(weekStartOfValue(targetSlot).getTime());
  if (!values.includes(targetSlot)) {
    throw Object.assign(new Error('目标时段不属于任何一个可选播出周'), { code: 40001 });
  }
  const from = row.scheduledSlot || null;
  const r = await S.applyChange(row, {
    reviewStatus: S.REVIEW.APPROVED,
    scheduleStatus: S.SCHEDULE.APPROVED,
    scheduledSlot: targetSlot,
    assignedAt: new Date(now),
  }, { operatorId, operatorName: 'ADMIN', reason });
  await logAssignment(row.id, from, targetSlot, ASSIGN.MANUAL, reason, operatorId);
  return r;
}

/* ------------------------------------------------------------------ *
 * ⑥ 兜底 sweep（管理端手动触发 / 定时器）
 * ------------------------------------------------------------------ */
/**
 * 全量兜底（幂等）：
 *   ① 对每个「还有活着的点歌」的周：跑第一轮排期 + 调剂
 *   ② 到锁定时刻的周 → 锁定（最后调度 + AUTO_REJECTED）
 *   ③ 播出时刻已过的 → 标记已播放
 *
 * ⚠️ 第 ② 步必须**独立于第 ① 步**扫一遍 `weekly_schedule`：
 *    如果只看「还有 UNASSIGNED/WAITING 的周」，那么「所有点歌早就排好了、
 *    一条候补都不剩」的周永远不会进入循环，也就永远锁不上 ——
 *    而周锁不上，`play_status` 与「排期已定稿」的展示就全都不对。
 */
async function sweep({ now = Date.now(), operatorId = null } = {}) {
  const result = { weeks: [], played: 0 };

  // ── 收集要处理的周 ──
  const weekMsSet = new Set();

  const alive = await Submit.findAll({
    where: { type: 1, scheduleStatus: { [Op.in]: [S.SCHEDULE.UNASSIGNED, S.SCHEDULE.WAITING] } },
    attributes: ['id', 'wantBroadcastTime', 'scheduledSlot', 'createTime'],
    raw: true,
  });
  alive.forEach((r) => {
    const ws = weekStartOfRow(r);
    if (ws) weekMsSet.add(ws.getTime());
  });

  // 已经建了周行、但还没锁定 / 取消的周（不管里面还有没有点歌）
  const openWeeks = await WeeklySchedule.findAll({
    where: { status: { [Op.in]: [WEEK_STATUS.DRAFT, WEEK_STATUS.APPLICATION, WEEK_STATUS.REVIEW, WEEK_STATUS.SCHEDULING] } },
    attributes: ['week_start_date'],
    raw: true,
  });
  openWeeks.forEach((w) => {
    const ms = msOfWeekStartDate(w.week_start_date);
    if (ms !== null) weekMsSet.add(ms);
  });

  for (const wsMs of [...weekMsSet].sort((a, b) => a - b)) {
    const week = await ensureWeek(wsMs, { now });
    const entry = { weekStartDate: week.weekStartDate, weekId: week.id };

    const lockAt = week.scheduleLockAt ? +new Date(week.scheduleLockAt) : 0;
    if (week.status === WEEK_STATUS.CANCELLED) {
      entry.skipped = 'CANCELLED';
    } else if (week.status === WEEK_STATUS.LOCKED) {
      entry.skipped = 'LOCKED';
    } else if (lockAt && now >= lockAt) {
      const r = await lockWeek(wsMs, { now, operatorId });
      entry.locked = !r.already;
      entry.rejected = r.rejected;
    } else {
      const a = await initialAllocate(wsMs, { now, operatorId });
      const b = await reschedule(wsMs, { now, operatorId });
      entry.assigned = a.assigned;
      entry.waiting = a.waiting;
      entry.promoted = b.promoted;
      entry.rescheduled = b.rescheduled;
    }
    result.weeks.push(entry);
  }

  result.played = (await markPlayed({ now })).played;
  return result;
}

/** 候选池 / 候补队列快照（管理端与候补卡用） */
async function waitingSnapshot(weekStartMs, now = Date.now()) {
  const week = await ensureWeek(weekStartMs, { now });
  const allowCross = canCrossSlot(week, now);
  const values = await slotValuesOfWeek(weekStartMs);
  const rows = await Submit.findAll({
    where: {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: { [Op.in]: values },
    },
    order: [['create_time', 'ASC'], ['id', 'ASC']],
  });
  const indexOf = new Map(values.map((v, i) => [v, i]));
  const capacity = await getCapacity();
  const counters = await countSeatedBySlot(values);
  const free = values.filter((v) => (capacity > 0 ? (counters[v] || 0) < capacity : true));

  return {
    total: rows.length,
    items: rows.map((r, i) => ({
      id: r.id,
      openid: r.openid,
      songName: r.songName,
      singer: r.singer,
      wantBroadcastTime: r.wantBroadcastTime,
      allowReschedule: Number(r.allowReschedule) !== 0,
      submittedAt: r.createTime,
      pos: i + 1,
      // 收歌未截止时即使「接受调剂」也去不了别处 —— 只能等首选格自己空出来
      canAccept: free.includes(r.wantBroadcastTime)
        ? 1
        : (Number(r.allowReschedule) !== 0 && allowCross ? free.length : 0),
    })),
    freeSlots: free,
    hasFree: free.length > 0,
    crossSlot: allowCross,
    capacity,
    indexTotal: indexOf.size,
  };
}

/** 某条 WAITING 的位次（同周、同排序键） */
async function waitingPosOf(row) {
  const ws = weekStartOfRow(row);
  if (!ws) return { pos: 1, ahead: 0, total: 1 };
  const values = await slotValuesOfWeek(ws.getTime());
  const rows = await Submit.findAll({
    where: {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: { [Op.in]: values },
    },
    attributes: ['id'],
    order: [['create_time', 'ASC'], ['id', 'ASC']],
    raw: true,
  });
  const i = rows.findIndex((r) => Number(r.id) === Number(row.id));
  const pos = i < 0 ? 1 : i + 1;
  return { pos, ahead: Math.max(0, pos - 1), total: rows.length };
}

module.exports = {
  // 常量
  DAYS_PER_WEEK,
  KV_LOCK_OFFSET,
  DEFAULT_LOCK_OFFSET_MINUTES,
  WEEK_STATUS,
  WEEK_STATUS_CN,
  ASSIGN,
  ASSIGN_REASON,
  // 时间 / 周 / 格子
  datePartOf,
  instantOfValue,
  weekStartOfValue,
  weekStartOfRow,
  slotValuesOfWeek,
  // 容量 / 占位
  getCapacity,
  weekCapacity,
  seatedWhere,
  countSeated,
  countSeatedBySlot,
  isSeated,
  // 周
  anchorOf,
  ensureWeek,
  ensureWeekOfValue,
  weekView,
  msOfWeekStartDate,
  getLockOffsetMinutes,
  // 算法
  canCrossSlot,
  initialAllocate,
  reschedule,
  runAllocators,
  afterRelease,
  lockWeek,
  cancelWeek,
  markPlayed,
  setPlayed,
  manualAssign,
  sweep,
  // 查询
  waitingSnapshot,
  waitingPosOf,
  logAssignment,
};
