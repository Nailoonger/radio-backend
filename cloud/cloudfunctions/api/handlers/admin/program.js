'use strict';

/**
 * 管理端 · 栏目管理
 * 迁移自 src/controllers/admin/programController.js
 *
 * 路由层挂 `adminAuth + requireAdmin`（普通管理员即可）→ 除编排写入外都是 `asAdmin`；
 * 编排写入 `PUT /admin/program/slots` 走 `asSuper`。
 *
 * ⚠️⚠️ 2026-11-19 起栏目不再填具体日期：
 *   常规栏目 = 每周哪几天（weekdays）+ 哪个时段（slotLabel）+ 第几档（slotIndex）；
 *   具体日期由 services/programSlot.expand() 在**下发前**投影出来。
 *   只有特别节目档（isSpecial=1）才带自己的 broadcastDate。
 *   原因：broadcast_date 是小程序节目单 / 首页唯一时间依据，只换字段会让按日期查的接口静默返回空。
 */

const { C, findMany, findOne, insertOne, updateById, removeWhere, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, asSuper, pager, pick, applyFields, sortRows } = require('./_kit');
const programSlot = require('../../services/programSlot');

/** program 的对外字段集 */
const FIELDS = [
  'id', 'title', 'host', 'broadcastTime', 'broadcastDate',
  'weekdays', 'slotLabel', 'slotIndex', 'isSpecial',
  'desc', 'cover', 'isShow', 'isLive', 'sort', 'createTime', 'updateTime',
];

/** 周几归一化 → '1,2,3' */
function normWeekdays(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (v !== undefined && v !== null && String(v).trim() !== '') arr = String(v).split(',');
  const nums = arr
    .map((x) => parseInt(String(x).trim(), 10))
    .filter((n) => n >= 1 && n <= 7)
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => a - b);
  return nums.join(',');
}

function resolveTime(body, slots) {
  const isSpecial = Number(body.isSpecial) === 1 ? 1 : 0;
  const manual = String(body.broadcastTime || '').trim();
  if (isSpecial) return manual;
  const auto = programSlot.timeTextOf(body.slotLabel, body.slotIndex, slots);
  return auto || manual;
}

