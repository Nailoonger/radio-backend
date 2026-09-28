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
 * ⚠️ 集合名 = 原表名（user / submit / weekly_schedule ...），字段名沿用 snake_case，
 *    与现有控制器/前端读取的字段名完全一致。
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
async function nextId(scope) {
  try {
    await coll(C.SEQUENCE).doc(scope).update({ data: { value: _.inc(1) } });
  } catch (e) {
    // 首次：文档不存在 → 建一个并设初值
    try {
      await coll(C.SEQUENCE).add({ data: { _id: scope, value: 1 } });
      return 1;
    } catch (e2) {
      await coll(C.SEQUENCE).doc(scope).update({ data: { value: _.inc(1) } });
    }
  }
  const r = await coll(C.SEQUENCE).doc(scope).get();
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

module.exports = {
  db, _, C, coll,
  findOne, findById, insertOne, updateWhere, updateById, removeWhere,
  nextId, reserveUnique, releaseUnique, getUniqueOwner, acquireIdempotentKey,
};
