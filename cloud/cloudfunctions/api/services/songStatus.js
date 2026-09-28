'use strict';

/**
 * 点歌三维状态 —— 从 src/services/songStatusService.js 移植
 *
 * 一个 status 同时表达「审核结果 + 排期结果 + 播放结果」会越来越乱，所以拆成三个正交维度：
 *
 *   reviewStatus    审核维度   PENDING / APPROVED / REJECTED / CANCELLED
 *   scheduleStatus  排期维度   UNASSIGNED / APPROVED / WAITING / AUTO_REJECTED
 *   playStatus      播放维度   NOT_PLAYED / PLAYED
 *
 * 占位口径：`reviewStatus = APPROVED **且** scheduleStatus = APPROVED` ⟺ 占着一个正式位。
 * 于是「人工驳回」只要把 reviewStatus 置成 REJECTED，位子就自动释放 —— 不可能忘记归还。
 *
 * submit.status 是**派生镜像列**（前端还在用它筛选），由 deriveStatus() 单点计算。
 * ⚠️ 任何改状态的路径都必须走 applyChange()，否则三维与镜像会对不上（新的「两本账」）。
 *
 * ═══════════════ 云化改动（只有一处，但很关键）═══════════════
 * 原实现的乐观锁是 `Submit.update(patch, { where: guard })` 再看 `affectedRows === 0`。
 * 云数据库的 `where().update()` 语义与 SQL 的 `UPDATE ... WHERE` 一致，
 * 所以 **lib/db.js 的 updateWhere() 是它的等价物，这里是逐字级等价移植** ——
 * 并发下「抢晚了导致影响 0 行 → 返回空 logs」的行为原样保留。
 * （云数据库不支持跨文档事务，但这条路径本来也不需要：单条条件 UPDATE 本身就是原子操作。）
 */

const { C, insertOne, updateWhere, findMany, nextId } = require('../lib/db');

/* ------------------------------------------------------------------ *
 * 维度定义
 * ------------------------------------------------------------------ */
const REVIEW = { PENDING: 0, APPROVED: 1, REJECTED: 2, CANCELLED: 3 };
const SCHEDULE = { UNASSIGNED: 0, APPROVED: 1, WAITING: 2, AUTO_REJECTED: 3 };
const PLAY = { NOT_PLAYED: 0, PLAYED: 1 };

const REVIEW_NAME = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'];
const SCHEDULE_NAME = ['UNASSIGNED', 'APPROVED', 'WAITING', 'AUTO_REJECTED'];
const PLAY_NAME = ['NOT_PLAYED', 'PLAYED'];

/** 镜像 status 码（= 前端现有口径 + 四个新增） */
const ST = {
  PENDING: 0,          // 待审核
  SCHEDULED: 1,        // 已排期
  REJECTED: 2,         // 已驳回（人工或系统）
  QUEUED: 3,           // 候补中
  PROMOTED: 4,         // 【保留】v2 的「已补位·待审」，协议版不再产生
  PLAYED: 5,           // 已播放
  APPROVED_WAIT: 6,    // 已通过 · 待排期
  CANCELLED: 7,        // 已取消
};

const STATUS_TEXT = {
  [ST.PENDING]: '待审核',
  [ST.SCHEDULED]: '已排期',
  [ST.REJECTED]: '已驳回',
  [ST.QUEUED]: '候补中',
  [ST.PROMOTED]: '已补位 · 待审核',
  [ST.PLAYED]: '已播放',
  [ST.APPROVED_WAIT]: '已通过 · 待排期',
  [ST.CANCELLED]: '已取消',
};

const SYSTEM_REASON = {
  slotFull: '下周排期已满额，未能补位',
  lockedNoSlot: '排期已锁定，没有可用位置',
  rescheduleOk: 'ORIGINAL_SLOT_CAPACITY_RELEASED',
  initial: 'INITIAL_ALLOCATION',
};

/* ------------------------------------------------------------------ *
 * 派生镜像
 * ------------------------------------------------------------------ */