/** GET /admin/program/list */
async function list(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const { page, pageSize, skip } = pager(q, 200);

  const rows = await findMany(C.PROGRAM, {});
  const sorted = sortRows(rows, [['sort', 'asc'], ['id', 'asc']]);
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
  const b = ctx.body || {};
  const title = String(b.title || '').trim();
  if (!title) throw new ApiError(Codes.PARAM_ERROR, '请填写节目名');

  const isSpecial = Number(b.isSpecial) === 1 ? 1 : 0;
  const weekdays = normWeekdays(b.weekdays);
  const broadcastDate = isSpecial ? String(b.broadcastDate || '').trim() : '';

  if (isSpecial) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(broadcastDate)) {
      throw new ApiError(Codes.PARAM_ERROR, '特别节目档必须选择播出日期');
    }
  } else {
    if (!weekdays) throw new ApiError(Codes.PARAM_ERROR, '请选择每周哪几天播出');
    if (!b.slotLabel) throw new ApiError(Codes.PARAM_ERROR, '请选择播出时段');
    if (!(Number(b.slotIndex) >= 1)) throw new ApiError(Codes.PARAM_ERROR, '请选择第几档');
  }

  const slots = await programSlot.getSlots();
  const broadcastTime = resolveTime({ ...b, isSpecial }, slots);
  if (!broadcastTime) {
    throw new ApiError(Codes.PARAM_ERROR, '这个时段 / 档位在播出编排里不存在，请刷新后重选');
  }

  const now = new Date();
  const doc = {
    id: await nextId(C.PROGRAM),
    title,
    host: b.host === undefined ? null : b.host,
    broadcastTime,
    broadcastDate: isSpecial ? broadcastDate : null,
    weekdays: isSpecial ? null : weekdays,
    slotLabel: isSpecial ? null : b.slotLabel,
    slotIndex: isSpecial ? null : parseInt(b.slotIndex, 10),
    isSpecial,
    desc: b.desc === undefined ? null : b.desc,
    cover: b.cover === undefined ? null : b.cover,
    isShow: b.isShow === undefined ? 1 : b.isShow,
    isLive: 0,
    sort: b.sort || 0,
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

  const b = ctx.body || {};
  const next = applyFields({ ...row }, b, ['title', 'host', 'desc', 'cover', 'isShow', 'sort']);
  const isSpecial = b.isSpecial === undefined ? Number(row.isSpecial) === 1 : Number(b.isSpecial) === 1;
  next.isSpecial = isSpecial ? 1 : 0;

  if (isSpecial) {
    if (b.broadcastDate !== undefined) next.broadcastDate = String(b.broadcastDate || '').trim() || null;
    if (!next.broadcastDate) throw new ApiError(Codes.PARAM_ERROR, '特别节目档必须选择播出日期');
    if (b.broadcastTime !== undefined) next.broadcastTime = String(b.broadcastTime).trim();
    next.weekdays = null;
    next.slotLabel = null;
    next.slotIndex = null;
  } else {
    if (b.weekdays !== undefined) next.weekdays = normWeekdays(b.weekdays);
    if (b.slotLabel !== undefined) next.slotLabel = b.slotLabel;
    if (b.slotIndex !== undefined) next.slotIndex = parseInt(b.slotIndex, 10);
    if (!next.weekdays) throw new ApiError(Codes.PARAM_ERROR, '请选择每周哪几天播出');
    if (!next.slotLabel) throw new ApiError(Codes.PARAM_ERROR, '请选择播出时段');
    if (!(Number(next.slotIndex) >= 1)) throw new ApiError(Codes.PARAM_ERROR, '请选择第几档');

    const slots = await programSlot.getSlots();
    next.broadcastTime = resolveTime(
      { isSpecial: 0, slotLabel: next.slotLabel, slotIndex: next.slotIndex },
      slots
    );
    next.broadcastDate = null;
  }

  next.updateTime = new Date();
  await updateById(C.PROGRAM, row._id, {
    title: next.title,
    host: next.host,
    broadcastTime: next.broadcastTime,
    broadcastDate: next.broadcastDate,
    weekdays: next.weekdays,
    slotLabel: next.slotLabel,
    slotIndex: next.slotIndex,
    isSpecial: next.isSpecial,
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

/** PUT /admin/program/:id/live —— 仅一个节目 live=1 */
async function setLive(ctx) {
  asAdmin(ctx);
  const isLive = Number((ctx.body || {}).isLive) === 1 ? 1 : 0;
  if (isLive === 1) {
    const live = await findMany(C.PROGRAM, { isLive: 1 });
    await Promise.all(live.map((r) => updateById(C.PROGRAM, r._id, { isLive: 0, updateTime: new Date() })));
  }
  const id = parseId(ctx.params.id);
  const row = id === null ? null : await findOne(C.PROGRAM, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
  await updateById(C.PROGRAM, row._id, { isLive, updateTime: new Date() });
  return pick({ ...row, isLive }, FIELDS);
}

/* ─────────── 播出编排 ─────────── */

/** GET /admin/program/slots */
async function getSlots(ctx) {
  asAdmin(ctx);
  const list = await programSlot.getSlotsWithTicks();
  return { list, maxSlots: programSlot.MAX_SLOTS, maxCount: programSlot.MAX_COUNT };
}

/** PUT /admin/program/slots（仅超管） */
async function saveSlots(ctx) {
  asSuper(ctx);
  const body = ctx.body || {};
  const list = Array.isArray(body) ? body : (body.list || []);
  const norm = await programSlot.setSlots(list);
  // 服务层只做归一化，不抛业务码（见 services/programSlot.setSlots 注释）；
  // 「一个合法时段都没剩」在这里报 40001，与 Express 端保持同一码同一文案。
  if (!norm) throw new ApiError(Codes.PARAM_ERROR, '至少要有一个合法时段（名称 + 起止 HH:mm + 档数）');
  return { list: norm };
}

module.exports = { list, create, update, remove, setLive, getSlots, saveSlots };
