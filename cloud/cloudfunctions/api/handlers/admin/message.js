'use strict';

/**
 * 管理端 · 留言审核
 * 迁移自 src/controllers/admin/messageController.js
 *
 * 路由层挂 `adminAuth + requireAdmin` → 全部 `asAdmin`。
 *
 * ⚠️ `message` 模型是 `timestamps: false`，**只有 `createTime`，没有 `updateTime`**
 *    （映射文档 §6）—— 审核动作也不写 updateTime，别顺手补。
 * ⚠️ `status` 过滤的判据是 `status !== undefined && status !== ''`（**空串要放过**）：
 *    前端「全部」档位会传空串，此时不能加过滤。
 */

const { C, findOne, insertOne, updateById, removeWhere, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, pager, pick, pagedList } = require('./_kit');

/** message 的对外字段集（= 映射文档 §6） */
const FIELDS = ['id', 'openid', 'programId', 'nickname', 'avatar', 'content', 'status', 'rejectReason', 'reviewerId', 'reviewTime', 'createTime'];

/** GET /admin/message/list */
async function list(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const { page, pageSize } = pager(q, 10);

  const where = {};
  if (q.status !== undefined && q.status !== '' && q.status !== null) {
    where.status = parseInt(q.status, 10);
  }
  if (q.programId) where.programId = parseInt(q.programId, 10);

  const r = await pagedList(C.MESSAGE, {
    where,
    keyword: q.keyword ? String(q.keyword) : '',
    fields: ['content', 'nickname'],
    orderBy: [['createTime', 'desc']],
    page,
    pageSize,
  });
  return { ...r, list: r.list.map((x) => pick(x, FIELDS)) };
}

/** PUT /admin/message/:id/approve */
async function approve(ctx) {
  const me = asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const msg = id === null ? null : await findOne(C.MESSAGE, { id });
  if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');

  const patch = { status: 1, reviewerId: me.id, reviewTime: new Date(), rejectReason: null };
  await updateById(C.MESSAGE, msg._id, patch);
  return pick({ ...msg, ...patch }, FIELDS);
}

/** PUT /admin/message/:id/reject   body: { reason } */
async function reject(ctx) {
  const me = asAdmin(ctx);
  const { reason } = ctx.body || {};
  if (!reason) throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');

  const id = parseId(ctx.params.id);
  const msg = id === null ? null : await findOne(C.MESSAGE, { id });
  if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');

  const patch = { status: 2, rejectReason: reason, reviewerId: me.id, reviewTime: new Date() };
  await updateById(C.MESSAGE, msg._id, patch);
  return pick({ ...msg, ...patch }, FIELDS);
}

/** DELETE /admin/message/:id */
async function remove(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const msg = id === null ? null : await findOne(C.MESSAGE, { id });
  if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
  await removeWhere(C.MESSAGE, { id });
  return null;
}

module.exports = { list, approve, reject, remove };
