'use strict';

/**
 * 点歌时间窗口 —— 学生只在开放时间内能提交点歌（docs/song-queue-v2.md §6.6）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 规则（2026-09-25 改版：周内任选 + 审核截止独立）
 *   · 默认「周六 18:00 → 周日 18:00」，管理员在后台可改（PUT 仅超管）
 *   · 开始 / 结束星期**任选 周一 → 周日**（不再限定五六日），最长可铺满整周
 *   · **收歌截止 ≠ 审核截止**：收歌结束只停止收新歌；审核截止单独配（reviewDay/reviewTime），
 *     到点才自动排期 + 驳回剩余候补 + 锁定本周
 *   · 窗口外提交点歌 → 40907，不落库；文稿不受限
 *   · 窗口时间必须常驻展示在点歌模块 —— 所以这里同时给出
 *     open / opensAt / closesAt / windowText / rangeText，前端不许硬编码星期与时刻
 *
 * 时间口径（容易错，写死在这里）
 *   学生的目标播出周永远是「严格下一周」（bj.nextWeekRange），窗口必须**整体落在
 *   目标周的上一周之内**，否则同一窗口内的提交会被算成「投给不同的周」。
 *
 *     weekStart  = nextWeekRange(now).start        // 目标播出周的周一 00:00（北京时间）
 *     songWeek   = weekStart - 7 天                // 收歌周的周一 00:00（窗口只允许落在这里面）
 *     offMon(d)  = ((d===0 ? 7 : d) - 1)           // 周一→0 … 周日→6（从收歌周周一起算的天数）
 *     windowStart = songWeek + offMon(startDay) * 1 天 + startTime
 *     windowEnd   = songWeek + offMon(endDay)   * 1 天 + endTime
 *     reviewAt    = songWeek + offMon(reviewDay)*1 天 + reviewTime   // 未配置则退回 windowEnd + 偏移
 *
 *   ⚠️ 旧实现用 `offBack(d) = (1-d+7)%7` 从 weekStart 往回推，`offBack(周一)=0` 会让
 *      startDay=周一 的窗口落到**目标周本身** —— 语义直接崩。新公式对 7 天一致：
 *      `offMon(d) === 7 - offBack(d)`（d≠周一），所以旧白名单（五/六/日）算出的结果完全不变。
 *
 *   硬约束（保命）：`0 <= startOff < endOff <= 7 天`，即窗口不跨收歌周周一 00:00。
 *   全程用固定 +08:00 计算（bjTime），与容器 TZ 无关 —— 容器是 UTC，
 *   直接用 dayjs() 取「今天」会把日切点挪到北京时间早上 8 点。
 * ═══════════════════════════════════════════════════════════════════════
 */

const { ApiError, Codes } = require('../utils/response');
const bj = require('../utils/bjTime');
const kv = require('./kvService');

const KV_WINDOW = 'song_submit_window';
/** 审核截止未单独配置时的兜底偏移：收歌结束 + N 分钟（沿用历史口径） */
const KV_LOCK_OFFSET = 'song_lock_offset_minutes';
const DEFAULT_LOCK_OFFSET_MINUTES = 360;   // 6h → 旧默认窗口（周日 18:00）正好落到播出周周一 00:00

/**
 * 默认窗口：周六 18:00 → 周日 18:00（0=周日 … 6=周六，与 bj.WEEKDAY_CN 一致）
 * reviewDay / reviewTime = null 表示「审核截止未单独配置」→ 退回 `收歌结束 + 偏移`。
 * 刻意不做成具体值：这样升级到「审核截止独立」不会悄悄改变现网行为。
 */
const DEFAULT_WINDOW = {
  enabled: 1,
  startDay: 6,
  startTime: '18:00',
  endDay: 0,
  endTime: '18:00',
  reviewDay: null,
  reviewTime: null,
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 拼「每周X」用（每 + 周六 = 每周六，不要写成「每周周六」） */
const DAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
/** 管理端下拉用的全星期列表（周一在前，符合「周内任选」的读法） */
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, name: DAY_NAMES[day] }));
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = bj.DAY_MS;
/** 窗口 / 审核截止的偏移上限：不得跨过播出周周一 00:00（7 天 = 收歌周整周） */
const MAX_OFFSET_MS = 7 * DAY_MS;
const CACHE_TTL = 30 * 1000;               // 读缓存：窗口是热路径（每次提交都查）

let cache = null;
let cacheAt = 0;
function clearCache() { cache = null; cacheAt = 0; }

