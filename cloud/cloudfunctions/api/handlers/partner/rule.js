'use strict';

/**
 * 伙伴端 · 值班排班规则（两条硬约束）
 *
 *   GET /partner/rules        读（任何人）
 *   PUT /partner/rules        存（超管）body: { items: [{ key, name, value, on }] }
 *
 * ═══════════ 为什么只有两条 ═══════════
 *   v151 `rules` 屏写的是「发布值班时段，并设两条硬约束」：
 *     ① 每天最多几场   ② 每周最多几场
 *   生成班表时**硬约束优先**：到上限的人不再进候选池，宁可保留缺岗也不硬凑。
 *   不在这里加「权重 / 偏好 / 轮值顺序」——那些没有业务口径，加了就是编规则。
 *
 * ═══════════ 为什么不落默认值 ═══════════
 *   集合空的时候**不写库**：读接口返回默认值即可。
 *   一旦写库，日后改默认值就对老站点无效（已有行不会跟着变），反而更难解释。
 */

const { C, findMany, insertOne, removeWhere, nextId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asPartner, asSuperPartner } = require('./_kit');

/** 默认两条（与 v151 演示口径一致：每天 1 场、每周 3 场） */
const DEFAULTS = [
  { key: 'day',  name: '每天最多场次', value: 1, on: true, unit: '场' },
  { key: 'week', name: '每周最多场次', value: 3, on: true, unit: '场' },
];

function dto(r) {
  return {
    key: r.key,
    name: r.name || '',
    value: Number(r.value) || 0,
    on: r.on !== false,
    unit: r.unit || '场',
  };
}

/** 合并：库里有就用库里的，没有就补默认 */
function merge(rows) {
  const byKey = {};
  (rows || []).forEach((r) => { byKey[r.key] = r; });
  return DEFAULTS.map((d) => dto(byKey[d.key] ? Object.assign({}, d, byKey[d.key]) : d));
}

async function get(ctx) {
  await asPartner(ctx);
  const rows = await findMany(C.DUTY_RULE, {}, { limit: 50 });
  return { items: merge(rows), defaults: DEFAULTS.map(dto) };
}

async function save(ctx) {
  const p = await asSuperPartner(ctx);
  const items = (ctx.body || {}).items;
  if (!Array.isArray(items) || !items.length) {
    throw new ApiError(Codes.PARAM_ERROR, '没有要保存的规则');
  }
  const now = new Date();
  // 只认默认这两条，且值必须是 1..14 的整数（0 会让生成算法无解）
  const clean = [];
  items.forEach((raw) => {
    const key = String(raw && raw.key || '');
    const hit = DEFAULTS.find((d) => d.key === key);
    if (!hit) return;                       // 未知 key 静默忽略，不新建
    const v = Math.round(Number(raw.value));
    if (!Number.isInteger(v) || v < 1 || v > 14) {
      throw new ApiError(Codes.PARAM_ERROR, `${hit.name}需在 1~14 之间`);
    }
    clean.push({ key, name: hit.name, value: v, on: raw.on !== false, unit: hit.unit });
  });
  if (!clean.length) throw new ApiError(Codes.PARAM_ERROR, '没有可识别的规则');

  // upsert：先删同 key 再插（规则总量极小，简单直白好排查）
  for (const it of clean) {
    await removeWhere(C.DUTY_RULE, { key: it.key });
    await insertOne(C.DUTY_RULE, Object.assign({}, it, {
      id: await nextId(C.DUTY_RULE),
      updatedBy: p.id,
      updatedByName: (p.admin && (p.admin.nickname || p.admin.username)) || '',
      updateTime: now,
    }));
  }
  const rows = await findMany(C.DUTY_RULE, {}, { limit: 50 });
  return { items: merge(rows) };
}

/** 给排班生成用的「有效上限」 */
async function effectiveLimits() {
  const rows = await findMany(C.DUTY_RULE, {}, { limit: 50 });
  const m = merge(rows);
  const dayRule = m.find((x) => x.key === 'day');
  const weekRule = m.find((x) => x.key === 'week');
  return {
    dayMax: dayRule && dayRule.on ? Math.max(1, dayRule.value) : 99,
    weekMax: weekRule && weekRule.on ? Math.max(1, weekRule.value) : 99,
  };
}

module.exports = { get, save, effectiveLimits, DEFAULTS };
