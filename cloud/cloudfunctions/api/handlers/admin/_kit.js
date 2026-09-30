'use strict';

/**
 * 管理端 handler 公共件
 *
 * 这里集中处理四件在移植中**反复出现、且极易悄悄错掉**的事：
 *
 *  ① 鉴权：Express 把 `adminAuth` / `requireSuperAdmin` 挂在**路由**上，
 *     云函数没有中间件层 → 每个 handler 的第一行必须自己调。
 *     漏掉的后果是「接口能调通、但没登录也能调」，不报错（静默漂移 #2）。
 *
 *  ② `LIKE '%kw%'`：云数据库**没有 LIKE**，`_.or([...])` 也表达不了子串。
 *     → 全量拉取 + JS 过滤。⚠️ 必须**大小写不敏感**：MySQL 默认排序规则
 *     `utf8mb4_general_ci` 的 LIKE 就是 ci 的，写成 `includes()` 会静默变成区分大小写。
 *
 *  ③ 排序：Sequelize 的 `order: [['sort','DESC'],['id','ASC']]` 是多键次序。
 *     ⚠️ 比较 Date 必须按**值**（`getTime()`），不能按对象同一性 —— 每个文档是
 *     独立的 Date 实例，`===` 判等恒 false，会让比较器自相矛盾、排序退化成插入顺序。
 *     （同款坑在 cloud/scripts/harness.js 里踩过一次，见 test-scheduling C5/C6。）
 *
 *  ④ 字段投影：云数据库不支持 `attributes: [...]` → 手工挑字段。
 *     ⚠️ 缺字段一律补 `null`：原 Sequelize 对 NULL 列就是返回 `null`，
 *     而 `undefined` 会被 `JSON.stringify` **整个丢掉**（静默漂移 #5）。
 *     `admin.list` 更是靠这一步**把 password 摘掉**，漏了就是安全事件。
 */

const { ApiError, Codes } = require('../../lib/response');
const { requireAdmin, requireSuperAdmin } = require('../../lib/auth');
const { findAllPaged } = require('../../lib/db');

/** 路由层 `adminAuth` 的等价物 —— 管理端每个 handler 的第一行 */
function asAdmin(ctx) {
  return requireAdmin(ctx);
}

/** 路由层 `requireSuperAdmin` 的等价物（内部已含 adminAuth 语义） */
function asSuper(ctx) {
  return requireSuperAdmin(ctx);
}

/**
 * 分页参数。
 * 原控制器写法是 `const { page = 1, pageSize = 20 } = req.query;` 再 `parseInt(...)`。
 * 前端恒传数字，这里统一收敛成**合法整数**（`parseInt` 失败退回默认），
 * 避免把 NaN 透进响应体（`JSON.stringify(NaN)` → `null`）。
 */
function pager(q, defSize = 20, maxSize = 200) {
  const query = q || {};
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const raw = parseInt(query.pageSize, 10) || defSize;
  const pageSize = Math.min(maxSize, Math.max(1, raw));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** LIKE '%kw%' 的单字段判定（大小写不敏感） */
function likeHit(value, keyword) {
  if (value === undefined || value === null) return false;
  return String(value).toLowerCase().indexOf(String(keyword).toLowerCase()) >= 0;
}

/** 多字段 OR LIKE */
function anyLike(row, keyword, fields) {
  return fields.some((f) => likeHit(row[f], keyword));
}

/** 排序取值：Date → 时间戳（**必须**，见文件头 ③） */
function sortValue(v) {
  return v instanceof Date ? v.getTime() : v;
}

/** 单键比较：NULL/undefined 最小（与 MySQL 一致），数字按数值，其余按字符串 */
function cmpValue(a, b) {
  const av = sortValue(a);
  const bv = sortValue(b);
  if (av === bv) return 0;
  if (av === undefined || av === null) return -1;
  if (bv === undefined || bv === null) return 1;
  if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1;
  const as = String(av);
  const bs = String(bv);
  if (as === bs) return 0;
  return as < bs ? -1 : 1;
}

/** 多键排序（等价 Sequelize `order: [[field, dir], ...]`） */
function sortRows(rows, orderBy) {
  const keys = (orderBy || []).map(([f, d]) => [f, String(d || 'asc').toLowerCase() === 'desc' ? -1 : 1]);
  if (!keys.length) return rows;
  return rows.slice().sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      const [f, dir] = keys[i];
      const c = cmpValue(x[f], y[f]);
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

/** 字段投影（等价 `attributes: [...]`）；缺字段补 null */
function pick(row, fields) {
  const out = {};
  (fields || []).forEach((f) => {
    const v = row ? row[f] : undefined;
    out[f] = v === undefined ? null : v;
  });
  return out;
}

/**
 * 「where + 可选关键字 + 排序 + 分页」的通用列表实现。
 *
 * ⚠️ 先全量拉（`findAllPaged`）再在 JS 里过滤/排序/切片 —— 因为 LIKE 与多键排序
 *    都无法下推到云数据库。**适用前提是集合不大**（本项目 admin / cadre / staff /
 *    notice / message 都是几十~几百量级）。
 *    大表（如 submit，见 `test-*` 的量级假设）请改用「能下推的条件 + 限量拉取」。
 *
 * @param {string} name 集合名
 * @param {object} o
 *   where   必选，能下推的等值/范围条件
 *   keyword 可选，子串关键字
 *   fields  可选，keyword 参与匹配的字段
 *   orderBy 可选，[['sort','desc'],['id','asc']]
 *   page/pageSize
 */
async function pagedList(name, o) {
  const opt = o || {};
  let rows = await findAllPaged(name, opt.where || {});
  if (opt.keyword) rows = rows.filter((r) => anyLike(r, opt.keyword, opt.fields || []));
  if (opt.orderBy) rows = sortRows(rows, opt.orderBy);
  const total = rows.length;
  const page = opt.page || 1;
  const pageSize = opt.pageSize || 20;
  const skip = (page - 1) * pageSize;
  return { list: rows.slice(skip, skip + pageSize), total, page, pageSize };
}

/** 取 body 里显式给出的字段（`!== undefined` 才覆盖，等价源控制器的 for 循环） */
function applyFields(target, body, fields) {
  (fields || []).forEach((f) => {
    if (body && body[f] !== undefined) target[f] = body[f];
  });
  return target;
}

/** 字符串长度上限校验（与原控制器的 `String(x).length > N` 逐字对齐） */
function assertMaxLen(value, max, label) {
  if (value !== undefined && value !== null && String(value).length > max) {
    throw new ApiError(Codes.PARAM_ERROR, `${label}过长`);
  }
}

module.exports = {
  asAdmin, asSuper,
  pager, likeHit, anyLike, sortRows, cmpValue, pick, pagedList, applyFields, assertMaxLen,
};