/* ------------------------------------------------------------------ *
 * 解析与归一化
 * ------------------------------------------------------------------ */
function parseDay(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : fallback;
}
function parseTime(v, fallback) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return HHMM.test(s) ? s : fallback;
}
function hhmmToMs(t) {
  const [h, m] = t.split(':').map(Number);
  return (h * 3600 + m * 60) * 1000;
}
function msToHhmm(ms) {
  return `${bj.pad2(Math.floor(ms / 3600000))}:${bj.pad2(Math.floor((ms % 3600000) / 60000))}`;
}

/** 从「收歌周周一 00:00」起算的偏移天数：周一→0、周二→1 … 周日→6（入参是 0=周日 的编码） */
function offMon(day) {
  const d = parseDay(day, 1);
  return (d === 0 ? 7 : d) - 1;
}

/** 星期 + 时刻 → 相对收歌周周一 00:00 的毫秒偏移（窗口与审核截止共用） */
function offsetOf(day, time) {
  return offMon(day) * DAY_MS + hhmmToMs(time);
}

/** 偏移毫秒 → 「周X HH:mm」（只用于报错文案，让管理员一眼看出错在哪天） */
function describeOffset(ms) {
  if (ms >= MAX_OFFSET_MS) return '播出周周一 00:00';
  const dayIdx = Math.min(6, Math.max(0, Math.floor(ms / DAY_MS)));
  const rest = ms - dayIdx * DAY_MS;
  const iso = dayIdx + 1;                       // 1=周一 … 7=周日
  return `${DAY_NAMES[iso === 7 ? 0 : iso]} ${msToHhmm(rest)}`;
}

