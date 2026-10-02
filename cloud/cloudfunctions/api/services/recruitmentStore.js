'use strict';

// Isolated document-only transactions. Existing lib/db primitives are untouched.
const { db, _ } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');
const R = require('./recruitmentCodes');
const { digest } = require('./recruitmentCode');

const C = Object.freeze({
  BATCH: 'recruitment_batch', APPLICATION: 'recruitment_application',
  UNIQUE: 'recruitment_unique', CODE: 'recruitment_code',
  CONTROL: 'recruitment_control', RATE: 'recruitment_rate',
});
function missing(e) {
  // -502001 also covers database failures: the code alone is not sufficient.
  const code = String(e && (e.code || e.errCode) || '');
  const msg = String(e && (e.errMsg || e.message) || '');
  return code === 'DATABASE_DOCUMENT_NOT_EXIST'
    || /(?:document|doc)\s+(?:with\s+_id\s+[^\r\n]{1,200}?\s+)?(?:does\s+not\s+exist|not\s+exist(?:s)?|not\s+found)/i.test(msg);
}
function conflict(e) {
  return String(e && (e.code || e.errCode) || '') === 'DATABASE_TRANSACTION_CONFLICT'
    || /\b(?:TransactionConflict|DATABASE_TRANSACTION_CONFLICT)\b/.test(String(e && (e.errMsg || e.message) || ''));
}
function access(database) {
  return {
    async get(name, id) {
      try {
        const r = await database.collection(name).doc(String(id)).get();
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        return row || null;
      } catch (e) { if (missing(e)) return null; throw e; }
    },
    async set(name, id, data) {
      const clean = { ...data }; delete clean._id;
      await database.collection(name).doc(String(id)).set({ data: clean });
    },
    async update(name, id, data) { await database.collection(name).doc(String(id)).update({ data }); },
    async remove(name, id) { await database.collection(name).doc(String(id)).remove(); },
  };
}
const direct = access(db);
async function transaction(work) {
  if (typeof db.runTransaction !== 'function') throw new ApiError(Codes.SERVER_ERROR, '招新数据库暂不可用，请稍后重试');
  let attempts = 0; let invocations = 0;
  for (;;) {
    invocations += 1;
    try {
      return await db.runTransaction(async (tx) => {
        attempts += 1;
        if (attempts > 3) throw new ApiError(R.VERSION_CONFLICT, '数据正在更新，请稍后重试');
        return work(access(tx));
      });
    } catch (e) {
      if (!conflict(e)) throw e;
      if (attempts >= 3 || invocations >= 3) throw new ApiError(R.VERSION_CONFLICT, '数据正在更新，请稍后重试');
    }
  }
}
async function list(name, where, { skip = 0, limit = 20, orderBy = [] } = {}) {
  let q = db.collection(name);
  if (where && Object.keys(where).length) q = q.where(where);
  orderBy.forEach(([field, dir]) => { q = q.orderBy(field, dir); });
  if (skip) q = q.skip(skip);
  const r = await q.limit(limit).get();
  return r.data || [];
}
async function count(name, where) {
  let q = db.collection(name);
  if (where && Object.keys(where).length) q = q.where(where);
  const r = await q.count();
  return r.total;
}
async function rate(ctx, action) {
  const source = ctx.source || (ctx.openid ? `cloud:${ctx.openid}` : '');
  if (typeof source !== 'string' || !/^(cloud|http):.+/.test(source)) {
    throw new ApiError(Codes.FORBIDDEN, '无法验证请求来源，请稍后重试');
  }
  const limits = { apply: 5, query: 20, mutate: 10 };
  if (!limits[action]) throw new Error('Unsupported recruitment rate action');
  const minute = Math.floor(Date.now() / 60000);
  const id = digest(`${source}:${action}:${minute}`);
  await transaction(async (tx) => {
    const row = await tx.get(C.RATE, id);
    const n = row ? row.count : 0;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid recruitment rate counter');
    if (n >= limits[action]) throw new ApiError(R.RATE_LIMITED, '操作过于频繁，请稍后重试');
    await tx.set(C.RATE, id, { count: n + 1, action, expiresAt: (minute + 2) * 60000 });
  });
}
// A bounded daily maintenance job can call this; never removes application data.
async function cleanupRates(now = Date.now()) {
  const rows = await list(C.RATE, { expiresAt: _.lt(now) }, { limit: 100 });
  await Promise.all(rows.map((row) => direct.remove(C.RATE, row._id)));
  return rows.length;
}

module.exports = { C, _, get: direct.get, transaction, list, count, rate, cleanupRates, _internals: { missing, conflict } };
