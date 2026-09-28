'use strict';

/**
 * 模块开关服务 —— 从 src/services/switchService.js 移植
 *
 * 语义完全保留：
 *  - 缺行视为 on（`!row || row.value !== 'off'`）
 *  - 用户端 publicList 只返回库里真实存在的开关（KNOWN_SWITCHES 只用于管理端列表展示）
 *  - listAll 把注册表里缺的补成默认行（**不写库**）
 *  - set() 惰性建行
 *
 * 缓存差异（有意为之）：
 *   原实现靠「单进程常驻 + 30s 内存缓存」。云函数实例会被回收、也会并发多实例，
 *   实例级缓存只对「同一次调用内的重复读」有意义，跨实例不保证一致。
 *   因此这里保留一个**极短 TTL 的实例内缓存**（默认 3s）来省掉同请求内的重复查询，
 *   但整体语义按「以库为准」处理——开关本来就不需要毫秒级一致。
 */

const { C, coll } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');

const CACHE_TTL = 3 * 1000;   // 仅实例内短期缓存，见上方说明
const cache = { expiresAt: 0, data: null };

async function loadAll(force = false) {
  const now = Date.now();
  if (!force && cache.data && cache.expiresAt > now) return cache.data;

  const r = await coll(C.SWITCH).limit(100).get();
  const data = (r.data || [])
    .map((row) => ({ key: row.key, value: row.value, desc: row.desc }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

  cache.data = data;
  cache.expiresAt = now + CACHE_TTL;
  return data;
}

function invalidate() {
  cache.data = null;
  cache.expiresAt = 0;
}

/** 任何非 'off' 都视为 on；缺行也视为 on */
function isEnabled(key) {
  if (!cache.data || cache.expiresAt < Date.now()) return true;   // 未预热时不拦（与原实现一致）
  const row = cache.data.find((r) => r.key === key);
  return !row || row.value !== 'off';
}

/** 业务拦截：模块关闭时抛 40302 */
function assertEnabled(key) {
  if (!isEnabled(key)) {
    throw new ApiError(Codes.MODULE_DISABLED, '该模块暂时关闭，请稍后再试');
  }
}

async function ensureLoaded() {
  try { await loadAll(true); } catch (e) { /* 静默：预热失败不影响业务 */ }
}

/**
 * 代码内置的「已知开关」注册表（只增不删）
 * ⚠️ 刻意不写进 seed、也不并入 loadAll：缺行即视为 on，无需为它多查一次库。
 */
const KNOWN_SWITCHES = [
  { key: 'account_login_required', value: 'on', desc: '强制学号登录' },
  { key: 'home_song_schedule', value: 'on', desc: '小程序首页展示本周点歌排期' },
];

/** 管理端：列出所有开关（DB 行 + 注册表补齐），按 key 升序 */
async function listAll() {
  const r = await coll(C.SWITCH).limit(100).get();
  const rows = (r.data || []).map((row) => ({
    key: row.key,
    value: row.value,
    desc: row.desc,
    updatedBy: row.updated_by,
    updateTime: row.update_time,
  }));

  const seen = new Set(rows.map((x) => x.key));
  KNOWN_SWITCHES.forEach((s) => {
    if (!seen.has(s.key)) rows.push({ ...s, updatedBy: null, updateTime: null });
  });
  rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return rows;
}

/** 管理端：更新某个开关（不存在则按默认 on 建行） */
async function set(key, value, adminId = null) {
  const id = `switch:${key}`;
  const patch = { key, value: String(value), updated_by: adminId, update_time: new Date() };
  let updated = 0;
  try {
    const r = await coll(C.SWITCH).doc(id).update({ data: patch });
    updated = (r.stats && r.stats.updated) || 0;
  } catch (e) { updated = 0; }

  if (!updated) {
    await coll(C.SWITCH).add({ data: { _id: id, ...patch, desc: '', create_time: new Date() } });
  }

  invalidate();
  await ensureLoaded();
  return { key, value: String(value) };
}

/** 用户端：仅 key + value */
async function publicList() {
  const all = await loadAll(true);
  return all.map((r) => ({ key: r.key, value: r.value }));
}

async function publicGet(key) {
  const all = await loadAll(true);
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
  KNOWN_SWITCHES,
};
