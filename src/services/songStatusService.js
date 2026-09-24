'use strict';

/**
 * 点歌三维状态（协议文档「十五、我建议把审核状态和排期状态拆开」）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一个 status 同时表达「审核结果 + 排期结果 + 播放结果」会越来越乱，所以拆成三个正交维度：
 *
 *   review_status    审核维度   PENDING / APPROVED / REJECTED
 *   schedule_status  排期维度   UNASSIGNED / APPROVED / WAITING / AUTO_REJECTED
 *   play_status      播放维度   NOT_PLAYED / PLAYED
 *
 * 于是「审核通过了但是还在候补」写得明明白白：
 *   review_status = APPROVED, schedule_status = WAITING, play_status = NOT_PLAYED
 * 而不是靠一个 status = WAITING 去猜它到底审没审。
 *
 * 关键结论（占位口径）：
 *   占一个正式位 ⟺ review_status = APPROVED AND schedule_status = APPROVED
 *   —— 所以「人工驳回」只要把 review_status 置成 REJECTED，位子就自动释放了，
 *      不需要额外的 release() 步骤，也就不可能忘记归还（v1 的名额泄漏就是这么来的）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 兼容镜像：
 *   submit.status 是**派生列**（前端小程序 / admin-web 还在用单 status 筛选），
 *   由本文件 deriveStatus() 单点计算。**任何改状态的路径都必须走 applyChange()**，
 *   否则三维与镜像会对不上（那就是新的「两本账」）。
 * ═══════════════════════════════════════════════════════════════════════
 */

const { Submit, RequestStatusLog } = require('../models');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ *
 * 维度定义
 * ------------------------------------------------------------------ */
const REVIEW = { PENDING: 0, APPROVED: 1, REJECTED: 2, CANCELLED: 3 };
const SCHEDULE = { UNASSIGNED: 0, APPROVED: 1, WAITING: 2, AUTO_REJECTED: 3 };
const PLAY = { NOT_PLAYED: 0, PLAYED: 1 };

const REVIEW_NAME = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'];
const SCHEDULE_NAME = ['UNASSIGNED', 'APPROVED', 'WAITING', 'AUTO_REJECTED'];
const PLAY_NAME = ['NOT_PLAYED', 'PLAYED'];

/** 镜像 status 码（= 前端现有口径 + 三个新增） */
const ST = {
  PENDING: 0,          // 待审核
  SCHEDULED: 1,        // 已排期
  REJECTED: 2,         // 已驳回（人工或系统）
  QUEUED: 3,           // 候补中
  PROMOTED: 4,         // 【保留】v2 的「已补位·待审」，协议版不再产生
  PLAYED: 5,           // 已播放（新增）
  APPROVED_WAIT: 6,    // 已通过 · 待排期（新增，审核通过但还没跑排期）
  CANCELLED: 7,        // 已取消（学生撤销 / 放弃候补，新增）
};

/** 给前端展示的中文文案（学生侧与 v2 对齐，新增三个） */
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
  /** 协议原文：SCHEDULE_LOCKED_NO_AVAILABLE_SLOT */
  lockedNoSlot: '排期已锁定，没有可用位置',
  rescheduleOk: 'ORIGINAL_SLOT_CAPACITY_RELEASED',
  initial: 'INITIAL_ALLOCATION',
};

/* ------------------------------------------------------------------ *
 * 派生镜像
 * ------------------------------------------------------------------ */
/**
 * 三维 → 单 status（镜像）。**这是唯一的映射实现**，别在别处再写一份。
 * 优先级：播放 > 取消 > 驳回 > 候补 > 已排期 > 已通过待排期 > 待审核
 *
 * 注：`CANCELLED` 属于 review 维度而非 schedule 维度 —— 「取消」是**申请还活不活着**，
 * 和「审核过没过」同属一条生命线；schedule 维度只回答「排到哪儿了」。
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

/** 维度名（写日志用） */
function reviewName(v) { return REVIEW_NAME[Number(v)] || 'PENDING_REVIEW'; }
function scheduleName(v) { return SCHEDULE_NAME[Number(v)] || 'UNASSIGNED'; }
function playName(v) { return PLAY_NAME[Number(v)] || 'NOT_PLAYED'; }

/**
 * 给接口用的状态视图：三维 + 名称 + 派生 status，一次给全。
 * 前端改造完成前照着 `status` 走，改造后照着三维走。
 */
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
/** 三个维度里哪些字段名会进 applyChange 的 changes */
const DIMENSION_OF = { reviewStatus: 'review', scheduleStatus: 'schedule', playStatus: 'play' };

const REVIEWER_TRACE_KEYS = new Set([
  'reviewStatus', 'scheduleStatus', 'playStatus',
  'scheduledSlot', 'assignedAt', 'playedAt',
  'reviewerId', 'reviewTime', 'rejectReason', 'autoRejected',
]);

