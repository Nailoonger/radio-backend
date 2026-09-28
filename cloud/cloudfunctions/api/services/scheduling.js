'use strict';

/**
 * 点歌排期服务 —— 从 src/services/songSchedulingService.js 移植
 *
 * ═══════════════ 本轮（阶段 4）只移植「用户端要用到的部分」═══════════════
 *
 * ✅ 已移植（只读 + 懒建周行，不涉及状态流转决策）：
 *      时间/周/格子工具  datePartOf / instantOfValue / weekStartOfValue / weekStartOfRow
 *                        slotValuesOfWeek / msOfWeekStartDate
 *      容量与占位        getCapacity / weekCapacity / seatedWhere / countSeated / countSeatedBySlot
 *                        isSeated
 *      周行              anchorOf / deriveWeekStatus / refreshAnchors / ensureWeek
 *                        ensureWeekOfValue / weekView / canCrossSlot
 *      候补读路径        waitingSnapshot / waitingPosOf
 *      常量              WEEK_STATUS / WEEK_STATUS_CN / ASSIGN / ASSIGN_REASON / DAYS_PER_WEEK
 *
 * ✅ 已移植（阶段 5 · 排期算法，**2026-09-28 全部完成**）：
 *      logAssignment / initialAllocate / reschedule / runAllocators / afterRelease
 *      lockWeek / unlockWeek / cancelWeek
 *      markPlayed / setPlayed / manualAssign / sweep
 *      + services/songRescheduleCost.js（调剂选址成本表，纯函数）
 *
 * 阶段 6 待办（**不在本文件范围**）：定时触发器替换原 60s `startScheduler`。
 *
 * ═══════════════ 云化改动 ═══════════════
 * ① weekly_schedule 的 `_id` 用业务键 `week:<week_start_date>`（见 lib/db.js 主键口径表），
 *    原表上的 UNIQUE(week_start_date) 由它天然承担；并发懒建撞键即失败 → 重读即可。
 * ② 去掉 `transaction` 参数（云数据库不支持跨文档事务）。本文件这些函数本来也只用它
 *    做「同一事务里读得到自己刚写的行」，而改成 `_id` 直查后这个需求消失了。
 * ③ 三处 `Submit.findAll({ group: ... })` → countByField；普通全量查询 → findAllPaged。
 * ④ `week.update(...)` → `updateById(...)` + 在内存对象上同步，保持调用方读字段是新值。
 */

const { C, _, findOne, findById, findAllPaged, count, countByField, insertWithId, updateById, updateWhere, nextId, insertOne } = require('../lib/db');
const bj = require('../lib/bjTime');
const kv = require('./kv');
const slotSvc = require('./broadcastSlot');
const songWindow = require('./songWindow');
const S = require('./songStatus');
/** 调剂选址成本表（纯函数，无 DB）—— 阶段 5 与 reschedule 一起启用 */
const costCalc = require('./songRescheduleCost');

const DAYS_PER_WEEK = 5;                    // 周一到周五
/** 审核截止未单独配置时的兜底偏移（真值在 songWindowService，这里只做转发/再导出） */
const KV_LOCK_OFFSET = songWindow.KV_LOCK_OFFSET;
const DEFAULT_LOCK_OFFSET_MINUTES = 360;

const WEEK_STATUS = {
  DRAFT: 'DRAFT',
  APPLICATION: 'APPLICATION',
  REVIEW: 'REVIEW',
  SCHEDULING: 'SCHEDULING',
  LOCKED: 'LOCKED',
  CANCELLED: 'CANCELLED',
};
/** 周状态中文名（下发到前端的 statusText）
 *  ⚠️ 命名规则（2026-09-27 陛下定）：状态本身 = "进行中" 形态，带「中」；
 *     前端状态带的"已完成 / 未到"胶囊直接去掉「中」（点播中 → 点播）。
 *     DRAFT 用「未开放」，与前端 WEEK_FLOW 对齐。 */
