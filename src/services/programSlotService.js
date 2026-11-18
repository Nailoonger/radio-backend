'use strict';

/**
 * 栏目播出编排（时段 + 档位）
 *
 * 为什么需要这一层（2026-11-19 陛下定稿）：
 *   站里每天只有两个播出时段 —— 午间 12:10-12:30、晚间 17:40-18:10，**每个时段固定 3 档**
 *   （一天中午可能播 3 个栏目，晚上也是）。
 *   ⇒ 栏目不能只记「一个自由时间」，必须落在「哪个时段的第几档」上，
 *     同一天同一时段的 2-3 档才排得开、改得动。
 *
 * 存 KV `program_slots`（JSON）：
 *   [{ label:'午间', start:'12:10', end:'12:30', count:3 },
 *    { label:'晚间', start:'17:40', end:'18:10', count:3 }]
 *
 * ⚠️ 每档时长**不单独存**：由 (end-start)/count 四舍五入算出来，末档强制收在 end。
 *    这样"午间 20 分钟 3 档"能整除不了（6.67 分钟）也不会出现总长对不上的情况 ——
 *    改成 12:10-12:17 / 12:17-12:24 / 12:24-12:30（7+7+6=20）。
 *
 * ⚠️⚠️ 这里的时间**不是**节目单的最终真相：
 *    小程序端拿到的是"投影之后"的 broadcastDate（本周具体日期）+ broadcastTime（本档起止），
 *    见 expand()。库里存的是"每周几 + 哪个时段第几档"，这样改配置能立刻作用到所有栏目。
 */

const kv = require('./kvService');

const KV_SLOTS = 'program_slots';

/** 建站默认值 —— 与陛下口述一致：只有午间、晚间，各 3 档 */
const DEFAULT_SLOTS = [
  { label: '午间', start: '12:10', end: '12:30', count: 3 },
  { label: '晚间', start: '17:40', end: '18:10', count: 3 },
];

const MAX_SLOTS = 6;
const MAX_COUNT = 6;
const CACHE_TTL = 30 * 1000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

let cache = null;
let cacheAt = 0;

function clearCache() {
  cache = null;
  cacheAt = 0;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function toMin(hhmm) {
  const p = String(hhmm).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

function toHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** 归一化：非法项丢掉；按 start 升序；最多 MAX_SLOTS 个 */
function normalizeSlots(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const label = String(item.label || '').trim().slice(0, 4);
    const start = String(item.start || '').trim();
    const end = String(item.end || '').trim();
    if (!label || seen.has(label)) return;
    if (!HHMM.test(start) || !HHMM.test(end)) return;
    if (toMin(end) <= toMin(start)) return;
    const count = Math.max(1, Math.min(MAX_COUNT, parseInt(item.count, 10) || 1));
    seen.add(label);
    out.push({ label, start, end, count });
  });
  out.sort((a, b) => (toMin(a.start) - toMin(b.start)));
  return out.slice(0, MAX_SLOTS);
}

/**
 * 一个时段里的各档起止
 * @returns {Array<{index:number,start:string,end:string,text:string}>}
 */
function slotTicks(slot) {
  if (!slot) return [];
  const s = toMin(slot.start);
  const e = toMin(slot.end);
  const total = e - s;
  const n = Math.max(1, parseInt(slot.count, 10) || 1);
  if (total <= 0) return [];
  const dur = Math.max(1, Math.round(total / n));
  const out = [];
  for (let i = 0; i < n; i++) {
    const st = Math.min(s + i * dur, e - 1);
    const en = i === n - 1 ? e : Math.min(st + dur, e);
    out.push({
      index: i + 1,
      start: toHHMM(st),
      end: toHHMM(en),
      text: toHHMM(st) + '-' + toHHMM(en),
    });
  }
  return out;
}

/** 当前生效的编排（读不到 / 配坏了 → 回默认，功能不因此挂掉） */
async function getSlots() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;

  let list = [];
  try {
    const raw = await kv.get(KV_SLOTS, '');
    if (raw) list = normalizeSlots(JSON.parse(String(raw)));
  } catch (e) {
    list = [];
  }
  if (!list.length) list = DEFAULT_SLOTS.map((s) => ({ ...s }));

  cache = list;
  cacheAt = now;
  return cache;
}

/** 对外输出（带每档推算结果，后台直接渲染，不用在前端重算一遍） */
async function getSlotsWithTicks() {
  const list = await getSlots();
  return list.map((s) => ({
    label: s.label,
    start: s.start,
    end: s.end,
    count: s.count,
    minutes: toMin(s.end) - toMin(s.start),
    ticks: slotTicks(s),
  }));
}

/**
 * 保存编排
 * @returns {Promise<Array|null>} 归一化后的编排；**全是非法项时返回 null**
 *
 * ⚠️ 不在这里抛业务错误：本文件同时被 Express（`src/`）与云函数（`cloud/`）引用，
 *    两边的 ApiError 是**两个不同的类**。服务层抛出去，Express 的 errorHandler
 *    只认自己的 `ApiError` 实例 ⇒ 落到 500「服务器内部错误」；云函数则落 50001。
 *    于是「同一条校验，两端表现还不一样」。⇒ 由调用方（controller / handler）报 40001。
 */
