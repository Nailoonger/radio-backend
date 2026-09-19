'use strict';

/**
 * 系统设置（KV）读写小工具
 *
 * 为什么不用 model 直接拿属性：`desc` 在部分方言里是关键字，属性名可能被模型改过。
 * 这里统一走 r.get('key') / r.get('value')，并对读写失败做兜底，
 * 让「设置读不到」不至于把业务接口打成 500。
 */
const { SystemSetting } = require('../models');

/** 批量读：{ key: value } */
async function getMany(keys) {
  const out = {};
  try {
    const rows = await SystemSetting.findAll({ where: { key: keys } });
    rows.forEach((r) => {
      const k = r.get ? r.get('key') : r.key;
      const v = r.get ? r.get('value') : r.value;
      out[k] = v;
    });
  } catch (e) {
    if (!/no such table|doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e.message))) throw e;
  }
  return out;
}

/** 单个读 */
async function get(key, fallback = '') {
  const m = await getMany([key]);
  return m[key] === undefined || m[key] === null ? fallback : m[key];
}

/** 写入（不存在则建） */
async function set(key, value, desc) {
  const row = await SystemSetting.findOne({ where: { key } });
  if (row) {
    await row.update({ value: String(value) });
    return row;
  }
  return SystemSetting.create({ key, value: String(value), desc: desc || null });
}

module.exports = { getMany, get, set };
