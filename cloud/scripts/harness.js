'use strict';

/**
 * 本地测试 harness —— 在**没有云环境**的情况下把云函数跑起来做真实断言
 *
 * 原理：把 `wx-server-sdk` 从 require 缓存里替换成内存假实现（Map 存集合），
 *      然后直接调用云函数入口 main(event)，拿到的返回值就是线上会返回的东西。
 *
 * 为什么必须做：云开发代码若只靠「部署后手点」验证，等于没有回归网。
 *              有了它，每个移植过来的 handler 都能在本地立刻断言，
 *              且不需要 wx-server-sdk / 云环境 / 网络。
 *
 * ⚠️ 假实现刻意模拟了以下真实行为，否则测不出问题：
 *    - add() 撞 _id → 抛错（等价 UNIQUE 冲突）
 *    - doc().get()/update() 不存在 → 抛错
 *    - where().update() 返回 stats.updated（等价 affectedRows）
 */

const Module = require('module');
const path = require('path');

// ---------------- 内存数据库 ----------------
const store = new Map();          // name -> Map(_id -> doc)
const autoId = { n: 0 };
const INC = Symbol('inc');

function bucket(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

function clone(v) {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function applyPatch(doc, patch) {
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (v && typeof v === 'object' && v[INC] !== undefined) {
      doc[k] = (doc[k] || 0) + v[INC];
    } else {
      doc[k] = clone(v);
    }
  });
}

function matches(doc, where) {
  return Object.keys(where || {}).every((k) => {
    const want = where[k];
    if (want && typeof want === 'object' && want[INC] !== undefined) return true; // 自增条件不参与筛选
    return doc[k] === want;
  });
}

class Query {
  constructor(name, where) { this.name = name; this._where = where || null; this._limit = 0; }
  where(w) { this._where = w; return this; }
  limit(n) { this._limit = n; return this; }
  async get() {
    let rows = Array.from(bucket(this.name).values()).filter((d) => !this._where || matches(d, this._where));
    if (this._limit) rows = rows.slice(0, this._limit);
    return { data: clone(rows) };
  }
  async update({ data }) {
    let updated = 0;
    bucket(this.name).forEach((doc) => {
      if (!this._where || matches(doc, this._where)) { applyPatch(doc, data); updated++; }
    });
    return { stats: { updated } };
  }
  async remove() {
    let removed = 0;
    const b = bucket(this.name);
    Array.from(b.entries()).forEach(([id, doc]) => {
      if (!this._where || matches(doc, this._where)) { b.delete(id); removed++; }
    });
    return { stats: { removed } };
  }
}

class Doc {
  constructor(name, id) { this.name = name; this.id = String(id); }
  _get() {
    const doc = bucket(this.name).get(this.id);
    if (!doc) { const e = new Error('document does not exist'); e.errCode = -502001; throw e; }
    return doc;
  }
  async get() { return { data: clone(this._get()) }; }
  async update({ data }) {
    const doc = this._get();
    applyPatch(doc, data);
    return { stats: { updated: 1 } };
  }
  async set({ data }) {
    const exists = bucket(this.name).has(this.id);
    bucket(this.name).set(this.id, { _id: this.id, ...(exists ? {} : {}), ...clone(data) });
    return { stats: { updated: exists ? 1 : 0, created: exists ? 0 : 1 } };
  }
  async remove() {
    const b = bucket(this.name);
    if (!b.has(this.id)) { const e = new Error('document does not exist'); e.errCode = -502001; throw e; }
    b.delete(this.id);
    return { stats: { removed: 1 } };
  }
}

class Collection {
  constructor(name) { this.name = name; }
  where(w) { return new Query(this.name, w); }
  limit(n) { return new Query(this.name, null).limit(n); }
  doc(id) { return new Doc(this.name, id); }
  async add({ data }) {
    const id = data._id !== undefined ? String(data._id) : `auto_${++autoId.n}`;
    if (bucket(this.name).has(id)) { const e = new Error('duplicate _id'); e.errCode = -502002; throw e; }
    bucket(this.name).set(id, { _id: id, ...clone(data) });
    return { _id: id };
  }
  async count() { return { total: bucket(this.name).size }; }
}

const fakeDb = {
  collection: (n) => new Collection(n),
  command: {
    inc: (n) => ({ [INC]: n }),
    eq: (v) => v,
    in: (arr) => arr,
    gte: (v) => v,
    lte: (v) => v,
    and: (...a) => a,
    or: (...a) => a,
  },
  RegExp: (o) => o,
};

// ---------------- 拦截 wx-server-sdk ----------------
let wxContext = { OPENID: '', UNIONID: '' };
const fakeSdk = {
  init: () => {},
  database: () => fakeDb,
  getWXContext: () => ({ ...wxContext }),
  DYNAMIC_CURRENT_ENV: 'test-env',
  openapi: {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad.apply(this, arguments);
};

// ---------------- 测试工具 ----------------
const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');

/** 重置数据库并写入种子数据 */
function reset(seed = {}) {
  store.clear();
  autoId.n = 0;
  wxContext = { OPENID: '', UNIONID: '' };
  Object.keys(seed).forEach((name) => {
    seed[name].forEach((doc) => {
      const id = doc._id !== undefined ? String(doc._id) : `seed_${++autoId.n}`;
      bucket(name).set(id, { _id: id, ...clone(doc) });
    });
  });
}

function setOpenid(openid) { wxContext = { OPENID: openid, UNIONID: '' }; }

function dump() { const o = {}; store.forEach((v, k) => { o[k] = Array.from(v.values()); }); return o; }

/** 调用云函数（等价线上 wx.cloud.callFunction 的返回值） */
async function call(event) {
  delete require.cache[require.resolve(path.join(API_DIR, 'index.js'))];
  const api = require(path.join(API_DIR, 'index.js'));
  return api.main(event, {});
}

const req = (method, pathname, body = {}, token = '') => ({ method, path: pathname, body, token });

module.exports = { reset, setOpenid, call, req, dump, fakeDb, store };
