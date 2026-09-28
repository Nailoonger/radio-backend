'use strict';

/**
 * 系统类 handler（无业务依赖）
 *
 * - health          : 部署后验证「小程序 → 云函数」通道是否打通
 * - initCollections : 一次性建齐所有集合（幂等），替代「去云开发控制台手点新建集合」
 *
 * ⚠️ 两者都不碰业务数据，可随时重复调用。
 */

const fs = require('fs');
const path = require('path');

const { version: jwtVersion } = (() => {
  try { return require('jsonwebtoken/package.json'); } catch (e) { return {}; }
})();

/** 列目录（失败不抛，返回错误串）—— 用于确认云端到底传上去了哪些文件 */
function listDir(p) {
  try { return fs.readdirSync(p); } catch (e) { return 'ERR ' + (e && e.message); }
}

/**
 * ⚠️ lib/db 必须**惰性**加载，不能在文件顶层 require。
 *
 * 原因：`lib/db.js` 顶层会执行 `cloud.database()`。一旦这里出问题（依赖缺失、SDK 版本差异、
 * 初始化时序），顶层 require 会把**整个 handler 模块**拖挂 → handlers/index.js 回落到
 * todoHandler → 前端只看到一句笼统的 50001「接口迁移中」，真实原因被完全吞掉。
 * 惰性加载后，失败会变成返回值里的 `dbReady / dbError`，一眼可见。
 */
function loadDb() {
  try {
    return { mod: require('../lib/db'), error: null };
  } catch (e) {
    return { mod: null, error: String((e && (e.message || e.errMsg)) || e) };
  }
}

async function health(ctx) {
  const { mod, error } = loadDb();
  const here = __dirname;
  return {
    ok: true,
    scope: 'cloud-function',
    now: new Date().toISOString(),
    // 便于排查：确认云函数能正常拿到调用者身份
    hasOpenid: !!ctx.openid,
    hasToken: !!ctx.token,
    jwtReady: !!jwtVersion,
    dbReady: !!mod,
    dbError: error,
    // ⚠️ 云端**实际**文件清单：用来区分「文件没传上去」与「代码报错」。
    //    排查 `50001 接口迁移中` 时先看这里。
    dirs: {
      root: listDir(here),
      lib: listDir(path.join(here, 'lib')),
      handlers: listDir(path.join(here, 'handlers')),
      userHandlers: listDir(path.join(here, 'handlers', 'user')),
      services: listDir(path.join(here, 'services')),
    },
  };
}

/**
 * 建集合（幂等，可重复调用）
 *
 * ⚠️ 只有**已部署**的云函数才有建集合权限；开发者工具的本地调试/模拟器里调用会静默无效
 *    （控制台看不到新集合），这属预期，不是 bug。
 * ⚠️ 集合已存在时 SDK 会抛错，这里按「已存在」归类，不算失败。
 * ⚠️ **并发建**：串行 18 次往返在云函数默认超时下容易被掐断，改成并发只花一次往返的时间。
 * ⚠️ 任何加载/执行失败都**转成返回值字段**，绝不让它变成笼统的 50001。
 */
async function initCollections() {
  const { mod, error } = loadDb();
  if (!mod) {
    return { supported: false, loadError: error, total: 0, summary: { loadError: 1 }, results: [] };
  }

  const { C, db } = mod;
  // 集合清单直接取自 lib/db.js 的 C —— 新增集合只改那一处，不会漏建
  const names = Object.values(C);

  if (typeof db.createCollection !== 'function') {
    return {
      supported: false,
      loadError: null,
      total: names.length,
      summary: { unsupported: names.length },
      note: '当前 wx-server-sdk 未提供 db.createCollection，需改用云开发控制台手动建集合',
      results: [],
    };
  }

  const results = await Promise.all(
    names.map(async (name) => {
      try {
        await db.createCollection(name);
        return { name, status: 'created' };
      } catch (e) {
        const msg = String((e && (e.errMsg || e.message)) || e);
        if (/exist/i.test(msg) || msg.indexOf('-501001') >= 0) return { name, status: 'exists' };
        return { name, status: 'error', message: msg };
      }
    })
  );

  const summary = {};
  results.forEach((r) => { summary[r.status] = (summary[r.status] || 0) + 1; });

  return {
    supported: true,
    loadError: null,
    total: names.length,
    summary,
    failures: results.filter((r) => r.status === 'error'),
    results,
  };
}

module.exports = { health, initCollections };
