'use strict';

/**
 * 社干 / 部员 两套 CRUD 的公共实现
 *
 * `cadreController` 与 `staffController` 结构几乎逐行相同（差异只有：必填字段、
 * 搜索字段、长度上限文案、排序键）。写成一个工厂，避免「改了一处忘了另一处」。
 *
 * ⚠️ 与原实现逐字对齐的细节：
 *   · `create` 先查必填，再查长度；`update` 只对**合并后**的值查长度
 *   · 长度判据是 `String(x).length > N`（空串天然通过）
 *   · `avatar` 缺省写 `''`（照片自 2026-09-19 起可选，各端用「姓名首字」兜底）
 *   · `motto` 缺省写 `null`（**不是**空串 —— 映射文档 §9 记的就是 null）
 *   · 列表排序 `[['sort','DESC'],['id','ASC']]`（staff 多一档 department ASC）
 *
 * ⚠️⚠️ **鉴权必须由 cfg.guard 显式传入，不要在这里写死 `asAdmin`**。
 *     原路由给 `/admin/cadre/*` 与 `/admin/staff/*` 挂的是 **requireSuperAdmin**
 *     （这两张表的增删改对普通管理员是禁区），而 `makeCrud` 一度默认 `asAdmin`
 *     → 普管能直接调 `/admin/cadre/create`，接口**返回 40101 之外的一切正常**，
 *     没有任何报错（静默漂移 #2 的典型形态）。
 *     兜底默认值仍然是 `asAdmin`（「最不意外的那个」），但调用方**应当**显式写清楚。
 */

const { findOne, insertOne, updateById, removeWhere, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, pager, pick, pagedList, applyFields } = require('./_kit');

/**
 * @param {object} cfg
 *   coll           集合名
 *   guard          (ctx) => admin  鉴权函数，**必传**（asAdmin / asSuper）
 *   label          404 文案里的名字（'社干' / '成员'）
 *   fields         对外字段集（顺序即返回顺序）
 *   searchFields   keyword 参与匹配的字段
 *   orderBy        列表排序
 *   createRequired [[field, message], ...]
 *   defaults       (body) => 额外的建行默认值
 *   lens           [field, max, message]
 */
function makeCrud(cfg) {
  if (!cfg.guard) cfg.guard = asAdmin;   // 兜底：不传时按「普通管理员即可」处理

  /** 长度上限校验（合并后的对象上也用同一套判据） */
  function assertLens(src) {
    (cfg.lens || []).forEach(([f, max, msg]) => {
      const v = src[f];
      if (v === undefined || v === null) return;
      if (String(v).length > max) throw new ApiError(Codes.PARAM_ERROR, msg);
    });
  }

  /** GET /admin/<x>/list */
  async function list(ctx) {
    cfg.guard(ctx);
    const q = ctx.query || {};
    const { page, pageSize } = pager(q, 20);
    const where = {};
    if (cfg.listFilter) cfg.listFilter(where, q);
    const r = await pagedList(cfg.coll, {
      where,
      keyword: q.keyword ? String(q.keyword) : '',
      fields: cfg.searchFields,
      orderBy: cfg.orderBy,
      page,
      pageSize,
    });
    return { ...r, list: r.list.map((x) => pick(x, cfg.fields)) };
  }

  /** GET /admin/<x>/:id */
  async function detail(ctx) {
    cfg.guard(ctx);
    const id = parseId(ctx.params.id);
    const row = id === null ? null : await findOne(cfg.coll, { id });
    if (!row) throw new ApiError(Codes.NOT_FOUND, `${cfg.label}不存在`);
    return pick(row, cfg.fields);
  }

  /** POST /admin/<x>/create */
  async function create(ctx) {
    cfg.guard(ctx);
    const body = ctx.body || {};
    (cfg.createRequired || []).forEach(([f, msg]) => {
      if (!body[f]) throw new ApiError(Codes.PARAM_ERROR, msg);
    });

    const now = new Date();
    const doc = { id: await nextId(cfg.coll), ...(cfg.defaults ? cfg.defaults(body) : {}) };
    // 可写字段：body 显式给了才取（其余一律用 defaults 的值，保证字段写全）
    (cfg.writable || []).forEach((f) => {
      if (body[f] !== undefined) doc[f] = body[f];
    });
    doc.createTime = now;
    doc.updateTime = now;

    assertLens(doc);
    await insertOne(cfg.coll, doc);
    return pick(doc, cfg.fields);
  }

  /** PUT /admin/<x>/:id */
  async function update(ctx) {
    cfg.guard(ctx);
    const id = parseId(ctx.params.id);
    const row = id === null ? null : await findOne(cfg.coll, { id });
    if (!row) throw new ApiError(Codes.NOT_FOUND, `${cfg.label}不存在`);

    const next = applyFields({ ...row }, ctx.body || {}, cfg.writable || []);
    assertLens(next);

    const patch = {};
    (cfg.writable || []).forEach((f) => { patch[f] = next[f] === undefined ? null : next[f]; });
    patch.updateTime = new Date();
    await updateById(cfg.coll, row._id, patch);
    return pick({ ...next, ...patch }, cfg.fields);
  }

  /** DELETE /admin/<x>/:id */
  async function remove(ctx) {
    cfg.guard(ctx);
    const id = parseId(ctx.params.id);
    const row = id === null ? null : await findOne(cfg.coll, { id });
    if (!row) throw new ApiError(Codes.NOT_FOUND, `${cfg.label}不存在`);
    await removeWhere(cfg.coll, { id });
    return null;
  }

  /** PUT /admin/<x>/:id/toggle */
  async function toggle(ctx) {
    cfg.guard(ctx);
    const id = parseId(ctx.params.id);
    const row = id === null ? null : await findOne(cfg.coll, { id });
    if (!row) throw new ApiError(Codes.NOT_FOUND, `${cfg.label}不存在`);

    const isShow = Number(row.isShow) === 1 ? 0 : 1;
    const updateTime = new Date();
    await updateById(cfg.coll, row._id, { isShow, updateTime });
    return pick({ ...row, isShow, updateTime }, cfg.fields);
  }

  return { list, detail, create, update, remove, toggle };
}

/** 单条 isShow 翻转（showcase.toggle 复用；文案与 CRUD 的 toggle 不同） */
async function flipShow(coll, id, label) {
  const row = id === null ? null : await findOne(coll, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, `${label}不存在`);
  const isShow = Number(row.isShow) === 1 ? 0 : 1;
  const updateTime = new Date();
  await updateById(coll, row._id, { isShow, updateTime });
  return { ...row, isShow, updateTime };
}

module.exports = { makeCrud, flipShow };
