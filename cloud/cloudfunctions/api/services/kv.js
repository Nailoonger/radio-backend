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

const { C, coll, nextId } = require('../lib/db');

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
  // ⚠️ 时间列一律**驼峰**（`createTime` / `updateTime`），与 docs/data-model-mapping.md 第 18 行一致。
  //    这里曾经写成 `create_time` / `update_time` —— 那不在 `system_setting` 模型的属性名里
  //    （模型属性是 `updateTime`，DB 列名才是 `update_time`），管理端 `setting/list` 直接把文档
  //    返回给前端时就会多出两个**前端不认识的**字段、却少了它期望的 `updateTime`。
  const data = { key, value: String(value), desc: desc || null, updateTime: new Date() };
  try {
    await coll(C.SETTING).doc(docId(key)).update({ data });
  } catch (e) {
    // 文档不存在 → 新建（固定 _id，天然充当唯一键）
    // ⚠️ 顺带补上数字 `id`：映射文档里 `system_setting` 的字段是
    //    `id, key, value, desc, updateTime`，管理端 `GET /admin/setting/list`
    //    在 direct 模式下是真的会返回 `id` 的 —— 不补就是一处静默的字段缺失。
    //    只在**新建**时取号（更新路径不碰），成本可忽略。
    const id = await nextId(C.SETTING);
    await coll(C.SETTING).add({ data: { _id: docId(key), id, ...data, createTime: new Date() } });
  }
  return { key, value: data.value, desc: data.desc };
}

module.exports = { getMany, get, set, docId };