const WEEK_STATUS_CN = {
  DRAFT: '未开放',
  APPLICATION: '点播中',
  REVIEW: '审核中',
  SCHEDULING: '排期中',
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

/** weekly_schedule 的业务键 = `_id` */
const weekDocId = (dateStr) => `week:${dateStr}`;

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

/** 周行里的 `weekStartDate`（DATEONLY 字符串）→ 该周一 00:00 的绝对时刻 */
function msOfWeekStartDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 北京时间周一 00:00 → UTC 时刻
  return Date.UTC(y, mo - 1, d) - bj.TZ_OFFSET_MS;
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
  return count(C.SUBMIT, seatedWhere({ scheduledSlot: slotValue }));
}

/** 批量取各格已占数 → { slotValue: n } */
async function countSeatedBySlot(values) {
  if (!values.length) return {};
  return countByField(C.SUBMIT, seatedWhere({ scheduledSlot: _.in(values) }), 'scheduledSlot');
}

/** 一行是否占着正式位（镜像口径的判据） */
function isSeated(row) {
  return Number(row.reviewStatus) === S.REVIEW.APPROVED
    && Number(row.scheduleStatus) === S.SCHEDULE.APPROVED;
}

/* ------------------------------------------------------------------ *
 * 周（weekly_schedule）：懒创建 + 状态推进
 * ------------------------------------------------------------------ */
/** 审核截止未单独配置时的兜底偏移（分钟）—— 真值口唯一在 songWindowService */
async function getLockOffsetMinutes() {
  return songWindow.getLockOffsetMinutes();
}

/**
 * 时间锚点全部由 KV 点歌窗口派生（2026-09-25 改版后含独立审核截止）。
 *   applicationEndAt = 点播截止（只停止收新歌）
 *   scheduleLockAt   = 审核截止（到点自动排期 + 驳回候补 + 锁定本周）
 * 两者不再相等 —— 点播结束后到审核截止之间，管理员仍可慢慢审、手动调格子。
 */
