'use strict';

/**
 * 点歌排期容量池 + 全局候补队列（docs/song-queue-v2.md，2026-09-20 定稿）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 一、为什么没有计数器表
 *   v1 用 song_quota 记「今天/本周过了几条」，与真实数据两本账，
 *   于是出现「驳回已通过件不还名额」这类泄漏。v2 直接数 submit 行：
 *
 *     占位 = status ∈ {0,1,4} AND scheduled_slot = 某个格子
 *     候补 = status = 3
 *
 *   位子释放 = 状态变化本身，物理上不可能忘记归还。
 *
 * 二、状态
 *   0 待审（占位） 1 已排期（占位） 2 已驳回 3 候补中 4 已补位·待审（占位）
 *
 * 三、三条铁律
 *   ① 提交即占位：容量在「提交」这一刻决定，审核只做内容把关，不再改容量
 *   ② 候补是全局队列：跨所有时段一条 FIFO，任意格子空出就补人，
 *      首选时段仍空则优先放首选（人不换，顺序不变）
 *   ③ 两条关闭线：全格满额 → 清空候补队列；窗口结束（默认周日 18:00）
 *      → 候补未补位(3) 与 补位未审(4) 全部自动驳回，排期定稿
 *
 * 四、失败策略
 *   写路径（落座/递补/清队/定稿）任何异常一律上抛或者记日志重试，
 *   绝不「读失败就当没满」——那会直接超容。读路径（快照）宽容处理。
 * ═══════════════════════════════════════════════════════════════════════
 */

const { Op, fn, col } = require('sequelize');
const { Submit } = require('../models');
const bj = require('../utils/bjTime');
const kv = require('./kvService');
const slotSvc = require('./broadcastSlotService');
const songWindow = require('./songWindowService');
const logger = require('../utils/logger');

/** 占用正式位的状态 */
const SEATED_STATUS = [0, 1, 4];
const ST = {
  PENDING: 0,      // 待审（占位）
  SCHEDULED: 1,    // 已排期（占位）
  REJECTED: 2,     // 已驳回
  QUEUED: 3,       // 候补中
  PROMOTED: 4,     // 已补位 · 待审（占位）
};

const KV_QUEUE_LIMIT = 'song_queue_limit';   // 全局候补上限，0/空 = 自动 = 下周正式位总数
const KV_GATE = 'song_finalize_gate';        // 定稿闸门（防同一周重复执行）

const SYSTEM_REASON = {
  slotFull: '下周排期已满额，未能补位',
  overdueQueue: '已过审核截止时间，未补位',
  overduePromoted: '已过审核截止时间，未完成审核',
  weekOver: '播出周已结束，未及时审核',
};

const DAYS_PER_WEEK = 5;   // 周一到周五

/* ------------------------------------------------------------------ *
 * 时间 / 周与格子的换算
 * ------------------------------------------------------------------ */
/** 从 "2026-09-21 午间 12:20" 里取出日期串 */
function datePartOf(value) {
  const m = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

/** 某个时段值所属播出周的周一 00:00（北京时间，绝对时刻） */
function weekStartOfValue(value) {
  const d = datePartOf(value);
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  // Date.UTC(y,m-1,day) = 北京时间当天 08:00，落在同一天，weekRange 归属正确
  return bj.weekRange(Date.UTC(y, m - 1, day)).start;
}

/** 某行的归属周：优先 actual（补位后可能已换时段），退回首选 */
function weekStartOfRow(row) {
  return weekStartOfValue(row.scheduledSlot)
    || weekStartOfValue(row.wantBroadcastTime)
    || bj.nextWeekRange(row.queueAt ? new Date(row.queueAt).getTime() : (row.createTime ? new Date(row.createTime).getTime() : Date.now())).start;
}

/** 播出周的全部格子值（5 天 × N 时段），与 broadcastSlot.getSlots 的拼法保持一致 */
async function slotValuesOfWeek(weekStartMs) {
  const periods = await slotSvc.getPeriods();
  const out = [];
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const dateStr = bj.ymd(bj.shifted(weekStartMs + i * bj.DAY_MS));
    periods.forEach((p) => out.push(`${dateStr} ${p.period} ${p.time}`));
  }
  return out;
}

