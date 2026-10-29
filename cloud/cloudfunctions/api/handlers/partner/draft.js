'use strict';

/**
 * 伙伴端 · 稿件（站内稿件 / 我的稿）
 *
 *   GET  /partner/draft/list            我的稿件（按状态筛，带各状态计数）
 *   GET  /partner/draft/review          社干审稿队列（全站待审，不限作者）
 *   GET  /partner/draft/:id             详情
 *   GET  /partner/draft/:id/versions    版本记录（全文快照）
 *   POST /partner/draft                 新建草稿
 *   PUT  /partner/draft/:id             存草稿（内容变了才升版本）
 *   PUT  /partner/draft/:id/submit      提交审核
 *   PUT  /partner/draft/:id/review      社干审：通过 / 驳回（驳回必须写理由）
 *   POST /partner/draft/:id/restore     恢复旧版 ⇒ **生成新草稿**，不覆盖当前版
 *
 * ═══════════ 为什么单开一张表，不复用 submit ═══════════
 *   `submit` 是**学生投稿**（点歌 / 学生文稿），归属 `openid`，一次提交=一条记录，不可编辑。
 *   站内稿件是**伙伴自己写、可反复改、有多版本、提交后还能被驳回再改**的东西，
 *   生命周期完全不同。混进 submit 会让「点歌名额」「每人每周 2 次」这些规则误伤。
 *
 * ═══════════ 版本语义（对齐 v151 `versions` 屏） ═══════════
 *   · 每次「存草稿」且正文/标题有变化 → version + 1，并把**上一版全文**压进 versions
 *   · 「恢复旧版」不是覆盖：把选中版的内容写成一份**新草稿**（version 继续加），
 *     当前版原样留在版本记录里 —— 用户的未提交修改不会被吞
 *   · versions 只留最近 20 版（再多翻不动，也不该无限膨胀）
 *
 * ⚠️ 并发：两端同时改同一篇。存草稿带 `baseVersion`，不匹配抛 40901 ——
 *    和审稿的乐观锁同一个思路（静默覆盖比报错更糟）。
 */

const { C, findOne, findMany, insertOne, updateWhere, count } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asPartner, asManager } = require('./_kit');
const { nextId } = require('../../lib/db');

const STATUS = { DRAFT: 0, PENDING: 1, APPROVED: 2, REJECTED: 3 };
const STATUS_TEXT = { 0: '草稿', 1: '待审核', 2: '已通过', 3: '已驳回' };
const DEFAULT_RATE = 240;        // 字/分钟（播音语速，前端也按这个折算，服务端为准）
const MAX_VERSIONS = 20;
const MAX_BODY = 20000;

/** 去空白后的字数（中文按字算，空行不算字） */
function countWords(body) {
  return String(body || '').replace(/\s/g, '').length;
}

/** 预计时长（秒）= 字数 / 语速 * 60，向上取整 */
function secondsOf(words, rate) {
  const r = Number(rate) > 0 ? Number(rate) : DEFAULT_RATE;
  return Math.max(0, Math.round((words / r) * 60));
}

function dto(d, opts) {
  if (!d) return null;
  const withBody = !opts || opts.body !== false;
  const out = {
    id: Number(d.id),
    title: d.title || '',
    columnName: d.columnName || '',
    status: Number(d.status) || 0,
    statusText: STATUS_TEXT[Number(d.status) || 0],
    wordCount: Number(d.wordCount) || 0,
    seconds: Number(d.seconds) || 0,
    rate: Number(d.rate) || DEFAULT_RATE,
    version: Number(d.version) || 0,
    rejectReason: d.rejectReason || '',
    authorId: Number(d.personId) || 0,
    authorName: d.personName || '',
    createTime: d.createTime || null,
    updateTime: d.updateTime || null,
    submittedAt: d.submittedAt || null,
    reviewedAt: d.reviewedAt || null,
    reviewedByName: d.reviewedByName || '',
  };
  if (withBody) out.body = d.body || '';
  return out;
}

