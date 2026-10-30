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
const account = require('../../services/accountPassword');

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

/** POST /admin/admin/create   body: { username, password, nickname, role, userId? } */
async function create(ctx) {
  asSuper(ctx);
  const body = ctx.body || {};
  const { username, password, nickname } = body;
  const roleNum = Number(body.role);

  if (!username || !password) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
  }
  if (String(password).length < 6) {
    throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
  }
  // 角色：0 超管 / 1 社干 / 2 站员（伙伴端站员）
  if (![0, 1, 2].includes(roleNum)) {
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

  /**
   * ── 账号密码统一（2026-10-31）──
   * 密码的唯一事实源是 user.password。所以建后台账号这一步必须连带处理 user 行：
   *
   *   · 超管 / 社干（老师）：**先建一条 user 行**（kind=teacher，工号当 username），
   *     admin.userId 指向它。不建的话这个人建出来就登不进去 ——
   *     登录会去找 user 记录，找不到才退回旧字段校验，而旧字段马上就不再是事实源了。
   *
   *   · 站员（role=2）：**必须已经有学生档案**，不接受手打建号。
   *     手建出来的站员 `userId` 为空，排班 / 请假 / 考勤都查不到这个人。
   *     正规通道是「账号管理 › 新增站员」（走 POST /partner/accounts/import）。
   */
  let userId = Number(body.userId) || null;
  let createdUserId = null;
  try {
    if (roleNum === 2) {
      if (!userId) {
        throw new ApiError(Codes.PARAM_ERROR, '站员请从学生名册导入（账号管理 › 新增站员）');
      }
      const u = await findOne(C.USER, { id: userId });
      if (!u) throw new ApiError(Codes.NOT_FOUND, '关联的学生档案不存在');
    } else {
      const u = await account.createUserForAdmin({
        username,
        plainPassword: password,
        nickname,
        kind: account.KIND_TEACHER,
      });
      userId = Number(u.id);
      createdUserId = Number(u.id);
    }
  } catch (e) {
    // 建 user 失败就把刚抢到的 admin 唯一键放掉，否则这个用户名从此建不了号
    await releaseUnique('admin', username);
    throw e;
  }

  const doc = {
    id,
    username,
    /**
     * ⚠️ admin.password 仍然写入，但**登录不再读它**（事实源已改为 user.password）。
     *    保留写入的理由有两条，都很实际：
     *      ① MySQL 的 admin.password 是 NOT NULL，写 null 直接报错；
     *      ② 万一要回滚登录逻辑，旧密码还在，不用让所有人重设密码。
     */
    password: await bcrypt.hash(String(password), 10),
    nickname: nickname || username,
    role: roleNum,
    // ⚠️ userId 指向 user 表（学生档案）。排班/请假/考勤/互评的 personId 一律用 **admin.id**，
    //    所以这里挂 userId 只是"认得出这是谁"，不改任何 duty 数据的键。
    userId,
    department: String(body.department || ''),
    dutyRoles: Array.isArray(body.dutyRoles) ? body.dutyRoles : [],
    status: 1,
    lastLoginAt: null,
    createTime: now,
    updateTime: now,
  };

  try {
    await insertOne(C.ADMIN, doc);
  } catch (e) {
    await releaseUnique('admin', username);
    if (createdUserId) {
      try {
        await removeWhere(C.USER, { id: createdUserId });
        await releaseUnique('user_name', username);
      } catch (_) { /* 回滚 user 行失败不掩盖原始错误 */ }
    }
    throw e;
  }

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
  if (body.role !== undefined && [0, 1, 2].includes(Number(body.role))) {
    const nextRole = Number(body.role);
    // 站员的身份必须挂在学生档案上，否则排班/考勤查不到这个人
    if (nextRole === 2 && !admin.userId) {
      throw new ApiError(Codes.PARAM_ERROR, '改成站员前，这个账号必须先关联学生档案');
    }
    patch.role = nextRole;
  }
  if (body.password) {
    if (String(body.password).length < 6) {
      throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
    }
    const hashed = await bcrypt.hash(String(body.password), 10);
    /**
     * admin.password 仍然写（MySQL 是 NOT NULL，且回滚时用得上），
     * 但**真正生效的是 user.password** —— 密码唯一事实源已经搬过去了。
     *
     * ⚠️ 写 user 的同时要升 pwdChangedAt：这个人三端的旧 token 下一次请求会全部 40101。
     *    「管理员重置密码 = 把人踢下线」是刻意的，不是副作用。
     */
    patch.password = hashed;

    let target = await account.findUserOfAdmin(admin);
    if (!target) target = await account.ensureTeacherProfile(admin);   // 存量老师：顺手补建
    if (!target) throw new ApiError(Codes.NOT_FOUND, '账号资料缺失，无法重置密码');

    const now = new Date();
    await updateById(C.USER, target._id, { password: hashed, pwdChangedAt: now, updateTime: now });
    try { await require('../../services/studentAccount').invalidate(target.username); }
    catch (e) { /* 清缓存失败不影响重置结果，入口直查会兜住 */ }
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

  /**
   * ── 老师的 user 记录要跟着删（2026-10-31 账号密码统一）──
   *
   * 密码搬到 user 表之后，admin 行删了但 user 行还留着，那个工号就被永久占住 ——
   * 再想建同名账号会直接撞「用户名已被占用」，而且没有任何地方能清掉它。
   *
   * ⚠️ 站员（role=2）**绝不能**删 user 行：他的身份首先是学生，
   *    伙伴身份只是第二角色。删了站员身份，他还要用同一个学号登学生端。
   * ⚠️ 只在 kind=teacher 且没有别的 admin 还指向这条 user 时才删。
   */
  if (Number(admin.role) !== 2 && admin.userId) {
    try {
      const u = await findOne(C.USER, { id: Number(admin.userId) });
      if (u && String(u.kind || 'student') === 'teacher') {
        const others = await count(C.ADMIN, { userId: Number(admin.userId) });
        if (others === 0) {
          await removeWhere(C.USER, { id: Number(admin.userId) });
          await releaseUnique('user_name', u.username);
        }
      }
    } catch (e) {
      // 清理失败不能把「账号已删除」这个既定结果变成报错
      console.warn('[admin] 删除账号后清理 user 记录失败', admin.id, admin.userId, (e && e.message) || e);
    }
  }

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