/**
 * 改状态 + 落状态日志（唯一入口）
 *
 * @param {object} submit              Sequelize 实例（或含 id 的普通对象）
 * @param {object} changes             要改的字段（驼峰），可含三维、scheduledSlot、reviewerId…
 * @param {object} [opts]
 * @param {number} [opts.operatorId]   操作管理员 id
 * @param {string} [opts.operatorName] 'SYSTEM' | 'ADMIN' | 'USER'（默认按 operatorId 推断）
 * @param {string} [opts.reason]
 * @param {object} [opts.transaction]
 * @param {object} [opts.model]        写库用的模型（默认用 submit.update）
 * @returns {Promise<{row:object, status:number, logs:Array}>}
 */
async function applyChange(submit, changes, opts = {}) {
  const { transaction, operatorId = null, reason = null } = opts;
  const operatorName = opts.operatorName || (operatorId ? 'ADMIN' : 'SYSTEM');

  const before = {
    reviewStatus: Number(submit.reviewStatus) || 0,
    scheduleStatus: Number(submit.scheduleStatus) || 0,
    playStatus: Number(submit.playStatus) || 0,
  };
  const patch = {};
  Object.keys(changes || {}).forEach((k) => {
    if (changes[k] === undefined) return;
    if (!REVIEWER_TRACE_KEYS.has(k)) return;   // 只允许白名单字段，防止手滑改到别处
    patch[k] = changes[k];
  });

  const after = {
    reviewStatus: patch.reviewStatus === undefined ? before.reviewStatus : Number(patch.reviewStatus) || 0,
    scheduleStatus: patch.scheduleStatus === undefined ? before.scheduleStatus : Number(patch.scheduleStatus) || 0,
    playStatus: patch.playStatus === undefined ? before.playStatus : Number(patch.playStatus) || 0,
  };

  patch.status = deriveStatus(after.reviewStatus, after.scheduleStatus, after.playStatus);

  /**
   * 条件 UPDATE（乐观锁）——《V1 规格》第 13 节「count < capacity 才 UPDATE」的等价物。
   *
   * 只对「本次真的要改的维度」加**读取时的旧值**作为条件：
   *   排期落座时 schedule_status 必须仍是 UNASSIGNED，抢晚了就影响 0 行。
   * 影响 0 行 = 别人先改了这一次 → 直接返回空 logs，调用方据此跳过，
   * 于是 capacity=3 时不会出现第 4 首 APPROVED（管理端手动触发与定时器重叠也不会超卖）。
   *
   * 未参与本次变更的维度不进 WHERE —— 否则「只想改播放状态」会被无关的并发改动误伤。
   */
  const guard = { id: submit.id };
  Object.keys(DIMENSION_OF).forEach((k) => {
    if (patch[k] === undefined) return;
    guard[k] = before[k];
  });

  const [affected] = await Submit.update(patch, { where: guard, transaction });
  if (affected === 0) {
    logger.warn(`[songStatus] 并发冲突，本次变更放弃 #${submit.id}`);
    return { row: submit, status: Number(submit.status) || 0, logs: [], conflict: true };
  }
  if (typeof submit.set === 'function') submit.set(patch);   // 内存实例同步，调用方读字段才是新值
  const row = submit;

  // ── 落状态日志（哪个维度变了就记哪条）──
  const logs = [];
  Object.keys(DIMENSION_OF).forEach((key) => {
    const dim = DIMENSION_OF[key];
    const from = before[key];
    const to = after[key];
    if (from === to) return;
    logs.push({
      requestId: row.id,
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
      await RequestStatusLog.bulkCreate(logs, { transaction });
    } catch (e) {
      // 日志写失败不该回滚业务动作（它只是可追溯性，不是真值）
      logger.warn(`[songStatus] 状态日志写入失败 #${row.id}：${e.message}`);
    }
  }

  return { row, status: patch.status, logs };
}

/**
 * 批量改（调度器 / 批量审核用）：不再逐条走 applyChange，直接条件 UPDATE，
 * 但**必须**同时把三维与镜像一起写对（调用方负责传全）。
 * 这里只做「三维 → 镜像」这一个计算，避免调用方自己拼 status 拼错。
 */
function patchWithDerivedStatus(changes) {
  const review = changes.reviewStatus === undefined ? null : Number(changes.reviewStatus);
  const schedule = changes.scheduleStatus === undefined ? null : Number(changes.scheduleStatus);
  const play = changes.playStatus === undefined ? null : Number(changes.playStatus);
  if (review === null || schedule === null || play === null) return { ...changes };
  return { ...changes, status: deriveStatus(review, schedule, play) };
}

/** 读某条点歌的状态变更历史（后台「这首歌为什么是这个状态」） */
async function historyOf(requestId, limit = 50) {
  return RequestStatusLog.findAll({
    where: { requestId },
    order: [['id', 'ASC']],
    limit,
    raw: true,
  });
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
