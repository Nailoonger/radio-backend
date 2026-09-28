'use strict';

/**
 * 数据层封装 —— 云数据库（文档型）
 *
 * 这一层的职责：把原 Sequelize 的三种惯用法，等价翻译成云数据库写法，
 * 让业务代码（从 src/services 移植过来的）**改动面最小**。
 *
 * | 原 Sequelize 写法 | 本层提供 |
 * |---|---|
 * | Model.create() | insertOne() |
 * | Model.update(data, { where }) + 判 affectedRows===0 | updateWhere() + 判 stats.updated===0 |
 * | UNIQUE 索引冲突 | reserveUnique()（固定 _id 写入，重复即失败） |
 * | AUTO_INCREMENT id | nextId(scope)（计数器集合 + 原子自增） |
 * | sequelize.transaction | 不提供跨文档事务；靠「原子更新抢位 + 幂等键」重建（见 docs 第四节） |
 *
 * ⚠️ 集合名 = 原表名（user / submit / weekly_schedule ...）。
 *
 * ⚠️⚠️ **字段名统一用驼峰**（== Sequelize 属性名 == 前端 JSON 字段名）。
 *     原表里的下划线列名（`is_show`）只是 Sequelize 的**存储细节**，不进云端。
 *     这样返回给前端零转换、零改动；阶段 8 数据迁移时也直接照属性名写入即可。
 *     例：SQL 列 `is_show` ↔ 云文档字段 `isShow`。
 */

const cloud = require('wx-server-sdk');

const db = cloud.database();
const _ = db.command;

/** 集合名常量（避免各处硬编码字符串拼错） */
const C = {
  USER: 'user',
  ADMIN: 'admin',
  SUBMIT: 'submit',
  PROGRAM: 'program',
  NOTICE: 'notice',
  MESSAGE: 'message',
  SETTING: 'system_setting',
  SWITCH: 'system_switch',
  CADRE: 'cadre',
  STAFF: 'staff',
  NOTICE_ACK: 'notice_ack',
  IMPORT_BATCH: 'import_batch',
  CLEANUP_LOG: 'cleanup_log',
  WEEKLY: 'weekly_schedule',
  ASSIGNMENT_LOG: 'assignment_log',
  STATUS_LOG: 'request_status_log',
  UNIQUE_KEYS: 'unique_keys',
  SEQUENCE: 'sequence',
};

const coll = (name) => db.collection(name);

/** 取一条（等价 findOne） */
async function findOne(name, where) {
  const r = await coll(name).where(where).limit(1).get();
  return (r.data && r.data[0]) || null;
}

/** 按 _id 取一条 */
async function findById(name, id) {
  try {
    const r = await coll(name).doc(String(id)).get();
    return r.data || null;
  } catch (e) {
    return null;  // 文档不存在时云数据库抛错，语义上等同 null
  }
}

async function insertOne(name, data) {
  const r = await coll(name).add({ data });
  return r._id;
}

/**
 * 指定 `_id` 写入 —— 给「业务键当主键」的那 4 张表用
 * （system_setting / system_switch / notice_ack / weekly_schedule）。
 * 重复写入会抛错，行为等同 UNIQUE 冲突。
 */
async function insertWithId(name, id, data) {
  const _id = String(id);
  await coll(name).add({ data: { _id, ...data } });
  return _id;
}

/**
 * 带条件更新 —— **本项目并发安全的核心**，等价于原 `Model.update(data,{where})` + affectedRows 判定
 *
 * 原有写法：`const [n] = await Submit.update(patch, { where: {...} }); if (n === 0) return { logs: [] };`
 * 现在写法：`const n = await updateWhere('submit', {...}, patch); if (n === 0) return { logs: [] };`
 *
 * ⚠️ 云数据库 where().update() 是**批量**更新，语义与 SQL UPDATE ... WHERE 一致。
 *    为了与原来「按主键 + 条件」的意图保持一致，where 里请显式带上 _id：
 *    updateWhere('submit', { _id: docId, review_status: 0 }, patch)
 */
async function updateWhere(name, where, patch) {
  const r = await coll(name).where(where).update({ data: patch });
  return (r.stats && r.stats.updated) || 0;
}