async function anchorOf(weekStartMs, now = Date.now()) {
  const cfg = await songWindow.getConfig(now);
  // 传「周一前 1 秒」，nextWeekRange 正好指向这一周
  const rng = await songWindow.anchorRangeAt(cfg, weekStartMs - 1000);
  return {
    applicationStartAt: rng.start,
    applicationEndAt: rng.end,
    reviewStartAt: rng.end,          // 点播截止 = 审核开始
    scheduleLockAt: rng.reviewAt,    // 锁定时刻 = 独立审核截止
    reviewEndAt: rng.reviewAt,
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

/** 锚点已冻结的周状态：排期一旦生成（或锁定/取消），时间锚点不再跟随配置改动 */
const ANCHOR_FROZEN_STATUS = [WEEK_STATUS.SCHEDULING, WEEK_STATUS.LOCKED, WEEK_STATUS.CANCELLED];

/**
 * 把周行的时间锚点对齐到当前 KV 配置。
 *
 * ⚠️ 为什么必须刷新：学生端能不能提交看的是 `songWindow.status()`（**实时读配置**），
 * 而周状态推进、`canCrossSlot()` 闸门、`sweep()` 的锁定时刻看的是**周行快照**。
 * 不刷新的话，管理员改完窗口会出现「学生已经能按新窗口提交了，但这一周的
 * 锁定时刻/审核截止还是旧的」这种自相矛盾的状态。
 * 已进入排期（SCHEDULING 及以上）的周不动 —— 那时锚点已被用作调度依据。
 */
async function refreshAnchors(week, weekStartMs, now) {
  if (ANCHOR_FROZEN_STATUS.includes(week.status)) return week;
  const a = await anchorOf(weekStartMs, now);
  const ms = (v) => (v ? +new Date(v) : null);
  const keys = ['applicationStartAt', 'applicationEndAt', 'reviewStartAt', 'scheduleLockAt', 'reviewEndAt'];
  if (keys.every((k) => ms(week[k]) === +a[k])) return week;
  console.log(`[songSchedule] 周 ${week.weekStartDate} 时间锚点跟随配置刷新`);
  const patch = {};
  keys.forEach((k) => { patch[k] = a[k]; });
  patch.updateTime = new Date();
  await updateById(C.WEEKLY, week._id, patch);
  return { ...week, ...patch };
}

/**
 * 取（必要时创建）某个播出周的排期行。
 * 懒创建：不需要管理员先「创建下周排期」，第一次有人提到这一周就自动建。
 */
async function ensureWeek(weekStartMs, { now = Date.now(), createdBy = null } = {}) {
  const dateStr = bj.ymd(bj.shifted(weekStartMs));
  let week = await findOne(C.WEEKLY, { weekStartDate: dateStr });

  if (!week) {
    const anchor = await anchorOf(weekStartMs, now);
    const id = await nextId(C.WEEKLY);
    try {
      await insertWithId(C.WEEKLY, weekDocId(dateStr), {
        id,
        weekStartDate: dateStr,
        ...anchor,
        status: WEEK_STATUS.DRAFT,
        lockPaused: 0,
        createdBy: createdBy || null,
        createTime: new Date(),
        updateTime: new Date(),
      });
    } catch (e) {
      // 并发下另一个请求刚建好 → 走下面的重读，别报错
      console.warn(`[songSchedule] 周行 ${dateStr} 并发创建：${e.message}`);
    }
    week = await findOne(C.WEEKLY, { weekStartDate: dateStr });
    if (!week) throw new Error(`weekly_schedule 创建失败：${dateStr}`);
  } else {
    week = await refreshAnchors(week, weekStartMs, now);
  }

  const next = deriveWeekStatus(week, now);
  if (next !== week.status) {
    await updateById(C.WEEKLY, week._id, { status: next, updateTime: new Date() });
    week = { ...week, status: next };
  }
  return week;
}

/** 按某个时段值拿它所属周的排期行 */
async function ensureWeekOfValue(value, opts = {}) {
  const ws = weekStartOfValue(value);
  if (!ws) return null;
  return ensureWeek(ws.getTime(), opts);
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
    // 审核截止（= 锁定时刻）：2026-09-25 起独立配置，前端别再拿 lockAt − applicationEndAt 反算偏移
    reviewEndAt: week.reviewEndAt ? songWindow.toBjsIso(new Date(+new Date(week.reviewEndAt))) : null,
    scheduleLockAt: lock ? songWindow.toBjsIso(new Date(lock)) : null,
    lockedAt: week.lockedAt ? songWindow.toBjsIso(new Date(+new Date(week.lockedAt))) : null,
    lockText: lock ? songWindow.toBjsIso(new Date(lock)) : null,
    secondsToLock: lock ? Math.max(0, Math.round((lock - now) / 1000)) : null,
    canApply: week.status === WEEK_STATUS.APPLICATION,
    locked: week.status === WEEK_STATUS.LOCKED,
    /** 已解锁 → 自动锁定暂停中（`sweep()` 不会把它锁回去），只有超管手动锁能恢复 */
    lockPaused: Number(week.lockPaused) === 1,
    /** 能不能解锁：只有真正锁定中的周才有意义 */
    unlockable: week.status === WEEK_STATUS.LOCKED,
  };
}

/**
 * 点播截止闸门：`now >= applicationEndAt` 才允许跨时段调剂。
 * ⚠️ 点播未截止时，即使「接受调剂」也只能等首选格自己空出来 —— 否则
 *    学生一边还在投这首歌、系统一边已经把它挪走，语义就乱了。
 * `lockWeek()` 与超管手动「执行排期」绕过这个闸门（显式传 crossSlot）。
 */
function canCrossSlot(week, now = Date.now()) {
  const end = week && week.applicationEndAt ? +new Date(week.applicationEndAt) : 0;
  return end > 0 && now >= end;
}

/* ------------------------------------------------------------------ *
 * 排期算法（阶段 5）
 * ------------------------------------------------------------------ */
/**
 * ⚠️⚠️ 周行更新必须走这里 —— **内存同步不可省**。
 *
 * 源实现里 `week` 是 Sequelize **实例**，`await week.update(patch)` 之后实例自身
 * 就是新值，紧接着读 `week.status` 拿到的是新数据（`cancelWeek` 就靠这个
 * 直接 `return weekView(week, now)`）。
 *
 * 云端 `week` 是**普通对象**，`updateById` 只改数据库、内存对象纹丝不动 ——
 * 漏了 `Object.assign` 就会「返回值悄悄是旧状态」，而且**不报任何错**。
 */
async function applyWeekPatch(week, patch) {
  await updateById(C.WEEKLY, week._id, { ...patch, updateTime: new Date() });
  Object.assign(week, patch);
  return week;
}

/** 写一条排期变动日志（失败只 warn，不影响主流程 —— 与源一致） */
async function logAssignment(requestId, fromSlot, toSlot, type, reason, operatorId = null) {
  try {
    const id = await nextId(C.ASSIGNMENT_LOG);
    await insertOne(C.ASSIGNMENT_LOG, {
      id,
      requestId,
      fromSlot: fromSlot || null,
      toSlot: toSlot || null,
      assignmentType: type,
      reason: reason || null,
      operatorId: operatorId || null,
      createTime: new Date(),
    });
  } catch (e) {
    console.log(`[songSchedule] 排期日志写入失败 #${requestId}：${e.message}`);
  }
}

/**
 * ① 第一轮排期 InitialAllocator
 *
 * 对每个时段：取「审核已通过 + 还没排期 + 首选就是这一格」的候选，
 * 按提交时间升序，前 capacity 个拿到正式位，其余进 WAITING。
 *
 * 幂等：候选条件带 scheduleStatus = UNASSIGNED，重复跑只命中更少行。
 * @returns {Promise<{assigned:number, waiting:number, weekId:number}>}
 */
async function initialAllocate(weekStartMs, { now = Date.now(), operatorId = null, dryRun = false } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  const values = await slotValuesOfWeek(weekStartMs);
  const capacity = await getCapacity();
  const res = { weekId: week.id, assigned: 0, waiting: 0, actions: [] };

  const counters = await countSeatedBySlot(values);

  for (const value of values) {
    let left = capacity > 0 ? Math.max(0, capacity - (counters[value] || 0)) : Infinity;

    const candidates = await findAllPaged(
      C.SUBMIT,
      {
        type: 1,
        reviewStatus: S.REVIEW.APPROVED,
        scheduleStatus: S.SCHEDULE.UNASSIGNED,
        wantBroadcastTime: value,
      },
      { orderBy: [['createTime', 'asc'], ['id', 'asc']] }
    );
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
          }, { operatorId, operatorName: operatorId ? 'ADMIN' : 'SYSTEM', reason: S.SYSTEM_REASON.initial });
          if (r.logs.length) await logAssignment(row.id, null, value, ASSIGN.INITIAL, ASSIGN_REASON.INITIAL, operatorId);
        }
        res.assigned += 1;
        if (left !== Infinity) left -= 1;
      } else {
        if (dryRun) {
          res.actions.push({ action: 'WAITING', id: row.id, songName: row.songName, want: value, to: null, cost: null });
          res.waiting += 1;
        } else {
          const r = await S.applyChange(row, { scheduleStatus: S.SCHEDULE.WAITING }, {
            operatorId, operatorName: 'SYSTEM', reason: 'ORIGINAL_SLOT_FULL',
          });
          if (r.logs.length) res.waiting += 1;
        }
      }
    }
  }

  if (!dryRun) {
    if (week.status !== WEEK_STATUS.LOCKED && week.status !== WEEK_STATUS.CANCELLED) {
      await applyWeekPatch(week, { status: WEEK_STATUS.SCHEDULING });
    }
    console.log(`[songSchedule] 第一轮排期 周${week.weekStartDate}：落座 ${res.assigned}、候补 ${res.waiting}`);
  }
  return res;
}

