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
 * ⛔ **尚未移植（阶段 5：排期算法，最高风险，动工前需出方案给陛下过目）**：
 *      initialAllocate / reschedule / lockWeek / unlockWeek / cancelWeek
 *      markPlayed / setPlayed / manualAssign / runAllocators / afterRelease / sweep
 *      logAssignment
 *    这些是**改状态**的路径，依赖《V1 规格》的完整调度语义 + 跨文档一致性设计。
 *    这里导出的是**显式抛错**的占位函数（而不是干脆不导出）—— 不导出的话调用点
 *    会得到晦涩的 `xxx is not a function`，那种报错在云函数日志里几乎无法定位。
 *
 * ═══════════════ 云化改动 ═══════════════
 * ① weekly_schedule 的 `_id` 用业务键 `week:<week_start_date>`（见 lib/db.js 主键口径表），
 *    原表上的 UNIQUE(week_start_date) 由它天然承担；并发懒建撞键即失败 → 重读即可。
 * ② 去掉 `transaction` 参数（云数据库不支持跨文档事务）。本文件这些函数本来也只用它
 *    做「同一事务里读得到自己刚写的行」，而改成 `_id` 直查后这个需求消失了。
 * ③ 三处 `Submit.findAll({ group: ... })` → countByField；普通全量查询 → findAllPaged。
 * ④ `week.update(...)` → `updateById(...)` + 在内存对象上同步，保持调用方读字段是新值。
 */

const { C, _, findOne, findAllPaged, count, countByField, insertWithId, updateById, nextId } = require('../lib/db');
const bj = require('../lib/bjTime');
const kv = require('./kv');
const slotSvc = require('./broadcastSlot');
const songWindow = require('./songWindow');
const S = require('./songStatus');

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
 * 阶段 5 占位（排期算法）
 * ------------------------------------------------------------------ */
/**
 * ⛔ 这些函数改状态、依赖完整调度语义，**尚未移植**（阶段 5）。
 *
 * 刻意导出成「一调就抛清晰错误」而不是不导出：
 * 不导出的话调用点只会得到 `x is not a function`，在云函数日志里几乎无法定位是
 * 「还没做」还是「打包漏了」。
 */
const NOT_PORTED_YET = [
  'initialAllocate', 'reschedule', 'lockWeek', 'unlockWeek', 'cancelWeek',
  'markPlayed', 'setPlayed', 'manualAssign',
  'runAllocators', 'afterRelease', 'sweep',
];
const notPort = {};
NOT_PORTED_YET.forEach((name) => {
  notPort[name] = async () => {
    throw new Error(`[阶段5未移植] songScheduling.${name}() —— 排期算法属于阶段 5，需先出方案`);
  };
});

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
  // ⛔ 阶段 5 占位
  ...notPort,
  NOT_PORTED_YET,
};