async function setSlots(list) {
  const norm = normalizeSlots(list);
  if (!norm.length) return null;
  await kv.set(KV_SLOTS, JSON.stringify(norm), '栏目播出编排：每天几个时段、每段几档（JSON）');
  clearCache();
  return norm;
}

/* ------------------------------------------------------------------ *
 * 投影：把「每周几 + 第几档」展开成指定区间内的具体播出日
 *
 * 为什么必须做（这轮改动的真正成本所在）：
 *   `broadcast_date` 是小程序节目单 / 首页「今天 12:10 见」**唯一**的时间依据。
 *   库里改成「每周几」之后，那些按日期 between 的查询会一条都查不到 ——
 *   不报错、只是列表空了，这种静默失效最难发现。
 *   ⇒ 库里存周几，下发前展开成本周的具体日期，小程序与首页一行都不用改。
 * ------------------------------------------------------------------ */

/** '1,3,5' → [1,3,5]（1=周一 … 7=周日，非法值丢掉） */
function parseWeekdays(v) {
  return String(v || '')
    .split(',')
    .map((x) => parseInt(String(x).trim(), 10))
    .filter((n) => n >= 1 && n <= 7)
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => a - b);
}

/** YYYY-MM-DD → 1..7（周一=1，周日=7） */
function weekdayOf(dateStr) {
  const p = String(dateStr).split('-').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return 0;
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const dow = d.getUTCDay();          // 0=周日
  return dow === 0 ? 7 : dow;
}

/** [from, to] 闭区间的每一天 */
function datesBetween(from, to) {
  const out = [];
  if (!YMD.test(String(from)) || !YMD.test(String(to))) return out;
  const p = String(from).split('-').map(Number);
  let t = Date.UTC(p[0], p[1] - 1, p[2]);
  const end = Date.UTC(...String(to).split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  let guard = 0;
  while (t <= end && guard < 400) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
    t += 86400000;
    guard++;
  }
  return out;
}

/**
 * 把节目行展开成区间内的播出条目
 * @param {Array} rows   Program 模型实例或普通对象
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {Array}  slots 编排（默认自己读一次）
 * @returns {Array} 每条都是**普通对象**，broadcastDate / broadcastTime 已按目标日算好
 */
async function expand(rows, from, to, slots) {
  const cfg = slots || (await getSlots());
  const slotMap = {};
  const tickMap = {};
  cfg.forEach((s) => {
    slotMap[s.label] = s;
    tickMap[s.label] = slotTicks(s);
  });

  const days = datesBetween(from, to);
  const out = [];

  (rows || []).forEach((row) => {
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
    const isSpecial = Number(plain.isSpecial) === 1;

    if (isSpecial) {
      const d = String(plain.broadcastDate || '').slice(0, 10);
      if (d && d >= from && d <= to) {
        out.push({ ...plain, occurDate: d, occKey: `${plain.id}-${d}`, cyclic: 0 });
      }
      return;
    }

    const days7 = parseWeekdays(plain.weekdays);

    // 老数据（本次改造前录入的）没有 weekdays，退回按它自己的 broadcastDate 显示，
    // 不因为升级而丢内容；管理员下次编辑时会自然带上新字段。
    if (!days7.length) {
      const d = String(plain.broadcastDate || '').slice(0, 10);
      if (d && d >= from && d <= to) {
        out.push({ ...plain, occurDate: d, occKey: `${plain.id}-${d}`, cyclic: 0 });
      }
      return;
    }

    // 时间以**当前编排**为准重算：改了档数/时长，已排的栏目自动跟着走
    let timeText = plain.broadcastTime;
    const ticks = tickMap[plain.slotLabel];
    if (ticks && plain.slotIndex) {
      const hit = ticks.find((t) => t.index === Number(plain.slotIndex));
      if (hit) timeText = hit.text;
    }

    days.forEach((d) => {
      if (days7.indexOf(weekdayOf(d)) === -1) return;
      out.push({
        ...plain,
        broadcastDate: d,
        broadcastTime: timeText,
        occurDate: d,
        occKey: `${plain.id}-${d}`,
        cyclic: 1,
      });
    });
  });

  out.sort((a, b) => {
    if (a.occurDate !== b.occurDate) return a.occurDate < b.occurDate ? -1 : 1;
    const at = String(a.broadcastTime || '');
    const bt = String(b.broadcastTime || '');
    if (at !== bt) return at < bt ? -1 : 1;
    const ai = Number(a.slotIndex) || 0;
    const bi = Number(b.slotIndex) || 0;
    if (ai !== bi) return ai - bi;
    const as = Number(a.sort) || 0;
    const bs = Number(b.sort) || 0;
    if (as !== bs) return as - bs;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  return out;
}

/** 保存时按编排算出这条栏目自己的 broadcastTime（只做兜底，展示时仍以投影为准） */
function timeTextOf(slotLabel, slotIndex, slots) {
  const s = (slots || []).find((x) => x.label === slotLabel);
  if (!s) return '';
  const hit = slotTicks(s).find((t) => t.index === Number(slotIndex));
  return hit ? hit.text : '';
}

module.exports = {
  KV_SLOTS,
  DEFAULT_SLOTS,
  MAX_SLOTS,
  MAX_COUNT,
  getSlots,
  getSlotsWithTicks,
  setSlots,
  normalizeSlots,
  slotTicks,
  timeTextOf,
  parseWeekdays,
  weekdayOf,
  datesBetween,
  expand,
  clearCache,
};
