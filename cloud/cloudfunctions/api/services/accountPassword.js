'use strict';

/**
 * 账号密码统一（2026-10-31）
 *
 * ═══════════ 为什么要有这个文件 ═══════════
 * 改造前：同一个学生在库里有两行、两套密码。
 *   user.password    ← 学生端 `POST /user/login/account` 校验
 *   admin.password   ← 伙伴端 / 管理后台 `POST /admin/login` 校验
 * 初始密码两边都是 `user+学号`，看着一样；但只要学生改过一次密码，两边就分叉了。
 * 而伙伴端甚至没有改密入口，站员只能一直用初始密码。
 *
 * 改造后：**密码唯一事实源 = user.password**。三个入口都拿它比对。
 * admin 表只保留「身份」（role / id / dutyRoles），不再有独立密码。
 *
 * ═══════════ 为什么不合并 token ═══════════
 * 后台 45 处 `asAdmin()`、伙伴端全部 handler，读的都是 `ctx.admin.id`（= admin.id）；
 * 排班/请假/考勤/互评四张表的 personId 也全部指向 admin.id。
 * 换成 user token 会让 `ctx.admin.id` 变成 user.id → 这四张表的历史数据全部认错人。
 * 所以：**登录时统一密码来源，签发的 token 结构一个字不动**。
 *
 * ═══════════ 惰性迁移（这个很重要）═══════════
 * 存量 admin 行没有 `userId`（老师那条是一直没有）。如果只靠一个一次性脚本，
 * 脚本没跑完之前老师就登不进来，而且没法回滚。
 * 所以这里做**就地补建**：登录时发现没有 userId，就把 admin.password 的哈希
 * 原样搬进一条新 user 行并回填 —— 迁移脚本没跑也照样能用，跑过之后走同一条路径。
 *
 * ⚠️ 哈希可以原样搬：两边都是 bcrypt，同一份 hash 搬到 user 表照样比对得上。
 *    所以整个迁移过程不需要知道任何人的明文密码，也不需要让任何人重设密码。
 */

const { C, findOne, insertOne, updateById, nextId, reserveUnique } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');

/** user.kind 取值 */
const KIND_STUDENT = 'student';
const KIND_TEACHER = 'teacher';

const BCRYPT_COST = 10;   // 用户自己设的密码统一 cost 10；初始密码 cost 8 走 studentAccount

/**
 * 读 kind。
 * ⚠️ 云开发没有 DEFAULT 约束，存量文档里这个字段**根本不存在** →
 *    直接读会是 undefined，必须兜底成 student，不能拿它做真值判断。
 */
function kindOf(user) {
  return String((user && user.kind) || KIND_STUDENT);
}

function isTeacher(user) {
  return kindOf(user) === KIND_TEACHER;
}

/** admin.userId 回填（幂等，已经是这个值就什么都不做） */
async function bindAdminUser(admin, user) {
  if (!admin || !user) return;
  if (Number(admin.userId) === Number(user.id)) return;
  await updateById(C.ADMIN, admin._id, {
    userId: Number(user.id),
    updateTime: new Date(),
  });
  admin.userId = Number(user.id);
}

/**
 * 给存量 admin（老师 / 社干）补一条 user 记录。
 *
 * ⚠️ pwdChangedAt 刻意保持 null：
 *    pv = pwdVersionOf(pwdChangedAt) = 0。而改造前签发的 admin token 里没有 pv，
 *    入口校验按 `Number(payload.pv || 0)` 算也是 0 —— 两边相等，**老师不会被踢下线**。
 *    如果这里写成 new Date()，所有老师下次请求就 40101（因为旧 token 的 pv=0 对不上）。
 */
async function ensureTeacherProfile(admin) {
  const username = String((admin && admin.username) || '').trim();
  if (!username) return null;

  const now = new Date();
  const id = await nextId(C.USER);
  // 抢唯一键：并发下两个人同时登录同一个工号，只有一个能建成
  const got = await reserveUnique('user_name', username, id);
  if (!got) {
    const again = await findOne(C.USER, { username });
    if (again) {
      await bindAdminUser(admin, again);
      return again;
    }
    throw new ApiError(Codes.CONFLICT, '账号初始化失败，请稍后重试');
  }

  const doc = {
    id,
    username,
    // 哈希原样搬过来，不需要明文
    password: (admin && admin.password) || null,
    kind: KIND_TEACHER,
    nickname: (admin && admin.nickname) || username,
    status: Number(admin && admin.status) === 0 ? 0 : 1,
    pwdChangedAt: null,
    loginCount: 0,
    lastLoginAt: null,
    // 老师的年级/班级/座位一律留空 —— 学生端那条线按这些字段算班级，不能给假值
    grade: null,
    classNo: null,
    seatNo: null,
    createTime: now,
    updateTime: now,
  };
  // ⚠️ 把 `_id` 带回返回值：调用方几乎紧接着就要改这一行（比如重置密码要写 password），
  //    没有 `_id` 就只能再查一次，或者踩「document does not exist」（2026-10-31 实测踩到）。
  doc._id = await insertOne(C.USER, doc);
  await bindAdminUser(admin, doc);
  return doc;
}