/**
 * ② 全局调剂 RescheduleAllocator
 *
 * 协议 §17：执行全局调剂
 *   1. 获取所有空位
 *   2. 候选 = 审核通过 + WAITING
 *   3. 排序：可接受位置少的优先 → 提交时间早的优先 → 距原时段近的优先
 *   4. 分配并写 assignment_log
 *
 * 「距原时段近」用《V1 规格》第 10 节的**成本表**（`songRescheduleCost`）：
 *   同一天其他时段 10 / 前后一天相同时段 20 / 前后一天其他时段 30 / 更远日期 50。
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.crossSlot] true=允许跨时段，false=只做原位递补，
 *                                   null / 省略 = 按「点播是否已截止」自动判断
 * @param {boolean} [opts.dryRun]    只算不写库（模拟排期预览），动作清单在 actions 里
 * @returns {Promise<{weekId, promoted, rescheduled, left, crossSlot, actions}>}
 */
async function reschedule(weekStartMs, { now = Date.now(), operatorId = null, crossSlot = null, dryRun = false } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  const values = await slotValuesOfWeek(weekStartMs);
  const capacity = await getCapacity();
  const indexOf = new Map(values.map((v, i) => [v, i]));
  const allowCross = crossSlot === null ? canCrossSlot(week, now) : !!crossSlot;
  const res = { weekId: week.id, promoted: 0, rescheduled: 0, left: 0, crossSlot: allowCross, actions: [] };

  const counters = await countSeatedBySlot(values);
  const free = new Set(
    capacity > 0 ? values.filter((v) => (counters[v] || 0) < capacity) : values
  );

  const candidates = await findAllPaged(
    C.SUBMIT,
    {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: _.in(values),
    },
    { orderBy: [['createTime', 'asc'], ['id', 'asc']] }
  );
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
        operatorId,
        operatorName: operatorId ? 'ADMIN' : 'SYSTEM',
        reason: isSame ? S.SYSTEM_REASON.rescheduleOk : ASSIGN_REASON.originalFull,
      });
      if (!r.logs.length) continue;              // 并发被别人改过 → 跳过

      await logAssignment(
        row.id, want, target,
        isSame ? ASSIGN.PROMOTED : ASSIGN.RESCHEDULED,
        isSame ? S.SYSTEM_REASON.rescheduleOk : ASSIGN_REASON.originalFull,
        operatorId
      );
    }
    if (isSame) res.promoted += 1; else res.rescheduled += 1;

    if (capacity > 0) {
      counters[target] = (counters[target] || 0) + 1;
      if (counters[target] >= capacity) free.delete(target);
    }
  }

  if (!dryRun && (res.promoted || res.rescheduled)) {
    console.log(`[songSchedule] 调剂 周${week.weekStartDate}${allowCross ? '' : '（点播未截止·仅原位递补）'}：原位递补 ${res.promoted}、跨时段调剂 ${res.rescheduled}、仍未安排 ${res.left}`);
  }
  return res;
}