/**
 * 三维 → 单 status（镜像）。**唯一的映射实现**，别在别处再写一份。
 * 优先级：播放 > 取消 > 驳回 > 候补 > 已排期 > 已通过待排期 > 待审核
 */
function deriveStatus(review, schedule, play) {
  const r = Number(review) || 0;
  const s = Number(schedule) || 0;
  const p = Number(play) || 0;
  if (p === PLAY.PLAYED) return ST.PLAYED;
  if (r === REVIEW.CANCELLED) return ST.CANCELLED;
  if (r === REVIEW.REJECTED) return ST.REJECTED;
  if (s === SCHEDULE.AUTO_REJECTED) return ST.REJECTED;
  if (s === SCHEDULE.WAITING) return ST.QUEUED;
  if (s === SCHEDULE.APPROVED) return ST.SCHEDULED;
  if (r === REVIEW.APPROVED) return ST.APPROVED_WAIT;
  return ST.PENDING;
}

function reviewName(v) { return REVIEW_NAME[Number(v)] || 'PENDING_REVIEW'; }
function scheduleName(v) { return SCHEDULE_NAME[Number(v)] || 'UNASSIGNED'; }
function playName(v) { return PLAY_NAME[Number(v)] || 'NOT_PLAYED'; }

/** 给接口用的状态视图：三维 + 名称 + 派生 status，一次给全 */
function statusView(row) {
  const r = Number(row.reviewStatus) || 0;
  const s = Number(row.scheduleStatus) || 0;
  const p = Number(row.playStatus) || 0;
  const status = deriveStatus(r, s, p);
  return {
    reviewStatus: r,
    reviewStatusName: reviewName(r),
    scheduleStatus: s,
    scheduleStatusName: scheduleName(s),
    playStatus: p,
    playStatusName: playName(p),
    status,
    statusText: STATUS_TEXT[status] || '',
  };
}

/* ------------------------------------------------------------------ *
 * 写状态（唯一入口）
 * ------------------------------------------------------------------ */
const DIMENSION_OF = { reviewStatus: 'review', scheduleStatus: 'schedule', playStatus: 'play' };

const REVIEWER_TRACE_KEYS = new Set([
  'reviewStatus', 'scheduleStatus', 'playStatus',
  'scheduledSlot', 'assignedAt', 'playedAt',
  'reviewerId', 'reviewTime', 'rejectReason', 'autoRejected',
]);

/**
 * 改状态 + 落状态日志（唯一入口）
 *
 * @param {object} submit    云文档对象（含数字 id 与三维）
 * @param {object} changes   要改的字段（驼峰），只白名单字段生效
 * @param {object} [opts]    { operatorId, operatorName, reason }
 * @returns {Promise<{row, status, logs, conflict?}>}
 *          ⚠️ `logs` 为空 = **没抢到**（并发冲突）。调用方必须判 `if (r.logs.length)`，
 *             不能只看 status —— 冲突时 status 是旧值。
 */