/**
 * 找到 admin 行对应的 user 行（密码的唯一来源）。**只读，不写库。**
 *
 * ⚠️ 只读是刻意的：补建动作必须发生在**密码校验通过之后**（见 handlers/admin/auth.login），
 *    否则随便一个错密码也会往 user 表写一条记录。
 *
 * 两条查找路径：
 *   ① admin.userId 有值 → 直接取（新建数据都走这条）
 *   ② 按 username 找 —— 存量站员的 admin.username 就是学号，user 表必然有同号
 *
 * ⚠️ 第 ② 步的理论风险：老师工号如果恰好等于某个学生的学号，会找到那个学生。
 *    现实中工号带字母前缀（T2024001），撞不上；真撞了这里会打日志，便于事后追。
 *
 * 找不到返回 null —— 调用方据此判断「这条 admin 还没有 user 记录」（存量老师）。
 */
async function findUserOfAdmin(admin) {
  if (!admin) return null;

  if (admin.userId) {
    const byId = await findOne(C.USER, { id: Number(admin.userId) });
    if (byId) return byId;
    console.warn('[account] admin.userId 指向的 user 不存在，退化为按 username 查找',
      admin.id, admin.userId, admin.username);
  }

  const byName = await findOne(C.USER, { username: String(admin.username || '') });
  return byName || null;
}

/**
 * 密码校验：**只看 user.password**。
 * 空密码的账号（老微信用户 / 尚未补建的老师）一律判失败，不能因为 password 为空就放行。
 */
async function passwordMatches(user, plain) {
  if (!user || !user.password) return false;
  const bcrypt = require('bcryptjs');   // 惰性：lib 层不该成为启动瓶颈
  return bcrypt.compare(String(plain == null ? '' : plain), user.password);
}

/** 按 admin.userId / username 找到 user 后回填绑定（幂等） */
async function bindByAdmin(admin) {
  const user = await findUserOfAdmin(admin);
  if (user) await bindAdminUser(admin, user);
  return user;
}

/**
 * 新建一个后台账号时，先建它对应的 user 行（密码的唯一事实源）。
 *
 * 用途：后台「账号管理」新建超管 / 社干。改造前只往 admin 表插一行，
 * 密码存在 admin.password；现在密码必须落在 user 表，所以这一步不能省，
 * 否则新老师建出来就登不进去（登录会去找 user 记录，找不到又退回旧字段校验 → 空密码）。
 *
 * ⚠️ 用户名冲突时**整个建号失败**，不静默复用：老师的工号如果撞上某个学生的学号，
 *    两个是不同的人，绝不能共用一条 user 记录。
 */
async function createUserForAdmin({ username, plainPassword, nickname, kind }) {
  const uname = String(username || '').trim();
  if (!uname) throw new ApiError(Codes.PARAM_ERROR, '账号不能为空');

  const exist = await findOne(C.USER, { username: uname });
  if (exist) {
    throw new ApiError(Codes.CONFLICT,
      `账号 ${uname} 已被一个${isTeacher(exist) ? '老师' : '学生'}占用，换一个用户名`);
  }

  const bcrypt = require('bcryptjs');
  const now = new Date();
  const id = await nextId(C.USER);
  const got = await reserveUnique('user_name', uname, id);
  if (!got) throw new ApiError(Codes.CONFLICT, '账号已存在（并发）');

  const doc = {
    id,
    username: uname,
    password: plainPassword ? await bcrypt.hash(String(plainPassword), BCRYPT_COST) : null,
    kind: kind === KIND_STUDENT ? KIND_STUDENT : KIND_TEACHER,
    nickname: nickname || uname,
    status: 1,
    // null = 还没自己改过密码。入口校验按 pv=0 处理，与刚签发的 token 一致。
    pwdChangedAt: null,
    loginCount: 0,
    lastLoginAt: null,
    grade: null,
    classNo: null,
    seatNo: null,
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.USER, doc);
  return doc;
}

module.exports = {
  KIND_STUDENT,
  KIND_TEACHER,
  BCRYPT_COST,
  kindOf,
  isTeacher,
  bindAdminUser,
  bindByAdmin,
  createUserForAdmin,
  ensureTeacherProfile,
  findUserOfAdmin,
  passwordMatches,
};
