'use strict';

/**
 * 用户端 · 模块开关（公开接口，无需登录）
 * 迁移自 src/controllers/user/switchController.js —— 返回值结构逐字段一致
 */

const switchService = require('../../services/switch');

/** GET /user/switch/list */
async function list() {
  const list = await switchService.publicList();
  return { list };
}

/** GET /user/switch/:key */
async function get(ctx) {
  return switchService.publicGet(ctx.params.key);
}

module.exports = { list, get };
