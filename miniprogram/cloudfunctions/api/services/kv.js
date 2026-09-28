'use strict';

/**
 * 系统设置 KV —— 从 src/services/kvService.js 移植
 *
 * 存储变化：`system_setting` 集合，**文档 _id 直接用 `setting:<key>`**，
 * 一次 doc().get() 即可命中，比原来 where({key}) 再走一次索引更快。
 *
 * 保留原语义：
 *  - get(key, fallback) 读不到返回 fallback（默认 ''），不抛错
 *  - set(key, value) 不存在则建，value 一律转字符串
 */

const { C, coll } = require('../lib/db');

const docId = (key) => `setting:${key}`;

/** 批量读：{ key: value } */
async function getMany(keys) {
  const out = {};
  await Promise.all((keys || []).map(async (k) => {
    try {
      const r = await coll(C.SETTING).doc(docId(k)).get();
      if (r && r.data) out[k] = r.data.value;
    } catch (e) {
      // 文档不存在 → 等同未配置，静默跳过（与原实现「读不到不报错」一致）
    }
  }));
  return out;
}

/** 单个读 */
async function get(key, fallback = '') {
  const m = await getMany([key]);
  return m[key] === undefined || m[key] === null ? fallback : m[key];
}

/** 写入（不存在则建） */
async function set(key, value, desc) {
  const data = { key, value: String(value), desc: desc || null, update_time: new Date() };
  try {
    await coll(C.SETTING).doc(docId(key)).update({ data });
  } catch (e) {
    // 文档不存在 → 新建（固定 _id，天然充当唯一键）
    await coll(C.SETTING).add({ data: { _id: docId(key), ...data, create_time: new Date() } });
  }
  return { key, value: data.value, desc: data.desc };
}

module.exports = { getMany, get, set, docId };
