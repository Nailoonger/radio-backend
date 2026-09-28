'use strict';

/**
 * 用户端 · 部门人员
 * 迁移自 src/controllers/user/staffController.js —— 仅 isShow=1 可见
 *
 * ⚠️ 主键是**数字 `id`**，不是云数据库的 `_id`（见 lib/db.js 的 parseId 注释）。
 */

const { C, findOne, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');

/** GET /user/staff/:id  部员详情 */
async function detail(ctx) {
  const id = parseId(ctx.params.id);
  const m = id === null ? null : await findOne(C.STAFF, { id, isShow: 1 });
  if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');
  return m;
}

module.exports = { detail };