/** 该播出周的窗口截止时刻（= 审核截止） */
function windowEndOfWeek(cfg, weekStartMs) {
  // 传「周一前 1 秒」，nextWeekRange 正好指向这一周
  return songWindow.windowRangeAt(cfg, weekStartMs - 1000).end;
}

/* ------------------------------------------------------------------ *
 * 容量与队列上限
 * ------------------------------------------------------------------ */
/** 每格正式位（0 = 不限） */
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

/**
 * 全局候补上限：KV 填了正数就用它；0/空 = 自动 = 下周正式位总数
 * @returns {Promise<{limit:number, auto:boolean}>} limit = 0 表示不限
 */
async function getQueueLimit(now = Date.now()) {
  let raw = '';
  try { raw = await kv.get(KV_QUEUE_LIMIT, ''); } catch (e) { raw = ''; }
  const n = parseInt(String(raw === null || raw === undefined ? '' : raw).trim(), 10);
  if (Number.isFinite(n) && n > 0) return { limit: n, auto: false };
  const auto = await weekCapacity(now);
  return { limit: auto, auto: true };
}

/* ------------------------------------------------------------------ *
 * 计数
 * ------------------------------------------------------------------ */
/** 某格已占位数 */
async function countSeated(slotValue, transaction) {
  return Submit.count({
    where: { type: 1, status: { [Op.in]: SEATED_STATUS }, scheduledSlot: slotValue },
    transaction,
  });
}

/** 批量取各格已占位数 → { slotValue: n } */
async function countSeatedBySlot(values, transaction) {
  if (!values.length) return {};
  const rows = await Submit.findAll({
    where: { type: 1, status: { [Op.in]: SEATED_STATUS }, scheduledSlot: { [Op.in]: values } },
    attributes: ['scheduledSlot', [fn('COUNT', col('id')), 'n']],
    group: ['scheduledSlot'],
    raw: true,
    transaction,
  });
  const out = {};
  rows.forEach((r) => { out[r.scheduledSlot] = Number(r.n) || 0; });
  return out;
}

/** 候补队列总人数 */
async function countQueued(transaction) {
  return Submit.count({ where: { type: 1, status: ST.QUEUED }, transaction });
}

/* ------------------------------------------------------------------ *
 * ① 提交落座
 * ------------------------------------------------------------------ */
/**
 * 决定这条点歌是「直接占位」还是「进候补」还是「彻底满了」
 * 调用方拿到结果后自己 create（可传 transaction 保证判定与写入同事务）
 *
 * @returns {Promise<{outcome:'seated'|'queued'|'full', seated:number, capacity:number,
 *                    queueUsed:number, queueLimit:number, queueLimitAuto:boolean, left:number}>}
 */
async function decideSeat({ slotValue, transaction, now = Date.now() } = {}) {
  const capacity = await getCapacity();
  const seated = slotValue ? await countSeated(slotValue, transaction) : 0;
  const { limit, auto } = await getQueueLimit(now);
  const queueUsed = await countQueued(transaction);

  if (!(capacity > 0) || seated < capacity) {
    return {
      outcome: 'seated', seated, capacity,
      queueUsed, queueLimit: limit, queueLimitAuto: auto,
      left: capacity > 0 ? Math.max(0, capacity - seated) : null,
    };
  }
  if (!(limit > 0) || queueUsed < limit) {
    return {
      outcome: 'queued', seated, capacity,
      queueUsed, queueLimit: limit, queueLimitAuto: auto,
      left: 0,
    };
  }
  return {
    outcome: 'full', seated, capacity,
    queueUsed, queueLimit: limit, queueLimitAuto: auto,
    left: 0,
  };
}

/* ------------------------------------------------------------------ *
 * ② 全局递补
 * ------------------------------------------------------------------ */