/** 审核截止未配置时，收歌结束 + N 分钟的兜底偏移 */
async function getLockOffsetMinutes() {
  try {
    const n = parseInt(await kv.get(KV_LOCK_OFFSET, ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOCK_OFFSET_MINUTES;
  } catch (e) {
    return DEFAULT_LOCK_OFFSET_MINUTES;
  }
}

/** 可空星期：null / undefined / '' 一律归一成 null（= 未配置） */
function parseNullableDay(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}
/** 可空时刻：与 parseNullableDay 同规矩 */
function parseNullableTime(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return HHMM.test(s) ? s : null;
}

/** 把任意来源（KV 字符串 / 对象）归一化成合法配置；坏值逐项退回默认 */
function normalize(raw) {
  let src = raw;
  if (typeof raw === 'string') {
    try { src = JSON.parse(raw); } catch (e) { src = null; }
  }
  if (!src || typeof src !== 'object') src = {};
  const base = DEFAULT_WINDOW;
  const enabled = src.enabled === undefined || src.enabled === null
    ? base.enabled
    : (Number(src.enabled) ? 1 : 0);
  const reviewDay = parseNullableDay(src.reviewDay);
  const reviewTime = parseNullableTime(src.reviewTime);
  return {
    enabled,
    startDay: parseDay(src.startDay, base.startDay),
    startTime: parseTime(src.startTime, base.startTime),
    endDay: parseDay(src.endDay, base.endDay),
    endTime: parseTime(src.endTime, base.endTime),
    // 两个必须同时有效才算「配置了审核截止」，只有一个按未配置处理（避免半截配置）
    reviewDay: reviewDay !== null && reviewTime !== null ? reviewDay : null,
    reviewTime: reviewDay !== null && reviewTime !== null ? reviewTime : null,
  };
}

/* ------------------------------------------------------------------ *
 * 配置读写
 * ------------------------------------------------------------------ */
async function getConfig(now = Date.now()) {
  const nowTs = Date.now();               // 缓存一律按真实时间算（测试会注入假 now）
  if (cache && nowTs - cacheAt < CACHE_TTL) return cache;
  let cfg = DEFAULT_WINDOW;
  try {
    const raw = await kv.get(KV_WINDOW, '');
    cfg = raw ? normalize(raw) : DEFAULT_WINDOW;
  } catch (e) {
    // 读不到配置 ≠ 不限时间：宁可退回默认窗口（周六 18:00 → 周日 18:00），
    // 也别把窗口整个放开 —— 放开等于学生随时能投，管理员会莫名其妙收到一堆稿。
    cfg = DEFAULT_WINDOW;
  }
  cache = cfg;
  cacheAt = nowTs;
  return cache;
}

/**
 * 写入窗口配置（仅超管，路由层把关）
 * 校验不过一律抛 40001，绝不允许写进一个「学生投的周会跳变」的窗口
 */
async function setConfig(patch, adminId) {
  const cur = await getConfig();
  const merged = normalize({
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled,
    startDay: patch.startDay === undefined ? cur.startDay : patch.startDay,
    startTime: patch.startTime === undefined ? cur.startTime : patch.startTime,
    endDay: patch.endDay === undefined ? cur.endDay : patch.endDay,
    endTime: patch.endTime === undefined ? cur.endTime : patch.endTime,
    reviewDay: patch.reviewDay === undefined ? cur.reviewDay : patch.reviewDay,
    reviewTime: patch.reviewTime === undefined ? cur.reviewTime : patch.reviewTime,
  });

  // ① 显式传了非法值要报错，不能静默退回默认（否则管理员以为自己改成了）
  if (patch.startTime !== undefined && !HHMM.test(String(patch.startTime).trim())) {
    throw new ApiError(Codes.PARAM_ERROR, '开始时间格式必须是 HH:mm，如 18:00');
  }
  if (patch.endTime !== undefined && !HHMM.test(String(patch.endTime).trim())) {
    throw new ApiError(Codes.PARAM_ERROR, '结束时间格式必须是 HH:mm，如 18:00');
  }
  [['startDay', patch.startDay], ['endDay', patch.endDay], ['reviewDay', patch.reviewDay]].forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new ApiError(Codes.PARAM_ERROR, `星期（${k}）必须是 0（周日）到 6（周六）之间的整数`);
    }
  });
  if (patch.reviewTime !== undefined && patch.reviewTime !== null && patch.reviewTime !== ''
    && !HHMM.test(String(patch.reviewTime).trim())) {
    throw new ApiError(Codes.PARAM_ERROR, '审核截止时间格式必须是 HH:mm，如 22:00');
  }

  const startOff = offsetOf(merged.startDay, merged.startTime);
  const endOff = offsetOf(merged.endDay, merged.endTime);
  const offsetMinutes = await getLockOffsetMinutes();
  const reviewOff = await reviewOffsetOf(merged, offsetMinutes);

  if (merged.enabled) {
    // ② 窗口自身：不跨收歌周周一 00:00（offMon ≤ 6 + HH:mm < 24:00 ⇒ 结构上恒成立，这里仍显式兜一道）
    if (endOff > MAX_OFFSET_MS) {
      throw new ApiError(Codes.PARAM_ERROR, '窗口不得跨过播出周周一 00:00，请把结束时间提前');
    }
    if (startOff >= endOff) {
      throw new ApiError(
        Codes.PARAM_ERROR,
        `收歌结束必须晚于收歌开始（当前：${describeOffset(startOff)} → ${describeOffset(endOff)}）`
      );
    }
  }

  // ③ 审核截止：不得早于收歌结束、不得晚于播出周周一 00:00
  if (merged.reviewDay !== null) {
    if (reviewOff < endOff) {
      throw new ApiError(
        Codes.PARAM_ERROR,
        `审核截止不得早于收歌结束（当前：收歌结束 ${describeOffset(endOff)} / 审核截止 ${describeOffset(reviewOff)}）`
      );
    }
    if (reviewOff > MAX_OFFSET_MS) {
      throw new ApiError(Codes.PARAM_ERROR, '审核截止不得晚于播出周周一 00:00（即最晚周日 23:59）');
    }
  }

  await kv.set(KV_WINDOW, JSON.stringify(merged), '点歌时间窗口（JSON，管理员可在后台修改）');
  clearCache();
  return { ...merged, adminId: adminId || null };
}

/* ------------------------------------------------------------------ *
 * 窗口区间计算
 * ------------------------------------------------------------------ */
/**
 * 审核截止相对收歌周周一 00:00 的偏移
 *   ① 配了 reviewDay + reviewTime → 用配置值（新形态，管理员显式指定）
 *   ② 没配 + 窗口开启 → 收歌结束 + `song_lock_offset_minutes`（默认 360 分）—— 兼容旧口径，
 *      默认窗口（周六 18:00 → 周日 18:00）下正好等于播出周周一 00:00，升级不改行为
 *   ③ 没配 + 窗口关闭 → 播出周周一 00:00 兜底（窗口关了就没有「窗口结束」可加偏移）
 * ②③ 一律夹到 7 天以内，绝不让锁定时刻跨过播出周周一
 */
async function reviewOffsetOf(cfg, offsetMinutes) {
  if (cfg.reviewDay !== null && cfg.reviewTime) {
    return offsetOf(cfg.reviewDay, cfg.reviewTime);
  }
  if (!cfg.enabled) return MAX_OFFSET_MS;
  const minutes = offsetMinutes === undefined ? await getLockOffsetMinutes() : offsetMinutes;
  const endOff = offsetOf(cfg.endDay, cfg.endTime);
  return Math.min(endOff + minutes * 60000, MAX_OFFSET_MS);
}

