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

const { C, findOne, insertOne, updateById, updateWhere, removeWhere, parseId } = require('../../lib/db');
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

/**
 * 审核动作的并发防护（2026-10-27 补）
 *
 * ═══════════ 为什么这里必须加乐观锁 ═══════════
 * 伙伴端（小程序）和电脑端（admin-web）**共用这一条接口**，两边的待审列表
 * 都是「拉一次列表 → 在本地列表上点通过/屏蔽」。于是这个时序很常见：
 *
 *   T0  电脑端拉到留言 #12（status=0）
 *   T1  手机上社干也拉到留言 #12（status=0）
 *   T2  电脑端点了「屏蔽」
 *   T3  手机上点了「通过」          ← 后写覆盖前写
 *
 * 原来用 `updateById` 无条件写，结果是**后点的赢**，而且两边都收到「成功」，
 * 谁都不知道自己覆盖了别人。审核人、审核时间、结论全部被静默改写。
 *
 * 现在把「读取时的 status」放进 WHERE：抢晚了影响 0 行。
 *
 * ═══════════ 抢晚了要分两种情况（2026-10-27 二改）═══════════
 * 第一版一律抛 40901，结果「两端都点通过」这种最常见的场景也报冲突 —— 但结论明明一样，
 * 报错纯属噪音，还会让用户以为没生效、反复重试。
 *
 * 所以影响 0 行时**回读一次**，按「落库结论是否等于我想要的结论」分流：
 *   ① 已是目标状态  → 别人做了同一件事，**幂等返回成功**（结论一致，没有信息损失）
 *   ② 是别的状态    → 别人做了**相反**的决定，抛 40901 让用户刷新（这才是真冲突）
 *
 * 关键是②必须报错：静默成功比报错更糟 —— 用户会以为是自己点的通过，
 * 而实际落库的是别人的驳回，审核人和理由全被改写。
 */
async function applyReview(msg, patch, actionText) {
  const affected = await updateWhere(C.MESSAGE, { _id: msg._id, status: msg.status }, patch);
  if (affected > 0) return pick({ ...msg, ...patch }, FIELDS);

  const fresh = await findOne(C.MESSAGE, { _id: msg._id });
  if (!fresh) throw new ApiError(Codes.NOT_FOUND, '这条留言刚被其他人删除');
  if (Number(fresh.status) === Number(patch.status)) return pick(fresh, FIELDS);   // ① 同结论
  throw new ApiError(Codes.CONFLICT, `这条留言刚被其他人${actionText}，请刷新后重试`);   // ② 反结论
}

/** PUT /admin/message/:id/approve */
async function approve(ctx) {
  const me = asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const msg = id === null ? null : await findOne(C.MESSAGE, { id });
  if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
  // 已经是「通过」时直接返回，避免自己重复点两次报冲突
  if (Number(msg.status) === 1) return pick(msg, FIELDS);

  const patch = { status: 1, reviewerId: me.id, reviewTime: new Date(), rejectReason: null };
  return applyReview(msg, patch, '通过了');
}

/** PUT /admin/message/:id/reject   body: { reason } */
async function reject(ctx) {
  const me = asAdmin(ctx);
  const { reason } = ctx.body || {};
  if (!reason) throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');

  const id = parseId(ctx.params.id);
  const msg = id === null ? null : await findOne(C.MESSAGE, { id });
  if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
  if (Number(msg.status) === 2) return pick(msg, FIELDS);

  const patch = { status: 2, rejectReason: reason, reviewerId: me.id, reviewTime: new Date() };
  return applyReview(msg, patch, '屏蔽了');
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