/** 候补位次（1 起）：前面还有几人 */
async function queuePosOf(row) {
  const qa = row.queueAt ? new Date(row.queueAt).getTime() : null;
  let ahead;
  if (qa) {
    ahead = await Submit.count({
      where: {
        type: 1, status: ST.QUEUED,
        [Op.or]: [
          { queueAt: { [Op.lt]: row.queueAt } },
          { queueAt: row.queueAt, id: { [Op.lte]: row.id } },
        ],
      },
    });
  } else {
    // 兜底：没写 queue_at 的历史行按创建时间排队
    ahead = await Submit.count({
      where: {
        type: 1, status: ST.QUEUED,
        [Op.or]: [
          { queueAt: null, createTime: { [Op.lte]: row.createTime } },
          { queueAt: { [Op.ne]: null } },
        ],
      },
    });
  }
  const pos = Math.max(1, Number(ahead) || 1);
  return { pos, ahead: Math.max(0, pos - 1) };
}

/** 取队首（FIFO：queue_at 升序，同刻按 id） */
async function queueHead(transaction) {
  return Submit.findOne({
    where: { type: 1, status: ST.QUEUED },
    order: [['queue_at', 'ASC'], ['id', 'ASC']],
    transaction,
  });
}

/**
 * 全局递补：有空位就按 FIFO 补人，补到「格子满」或「队列空」为止
 *   · 已审过的候补 → status=1（已排期）
 *   · 没审过的候补 → status=4（已补位 · 待审）
 *   · 首选时段仍空则优先放首选，否则填当前空位（可能与学生首选不同）
 * 幂等：条件更新 WHERE status = 3，重复跑只少做事
 */
async function promote({ now = Date.now(), transaction } = {}) {
  const capacity = await getCapacity();
  let promoted = 0;

  // capacity = 0（不限）：每格都不限，队列里所有人一次性全部落位
  if (!(capacity > 0)) {
    const rows = await Submit.findAll({
      where: { type: 1, status: ST.QUEUED },
      order: [['queue_at', 'ASC'], ['id', 'ASC']],
      transaction,
    });
    for (const row of rows) {
      const target = row.wantBroadcastTime || row.scheduledSlot;
      if (!target) continue;
      const [n] = await Submit.update(
        {
          status: row.reviewTime ? ST.SCHEDULED : ST.PROMOTED,
          scheduledSlot: target,
          promotedAt: new Date(),
        },
        { where: { id: row.id, status: ST.QUEUED }, transaction }
      );
      if (n) promoted += 1;
    }
    return { promoted, closed: 0, full: false };
  }

  let full = false;
  // guard 防止极端脏数据下死循环（正常最多 = 队列长度）
  for (let guard = 0; guard < 500; guard++) {
    const head = await queueHead(transaction);
    if (!head) break;                            // 队列空 → 停，格子空着就空着

    const weekStartMs = weekStartOfRow(head);
    if (!weekStartMs) {                          // 脏数据：时段值解析不出周 → 跳过并记录
      logger.warn(`[songQueue] 候补 #${head.id} 的时段值无法解析，跳过递补`);
      break;
    }
    const values = await slotValuesOfWeek(weekStartMs.getTime());
    if (!values.length) break;

    const seatedMap = await countSeatedBySlot(values, transaction);
    const free = values.find((v) => (seatedMap[v] || 0) < capacity);
    if (!free) { full = true; break; }           // 所有格子满额 → 停（下面由 closeQueueIfFull 清队）

    const want = head.wantBroadcastTime;
    const preferOk = want && values.includes(want) && (seatedMap[want] || 0) < capacity;
    const target = preferOk ? want : free;

    const [n] = await Submit.update(
      {
        status: head.reviewTime ? ST.SCHEDULED : ST.PROMOTED,
        scheduledSlot: target,
        promotedAt: new Date(),
      },
      { where: { id: head.id, status: ST.QUEUED }, transaction }
    );
    if (n) promoted += 1;
    // 命中 0 行（并发被别人改过）→ 继续循环，重新取队首
  }

  const closed = await closeQueueIfFull({ now, transaction });
  return { promoted, closed, full };
}