/**
 * 窗口区间 —— 锚点＝**收歌周的周一 00:00**（= 目标播出周周一 00:00 − 7 天）
 * 窗口整体落在收歌周内 ⇒ 窗口内任意时刻 `nextWeekRange(now)` 恒等于同一个 weekStart，
 * 「投的是哪一周」永不跳变。
 */
function windowRangeAt(cfg, now = Date.now()) {
  const weekStart = bj.nextWeekRange(now).start;                 // 目标播出周的周一 00:00（绝对时刻）
  const songWeek = new Date(weekStart.getTime() - 7 * DAY_MS);   // 收歌周的周一 00:00
  const start = new Date(songWeek.getTime() + offsetOf(cfg.startDay, cfg.startTime));
  const end = new Date(songWeek.getTime() + offsetOf(cfg.endDay, cfg.endTime));
  return {
    start,
    end,
    weekStart,                                                   // 播出周周一 00:00
    weekEnd: new Date(weekStart.getTime() + 7 * DAY_MS),
    songWeek,                                                    // 收歌周周一 00:00
  };
}

/**
 * 完整锚点 = 收歌开始 / 收歌结束 / 审核截止（周行落库、管理端展示统一走这里）
 */
async function anchorRangeAt(cfg, now = Date.now()) {
  const rng = windowRangeAt(cfg, now);
  const reviewOff = await reviewOffsetOf(cfg);
  return {
    ...rng,
    reviewAt: new Date(rng.songWeek.getTime() + reviewOff),
    reviewOff,
  };
}

/** 北京时间 ISO 串（前端直接拿去算倒计时，不用猜时区） */
function toBjsIso(date) {
  const d = bj.shifted(date.getTime());
  return `${bj.ymd(d)}T${bj.pad2(d.getUTCHours())}:${bj.pad2(d.getUTCMinutes())}:${bj.pad2(d.getUTCSeconds())}+08:00`;
}
/** 给管理端看的区间文案：9/19 18:00 – 9/20 18:00 */
function shortRangeText(start, end) {
  const md = (dd) => `${bj.shifted(dd.getTime()).getUTCMonth() + 1}/${bj.shifted(dd.getTime()).getUTCDate()}`;
  const hm = (dd) => `${bj.pad2(bj.shifted(dd.getTime()).getUTCHours())}:${bj.pad2(bj.shifted(dd.getTime()).getUTCMinutes())}`;
  return `${md(start)} ${hm(start)} – ${md(end)} ${hm(end)}`;
}

/** 「每周六 18:00 – 周日 18:00」这类给用户看的文案（常驻展示在点歌模块） */
function windowTextOf(cfg) {
  if (!cfg.enabled) return '不限时间';
  // 起点带「每」、终点不带：每周六 18:00 – 周日 18:00（不要写成「每周周六」）
  return `每周${DAY_SHORT[cfg.startDay]} ${cfg.startTime} – ${DAY_NAMES[cfg.endDay]} ${cfg.endTime}`;
}

/** 审核截止文案：配了就报配置值，否则报实际生效的时刻（「收歌结束 + 偏移」算出来的那天） */
function reviewTextOf(cfg, reviewAt) {
  if (cfg.reviewDay !== null && cfg.reviewTime) {
    return `${DAY_NAMES[cfg.reviewDay]} ${cfg.reviewTime}`;
  }
  const d = bj.shifted(reviewAt.getTime());
  return `${DAY_NAMES[d.getUTCDay()]} ${bj.pad2(d.getUTCHours())}:${bj.pad2(d.getUTCMinutes())}`;
}

/**
 * 当前窗口状态（学生端 / 管理端展示用，也用于服务端判闸）
 * @returns {Promise<{
 *   enabled:boolean, open:boolean, start:string, end:string,
 *   opensAt:string|null, closesAt:string|null,
 *   secondsToOpen:number|null, secondsToClose:number|null,
 *   windowText:string, rangeText:string, serverNow:string,
 *   config:object
 * }>}
 */
