'use strict';

/**
 * 管理端 · 模块开关（仅超管）
 * 迁移自 src/controllers/admin/switchController.js
 *
 * `list` 会把 `updatedBy`（存的是 admin.id）换成管理员姓名 —— 原实现查 `Admin.findAll`
 * 拿 `nickname || username`，云端等价于按 `id ∈ ids` 查一次 admin 集合。
 */

const { C, findAllPaged } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const switchService = require('../../services/switch');
const { asSuper } = require('./_kit');

/** GET /admin/switch/list */
async function list(ctx) {
  asSuper(ctx);
  const rows = await switchService.listAll();

  // updatedBy 存的是 admin.id，给前端换成姓名
  const ids = [...new Set(rows.map((r) => r.updatedBy).filter(Boolean))].map((v) => Number(v));
  const nameMap = new Map();
  if (ids.length) {
    // ⚠️ 用 findAllPaged + JS 过滤：云端 `_.in(ids)` 的数组长度受命令体大小限制，
    //    而这里 ids 最多就是管理员人数（个位数），直接拉全表更简单、也不会失败。
    const admins = await findAllPaged(C.ADMIN);
    admins.forEach((a) => {
      if (ids.indexOf(Number(a.id)) >= 0) nameMap.set(Number(a.id), a.nickname || a.username);
    });
  }

  return {
    list: rows.map((r) => ({
      ...r,
      updatedByName: r.updatedBy ? nameMap.get(Number(r.updatedBy)) || null : null,
    })),
  };
}

/** PUT /admin/switch/:key   body: { value: 'on' | 'off' } */
async function update(ctx) {
  const me = asSuper(ctx);
  const { key } = ctx.params;
  const { value } = ctx.body || {};
  if (!['on', 'off'].includes(value)) {
    throw new ApiError(Codes.PARAM_ERROR, 'value 必须为 on 或 off');
  }
  return switchService.set(key, value, me && me.id ? me.id : null);
}

module.exports = { list, update };