/* ------------------------------------------------------------------ *
 * ③ 满额清队
 * ------------------------------------------------------------------ */
/**
 * 所有格子占满 → 候补队列已无意义，全部自动驳回（幂等）
 * 注：清队后若管理员再驳回一条已排期件释放位子，队列已空 → 位子空着（设计如此）。
 *    想改成「满额只冻结队列」的话，把这里的 UPDATE 去掉即可。
 */
async function closeQueueIfFull({ now = Date.now(), transaction } = {}) {
  const capacity = await getCapacity();
  if (!(capacity > 0)) return 0;                 // 不限 = 永远不满

  const periods = await slotSvc.getPeriods(now);
  const total = DAYS_PER_WEEK * periods.length * capacity;
  const seatedTotal = await Submit.count({
    where: { type: 1, status: { [Op.in]: SEATED_STATUS } },
    transaction,
  });
  if (seatedTotal < total) return 0;
  if ((await countQueued(transaction)) === 0) return 0;

  const [affected] = await Submit.update(
    {
      status: ST.REJECTED,
      autoRejected: 1,
      rejectReason: SYSTEM_REASON.slotFull,
      reviewerId: null,
      reviewTime: new Date(),
    },
    { where: { type: 1, status: ST.QUEUED }, transaction }
  );
  if (affected) logger.info(`[songQueue] 排期已满额，清空候补队列 ${affected} 条`);
  return affected;
}