async function status(now = Date.now()) {
  const cfg = await getConfig(now);
  const { start, end, reviewAt } = await anchorRangeAt(cfg, now);
  const base = {
    enabled: !!cfg.enabled,
    open: true,
    start: toBjsIso(start),
    end: toBjsIso(end),
    reviewAt: toBjsIso(reviewAt),        // 独立审核截止（收歌结束后才开始审这一轮）
    opensAt: null,
    closesAt: null,
    secondsToOpen: null,
    secondsToClose: null,
    windowText: windowTextOf(cfg),
    reviewText: reviewTextOf(cfg, reviewAt),
    rangeText: shortRangeText(start, end),
    serverNow: toBjsIso(new Date(now)),
    config: cfg,
  };

  if (!cfg.enabled) return base;   // 关闭窗口限制 = 一直开放

  if (now < start.getTime()) {
    return {
      ...base,
      open: false,
      opensAt: toBjsIso(start),
      closesAt: toBjsIso(end),
      secondsToOpen: Math.round((start.getTime() - now) / 1000),
    };
  }
  if (now < end.getTime()) {
    return {
      ...base,
      open: true,
      opensAt: toBjsIso(start),
      closesAt: toBjsIso(end),
      secondsToClose: Math.round((end.getTime() - now) / 1000),
    };
  }
  // 已过窗口：下一次开放 = 本周窗口 + 7 天
  const next = new Date(start.getTime() + 7 * bj.DAY_MS);
  return {
    ...base,
    open: false,
    opensAt: toBjsIso(next),
    closesAt: null,
    secondsToOpen: Math.round((next.getTime() - now) / 1000),
  };
}

/** 是否在开放时间内 */
async function isOpen(now = Date.now()) {
  const st = await status(now);
  return st.open;
}

/**
 * 提交前的硬闸（服务端唯一权威判定，不信前端）
 * 不在窗口内 → 抛 40907，data 带 opensAt / windowText，前端据此显示倒计时
 */
async function assertOpen(now = Date.now()) {
  const st = await status(now);
  if (st.open) return st;
  throw new ApiError(
    Codes.SONG_WINDOW_CLOSED,
    st.enabled ? `现在不在点歌时间段（${st.windowText}）` : '现在不在点歌时间段',
    200,
    { opensAt: st.opensAt, closesAt: st.closesAt, windowText: st.windowText, secondsToOpen: st.secondsToOpen }
  );
}

/** 管理端面板用：配置 + 状态 + 星期中文名 */
async function describe(now = Date.now()) {
  const st = await status(now);
  const rng = await anchorRangeAt(st.config, now);
  const followOffsetMinutes = await getLockOffsetMinutes();
  return {
    ...st,
    startDayName: DAY_NAMES[st.config.startDay],
    endDayName: DAY_NAMES[st.config.endDay],
    reviewDayName: st.config.reviewDay === null ? null : DAY_NAMES[st.config.reviewDay],
    /** 审核截止是否被单独配置过（false = 跟随「收歌结束 + 偏移」，升级前后行为一致） */
    reviewConfigured: st.config.reviewDay !== null,
    /** 「跟随」档位的偏移分钟数（管理端下拉文案用，别在前端硬编码 360） */
    followOffsetMinutes,
    reviewOff: rng.reviewOff,
    reviewOffText: describeOffset(rng.reviewOff),
    // 星期任选 周一 → 周日（v2 的白名单已废除）
    allowedDays: ALL_DAYS,
    allowedStartDays: ALL_DAYS,
    allowedEndDays: ALL_DAYS,
    dayNames: DAY_NAMES,
    maxSpanHours: MAX_OFFSET_MS / 3600000,
    note: '收歌截止只停止新提交；到审核截止系统才自动排期、把剩余候补驳回并锁定本周',
  };
}

module.exports = {
  KV_WINDOW,
  KV_LOCK_OFFSET,
  DEFAULT_WINDOW,
  DAY_NAMES,
  ALL_DAYS,
  ALLOWED_START_DAYS: ALL_DAYS.map((d) => d.day),   // @deprecated 兼容旧引用：已放开全周
  ALLOWED_END_DAYS: ALL_DAYS.map((d) => d.day),     // @deprecated
  MAX_OFFSET_MS,
  clearCache,
  normalize,
  offMon,
  offsetOf,
  describeOffset,
  getLockOffsetMinutes,
  reviewOffsetOf,
  windowRangeAt,
  anchorRangeAt,
  windowTextOf,
  reviewTextOf,
  shortRangeText,
  toBjsIso,
  getConfig,
  setConfig,
  status,
  isOpen,
  assertOpen,
  describe,
  // 供测试注入时间用
  _internals: { windowRangeAt, anchorRangeAt, hhmmToMs, msToHhmm, reviewOffsetOf },
};