function pickId(ctx) {
  const n = Number(ctx.params && ctx.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(Codes.PARAM_ERROR, 'id 不合法');
  return n;
}

/** 读一条并鉴权：作者本人，或社干（社干能看全部，审稿要用） */
async function loadOne(ctx, needOwner) {
  const p = ctx.partner || (await asPartner(ctx));
  const id = pickId(ctx);
  const doc = await findOne(C.PARTNER_DRAFT, { id });
  if (!doc) throw new ApiError(Codes.NOT_FOUND, '稿件不存在');
  const owner = Number(doc.personId) === p.id;
  if (needOwner && !owner) throw new ApiError(Codes.FORBIDDEN, '只能操作自己的稿件');
  return { p, doc };
}

/** GET /partner/draft/list?status=&page=&pageSize= */
async function list(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(q.pageSize) || 20));
  const where = { personId: p.id };
  if (q.status !== undefined && q.status !== '' && q.status !== null) {
    where.status = Number(q.status);
  }
  const [rows, total, c0, c1, c2, c3] = await Promise.all([
    findMany(C.PARTNER_DRAFT, where, {
      orderBy: [['updateTime', 'desc'], ['id', 'desc']],
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    count(C.PARTNER_DRAFT, where),
    count(C.PARTNER_DRAFT, { personId: p.id, status: 0 }),
    count(C.PARTNER_DRAFT, { personId: p.id, status: 1 }),
    count(C.PARTNER_DRAFT, { personId: p.id, status: 2 }),
    count(C.PARTNER_DRAFT, { personId: p.id, status: 3 }),
  ]);
  return {
    list: rows.map((r) => dto(r, { body: false })),
    total,
    page,
    pageSize,
    counts: { draft: c0, pending: c1, approved: c2, rejected: c3 },
  };
}

/** GET /partner/draft/review —— 社干审稿队列（不限作者） */
async function reviewList(ctx) {
  await asManager(ctx);
  const q = ctx.query || {};
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(q.pageSize) || 20));
  const status = q.status === undefined || q.status === '' ? STATUS.PENDING : Number(q.status);
  const where = { status };
  const [rows, total] = await Promise.all([
    findMany(C.PARTNER_DRAFT, where, {
      orderBy: [['submittedAt', 'asc'], ['id', 'asc']],   // 先交先审
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    count(C.PARTNER_DRAFT, where),
  ]);
  return { list: rows.map((r) => dto(r, { body: false })), total, page, pageSize, status };
}

async function detail(ctx) {
  const { doc } = await loadOne(ctx, false);
  return dto(doc);
}

async function versions(ctx) {
  const { doc } = await loadOne(ctx, false);
  const vs = Array.isArray(doc.versions) ? doc.versions : [];
  // 当前版放最前（v 号最大）
  const cur = {
    v: Number(doc.version) || 1,
    title: doc.title || '',
    body: doc.body || '',
    wordCount: Number(doc.wordCount) || 0,
    seconds: Number(doc.seconds) || 0,
    status: Number(doc.status) || 0,
    statusText: STATUS_TEXT[Number(doc.status) || 0],
    savedAt: doc.updateTime || doc.createTime || null,
    current: true,
  };
  return {
    id: Number(doc.id),
    title: doc.title || '',
    columnName: doc.columnName || '',
    current: doc.version || 1,
    list: [cur].concat(vs.map((v) => ({
      v: Number(v.v) || 0,
      title: v.title || '',
      body: v.body || '',
      wordCount: Number(v.wordCount) || 0,
      seconds: Number(v.seconds) || 0,
      status: Number(v.status) || 0,
      statusText: STATUS_TEXT[Number(v.status) || 0],
      savedAt: v.savedAt || null,
      current: false,
    }))),
  };
}

/** POST /partner/draft  body: { title, columnName, body, rate } */
async function create(ctx) {
  const p = await asPartner(ctx);
  const b = ctx.body || {};
  const title = String(b.title || '').trim();
  if (title.length > 80) throw new ApiError(Codes.PARAM_ERROR, '标题最多 80 字');
  const body = String(b.body || '');
  if (body.length > MAX_BODY) throw new ApiError(Codes.PARAM_ERROR, '正文过长');
  const rate = Number(b.rate) > 0 ? Number(b.rate) : DEFAULT_RATE;
  const words = countWords(body);
  const now = new Date();
  const id = await nextId(C.PARTNER_DRAFT);
  const doc = {
    id,
    personId: p.id,
    personName: (p.admin && (p.admin.nickname || p.admin.username)) || '',
    title: title || '未命名稿件',
    columnName: String(b.columnName || '').trim(),
    body,
    wordCount: words,
    seconds: secondsOf(words, rate),
    rate,
    status: STATUS.DRAFT,
    rejectReason: '',
    version: 1,
    versions: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewedByName: '',
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.PARTNER_DRAFT, doc);
  return dto(doc);
}

/**
 * PUT /partner/draft/:id  存草稿
 * body: { title, columnName, body, rate, baseVersion }
 * 只有内容真的变了才升版本 + 快照，避免「点一下存草稿就多一版」。
 */
async function save(ctx) {
  const { p, doc } = await loadOne(ctx, true);
  if (Number(doc.status) === STATUS.PENDING) {
    throw new ApiError(Codes.CONFLICT, '待审核的稿不能改，等审完再改');
  }
  const b = ctx.body || {};
  const base = b.baseVersion === undefined ? null : Number(b.baseVersion);
  if (base !== null && base !== Number(doc.version)) {
    throw new ApiError(Codes.CONFLICT, '这篇在别处被改过，刷新后再试');
  }
  const title = b.title === undefined ? doc.title : String(b.title || '').trim();
  const columnName = b.columnName === undefined ? doc.columnName : String(b.columnName || '').trim();
  const body = b.body === undefined ? doc.body : String(b.body || '');
  if (body.length > MAX_BODY) throw new ApiError(Codes.PARAM_ERROR, '正文过长');
  const rate = Number(b.rate) > 0 ? Number(b.rate) : (Number(doc.rate) || DEFAULT_RATE);

  const changed = title !== doc.title || columnName !== doc.columnName || body !== doc.body;
  const words = countWords(body);
  const now = new Date();

  let versions = Array.isArray(doc.versions) ? doc.versions.slice() : [];
  let version = Number(doc.version) || 1;
  if (changed) {
    // 把**上一版**压进快照，再升号
    versions.unshift({
      v: version,
      title: doc.title || '',
      body: doc.body || '',
      wordCount: Number(doc.wordCount) || 0,
      seconds: Number(doc.seconds) || 0,
      status: Number(doc.status) || 0,
      savedAt: doc.updateTime || doc.createTime || null,
    });
    versions = versions.slice(0, MAX_VERSIONS);
    version += 1;
  }

  const patch = {
    title: title || '未命名稿件',
    columnName,
    body,
    wordCount: words,
    seconds: secondsOf(words, rate),
    rate,
    version,
    versions,
    updateTime: now,
    // 被驳的稿改了内容 ⇒ 自动回到草稿态（不用手动点"重新提交"）
    status: Number(doc.status) === STATUS.REJECTED && changed ? STATUS.DRAFT : Number(doc.status),
  };
  if (Number(doc.status) === STATUS.REJECTED && changed) patch.rejectReason = '';

  await updateWhere(C.PARTNER_DRAFT, { id: doc.id }, patch);
  return dto(Object.assign({}, doc, patch, { personId: doc.personId }));
}

/** PUT /partner/draft/:id/submit —— 提交审核 */
async function submit(ctx) {
  const { doc } = await loadOne(ctx, true);
  const st = Number(doc.status);
  if (st === STATUS.PENDING) throw new ApiError(Codes.CONFLICT, '已经在待审队列里了');
  if (st === STATUS.APPROVED) throw new ApiError(Codes.CONFLICT, '已通过的稿不用再交');
  if (!countWords(doc.body)) throw new ApiError(Codes.PARAM_ERROR, '正文是空的，写点东西再交');
  const now = new Date();
  const patch = { status: STATUS.PENDING, submittedAt: now, updateTime: now, rejectReason: '' };
  await updateWhere(C.PARTNER_DRAFT, { id: doc.id, status: st }, patch);
  return dto(Object.assign({}, doc, patch, { personId: doc.personId }));
}

/**
 * PUT /partner/draft/:id/review   body: { approve: bool, reason }
 * 驳回必须写理由（前端也能看到为什么）。
 */
async function review(ctx) {
  const p = await asManager(ctx);
  const id = pickId(ctx);
  const b = ctx.body || {};
  const approve = b.approve === true || b.approve === 'true' || b.approve === 1;
  const reason = String(b.reason || '').trim();
  if (!approve && !reason) throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');

  const doc = await findOne(C.PARTNER_DRAFT, { id });
  if (!doc) throw new ApiError(Codes.NOT_FOUND, '稿件不存在');
  if (Number(doc.status) !== STATUS.PENDING) {
    throw new ApiError(Codes.CONFLICT, '这条不在待审队列里，刷新看看');
  }
  const now = new Date();
  const patch = {
    status: approve ? STATUS.APPROVED : STATUS.REJECTED,
    rejectReason: approve ? '' : reason,
    reviewedAt: now,
    reviewedBy: p.id,
    reviewedByName: (p.admin && (p.admin.nickname || p.admin.username)) || '',
    updateTime: now,
  };
  const affected = await updateWhere(
    C.PARTNER_DRAFT,
    { id, status: STATUS.PENDING },     // 乐观锁：抢晚了影响 0 行
    patch
  );
  if (!affected) throw new ApiError(Codes.CONFLICT, '这条刚被别人处理过，刷新看看');
  return dto(Object.assign({}, doc, patch, { personId: doc.personId }));
}

/**
 * POST /partner/draft/:id/restore   body: { v }
 * 恢复旧版 = **另存为新草稿**（version 继续加），当前版原样留在版本记录里。
 */
async function restore(ctx) {
  const { doc } = await loadOne(ctx, true);
  const want = Number((ctx.body || {}).v);
  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  const hit = versions.find((x) => Number(x.v) === want);
  if (!hit) throw new ApiError(Codes.NOT_FOUND, '这一版不在了');
  if (Number(doc.status) === STATUS.PENDING) {
    throw new ApiError(Codes.CONFLICT, '待审核的稿不能改，等审完再恢复');
  }
  const now = new Date();
  const words = countWords(hit.body);
  const version = (Number(doc.version) || 1) + 1;
  // 先把当前版压进快照，再把内容换成旧版
  const next = [{
    v: Number(doc.version) || 1,
    title: doc.title || '',
    body: doc.body || '',
    wordCount: Number(doc.wordCount) || 0,
    seconds: Number(doc.seconds) || 0,
    status: Number(doc.status) || 0,
    savedAt: doc.updateTime || doc.createTime || null,
  }].concat(versions).slice(0, MAX_VERSIONS);

  const patch = {
    title: hit.title || doc.title || '未命名稿件',
    body: hit.body || '',
    wordCount: words,
    seconds: secondsOf(words, doc.rate),
    status: STATUS.DRAFT,
    rejectReason: '',
    version,
    versions: next,
    updateTime: now,
  };
  await updateWhere(C.PARTNER_DRAFT, { id: doc.id }, patch);
  return dto(Object.assign({}, doc, patch, { personId: doc.personId }));
}

module.exports = { list, reviewList, detail, versions, create, save, submit, review, restore };