/** 按 _id 更新（无条件），返回是否成功 */
async function updateById(name, id, patch) {
  const r = await coll(name).doc(String(id)).update({ data: patch });
  return (r.stats && r.stats.updated) || 0;
}

async function removeWhere(name, where) {
  const r = await coll(name).where(where).remove();
  return (r.stats && r.stats.removed) || 0;
}

/**
 * 数字主键生成（等价 AUTO_INCREMENT）
 * 计数器集合 sequence：{ _id: 'submit', value: 3 }
 * 用原子自增拿号，且**不会因并发拿到重复号**。
 */
/**
 * 数字主键生成（等价 AUTO_INCREMENT）
 * 计数器集合 sequence：{ _id: 'submit', value: 3 }
 *
 * ⚠️⚠️ **首次建计数器时，初值取「目标集合现有最大 id + 1」，不是 1。**
 *    这条保护是给阶段 8 数据迁移用的：历史数据的 id 由 MySQL 自增产生，
 *    若云端的计数器从 1 重新开始，新建记录会**与历史 id 撞号** ——
 *    而云数据库只保证 `_id` 唯一，**不校验业务 `id`**，所以冲突是静默的：
 *    前端按 id 跳详情会拿到错的那一条，排查代价极高。
 *    （本项目 scope 恒等于集合名，故直接用 scope 当集合名查 max(id)。）
 */
async function nextId(scope) {
  const seq = coll(C.SEQUENCE);

  let exists = true;
  try {
    await seq.doc(scope).get();
  } catch (e) {
    exists = false; // 文档不存在 → 首次
  }

  if (!exists) {
    let init = 1;
    try {
      const top = await coll(scope).orderBy('id', 'desc').limit(1).get();
      const maxId = top.data && top.data[0] ? Number(top.data[0].id) : NaN;
      if (Number.isInteger(maxId) && maxId >= 1) init = maxId + 1;
    } catch (e) { /* 集合不存在 / 尚未建 → 从 1 开始 */ }

    try {
      await seq.add({ data: { _id: scope, value: init } });
      return init;
    } catch (e2) {
      // 并发下两个实例同时首次创建：撞 _id 的那个走自增分支
      await seq.doc(scope).update({ data: { value: _.inc(1) } });
      const r = await seq.doc(scope).get();
      return r.data.value;
    }
  }

  await seq.doc(scope).update({ data: { value: _.inc(1) } });
  const r = await seq.doc(scope).get();
  return r.data.value;
}

/**
 * 唯一性登记（等价 UNIQUE 索引）
 *
 *   const ok = await reserveUnique('user_name', username, userId);
 *   if (!ok) throw new ApiError(Codes.CONFLICT, '学号已存在');
 *
 * 原理：文档 _id 天然唯一，`unique_keys` 里用固定 _id 占位，重复 add 直接报错。
 */
async function reserveUnique(scope, key, ownerId) {
  const id = `${scope}:${key}`;
  try {
    await coll(C.UNIQUE_KEYS).add({ data: { _id: id, scope, key: String(key), owner_id: ownerId, create_time: new Date() } });
    return true;
  } catch (e) {
    return false;   // 已存在 → 唯一冲突
  }
}

/** 释放唯一键（删除主记录时同步调用，避免孤儿键挡住后续写入） */
async function releaseUnique(scope, key) {
  try {
    await coll(C.UNIQUE_KEYS).doc(`${scope}:${key}`).remove();
    return true;
  } catch (e) {
    return false;
  }
}

/** 查唯一键归属（用于「该键属于我自己则允许」的更新场景） */
async function getUniqueOwner(scope, key) {
  const doc = await findById(C.UNIQUE_KEYS, `${scope}:${key}`);
  return doc ? doc.owner_id : null;
}

/**
 * 幂等锁：定时任务/重跑场景防重复执行
 * 返回 true 表示本次抢到执行权；false 表示已有同键记录（跳过）
 */
