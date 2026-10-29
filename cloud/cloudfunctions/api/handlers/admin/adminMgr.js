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
const { C, _, findOne, findAllPaged, insertOne, updateById, removeWhere, count, nextId, parseId, reserveUnique, releaseUnique } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asSuper, pager, pick, pagedList } = require('./_kit');

/** 初始口令的 bcrypt 成本（与 partner/accounts.import 同口径，见 resetPasswordBatch 注释） */
const BCRYPT_COST = 8;

/** admin 的对外字段集（**绝无 password**） */
const LIST_FIELDS = ['id', 'username', 'nickname', 'role', 'status', 'lastLoginAt', 'createTime',
  'userId', 'department', 'dutyRoles'];

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
  // 角色：0 超管 / 1 社干 / 2 站员（伙伴端站员）
  if (![0, 1, 2].includes(Number(role))) {
    throw new ApiError(Codes.PARAM_ERROR, '角色必须为 0(超管) / 1(社干) / 2(站员)');
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
    role: Number(role),
    // ⚠️ userId 指向 user 表（学生档案）。排班/请假/考勤/互评的 personId 一律用 **admin.id**，
    //    所以这里挂 userId 只是"认得出这是谁的学生档案"，不改任何 duty 数据的键。
    userId: Number((ctx.body || {}).userId) || null,
    department: String((ctx.body || {}).department || ''),
    dutyRoles: Array.isArray((ctx.body || {}).dutyRoles) ? ctx.body.dutyRoles : [],
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
  if (body.role !== undefined && [0, 1, 2].includes(Number(body.role))) patch.role = Number(body.role);
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

/**
 * POST /admin/admin/reset-password/batch   body: { range: 'all'|'cadre'|'staff'|'todo' }
 *
 * 批量把伙伴账号的密码重置回「user + 学号」——伙伴端「批量重置」抽屉的落地接口。
 *
 * ⚠️ 为什么不在前端循环 PUT：
 *    每次 PUT 都是一次网络往返 + 一次 bcrypt，几十人就是几十次串行请求，小程序上必卡；
 *    这里一轮取全量、只发一次请求，且**失败即整条报错**，不会中途静默断在某一半。
 *
 * ⚠️ cost 用 8（与 partner/accounts.import 同口径）：重置就是回到初始状态，
 *    初始口令形态本来就是可预测的「user+学号」，不是永久口令；
 *    用户自己改密后由 update 接口升到 10。cost 10 × 200 人会撞云函数执行时长。
 *
 * ⚠️ 不排除调用者自己：JWT 不会因为改密码而失效，所以不会把人立刻踢出去；
 *    真踢出去的是「下次登录」，前端在确认文案里已说明。
 */
async function resetPasswordBatch(ctx) {
  asSuper(ctx);
  const b = ctx.body || {};
  const RANGES = ['all', 'cadre', 'staff', 'todo'];
  const range = RANGES.includes(String(b.range)) ? String(b.range) : 'todo';

  const all = await findAllPaged(C.ADMIN, {});
  const target = all.filter((a) => {
    if (!a || !a.username) return false;
    if (range === 'cadre') return Number(a.role) === 1;   // 社干
    if (range === 'staff') return Number(a.role) === 2;   // 站员
    // 待激活：账号启用着、但从来没登录过（发了账号人还没进来）
    if (range === 'todo') return Number(a.status) === 1 && !a.lastLoginAt;
    return true;
  });

  // 一次最多 200（与 import 同上限）；超出的部分不静默吞掉，回 truncated 让前端提示
  const BATCH_MAX = 200;
  const hits = target.slice(0, BATCH_MAX);
  const now = new Date();
  const done = [];

  for (const a of hits) {
    const plain = `user${String(a.username).trim()}`;
    await updateById(C.ADMIN, a._id, {
      password: await bcrypt.hash(plain, BCRYPT_COST),
      initPwd: true,
      updateTime: now,
    });
    done.push({ id: a.id, username: a.username, name: a.nickname || a.username });
  }

  return {
    range,
    resetCount: done.length,
    total: target.length,
    truncated: target.length > BATCH_MAX,
    list: done,
    // ⚠️ 不回明文：所有账号都是同一条规则，界面直接说规则即可
    passwordRule: '初始密码 = user + 学号',
  };
}

module.exports = { list, create, update, remove, resetPasswordBatch };
