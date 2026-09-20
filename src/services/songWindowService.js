'use strict';

/**
 * 点歌时间窗口 —— 学生只在开放时间内能提交点歌（docs/song-queue-v2.md §6.6）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 规则（2026-09-20 用户定稿）
 *   · 默认「周六 18:00 → 周日 18:00」，管理员在后台可改（PUT 仅超管）
 *   · 窗口外提交点歌 → 40907，不落库；文稿不受限
 *   · 窗口结束时刻 = 审核截止时刻（同一个点，不再单独配定稿时间）
 *   · 窗口时间必须常驻展示在点歌模块 —— 所以这里同时给出
 *     open / opensAt / closesAt / windowText / rangeText，前端不许硬编码星期与时刻
 *
 * 时间口径（容易错，写死在这里）
 *   学生的目标播出周永远是「严格下一周」（bj.nextWeekRange），而窗口（周五/周六/周日）
 *   在周日 24:00 之前结束 —— 所以无论现在是周五、周六还是周日，
 *   算出的 nextWeekRange 都指向同一个目标周，窗口与该周一一对应：
 *
 *     weekStart = nextWeekRange(now).start          // 目标周的周一 00:00（北京时间）
 *     offBack(d) = (1 - d + 7) % 7                  // 周一=1；周日→1 天，周六→2 天，周五→3 天
 *     windowStart = weekStart - offBack(startDay) + startTime
 *     windowEnd   = weekStart - offBack(endDay)   + endTime
 *
 *   全程用固定 +08:00 计算（bjTime），与容器 TZ 无关 —— 容器是 UTC，
 *   直接用 dayjs() 取「今天」会把日切点挪到北京时间早上 8 点。
 * ═══════════════════════════════════════════════════════════════════════
 */

const { ApiError, Codes } = require('../utils/response');
const bj = require('../utils/bjTime');
const kv = require('./kvService');

const KV_WINDOW = 'song_submit_window';

/** 默认窗口：周六 18:00 → 周日 18:00（0=周日 … 6=周六，与 bj.WEEKDAY_CN 一致） */
const DEFAULT_WINDOW = {
  enabled: 1,
  startDay: 6,
  startTime: '18:00',
  endDay: 0,
  endTime: '18:00',
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 拼「每周X」用（每 + 周六 = 每周六，不要写成「每周周六」） */
const DAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SPAN_MS = 72 * 60 * 60 * 1000;   // 窗口最长 72 小时
const CACHE_TTL = 30 * 1000;               // 读缓存：窗口是热路径（每次提交都查）

/** 开始日必须落在周五/周六/周日 —— 否则窗口跨进周中，学生投的周会跳变 */
const ALLOWED_START_DAYS = [5, 6, 0];
/** 结束日只能是周六/周日 —— 必须早于目标周周一 00:00 */
const ALLOWED_END_DAYS = [6, 0];

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
  return {
    enabled,
    startDay: parseDay(src.startDay, base.startDay),
    startTime: parseTime(src.startTime, base.startTime),
    endDay: parseDay(src.endDay, base.endDay),
    endTime: parseTime(src.endTime, base.endTime),
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
  });

  // ① 显式传了非法值要报错，不能静默退回默认（否则管理员以为自己改成了）
  if (patch.startTime !== undefined && !HHMM.test(String(patch.startTime).trim())) {
    throw new ApiError(Codes.PARAM_ERROR, '开始时间格式必须是 HH:mm，如 18:00');
  }
  if (patch.endTime !== undefined && !HHMM.test(String(patch.endTime).trim())) {
    throw new ApiError(Codes.PARAM_ERROR, '结束时间格式必须是 HH:mm，如 18:00');
  }
  [['startDay', patch.startDay], ['endDay', patch.endDay]].forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new ApiError(Codes.PARAM_ERROR, '星期必须是 0（周日）到 6（周六）之间的整数');
    }
  });

  if (merged.enabled) {
    if (!ALLOWED_START_DAYS.includes(merged.startDay)) {
      throw new ApiError(
        Codes.PARAM_ERROR,
        '点歌开始日只能是周五、周六或周日 —— 窗口跨到周中会让「下一周」跳变，学生投错周'
      );
    }
    if (!ALLOWED_END_DAYS.includes(merged.endDay)) {
      throw new ApiError(
        Codes.PARAM_ERROR,
        '点歌结束日只能是周六或周日（必须早于目标播出周的周一 00:00）'
      );
    }
    const probe = Date.now();
    const r = windowRangeAt(merged, probe);
    const span = r.end.getTime() - r.start.getTime();
    if (span <= 0) {
      throw new ApiError(Codes.PARAM_ERROR, '结束时间必须晚于开始时间');
    }
    if (span > MAX_SPAN_MS) {
      throw new ApiError(Codes.PARAM_ERROR, '点歌窗口最长 72 小时，请缩短时间跨度');
    }
    if (r.end.getTime() > r.weekStart.getTime()) {
      throw new ApiError(Codes.PARAM_ERROR, '结束时间不得晚于目标播出周的周一 00:00');
    }
  }

  await kv.set(KV_WINDOW, JSON.stringify(merged), '点歌时间窗口（JSON，管理员可在后台修改）');
  clearCache();
  return { ...merged, adminId: adminId || null };
}

/* ------------------------------------------------------------------ *
 * 窗口区间计算
 * ------------------------------------------------------------------ */
function windowRangeAt(cfg, now = Date.now()) {
  const weekStart = bj.nextWeekRange(now).start;            // 目标播出周的周一 00:00（绝对时刻）
  const offBack = (day) => (1 - day + 7) % 7;               // 周一=1
  const start = new Date(weekStart.getTime() - offBack(cfg.startDay) * bj.DAY_MS + hhmmToMs(cfg.startTime));
  const end = new Date(weekStart.getTime() - offBack(cfg.endDay) * bj.DAY_MS + hhmmToMs(cfg.endTime));
  return { start, end, weekStart, weekEnd: new Date(weekStart.getTime() + 7 * bj.DAY_MS) };
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
  const { start, end } = windowRangeAt(cfg, now);
  const base = {
    enabled: !!cfg.enabled,
    open: true,
    start: toBjsIso(start),
    end: toBjsIso(end),
    opensAt: null,
    closesAt: null,
    secondsToOpen: null,
    secondsToClose: null,
    windowText: windowTextOf(cfg),
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
  return {
    ...st,
    startDayName: DAY_NAMES[st.config.startDay],
    endDayName: DAY_NAMES[st.config.endDay],
    allowedStartDays: ALLOWED_START_DAYS.map((d) => ({ day: d, name: DAY_NAMES[d] })),
    allowedEndDays: ALLOWED_END_DAYS.map((d) => ({ day: d, name: DAY_NAMES[d] })),
    dayNames: DAY_NAMES,
    maxSpanHours: MAX_SPAN_MS / 3600000,
    note: '窗口结束时刻 = 审核截止时刻：到点后未补位的候补与未审完的补位件会被系统自动驳回',
  };
}

module.exports = {
  KV_WINDOW,
  DEFAULT_WINDOW,
  DAY_NAMES,
  ALLOWED_START_DAYS,
  ALLOWED_END_DAYS,
  MAX_SPAN_MS,
  clearCache,
  normalize,
  windowRangeAt,
  windowTextOf,
  shortRangeText,
  toBjsIso,
  getConfig,
  setConfig,
  status,
  isOpen,
  assertOpen,
  describe,
  // 供测试注入时间用
  _internals: { windowRangeAt, hhmmToMs, msToHhmm },
};
