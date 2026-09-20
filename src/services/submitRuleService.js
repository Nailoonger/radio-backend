'use strict';

/**
 * 点歌提交规则（两条由管理员开关的硬约束，2026-09-18 需求）
 *
 * ① 单个同学每（ISO）周最多点 N 次歌
 *    - 默认 2；KV `song_weekly_user_limit`，填 0 = 不限制
 *    - 计数口径：本周**提交**的点歌条数，但
 *      **「因名额已满被系统自动驳回」的不计入** —— 那不是学生的错，不该占他的次数。
 *      人工驳回的算（那是他自己写的，占用一次机会合理）。
 *
 * ② 同一首歌一周内不可重复
 *    - 默认开；KV `song_dup_block`，填 0 = 关闭
 *    - 判定口径：本周内 type=1 且 **状态不是「已驳回」** 的记录里已经有同名歌
 *      —— 被驳回的没播出，理应允许再点（否则一次误投就把这首歌锁死一周）。
 *    - 比较用归一化歌名（全角→半角、去空白、忽略大小写）；库存原文不动。
 *    - ⚠️ 这是「查一次再写」的最佳努力校验：极端并发下两条同名投稿仍可能同时落库。
 *      同一个人 1 分钟内的重复投稿另有提交限流兜底；要 100% 唯一得上「周+歌名」维度的锁或唯一表。
 *
 * 时区：周界按北京时间（utils/bjTime），与容器 TZ 无关。
 */

const { Op } = require('sequelize');
const { Submit } = require('../models');
const bj = require('../utils/bjTime');
const kv = require('./kvService');

const KV_USER_LIMIT = 'song_weekly_user_limit';
const KV_DUP_BLOCK = 'song_dup_block';
const DEFAULT_USER_LIMIT = 2;
const CACHE_TTL = 15 * 1000;
const DEFAULT_RULES = { weeklyUserLimit: DEFAULT_USER_LIMIT, dupBlock: 1 };

let cache = null;
let cacheAt = 0;
function clearCache() { cache = null; cacheAt = 0; }

function parseLimit(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function getRules() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL) return cache;
  const m = await kv.getMany([KV_USER_LIMIT, KV_DUP_BLOCK]);
  cache = {
    weeklyUserLimit: parseLimit(m[KV_USER_LIMIT], DEFAULT_USER_LIMIT),
    dupBlock: parseLimit(m[KV_DUP_BLOCK], 1) ? 1 : 0,
  };
  cacheAt = now;
  return cache;
}

async function setRules({ weeklyUserLimit, dupBlock }) {
  const cur = await getRules();
  const limit = weeklyUserLimit === undefined
    ? cur.weeklyUserLimit
    : Math.max(0, parseInt(weeklyUserLimit, 10) || 0);
  const dup = dupBlock === undefined ? cur.dupBlock : (Number(dupBlock) ? 1 : 0);
  await kv.set(KV_USER_LIMIT, limit, '单个同学每周最多点歌次数（0=不限）');
  await kv.set(KV_DUP_BLOCK, dup, '同一首歌一周内不可重复（1=开 0=关）');
  clearCache();
  return getRules();
}

/** 本周区间（北京时间，左闭右开） */
function thisWeek(now = Date.now()) {
  return bj.weekRange(now);
}

/**
 * ① 本周个人次数是否还有额度
 * @returns {Promise<{ok:boolean, used:number, limit:number, remaining:number|null}>}
 */
async function checkUserWeeklyLimit(openid, now = Date.now()) {
  const { weeklyUserLimit: limit } = await getRules();
  if (!limit) return { ok: true, used: 0, limit: 0, remaining: null };
  const r = thisWeek(now);
  const used = await Submit.count({
    where: {
      openid,
      type: 1,
      autoRejected: 0,                     // 因名额满被系统驳掉的不算
      createTime: { [Op.gte]: r.start, [Op.lt]: r.end },
    },
  });
  return { ok: used < limit, used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * 歌名归一化（温和档，用于同曲去重比较；不改动库存的原文）：
 *   全角 → 半角（含全角空格）→ 去掉所有空白 → 转小写
 * 《晴天》/「晴 天 」/「ＱＲ」大写小写全角半角视为同一首。
 * 故意不做：去括号后缀、去标点、繁简转换 —— 定太狠容易误伤。
 */
function normalizeSongName(s) {
  let t = String(s || '');
  // 全角空格 U+3000 单独映射（它不在 FF01-FF5E 的偏移区间里，减 0xFEE0 会得到乱码）
  t = t.replace(/\u3000/g, ' ');
  // 其余全角 ASCII（!-~）折叠为半角
  t = t.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return t.replace(/\s+/g, '').toLowerCase();
}

/**
 * ② 本周是否已经有人点过这首歌（被驳回的不算占用）
 * 比较用归一化歌名：本周 type=1 且状态为待审/已通过的行数量很小（名额限着），
 * 取出来在 JS 里比，避免为归一化比较加列 / 迁移。
 * @returns {Promise<{ok:boolean, songName:string}>}
 */
async function checkSongDuplicate(songName, now = Date.now()) {
  const name = String(songName || '').trim();
  if (!name) return { ok: true, songName: name };
  const { dupBlock } = await getRules();
  if (!dupBlock) return { ok: true, songName: name };
  const r = thisWeek(now);
  const rows = await Submit.findAll({
    where: {
      type: 1,
      // v2：待审(0) / 已排期(1) / 候补中(3) / 已补位待审(4) 都算占用；已驳回(2) 不算
      //（候补也算占用，否则同一首歌可以堆满整个候补队列）
      status: { [Op.in]: [0, 1, 3, 4] },
      createTime: { [Op.gte]: r.start, [Op.lt]: r.end },
    },
    attributes: ['songName'],
  });
  const norm = normalizeSongName(name);
  const hit = norm && rows.some((row) => normalizeSongName(row.songName) === norm);
  return { ok: !hit, songName: name };
}

/** 提交前把两条规则一起过一遍（返回第一个不通过的原因） */
async function checkSubmit({ openid, songName }, now = Date.now()) {
  const dup = await checkSongDuplicate(songName, now);
  if (!dup.ok) {
    return { ok: false, code: 'SONG_DUPLICATED', message: `本周已经有人点过《${dup.songName}》了，换一首吧` };
  }
  const lim = await checkUserWeeklyLimit(openid, now);
  if (!lim.ok) {
    return { ok: false, code: 'USER_WEEKLY_LIMIT', message: `本周点歌次数已用完（每周最多 ${lim.limit} 次），下周再来吧` };
  }
  return { ok: true, weekly: lim };
}

module.exports = {
  KV_USER_LIMIT,
  KV_DUP_BLOCK,
  DEFAULT_USER_LIMIT,
  DEFAULT_RULES,
  getRules,
  setRules,
  normalizeSongName,
  checkUserWeeklyLimit,
  checkSongDuplicate,
  checkSubmit,
  clearCache,
};
