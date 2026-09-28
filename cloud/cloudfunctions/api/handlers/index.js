'use strict';

/**
 * handler 注册表 + 惰性解析
 *
 * ═══════════ 为什么必须是「静态表」而不是动态拼路径 ═══════════
 * 路由表里的 handlerKey（如 'user.submit.create'）要映射到某个文件 + 某个导出方法。
 * 最直觉的写法是动态拼：
 *
 *     const mod = require('./' + segs.join('/'));     // ❌ 已废弃
 *
 * ⚠️⚠️ 但云函数是**单文件打包**上线的（见 cloud/scripts/bundle.js —— 因为 Windows 下
 *    开发者工具 CLI 会把路径分隔符 `\` 写进压缩包条目名，子目录文件根本传不上去）。
 *    打包器靠**静态分析**找依赖，动态拼接的路径它看不见 → 目标文件不会进产物
 *    → 线上报 `Cannot find module ...`。
 *    因此这里显式列出每个模块，写法必须保持「字面量 require」。
 *
 * ⚠️ 惰性求值：每个 entry 是 `() => require('...')`，只有真正命中的路由才加载该模块。
 *    某个模块依赖缺失只影响它自己，不会把整个网关拖挂。
 *
 * ⚠️ 新增 handler 模块时**必须在这里登记一行**，否则调用返回「模块未登记」。
 *
 * ⚠️ 每条 `require` 路径必须是**字符串字面量**，不要拼接、不要变量。
 */

const { ApiError, Codes } = require('../lib/response');

const REGISTRY = {
  // ---- 系统 ----
  system: () => require('./system'),

  // ---- 用户端（阶段 4）----
  'user.auth': () => require('./user/auth'),
  'user.cadre': () => require('./user/cadre'),
  'user.message': () => require('./user/message'),
  'user.notice': () => require('./user/notice'),
  'user.profile': () => require('./user/profile'),
  'user.program': () => require('./user/program'),
  'user.showcase': () => require('./user/showcase'),
  'user.staff': () => require('./user/staff'),
  'user.submit': () => require('./user/submit'),
  'user.switch': () => require('./user/switch'),

  // ---- 管理端（阶段 7：模块建好后逐条登记）----
  // 'admin.auth': () => require('./admin/auth'),
};

const cache = new Map();
const missing = new Set();

/**
 * 未就绪时的兜底 handler。
 *
 * ⚠️ 迁移期刻意把**真实原因**拼进 message：原来只有笼统一句「接口迁移中」，
 *    于是「模块名写错 / 依赖缺失 / 模块不存在」长得一模一样，只能干瞪眼。
 *    现在一眼可辨：`模块未登记：admin.submit（尚未移植）` / `Cannot find module 'xxx'`。
 */
function todoHandler(handlerKey, reason) {
  return async () => {
    const tail = reason ? ` · 原因：${reason}` : '';
    throw new ApiError(Codes.SERVER_ERROR, `接口未就绪（${handlerKey}）${tail}`);
  };
}

function resolveHandler(handlerKey) {
  if (cache.has(handlerKey)) return cache.get(handlerKey);

  const dot = handlerKey.lastIndexOf('.');
  const modKey = dot < 0 ? handlerKey : handlerKey.slice(0, dot);
  const method = dot < 0 ? handlerKey : handlerKey.slice(dot + 1);

  let handler = null;
  let reason = '';

  const loader = REGISTRY[modKey];
  if (!loader) {
    reason = `模块未登记：${modKey}（尚未移植）`;
  } else {
    try {
      const mod = loader();
      if (mod && typeof mod[method] === 'function') handler = mod[method];
      else reason = `模块 ${modKey} 未导出 ${method}`;
    } catch (e) {
      // 模块内部出错（依赖缺失 / 打包遗漏）时不要让整个网关挂掉
      reason = (e && e.message) || String(e);
      console.error('[handlers] 载入失败', handlerKey, reason);
    }
  }

  if (!handler) {
    if (!missing.has(handlerKey)) {
      missing.add(handlerKey);
      console.log('[handlers] 未就绪', handlerKey, reason);
    }
    handler = todoHandler(handlerKey, reason);
  }

  cache.set(handlerKey, handler);
  return handler;
}

/** 供自检脚本断言「路由表里的每个 handlerKey 都已登记」 */
function registeredModules() {
  return Object.keys(REGISTRY);
}

module.exports = { resolveHandler, registeredModules };
