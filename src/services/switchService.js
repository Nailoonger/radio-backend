'use strict';

/**
 * 模块开关服务
 *  - 内存缓存 30 秒，避免每次写入都查 DB
 *  - 提供 isEnabled / assertEnabled（业务拦截用）
 *  - 提供 admin / user 端读 / 写接口
 */

const { SystemSwitch } = require('../models');
const { ApiError, Codes } = require('../utils/response');

const CACHE_TTL = 30 * 1000; // 30s
const cache = { expiresAt: 0, data: null };

/**
 * 加载所有开关（命中缓存则跳过 DB）
 * 返回 [{ key, value, desc }, ...]
 */
async function loadAll(force = false) {
  const now = Date.now();
  if (!force && cache.data && cache.expiresAt > now) {
    return cache.data;
  }
  const rows = await SystemSwitch.findAll({ order: [['key', 'ASC']] });
  const data = rows.map((r) => ({ key: r.key, value: r.value, desc: r.desc }));
  cache.data = data;
  cache.expiresAt = now + CACHE_TTL;
  return data;
}

function invalidate() {
  cache.data = null;
  cache.expiresAt = 0;
}

/**
 * 判断某个模块是否启用
 * 任何非 'off' 都视为 on（兼容旧值/未知值）
 */
function isEnabled(key) {
  if (!cache.data || cache.expiresAt < Date.now()) {
    // 同步读不到缓存，业务代码应当先调 ensureLoaded 预热
    return true;
  }
  const row = cache.data.find((r) => r.key === key);
  return !row || row.value !== 'off';
}

/**
 * 业务拦截：模块关闭时抛 ApiError
 */
function assertEnabled(key) {
  if (!isEnabled(key)) {
    throw new ApiError(Codes.MODULE_DISABLED, '该模块暂时关闭，请稍后再试');
  }
}

/**
 * 启动时预热缓存（失败不影响启动）
 */
async function ensureLoaded() {
  try { await loadAll(); } catch { /* 静默 */ }
}

/**
 * 代码内置的「已知开关」注册表。
 *
 * 用途：新加的开关在老库 / 新库里可能还没有对应的行，管理端就看不到、也就没法切换。
 *      这里按默认值补进管理端列表（**不主动写库**）。
 *
 * ⚠️ 为什么不直接写进 seed：switch.test.js 断言「默认 seed 恰好 4 条开关」，
 *    在代码里预置行会把那个数字顶成 5。放在这里展示，等管理员第一次切换时才真正落库。
 * ⚠️ 也刻意不进 loadAll()：业务判断用 isEnabled()，缺行时本来就算「开」，
 *    不需要为它多查一次库，用户端 switch/list 也不会因此多条数据。
 */
const KNOWN_SWITCHES = [
  { key: 'account_login_required', value: 'on', desc: '强制学号登录' },
  { key: 'home_song_schedule', value: 'on', desc: '小程序首页展示本周点歌排期' },
];

/**
 * 管理端：列出所有开关（含 desc / updatedBy / 时间）
 * DB 里已有的行以 DB 值为准，注册表里缺的补默认行
 */
async function listAll() {
  const { SystemSwitch } = require('../models');
  const rows = await SystemSwitch.findAll({ order: [['key', 'ASC']] });
  const seen = new Set(rows.map((r) => r.key));

  const list = rows.map((r) => ({
    key: r.key,
    value: r.value,
    desc: r.desc,
    updatedBy: r.updatedBy,
    // 模型属性是 updatedAt（列名 update_time），之前误写 r.updateTime 导致恒为 undefined
    updateTime: r.updatedAt,
  }));
  KNOWN_SWITCHES.forEach((s) => {
    if (!seen.has(s.key)) list.push({ ...s, updatedBy: null, updateTime: null });
  });
  list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return list;
}

/**
 * 管理端：更新某个开关
 */
async function set(key, value, adminId = null) {
  const { SystemSwitch } = require('../models');
  const [row, created] = await SystemSwitch.findOrCreate({
    where: { key },
    defaults: { key, value: 'on', desc: '' },
  });
  row.value = value;
  row.updatedBy = adminId;
  await row.save();
  invalidate();
  // 同步预热，让下一个请求立刻看到最新值（避免 30s 内不一致）
  await ensureLoaded();
  return row;
}

/**
 * 用户端：仅返回 key + value
 */
async function publicList() {
  const all = await loadAll();
  return all.map((r) => ({ key: r.key, value: r.value }));
}

async function publicGet(key) {
  const all = await loadAll();
  const row = all.find((r) => r.key === key);
  return row ? { key: row.key, value: row.value } : { key, value: 'on' };
}

module.exports = {
  ensureLoaded,
  isEnabled,
  assertEnabled,
  listAll,
  set,
  publicList,
  publicGet,
  invalidate,
};
