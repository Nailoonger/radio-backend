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
 *    - 查询指令可链式：`_.gte(a).and(_.lte(b))` —— 否则范围查询的 handler 在本地直接抛错（等于漏测）
 *    - Query 支持 skip / orderBy / count（排序里 NULL 视作最小，近似 SQL 行为）
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

/**
 * 深拷贝
 * ⚠️ 必须**保留 Date 实例**：早期实现用 `JSON.parse(JSON.stringify(v))`，会把 Date 变成 ISO 字符串。
 *    于是「拿 Date 去比 `_.gte(某Date)`」在假库里永远不匹配（真库是 Date vs Date，正常匹配）——
 *    这个失真曾让「1 分钟防刷」这类时间条件在本地静默失效，等于漏测。
 */
function clone(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = clone(v[k]); });
    return o;
  }
  return v;
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

/**
 * 查询指令（模拟 db.command 的链式对象）
 * ⚠️ 真实 SDK 里 `_.gte(x)` 返回的是 Command 对象、**可以继续 .and()**；
 *    早期假实现直接返回裸值，导致 `_.gte(a).and(_.lte(b))` 抛 TypeError，
 *    范围查询的 handler 在本地根本跑不起来（漏测）。这里补上真实语义。
 */
class Cmd {
  constructor(op) { this.__cmd = op; }
  and(other) { return new Cmd({ and: [this, other] }); }
  or(other) { return new Cmd({ or: [this, other] }); }
}

const isCmd = (v) => v instanceof Cmd;

/** 求值：文档值 vs 指令 */
function matchCmd(docVal, cmd) {
  const op = cmd.__cmd || {};
  if (op.and) return op.and.every((c) => matchCmd(docVal, c));
  if (op.or) return op.or.some((c) => matchCmd(docVal, c));
  if (op.neq !== undefined) return docVal !== op.neq;
  if (op.gt !== undefined) return docVal > op.gt;
  if (op.gte !== undefined) return docVal >= op.gte;
  if (op.lt !== undefined) return docVal < op.lt;
  if (op.lte !== undefined) return docVal <= op.lte;
  if (op.in !== undefined) return op.in.indexOf(docVal) >= 0;
  if (op.nin !== undefined) return op.nin.indexOf(docVal) < 0;
  if (op.eq !== undefined) return docVal === op.eq;
  if (op.exists !== undefined) return op.exists ? docVal !== undefined : docVal === undefined;
  return false;
}

/**
 * where 求值。
 *
 * ⚠️⚠️ 真实云数据库的 `where()` 既能接**字段映射**，也能接**顶层逻辑指令**：
 *
 *     db.collection('order_info').where(_.and([
 *       { publish_type: '1' },
 *       _.or([{ _openid: openid }, { order_openid: openid }]),
 *     ])).get()
 *
 *   —— 顶层 `_.and` / `_.or` 的**子项是 where 子句**（不是字段值），且可以嵌套。
 *   早期假实现只支持「字段级指令」，于是任何用顶层 `or` 的查询在本地会
 *   **恒不匹配**（静默返回空集），而线上却正常 —— 典型的「本地绿、线上错」。
 *   排期算法里 `lockWeek` / `unlockWeek` 的候补筛选正是这个形状，所以必须补。
 *
 * 字段级指令（`{ age: _.gte(16).and(_.lte(19)) }`）仍走 `matchCmd`。
 */
function matchesWhere(doc, where) {
  if (!where) return true;
  if (isCmd(where)) {
    const op = where.__cmd || {};
    if (op.and) return op.and.every((c) => matchesWhere(doc, c));
    if (op.or) return op.or.some((c) => matchesWhere(doc, c));
    return false;            // 顶层只支持 and / or 组合
  }
  return Object.keys(where).every((k) => {
    const want = where[k];
    if (isCmd(want)) return matchCmd(doc[k], want);
    if (want && typeof want === 'object' && want[INC] !== undefined) return true; // 自增条件不参与筛选
    return doc[k] === want;
  });
}

/** @deprecated 保留旧名，内部转交 matchesWhere（阶段 5 前只有字段级 where） */
const matches = matchesWhere;

class Query {
  constructor(name, where) {
    this.name = name;
    this._where = where || null;
    this._limit = 0;
    this._skip = 0;
    this._orders = [];
  }
  where(w) { this._where = w; return this; }
  limit(n) { this._limit = n; return this; }
  skip(n) { this._skip = n; return this; }
  orderBy(field, dir) { this._orders.push([field, dir || 'asc']); return this; }