async function applyChange(submit, changes, opts = {}) {
  const { operatorId = null, reason = null } = opts;
  const operatorName = opts.operatorName || (operatorId ? 'ADMIN' : 'SYSTEM');

  const before = {
    reviewStatus: Number(submit.reviewStatus) || 0,
    scheduleStatus: Number(submit.scheduleStatus) || 0,
    playStatus: Number(submit.playStatus) || 0,
  };
  const patch = {};
  Object.keys(changes || {}).forEach((k) => {
    if (changes[k] === undefined) return;
    if (!REVIEWER_TRACE_KEYS.has(k)) return;   // 白名单：防止手滑改到别处
    patch[k] = changes[k];
  });

  const after = {
    reviewStatus: patch.reviewStatus === undefined ? before.reviewStatus : Number(patch.reviewStatus) || 0,
    scheduleStatus: patch.scheduleStatus === undefined ? before.scheduleStatus : Number(patch.scheduleStatus) || 0,
    playStatus: patch.playStatus === undefined ? before.playStatus : Number(patch.playStatus) || 0,
  };

  patch.status = deriveStatus(after.reviewStatus, after.scheduleStatus, after.playStatus);

  /**
   * 条件 UPDATE（乐观锁）。
   * 只对「本次真的要改的维度」加**读取时的旧值**作为条件：
   *   排期落座时 scheduleStatus 必须仍是 UNASSIGNED，抢晚了就影响 0 行。
   * 未参与本次变更的维度不进 WHERE —— 否则「只想改播放状态」会被无关的并发改动误伤。
   *
   * ⚠️ guard 里的 `id` 是**数字业务主键**（见 lib/db.js 的 parseId 注释），不是 `_id`。
   */
  const guard = { id: submit.id };
  Object.keys(DIMENSION_OF).forEach((k) => {
    if (patch[k] === undefined) return;
    guard[k] = before[k];
  });

  const affected = await updateWhere(C.SUBMIT, guard, patch);
  if (affected === 0) {
    console.warn(`[songStatus] 并发冲突，本次变更放弃 #${submit.id}`);
    return { row: submit, status: Number(submit.status) || 0, logs: [], conflict: true };
  }
  Object.assign(submit, patch);   // 内存对象同步，调用方读字段才是新值

  // ── 落状态日志（哪个维度变了就记哪条）──
  const logs = [];
  Object.keys(DIMENSION_OF).forEach((key) => {
    const dim = DIMENSION_OF[key];
    const from = before[key];
    const to = after[key];
    if (from === to) return;
    logs.push({
      requestId: submit.id,
      operatorId: operatorId || null,
      operatorName,
      dimension: dim,
      fromStatus: dim === 'review' ? reviewName(from) : dim === 'schedule' ? scheduleName(from) : playName(from),
      toStatus: dim === 'review' ? reviewName(to) : dim === 'schedule' ? scheduleName(to) : playName(to),
      reason: reason || null,
    });
  });

  if (logs.length) {
    try {
      for (const l of logs) {
        const id = await nextId(C.STATUS_LOG);
        await insertOne(C.STATUS_LOG, { id, createTime: new Date(), ...l });
      }
    } catch (e) {
      // 日志写失败不该回滚业务动作（它只是可追溯性，不是真值）
      console.warn(`[songStatus] 状态日志写入失败 #${submit.id}：${e.message}`);
    }
  }

  return { row: submit, status: patch.status, logs };
}

/** 三维 → 镜像（调用方负责传全三维时用，避免自己拼 status 拼错） */
function patchWithDerivedStatus(changes) {
  const review = changes.reviewStatus === undefined ? null : Number(changes.reviewStatus);
  const schedule = changes.scheduleStatus === undefined ? null : Number(changes.scheduleStatus);
  const play = changes.playStatus === undefined ? null : Number(changes.playStatus);
  if (review === null || schedule === null || play === null) return { ...changes };
  return { ...changes, status: deriveStatus(review, schedule, play) };
}

/** 读某条点歌的状态变更历史（后台「这首歌为什么是这个状态」） */
async function historyOf(requestId, limit = 50) {
  const rid = Number(requestId);
  if (!Number.isInteger(rid)) return [];
  return findMany(C.STATUS_LOG, { requestId: rid }, { orderBy: [['id', 'asc']], limit });
}

module.exports = {
  REVIEW,
  SCHEDULE,
  PLAY,
  REVIEW_NAME,
  SCHEDULE_NAME,
  PLAY_NAME,
  ST,
  STATUS_TEXT,
  SYSTEM_REASON,
  deriveStatus,
  reviewName,
  scheduleName,
  playName,
  statusView,
  applyChange,
  patchWithDerivedStatus,
  historyOf,
  /** 兼容 v2 的常量名：占正式位的**镜像**状态码（已排期 / 已播放） */
  SEATED_STATUS: [ST.SCHEDULED, ST.PLAYED],
};
