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
 * 管理端：列出所有开关（含 desc / updatedBy / 时间）
 */
async function listAll() {
  const { SystemSwitch } = require('../models');
  return SystemSwitch.findAll({ order: [['key', 'ASC']] });
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