  /** 过滤 + 排序后的全量行（分页前） */
  _rows() {
    let rows = Array.from(bucket(this.name).values()).filter((d) => !this._where || matches(d, this._where));
    if (this._orders.length) {
      rows = rows.slice().sort((a, b) => {
        for (let i = 0; i < this._orders.length; i++) {
          const f = this._orders[i][0];
          const dir = this._orders[i][1];
          const rawA = a[f];
          const rawB = b[f];
          /**
           * ⚠️⚠️ **Date 必须按「时刻」比较，不能用 `===` 判等**。
           *    这里每个文档都是 `clone()` 出来的**独立 Date 实例** ——
           *    两行 createTime 同一时刻但实例不同，`rawA === rawB` 是 **false**，
           *    于是 `rawA < rawB ? -1 : 1` 恒返回 1，比较器自相矛盾，
           *    多键排序**退化成插入顺序**（且不报错）。
           *    而「候选按 createTime 升序 + id 兜同秒」正是排期算法的可复现性基础
           *    （见 songSchedulingService.initialAllocate / reschedule），
           *    这个 bug 会让「同秒提交的两个人谁先落座」每次跑都不一样。
           */
          const av = rawA instanceof Date ? rawA.getTime() : rawA;
          const bv = rawB instanceof Date ? rawB.getTime() : rawB;
          const an = av === undefined || av === null;
          const bn = bv === undefined || bv === null;
          let c;
          if (an && bn) c = 0;
          else if (an) c = -1;      // 近似 SQL：NULL 最小
          else if (bn) c = 1;
          else if (av === bv) c = 0;              // 相等 → 交给下一个排序键
          else c = av < bv ? -1 : 1;
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    return rows;
  }

  async get() {
    let rows = this._rows();
    if (this._skip) rows = rows.slice(this._skip);
    if (this._limit) rows = rows.slice(0, this._limit);
    return { data: clone(rows) };
  }

  async count() { return { total: this._rows().length }; }
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
  skip(n) { return new Query(this.name, null).skip(n); }
  orderBy(f, d) { return new Query(this.name, null).orderBy(f, d); }
  doc(id) { return new Doc(this.name, id); }
  async add({ data }) {
    const id = data._id !== undefined ? String(data._id) : `auto_${++autoId.n}`;
    if (bucket(this.name).has(id)) { const e = new Error('duplicate _id'); e.errCode = -502002; throw e; }
    bucket(this.name).set(id, { _id: id, ...clone(data) });
    return { _id: id };
  }
  async count() { return { total: bucket(this.name).size }; }
}

// Serial transactions with rollback exercise atomicity, not real cloud contention.
// Transaction collection deliberately permits document operations only.
let transactionTail = Promise.resolve();
const fakeDb = {
  runTransaction: async (work) => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = new Map(Array.from(store, ([name, docs]) => [name, new Map(Array.from(docs, ([id, doc]) => [id, clone(doc)]))]));
    try {
      return await work({ collection: (name) => ({
        doc: (id) => new Doc(name, id),
        add: (options) => new Collection(name).add(options),
      }) });
    } catch (error) {
      store.clear();
      snapshot.forEach((docs, name) => store.set(name, docs));
      throw error;
    } finally { release(); }
  },
  collection: (n) => new Collection(n),
  // 模拟服务端建集合：已存在时抛错（对齐真实 SDK 行为）
  createCollection: async (name) => {
    if (store.has(name)) {
      const e = new Error('collection already exists');
      e.errCode = -501001;
      throw e;
    }
    store.set(name, new Map());
    return {};
  },
  command: {
    inc: (n) => ({ [INC]: n }),                    // 自增：applyPatch 特判处理
    eq: (v) => new Cmd({ eq: v }),
    neq: (v) => new Cmd({ neq: v }),
    gt: (v) => new Cmd({ gt: v }),
    gte: (v) => new Cmd({ gte: v }),
    lt: (v) => new Cmd({ lt: v }),
    lte: (v) => new Cmd({ lte: v }),
    in: (arr) => new Cmd({ in: arr }),
    nin: (arr) => new Cmd({ nin: arr }),
    exists: (b) => new Cmd({ exists: !!b }),
    and: (...a) => new Cmd({ and: a.length === 1 && Array.isArray(a[0]) ? a[0] : a }),
    or: (...a) => new Cmd({ or: a.length === 1 && Array.isArray(a[0]) ? a[0] : a }),
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
/**
 * 被测的云函数目录
 * 默认 = **源码目录**（cloud/cloudfunctions/api）。
 * 设 `HARNESS_API_DIR` 可指向**打包产物**（miniprogram/cloudfunctions/api），
 * 用来验证「单文件打包后行为与源码一致」—— 打包器是我们自己写的，必须能自证。
 * ⚠️ 必须在 `require('./harness')` **之前**设置该环境变量（此处只读一次）。
 */
const API_DIR = process.env.HARNESS_API_DIR || path.join(__dirname, '..', 'cloudfunctions', 'api');

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