/** 释放位子之后统一调用：原位递补 + 全局调剂（幂等） */
async function runAllocators(weekStartMs, opts = {}) {
  try {
    const r = await reschedule(weekStartMs, opts);
    return r;
  } catch (e) {
    console.log(`[songSchedule] 调剂失败（下次审核 / 手动 sweep 会重试）：${e.message}`);
    return { promoted: 0, rescheduled: 0, left: 0, error: e.message };
  }
}

/** 释放某条记录占的位子 → 对归属周跑一次调剂 */
async function afterRelease(row, opts = {}) {
  const ws = weekStartOfRow(row);
  if (!ws) return { promoted: 0, rescheduled: 0, left: 0 };
  return runAllocators(ws.getTime(), opts);
}

/**
 * ③ 正式锁定 Lock（协议 §18）
 *
 * 检查是否到锁定时间 → 执行最后一次调度 → WAITING → AUTO_REJECTED → 周 = LOCKED
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
  // 锁定时**显式**放开跨时段 —— 到了这一步点播早已截止，不可能再有新申请者
  await initialAllocate(weekStartMs, { now, operatorId });
  const alloc = await reschedule(weekStartMs, { now, operatorId, crossSlot: true });

  // 剩下仍是 WAITING 的 → AUTO_REJECTED
  // ⚠️ 云数据库的顶层 `_.or` 子项是 **where 子句**（见 harness 里 matchesWhere 的注释）
  const values = await slotValuesOfWeek(weekStartMs);
  const waiting = await findAllPaged(C.SUBMIT, _.and([
    { type: 1, reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.WAITING },
    _.or([
      { wantBroadcastTime: _.in(values) },
      { scheduledSlot: _.in(values) },
    ]),
  ]));
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

  await applyWeekPatch(week, { status: WEEK_STATUS.LOCKED, lockedAt: new Date(now), lockPaused: 0 });
  console.log(`[songSchedule] 周 ${week.weekStartDate} 已锁定：最后调度 ${alloc.promoted + alloc.rescheduled} 条，无位自动驳回 ${rejected} 条`);
  return { ...weekView(await findById(C.WEEKLY, week._id), now), already: false, rejected, lastAlloc: alloc };
}

/**
 * 解锁（撤销锁定）—— 超管专用，给「锁错了 / 锁完发现还要改」兜底。
 *
 * 做三件事：
 *   ① 周退回 `SCHEDULING`（可继续人工调整、可重跑排期）；
 *   ② **恢复本次锁定时被系统自动驳回的候补** —— 退回 `WAITING`，清掉 `reject_reason`
 *      与 `auto_rejected` 标记。只恢复「当时是系统驳回、且现在仍原封不动」的那些
 *      （`schedule_status` 还是 AUTO_REJECTED），管理员后来手动动过的一概不碰。
 *      不想恢复就传 `restore: false`（此时这些人会永久停在已驳回，慎用）。
 *   ③ `lock_paused = 1` —— ⚠️ 这一步不能省：`sweep()` 的自动锁定只看
 *      `now >= schedule_lock_at`，而解锁发生在锁定时刻之后，不拦住的话
 *      下一轮 sweep（定时器/手动）会立刻把它锁回去，解锁等于没做。
 *      恢复自动锁定只能靠超管**手动**重新锁定（`lockWeek` 里会清 0）。
 *
 * ⚠️ 锚点不动：解锁后状态是 SCHEDULING，而 SCHEDULING 属于 `ANCHOR_FROZEN_STATUS`，
 * `refreshAnchors()` 不会拿新配置覆盖它 —— 这一周的调度依据必须保持原样。
 */
