'use strict';

/**
 * 管理端 · 系统设置 KV（仅超管）
 * 迁移自 src/controllers/admin/settingController.js
 *
 * 存储：`system_setting` 集合，`_id = 'setting:<key>'`（见 services/kv.js）。
 * ⚠️ 路由层挂的是 `requireSuperAdmin`（含 adminAuth）→ 三个方法都必须 `asSuper`。
 *
 * ⚠️ `upsert` 的语义照抄源实现：
 *   - 新建：`value: value || ''`、`desc: desc || ''`（空串兜底）
 *   - 更新：`value !== undefined` 才覆盖；`desc !== undefined` 才覆盖
 *   ⇒ **不能**直接复用 `kv.set()` —— 它是给「整条写入」用的，`desc` 缺省时会写成 null。
 */

const { C, findById, findAllPaged, insertWithId, updateById, nextId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const kv = require('../../services/kv');
const { asSuper, pick, sortRows } = require('./_kit');

/** system_setting 的对外字段集（= 映射文档 §7；**不含** _id） */
const FIELDS = ['id', 'key', 'value', 'desc', 'updateTime'];

/** GET /admin/setting/list */
async function list(ctx) {
  asSuper(ctx);
  const rows = await findAllPaged(C.SETTING);
  return { list: sortRows(rows, [['key', 'asc']]).map((r) => pick(r, FIELDS)) };
}

/** GET /admin/setting/:key */
async function get(ctx) {
  asSuper(ctx);
  const doc = await findById(C.SETTING, kv.docId(ctx.params.key));
  if (!doc) throw new ApiError(Codes.NOT_FOUND, '配置不存在');
  return pick(doc, FIELDS);
}

/** PUT /admin/setting/:key   body: { value, desc } */
async function upsert(ctx) {
  asSuper(ctx);
  const key = ctx.params.key;
  const { value, desc } = ctx.body || {};
  const docId = kv.docId(key);
  const existing = await findById(C.SETTING, docId);

  if (!existing) {
    const now = new Date();
    const id = await nextId(C.SETTING);
    const doc = {
      id,
      key,
      value: value || '',
      desc: desc || '',
      createTime: now,
      updateTime: now,
    };
    await insertWithId(C.SETTING, docId, doc);
    return pick(doc, FIELDS);
  }

  const patch = { updateTime: new Date() };
  if (value !== undefined) patch.value = value;
  if (desc !== undefined) patch.desc = desc;
  await updateById(C.SETTING, docId, patch);
  return pick({ ...existing, ...patch }, FIELDS);
}

module.exports = { list, get, upsert };
