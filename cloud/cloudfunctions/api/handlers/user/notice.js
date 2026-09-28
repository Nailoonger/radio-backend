'use strict';

/**
 * 用户端 · 公告
 * 迁移自 src/controllers/user/noticeController.js
 *   list   —— 仅 isShow=1，按 isTop DESC, publishTime DESC 排序，分页
 *   detail —— 仅 isShow=1，否则 40401
 *
 * ⚠️ 字段名用驼峰（= 原 Sequelize 属性名 = 前端读的字段名）。
 */

const { C, findOne, findMany, count, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');

/** GET /user/notice/list */
async function list(ctx) {
  const q = ctx.query || {};
  const page = parseInt(q.page, 10) || 1;
  const pageSize = parseInt(q.pageSize, 10) || 10;
  const where = { isShow: 1 };

  const [rows, total] = await Promise.all([
    findMany(C.NOTICE, where, {
      orderBy: [['isTop', 'desc'], ['publishTime', 'desc']],
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    count(C.NOTICE, where),
  ]);

  return { list: rows, total, page, pageSize };
}

/** GET /user/notice/:id */
async function detail(ctx) {
  // ⚠️ 主键是数字 id，不是 _id（见 lib/db.js 的 parseId 注释）
  const id = parseId(ctx.params.id);
  const notice = id === null ? null : await findOne(C.NOTICE, { id, isShow: 1 });
  if (!notice) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
  return notice;
}

module.exports = { list, detail };
