'use strict';

/**
 * handler 惰性解析器
 *
 * 路由表里每个 handlerKey（如 'user.submit.create'）对应一个文件 + 一个导出方法：
 *   'user.submit.create' → ./user/submit.js 的 create
 *   'admin.student.list' → ./admin/student.js 的 list
 *
 * 好处：迁移是**一个模块一个模块**推进的，没移植到的接口不会让整个云函数崩掉，
 * 而是返回统一的可识别提示（code=50001 + 文案「接口迁移中」），
 * 便于灰度：小程序端哪个功能没通，一看就知道是哪一段还没搬。
 */

const path = require('path');
const fs = require('fs');
const { ApiError, Codes } = require('../lib/response');

const cache = new Map();
const missing = new Set();

function todoHandler(handlerKey) {
  return async () => {
    throw new ApiError(Codes.SERVER_ERROR, `接口迁移中（${handlerKey}）`);
  };
}

function resolveHandler(handlerKey) {
  if (cache.has(handlerKey)) return cache.get(handlerKey);

  const segs = handlerKey.split('.');
  const method = segs.pop();
  const modPath = './' + segs.join('/');
  const file = path.join(__dirname, segs.join('/') + '.js');

  let handler = null;
  if (fs.existsSync(file)) {
    try {
      const mod = require(modPath);
      if (mod && typeof mod[method] === 'function') handler = mod[method];
    } catch (e) {
      // 模块内部出错（例如依赖未安装）时不要让整个网关挂掉
      console.error('[handlers] 载入失败', handlerKey, e && e.message);
    }
  }

  if (!handler) {
    if (!missing.has(handlerKey)) {
      missing.add(handlerKey);
      console.log('[handlers] 尚未移植', handlerKey);
    }
    handler = todoHandler(handlerKey);
  }

  cache.set(handlerKey, handler);
  return handler;
}

module.exports = { resolveHandler };