async function acquireIdempotentKey(key) {
  try {
    await coll(C.UNIQUE_KEYS).add({ data: { _id: `idem:${key}`, scope: 'idem', key, create_time: new Date() } });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 多条查询（等价 Sequelize findAll）
 *   findMany('notice', { isShow: 1 }, { orderBy: [['isTop','desc'],['publishTime','desc']], skip, limit })
 *
 * ⚠️ orderBy 用**驼峰**字段名（见文件头说明）。
 * ⚠️ 云数据库单次 get 上限 100 条（云函数端）；超量请分页（skip/limit）。
 */
async function findMany(name, where, opts) {
  const o = opts || {};
  let q = coll(name);
  if (where && Object.keys(where).length) q = q.where(where);
  (o.orderBy || []).forEach(([field, dir]) => { q = q.orderBy(field, dir || 'asc'); });
  if (o.skip) q = q.skip(o.skip);
  if (o.limit) q = q.limit(o.limit);
  const r = await q.get();
  return r.data || [];
}

/**
 * 计数（等价 Sequelize count）
 *
 * ⚠️ `where` 为空时**不下 `.where({})`**，直接用 `collection.count()`。
 *    与 `findMany` 的口径保持一致；`where({})` 在部分 SDK 版本上语义不明，
 *    而「统计全表」在管理端概览里是常见调用（14 个 count 里有好几个不带条件）。
 */
async function count(name, where) {
  let q = coll(name);
  if (where && Object.keys(where).length) q = q.where(where);
  const r = await q.count();
  return (r && r.total) || 0;
}

/**
 * 全量查询（自动翻页）
 *
 * ⚠️ 云函数端单次 get **上限 100 条**，一次性 `limit: 999` 是无效的（静默只回 100 条）。
 *    需要「拿到全部符合条件的行」时必须用本函数，不要直接 findMany 加大 limit。
 *
 * @param {number} [opts.max] 安全上限，防止异常数据把查询拖垮（默认 1000）
 */
async function findAllPaged(name, where, opts) {
  const o = opts || {};
  const pageSize = o.pageSize || 100;
  const max = o.max || 1000;
  const out = [];
  let skip = 0;
  while (skip < max) {
    const rows = await findMany(name, where, { ...o, limit: pageSize, skip });
    out.push(...rows);
    if (rows.length < pageSize) break;
    skip += rows.length;
  }
  return out;
}

/**
 * 分组计数（等价 SQL `GROUP BY field` + `COUNT(*)`）
 *
 * ⚠️⚠️ 云数据库**没有**云端 GROUP BY（要么用聚合管道 `aggregate()` —— 自研 harness
 *    不支持；要么在 JS 里聚合）。这里退化成「全量拉取 + JS 聚合」。
 *
 * 适用前提：待统计集合很小（如「某个播出周已排期的点歌」，上限 = 5 天 × N 时段 × 容量）。
 * 大表请勿用本函数。
 */
async function countByField(name, where, field, opts) {
  const rows = await findAllPaged(name, where, opts);
  const out = {};
  rows.forEach((r) => {
    const k = r[field];
    if (k === undefined || k === null || k === '') return;
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

/**
 * URL 路径参数 → 业务数字主键
 *
 * ⚠️⚠️ **主键口径（全项目唯一权威）**：云文档里同时存在两个标识
 *   - `_id`  ：云数据库自带的字符串主键（唯一性模拟 / 业务键文档用，见下）
 *   - `id`   ：**数字**业务主键，= 原 MySQL AUTO_INCREMENT，与旧数据同一套 id 空间
 *
 *   业务查询（详情 / 关联外键）**一律用 `id`**。
 *   不要拿 URL 里的 `:id`（字符串）去查 `_id` —— 类型不一致，恒查不到，且不报错（静默 404）。
 *
 *   唯一例外（用「业务键」当 `_id`，此时不用数字 id 查）：
 *     system_setting → `_id = 'setting:<key>'`
 *     system_switch  → `_id = 'switch:<key>'`
 *     notice_ack     → `_id = 'ack:<openid>:<notice_key>'`
 *     weekly_schedule→ `_id = 'week:<week_start_date>'`
 *
 * 非法值返回 null，调用方据此走「不存在」分支。
 * **不要**把 NaN 塞进 where：JSON 序列化后变 null，条件会静默失效。
 */
function parseId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = {
  db, _, C, coll,
  findOne, findById, findMany, findAllPaged, insertOne, insertWithId, updateWhere, updateById, removeWhere,
  count, countByField,
  nextId, reserveUnique, releaseUnique, getUniqueOwner, acquireIdempotentKey, parseId,
};