/** 释放位子之后统一调用：先递补，再检查是否满额 */
async function runAfterRelease({ now = Date.now() } = {}) {
  try {
    const r = await promote({ now });
    return r;
  } catch (e) {
    logger.warn(`[songQueue] 递补失败（下次审核 / 手动 sweep 会重试）：${e.message}`);
    return { promoted: 0, closed: 0, error: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * ④ 定稿关闭 + 跨周兜底（窗口结束后跑）
 * ------------------------------------------------------------------ */
async function readGate() {
  try {
    const raw = await kv.get(KV_GATE, '');
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
async function writeGate(list) {
  const trimmed = list.slice(-12);   // 只留最近 12 周，别把 KV 撑大
  await kv.set(KV_GATE, JSON.stringify(trimmed), '点歌定稿闸门（已定稿的播出周，防重复执行）');
}

/**
 * 定稿清理（幂等）：
 *  ① 已过窗口截止的播出周：候补(3) 与 补位未审(4) 全部自动驳回
 *  ② 播出周已经过去的残留待审(0)：按「播出周已结束」清掉（跨周兜底）
 * @returns {Promise<{weeks:number, queued:number, promoted:number, pending:number}>}
 */
async function finalizeDueWeeks({ now = Date.now() } = {}) {
  const cfg = await songWindow.getConfig(now);
  const gate = await readGate();
  const result = { weeks: 0, queued: 0, promoted: 0, pending: 0 };

  // ── 收集「还有活着的点歌」的播出周 ──
  const alive = await Submit.findAll({
    where: { type: 1, status: { [Op.in]: [ST.PENDING, ST.QUEUED, ST.PROMOTED] } },
    attributes: ['id', 'status', 'wantBroadcastTime', 'scheduledSlot', 'queueAt', 'createTime'],
    raw: true,
  });
  const weeks = new Set();
  alive.forEach((r) => {
    const ws = weekStartOfRow(r);
    if (ws) weeks.add(ws.getTime());
  });

  for (const wsMs of [...weeks].sort((a, b) => a - b)) {
    const key = bj.ymd(bj.shifted(wsMs));               // 2026-09-21
    const values = await slotValuesOfWeek(wsMs);
    if (!values.length) continue;

    // 「播出周已结束」= 周一到周五都播完了，即周六 00:00 起
    // （用「下周一 00:00」做界会把这批残留多留一整周，学生端会一直看到一条永不播出的待审）
    const ended = now >= wsMs + DAYS_PER_WEEK * bj.DAY_MS;
    const cutoff = windowEndOfWeek(cfg, wsMs).getTime();
    const gated = gate.includes(key);
    const overdue = ended || (now >= cutoff && !gated);
    if (!overdue) continue;

    const inWeek = {
      [Op.or]: [
        { scheduledSlot: { [Op.in]: values } },
        { scheduledSlot: null, wantBroadcastTime: { [Op.in]: values } },
      ],
    };

    // ① 候补未补位(3) + 补位未审(4) → 一律驳回
    //    （窗口截止就清 3/4；播出周已过时连 3/4 也一起清干净，不依赖 gate 是否丢过）
    const [q] = await Submit.update(
      {
        status: ST.REJECTED, autoRejected: 1,
        rejectReason: SYSTEM_REASON.overdueQueue,
        reviewerId: null, reviewTime: new Date(),
      },
      { where: { type: 1, status: ST.QUEUED, ...inWeek } }
    );
    const [p] = await Submit.update(
      {
        status: ST.REJECTED, autoRejected: 1,
        rejectReason: SYSTEM_REASON.overduePromoted,
        reviewerId: null, reviewTime: new Date(),
      },
      { where: { type: 1, status: ST.PROMOTED, ...inWeek } }
    );

    // ② 残留待审(0)：只有「播出周已经过去」才清（跨周兜底）。
    //    目标周刚过截止时刻时**保留**待审 —— 管理员当晚还可能手动审完。
    let n0 = 0;
    if (ended) {
      [n0] = await Submit.update(
        {
          status: ST.REJECTED, autoRejected: 1,
          rejectReason: SYSTEM_REASON.weekOver,
          reviewerId: null, reviewTime: new Date(),
        },
        { where: { type: 1, status: ST.PENDING, ...inWeek } }
      );
    }

    result.queued += q;
    result.promoted += p;
    result.pending += n0;
    result.weeks += 1;
    if (now >= cutoff && !gated) gate.push(key);
    logger.info(
      `[songQueue] 播出周 ${key} 已定稿：候补未补位 ${q} 条、补位未审 ${p} 条` +
      (ended ? `、跨周残留待审 ${n0} 条` : '')
    );
  }

  if (result.weeks) await writeGate(gate);
  return result;
}

/** 手动兜底（管理端 queue/sweep）：递补 + 满额清队 + 定稿清理，全幂等 */
async function sweepAll({ now = Date.now() } = {}) {
  const promoteRes = await runAfterRelease({ now });
  const finalizeRes = await finalizeDueWeeks({ now });
  return { promote: promoteRes, finalize: finalizeRes, snapshot: await snapshot(now) };
}

/* ------------------------------------------------------------------ *
 * ⑤ 快照（读路径，宽容）
 * ------------------------------------------------------------------ */
async function snapshot(now = Date.now()) {
  const capacity = await getCapacity();
  const { limit, auto } = await getQueueLimit(now);
  const total = await countQueued();
  const items = await Submit.findAll({
    where: { type: 1, status: ST.QUEUED },
    order: [['queue_at', 'ASC'], ['id', 'ASC']],
    attributes: ['id', 'openid', 'songName', 'singer', 'wantBroadcastTime', 'queueAt', 'reviewTime', 'createTime'],
    limit: 50,
    raw: true,
  });
  const head = items[0];
  const headWaitMinutes = head && head.queueAt
    ? Math.max(0, Math.round((now - new Date(head.queueAt).getTime()) / 60000))
    : null;

  return {
    capacity,
    limit,
    limitAuto: auto,
    weekCapacity: await weekCapacity(now),
    total,
    full: limit > 0 ? total >= limit : false,
    headWaitMinutes,
    items: items.map((r, i) => ({
      id: r.id,
      openid: r.openid,
      songName: r.songName,
      singer: r.singer,
      wantBroadcastTime: r.wantBroadcastTime,
      queueAt: r.queueAt,
      pos: i + 1,
      reviewed: !!r.reviewTime,
    })),
  };
}

/** 一个格子的实时占用情况（学生端时段列表 / 管理端矩阵用） */
async function slotUsage(values, now = Date.now()) {
  const capacity = await getCapacity();
  const seatedMap = await countSeatedBySlot(values).catch(() => ({}));
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

/** 学生端的候补卡数据（docs/song-queue-v2.md §7） */
async function cardFor(row, now = Date.now()) {
  const status = Number(row.status);
  const st = await songWindow.status(now);
  if (status === ST.QUEUED) {
    const { pos, ahead } = await queuePosOf(row);
    const { limit } = await getQueueLimit(now);
    return {
      type: 'queue',
      status: 'waiting',
      queuePos: pos,
      aheadCount: ahead,
      queueUsed: await countQueued(),
      queueLimit: limit,
      preferred: row.wantBroadcastTime || null,
      finalizeAt: st.enabled ? st.end : null,
      hint: '下周任意时段有空位时按提交先后自动补位，实际排到的时段可能与你首选不同',
      actions: [{ key: 'leave', label: '放弃候补' }],
    };
  }
  if (status === ST.PROMOTED || (status === ST.SCHEDULED && row.promotedAt)) {
    const target = row.scheduledSlot || row.wantBroadcastTime;
    const changed = !!(row.wantBroadcastTime && row.scheduledSlot && row.wantBroadcastTime !== row.scheduledSlot);
    return {
      type: 'queue',
      status: 'promoted',
      scheduledSlot: target,
      preferred: row.wantBroadcastTime || null,
      changed,
      finalizeAt: st.enabled ? st.end : null,
      hint: changed
        ? `你首选的是「${row.wantBroadcastTime}」，该时段已满，系统把你补到了「${target}」`
        : (status === ST.PROMOTED ? '已自动补位，审核通过后即安排播出' : '已自动补位并排入播出'),
      actions: [],
    };
  }
  if (status === ST.REJECTED && Number(row.autoRejected) === 1) {
    return {
      type: 'queue',
      status: 'failed',
      reason: row.rejectReason || '本次未补上',
      actions: [],
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * ⑥ 调度器：窗口结束后定稿（项目里没有 cron，用轻量定时器）
 * ------------------------------------------------------------------ */
let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return;                 // 上一轮还没跑完就跳过，别叠
  ticking = true;
  try {
    const now = Date.now();
    const r = await finalizeDueWeeks({ now });
    if (r.weeks || r.pending) {
      logger.info(`[songQueue] 定时定稿：周 ${r.weeks} 个 / 候补 ${r.queued} / 补位未审 ${r.promoted} / 跨周待审 ${r.pending}`);
    }
  } catch (e) {
    logger.warn(`[songQueue] 定稿任务失败（下个周期重试）：${e.message}`);
  } finally {
    ticking = false;
  }
}

/**
 * 启动定时器（app.js 的 start() 里调用）
 * 一分钟一次；启动先立即跑一次（服务停过几天，重启也能补齐）
 */
function startScheduler(intervalMs = 60 * 1000) {
  if (timer) return timer;
  if (process.env.NODE_ENV === 'test') return null;      // 测试环境不挂定时器，避免干扰用例
  setTimeout(() => { tick(); }, 1000);                   // 启动即补跑
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();                        // 不阻止进程退出
  logger.info(`[songQueue] 定稿调度器已启动（每 ${Math.round(intervalMs / 1000)} 秒检查一次）`);
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  ST,
  SEATED_STATUS,
  KV_QUEUE_LIMIT,
  KV_GATE,
  SYSTEM_REASON,
  DAYS_PER_WEEK,
  // 时间与格子换算
  datePartOf,
  weekStartOfValue,
  weekStartOfRow,
  slotValuesOfWeek,
  windowEndOfWeek,
  // 容量
  getCapacity,
  weekCapacity,
  getQueueLimit,
  // 计数
  countSeated,
  countSeatedBySlot,
  countQueued,
  slotUsage,
  // 主流程
  decideSeat,
  promote,
  closeQueueIfFull,
  runAfterRelease,
  finalizeDueWeeks,
  sweepAll,
  // 展示
  queuePosOf,
  queueHead,
  snapshot,
  cardFor,
  // 调度器
  startScheduler,
  stopScheduler,
  _tick: tick,
};
