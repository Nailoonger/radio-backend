'use strict';

/**
 * 管理端 · 公告管理
 * 迁移自 src/controllers/admin/noticeController.js
 *
 * 路由层挂 `adminAuth + requireAdmin` → 全部 `asAdmin`。
 *
 * ⚠️ 关键字搜索是 `title/content` 两字段 OR LIKE —— 云端没有 LIKE，走
 *    `_kit.pagedList` 的「全量拉取 + JS 子串过滤」。公告量级很小（几十条），可接受。
 */

const { C, findOne, insertOne, updateById, removeWhere, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, pager, pick, pagedList, applyFields } = require('./_kit');

/** notice 的对外字段集（= 映射文档 §5） */
const FIELDS = ['id', 'title', 'content', 'isTop', 'isShow', 'publisherId', 'publishTime', 'createTime', 'updateTime'];

/** GET /admin/notice/list */
async function list(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const { page, pageSize } = pager(q, 20);
  const r = await pagedList(C.NOTICE, {
    where: {},
    keyword: q.keyword ? String(q.keyword) : '',
    fields: ['title', 'content'],
    orderBy: [['isTop', 'desc'], ['publishTime', 'desc']],
    page,
    pageSize,
  });
  return { ...r, list: r.list.map((x) => pick(x, FIELDS)) };
}

/** POST /admin/notice/create */
async function create(ctx) {
  const me = asAdmin(ctx);
  const { title, content, isTop, isShow } = ctx.body || {};
  if (!title || !content) {
    throw new ApiError(Codes.PARAM_ERROR, '请填写标题和内容');
  }
  const now = new Date();
  const doc = {
    id: await nextId(C.NOTICE),
    title,
    content,
    isTop: isTop ? 1 : 0,
    isShow: isShow === undefined ? 1 : isShow,
    publisherId: me.id,
    publishTime: now,
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.NOTICE, doc);
  return pick(doc, FIELDS);
}

/** PUT /admin/notice/:id */
async function update(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.NOTICE, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '公告不存在');

  const next = applyFields({ ...row }, ctx.body || {}, ['title', 'content', 'isTop', 'isShow']);
  next.updateTime = new Date();
  await updateById(C.NOTICE, row._id, {
    title: next.title, content: next.content, isTop: next.isTop, isShow: next.isShow,
    updateTime: next.updateTime,
  });
  return pick(next, FIELDS);
}

/** DELETE /admin/notice/:id */
async function remove(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.NOTICE, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
  await removeWhere(C.NOTICE, { id });
  return null;
}

/** PUT /admin/notice/:id/toggle */
async function toggle(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.NOTICE, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '公告不存在');

  const isShow = Number(row.isShow) === 1 ? 0 : 1;
  const updateTime = new Date();
  await updateById(C.NOTICE, row._id, { isShow, updateTime });
  return pick({ ...row, isShow, updateTime }, FIELDS);
}

module.exports = { list, create, update, remove, toggle };