async function unlockWeek(weekStartMs, { now = Date.now(), operatorId = null, restore = true } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  if (week.status !== WEEK_STATUS.LOCKED) {
    throw Object.assign(new Error('这一周没有锁定，无需解锁'), { code: 40001 });
  }

  // ② 恢复被自动驳回的候补
  let restored = 0;
  if (restore) {
    const values = await slotValuesOfWeek(weekStartMs);
    const rows = await findAllPaged(C.SUBMIT, _.and([
      {
        type: 1,
        reviewStatus: S.REVIEW.APPROVED,
        scheduleStatus: S.SCHEDULE.AUTO_REJECTED,
        autoRejected: 1,
        rejectReason: S.SYSTEM_REASON.lockedNoSlot,
      },
      _.or([
        { wantBroadcastTime: _.in(values) },
        { scheduledSlot: _.in(values) },
      ]),
    ]));
    for (const row of rows) {
      const r = await S.applyChange(row, {
        scheduleStatus: S.SCHEDULE.WAITING,
        rejectReason: null,
        autoRejected: 0,
      }, { operatorId, reason: 'WEEK_UNLOCKED_RESTORE_WAITING' });
      if (r.logs.length) restored += 1;
    }
  }

  await applyWeekPatch(week, { status: WEEK_STATUS.SCHEDULING, lockedAt: null, lockPaused: 1 });
  console.log(`[songSchedule] 周 ${week.weekStartDate} 已解锁：恢复候补 ${restored} 条，自动锁定暂停`);
  return {
    ...weekView(await findById(C.WEEKLY, week._id), now),
    already: false,
    restored,
    lockPaused: true,
  };
}

/** 取消某一周的排期（管理员操作，未开始播出的周） */
async function cancelWeek(weekStartMs, { now = Date.now(), operatorId = null } = {}) {
  const week = await ensureWeek(weekStartMs, { now });
  if (week.status === WEEK_STATUS.LOCKED) {
    throw Object.assign(new Error('这一周已经锁定，不能取消'), { code: 40001 });
  }
  await applyWeekPatch(week, { status: WEEK_STATUS.CANCELLED });
  return weekView(week, now);
}

/* ------------------------------------------------------------------ *
 * ④ 播放标记
 * ------------------------------------------------------------------ */
