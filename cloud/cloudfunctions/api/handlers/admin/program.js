'use strict';

/**
 * 管理端 · 节目排期
 * 迁移自 src/controllers/admin/programController.js
 *
 * 路由层挂 `adminAuth + requireAdmin`（普通管理员即可）→ 全部 `asAdmin`。
 *
 * ⚠️ 时间语义：`broadcastDate` 是 `DATEONLY`（`YYYY-MM-DD` 字符串）。
 *    原实现用 `Op.between: [startDate, endDate]` 落在 SQL 上比较的是日期；
 *    云端改成 `_.gte(startDate).and(_.lte(endDate))`。字符串 `YYYY-MM-DD` 定长零填充，
 *    字典序 == 日期序，所以等价。
 *    ⚠️ 但**必须两端都给**才过滤（源实现就是 `if (startDate && endDate)`）。
 */

const { C, _, findOne, findAllPaged, insertOne, updateById, updateWhere, removeWhere, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, pager, pick, applyFields, sortRows } = require('./_kit');

/** program 的对外字段集（= 映射文档 §4，顺序与 Sequelize 属性一致） */
const FIELDS = ['id', 'title', 'host', 'broadcastTime', 'broadcastDate', 'desc', 'cover', 'isShow', 'isLive', 'sort', 'createTime', 'updateTime'];

/** GET /admin/program/list */
async function list(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const { page, pageSize } = pager(q, 20);

  const where = {};
  if (q.startDate && q.endDate) {
    where.broadcastDate = _.gte(q.startDate).and(_.lte(q.endDate));
  }

  const rows = await findAllPaged(C.PROGRAM, where);
  const sorted = sortRows(rows, [['broadcastDate', 'asc'], ['sort', 'asc']]);
  const skip = (page - 1) * pageSize;
  return {
    list: sorted.slice(skip, skip + pageSize).map((r) => pick(r, FIELDS)),
    total: sorted.length,
    page,
    pageSize,
  };
}

/** POST /admin/program/create */
async function create(ctx) {
  asAdmin(ctx);
  const body = ctx.body || {};
  const { title, host, broadcastTime, broadcastDate, desc, cover, isShow, sort } = body;
  if (!title || !broadcastTime) {
    throw new ApiError(Codes.PARAM_ERROR, '请填写节目名和开播时间');
  }

  const now = new Date();
  const doc = {
    id: await nextId(C.PROGRAM),
    title,
    host: host === undefined ? null : host,
    broadcastTime,
    broadcastDate: broadcastDate || null,
    desc: desc === undefined ? null : desc,
    cover: cover === undefined ? null : cover,
    isShow: isShow === undefined ? 1 : isShow,
    isLive: 0,
    sort: sort || 0,
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.PROGRAM, doc);
  return pick(doc, FIELDS);
}

/** PUT /admin/program/:id */
async function update(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.PROGRAM, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '节目不存在');

  const next = applyFields({ ...row }, ctx.body || {},
    ['title', 'host', 'broadcastTime', 'broadcastDate', 'desc', 'cover', 'isShow', 'sort']);
  next.updateTime = new Date();
  await updateById(C.PROGRAM, row._id, {
    title: next.title,
    host: next.host,
    broadcastTime: next.broadcastTime,
    broadcastDate: next.broadcastDate,
    desc: next.desc,
    cover: next.cover,
    isShow: next.isShow,
    sort: next.sort,
    updateTime: next.updateTime,
  });
  return pick(next, FIELDS);
}

/** DELETE /admin/program/:id */
async function remove(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.PROGRAM, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
  await removeWhere(C.PROGRAM, { id });
  return null;
}

/**
 * PUT /admin/program/:id/live   切换「正在直播」（保证全表仅一个 live=1）
 *
 * ⚠️ 源实现先 `Program.update({isLive:0}, {where:{}})` 全表清零，再置目标为 1。
 *    云端 `where({})` 语义不明确，改用 `_id: _.exists(true)`（= 全部文档），等价。
 */
async function setLive(ctx) {
  asAdmin(ctx);
  const { isLive } = ctx.body || {};
  const id = parseId(ctx.params.id);

  if (Number(isLive) === 1) {
    await updateWhere(C.PROGRAM, { _id: _.exists(true) }, { isLive: 0 });
  }

  const row = id === null ? null : await findOne(C.PROGRAM, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '节目不存在');

  const next = { ...row, isLive: isLive ? 1 : 0, updateTime: new Date() };
  await updateById(C.PROGRAM, row._id, { isLive: next.isLive, updateTime: next.updateTime });
  return pick(next, FIELDS);
}

module.exports = { list, create, update, remove, setLive };
