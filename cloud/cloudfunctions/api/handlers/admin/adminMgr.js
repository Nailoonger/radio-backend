'use strict';

/**
 * 管理端 · 管理员账号管理（仅超管）
 * 迁移自 src/controllers/admin/adminController.js
 *
 * ⚠️ 字段安全：原实现用 `attributes: ['id','username','nickname','role','status','lastLoginAt','createTime']`
 *    **把 password 摘掉**。云数据库没有投影能力 → 必须手工 `pick`，
 *    漏了就是把 bcrypt 哈希吐给前端。
 *
 * ⚠️ 唯一性：MySQL 有 `uk_admin_username`。云端改用 `reserveUnique('admin_username', ...)`
 *    （固定 `_id` 占位，重复写入直接报错）—— 与源实现「先 findOne 查重 + DB 唯一索引兜底」
 *    两层语义对齐。⚠️ 阶段 8 迁移时需要**为存量管理员补登记** `unique_keys`。
 */

const bcrypt = require('bcryptjs');
const { C, _, findOne, insertOne, updateById, removeWhere, count, nextId, parseId, reserveUnique, releaseUnique } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asSuper, pager, pick, pagedList } = require('./_kit');

/** admin 的对外字段集（**绝无 password**） */
const LIST_FIELDS = ['id', 'username', 'nickname', 'role', 'status', 'lastLoginAt', 'createTime'];

/** GET /admin/admin/list */
async function list(ctx) {
  asSuper(ctx);
  const q = ctx.query || {};
  const { page, pageSize } = pager(q, 20);
  const r = await pagedList(C.ADMIN, {
    where: {},
    keyword: q.keyword ? String(q.keyword) : '',
    fields: ['username', 'nickname'],
    orderBy: [['id', 'asc']],
    page,
    pageSize,
  });
  return { ...r, list: r.list.map((x) => pick(x, LIST_FIELDS)) };
}

/** POST /admin/admin/create   body: { username, password, nickname, role } */
async function create(ctx) {
  asSuper(ctx);
  const { username, password, nickname, role } = ctx.body || {};
  if (!username || !password) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
  }
  if (String(password).length < 6) {
    throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
  }
  if (![0, 1].includes(role)) {
    throw new ApiError(Codes.PARAM_ERROR, '角色必须为0或1');
  }

  const exists = await findOne(C.ADMIN, { username });
  if (exists) throw new ApiError(Codes.CONFLICT, '用户名已存在');

  const now = new Date();
  const id = await nextId(C.ADMIN);
  // 唯一索引等价物（并发下 findOne 可能双双落空，这一步才是真兜底）。
  // ⚠️ scope 必须用 'admin'（= 映射文档 §三 的 `admin:` 前缀），不要另起名字。
  const got = await reserveUnique('admin', username, id);
  if (!got) throw new ApiError(Codes.CONFLICT, '用户名已存在');

  const doc = {
    id,
    username,
    password: await bcrypt.hash(String(password), 10),
    nickname: nickname || username,
    role,
    status: 1,
    lastLoginAt: null,
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.ADMIN, doc);

  return { id: doc.id, username: doc.username, nickname: doc.nickname, role: doc.role };
}

/** PUT /admin/admin/:id   body: { nickname?, status?, role?, password? } */
async function update(ctx) {
  asSuper(ctx);
  const id = parseId(ctx.params.id);
  const admin = id === null ? null : await findOne(C.ADMIN, { id });
  if (!admin) throw new ApiError(Codes.NOT_FOUND, '账号不存在');

  const body = ctx.body || {};
  const patch = { updateTime: new Date() };
  if (body.nickname !== undefined) patch.nickname = body.nickname;
  if (body.status !== undefined) patch.status = body.status ? 1 : 0;
  if (body.role !== undefined && [0, 1].includes(body.role)) patch.role = body.role;
  if (body.password) {
    if (String(body.password).length < 6) {
      throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
    }
    patch.password = await bcrypt.hash(String(body.password), 10);
  }

  await updateById(C.ADMIN, admin._id, patch);
  const next = { ...admin, ...patch };
  return {
    id: next.id,
    username: next.username,
    nickname: next.nickname,
    role: next.role,
    status: next.status,
  };
}

/** DELETE /admin/admin/:id */
async function remove(ctx) {
  const me = asSuper(ctx);
  const id = parseId(ctx.params.id);
  if (id !== null && id === Number(me.id)) {
    throw new ApiError(Codes.FORBIDDEN, '不能删除自己');
  }
  const admin = id === null ? null : await findOne(C.ADMIN, { id });
  if (!admin) throw new ApiError(Codes.NOT_FOUND, '账号不存在');

  if (Number(admin.role) === 0) {
    // 检查是否还有其它超级管理员
    const otherSuper = await count(C.ADMIN, { role: 0, id: _.neq(admin.id) });
    if (otherSuper === 0) {
      throw new ApiError(Codes.FORBIDDEN, '系统至少保留一个超级管理员');
    }
  }

  await removeWhere(C.ADMIN, { id });
  // 删主记录必须同步释放唯一键（否则孤儿键挡住后续同名新建）
  await releaseUnique('admin', admin.username);
  return null;
}

module.exports = { list, create, update, remove };