/**
 * 播出时刻已过的「已排期」→ 已播放（幂等）
 * 播出时刻 = 时段值里的日期 + 时刻（北京时间）
 *
 * ⚠️⚠️ 本函数是**批量** UPDATE，是全项目唯一**不用** `applyChange` 的改状态路径
 *    （源实现就是 `Submit.update(patch, { where: { id: { [Op.in]: due } } })`）。
 *    两点必须如实保留、不要「顺手修正」：
 *      ① **不带** reviewStatus/scheduleStatus/playStatus 守卫 —— 加了会改变
 *         `affectedRows` 的语义（原实现没有守卫）；
 *      ② **不写** `request_status_log`（只有 `applyChange` 才写状态日志）。
 *
 * ⚠️ 云端差异：`_.in(due)` 的数组长度受**单次命令体大小**限制，故按 100 一批切分，
 *    累加 `updated`（结果与一次性 UPDATE 等价）。
 */
async function markPlayed({ now = Date.now() } = {}) {
  const rows = await findAllPaged(C.SUBMIT, {
    type: 1,
    reviewStatus: S.REVIEW.APPROVED,
    scheduleStatus: S.SCHEDULE.APPROVED,
    playStatus: S.PLAY.NOT_PLAYED,
  });
  const due = [];
  rows.forEach((r) => {
    const t = instantOfValue(r.scheduledSlot);
    if (t !== null && now >= t) due.push(r.id);
  });
  if (!due.length) return { played: 0 };

  const patch = S.patchWithDerivedStatus({
    reviewStatus: S.REVIEW.APPROVED,
    scheduleStatus: S.SCHEDULE.APPROVED,
    playStatus: S.PLAY.PLAYED,
    playedAt: new Date(now),
  });
  let n = 0;
  const CHUNK = 100;
  for (let i = 0; i < due.length; i += CHUNK) {
    n += await updateWhere(C.SUBMIT, { id: _.in(due.slice(i, i + CHUNK)) }, patch);
  }
  if (n) console.log(`[songSchedule] 标记已播放 ${n} 条`);
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
 * ⑥ 兜底 sweep（管理端手动触发 / 定时器 → 阶段 6 改触发器）
 * ------------------------------------------------------------------ */
/**
 * 全量兜底（幂等）：
 *   ① 对每个「还有活着的点歌」的周：跑第一轮排期 + 调剂
 *   ② 到锁定时刻的周 → 锁定（最后调度 + AUTO_REJECTED）
 *   ③ 播出时刻已过的 → 标记已播放
 *
 * ⚠️⚠️ 第 ② 步必须**独立于第 ① 步**扫一遍 `weekly_schedule`：
 *    如果只看「还有 UNASSIGNED/WAITING 的周」，那么「所有点歌早就排好了、
 *    一条候补都不剩」的周永远不会进入循环，也就永远锁不上 ——
 *    而周锁不上，`play_status` 与「排期已定稿」的展示就全都不对。
 *
 * ⚠️ 原实现用 `attributes: ['week_start_date']` 做投影，云端不支持字段投影 →
 *    `findAllPaged` 全字段返回。**但字段名必须改成驼峰 `weekStartDate`** ——
 *    写成 `week_start_date` 会得到 `undefined` → `msOfWeekStartDate` 返回 null
 *    → 那一周被静默跳过 → 永远锁不上，且不报任何错。
 */
async function sweep({ now = Date.now(), operatorId = null } = {}) {
  const result = { weeks: [], played: 0 };

  // ── 收集要处理的周 ──
  const weekMsSet = new Set();

  const alive = await findAllPaged(C.SUBMIT, {
    type: 1,
    scheduleStatus: _.in([S.SCHEDULE.UNASSIGNED, S.SCHEDULE.WAITING]),
  });
  alive.forEach((r) => {
    const ws = weekStartOfRow(r);
    if (ws) weekMsSet.add(ws.getTime());
  });

  // 已经建了周行、但还没锁定 / 取消的周（不管里面还有没有点歌）
  const openWeeks = await findAllPaged(C.WEEKLY, {
    status: _.in([WEEK_STATUS.DRAFT, WEEK_STATUS.APPLICATION, WEEK_STATUS.REVIEW, WEEK_STATUS.SCHEDULING]),
  });
  openWeeks.forEach((w) => {
    const ms = msOfWeekStartDate(w.weekStartDate);
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
    } else if (lockAt && now >= lockAt && Number(week.lockPaused) === 1) {
      // ⚠️ 已解锁的周：到点了也**不自动锁**，否则解锁后一眨眼又锁回去。
      // 仍然跑一遍排期（空位照补），只是不再走「锁定 + 自动驳回」那一步。
      entry.lockPaused = true;
      const a = await initialAllocate(wsMs, { now, operatorId });
      const b = await reschedule(wsMs, { now, operatorId });
      entry.assigned = a.assigned;
      entry.waiting = a.waiting;
      entry.promoted = b.promoted;
      entry.rescheduled = b.rescheduled;
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

/* ------------------------------------------------------------------ *
 * 候补读路径
 * ------------------------------------------------------------------ */
/** 候选池 / 候补队列快照（管理端与候补卡用） */
async function waitingSnapshot(weekStartMs, now = Date.now()) {
  const week = await ensureWeek(weekStartMs, { now });
  const allowCross = canCrossSlot(week, now);
  const values = await slotValuesOfWeek(weekStartMs);
  const rows = await findAllPaged(
    C.SUBMIT,
    {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: _.in(values),
    },
    { orderBy: [['createTime', 'asc'], ['id', 'asc']] }
  );
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
      // 点播未截止时即使「接受调剂」也去不了别处 —— 只能等首选格自己空出来
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
  const rows = await findAllPaged(
    C.SUBMIT,
    {
      type: 1,
      reviewStatus: S.REVIEW.APPROVED,
      scheduleStatus: S.SCHEDULE.WAITING,
      wantBroadcastTime: _.in(values),
    },
    { orderBy: [['createTime', 'asc'], ['id', 'asc']] }
  );
  const i = rows.findIndex((r) => Number(r.id) === Number(row.id));
  const pos = i < 0 ? 1 : i + 1;
  return { pos, ahead: Math.max(0, pos - 1), total: rows.length };
}

/* ------------------------------------------------------------------ *
 * 阶段 5 完成
 * ------------------------------------------------------------------ */
/**
 * ✅ 排期算法 12 个函数**已全部移植完成**（2026-09-28）。
 *
 * 原先这里有一组「一调就抛清晰错误」的占位函数（`NOT_PORTED_YET`），
 * 现在已随阶段 5 收尾**全部拆除** —— 保留空壳只会变成误导。
 *
 * 阶段 6 待办（**不在本文件范围**）：把原 `songQueueService.startScheduler()`
 * 的 60 秒 `setInterval` 换成云开发的**定时触发器**（云函数无常驻进程），
 * 触发器只需调 `sweep()` 一处。
 */

module.exports = {
  // 常量
  DAYS_PER_WEEK,
  KV_LOCK_OFFSET,
  DEFAULT_LOCK_OFFSET_MINUTES,
  WEEK_STATUS,
  WEEK_STATUS_CN,
  ASSIGN,
  ASSIGN_REASON,
  ANCHOR_FROZEN_STATUS,
  weekDocId,
  // 时间与格子
  datePartOf,
  instantOfValue,
  weekStartOfValue,
  weekStartOfRow,
  slotValuesOfWeek,
  msOfWeekStartDate,
  // 容量 / 占位
  getCapacity,
  weekCapacity,
  seatedWhere,
  countSeated,
  countSeatedBySlot,
  isSeated,
  // 周
  getLockOffsetMinutes,
  anchorOf,
  deriveWeekStatus,
  refreshAnchors,
  ensureWeek,
  ensureWeekOfValue,
  weekView,
  canCrossSlot,
  // 候补读路径
  waitingSnapshot,
  waitingPosOf,
  // ── 排期算法（阶段 5 · 已全部落地）──
  logAssignment,
  initialAllocate,
  reschedule,
  runAllocators,
  afterRelease,
  lockWeek,
  unlockWeek,
  cancelWeek,
  markPlayed,
  setPlayed,
  manualAssign,
  sweep,
};
