'use strict';

/**
 * 账号密码统一 · 直连模式（2026-10-31）
 *
 * 对应云端 `cloud/cloudfunctions/api/services/accountPassword.js`，逐函数对齐。
 *
 * ═══════════ 改了什么 ═══════════
 * 改造前：学生在 user 表一份密码，老师在 admin 表另一份。
 * 改造后：**密码唯一事实源 = user.password**，admin 表只留身份（role / id）。
 * 老师没有学号，但有工号：工号当 `user.username`，`user.kind = 'teacher'`。
 *
 * ═══════════ 为什么保留 admin.password ═══════════
 * MySQL 的 `admin.password` 是 NOT NULL，写 null 直接报错；而且万一要回滚登录逻辑，
 * 旧密码还在，不用让所有人重设。所以它继续被写入，但**不再被读取**。
 *
 * ⚠️ `User` 模型有 defaultScope 排除 password —— 任何要比对密码的查询都必须
 *    显式 `.scope('withPassword')`，否则拿到的是 undefined，比对必然失败。
 */

const bcrypt = require('bcryptjs');
const { User, Admin } = require('../models');
const { ApiError, Codes } = require('../utils/response');

const KIND_STUDENT = 'student';
const KIND_TEACHER = 'teacher';
const BCRYPT_COST = 10;

function kindOf(user) {
  // MySQL 有 DEFAULT 'student'，但老数据可能被写成 null，统一兜底
  return String((user && user.kind) || KIND_STUDENT);
}

function isTeacher(user) {
  return kindOf(user) === KIND_TEACHER;
}

/** admin.userId 回填（幂等） */
async function bindAdminUser(admin, user) {
  if (!admin || !user) return;
  if (Number(admin.userId) === Number(user.id)) return;
  admin.userId = Number(user.id);
  await admin.save();
}

/**
 * 找到 admin 对应的 user 行。**只读**，不写库 —— 补建必须发生在密码校验通过之后。
 */
async function findUserOfAdmin(admin) {
  if (!admin) return null;

  if (admin.userId) {
    const byId = await User.scope('withPassword').findByPk(Number(admin.userId));
    if (byId) return byId;
  }
  if (!admin.username) return null;
  return User.scope('withPassword').findOne({ where: { username: admin.username } });
}

/**
 * 给存量 admin（老师 / 社干）补一条 user 记录。
 *
 * ⚠️ `pwdChangedAt` 刻意留 null：pv = 0，与改造前签发的 token（无 pv）算出来一致，
 *    老师不会被踢下线。
 */
async function ensureTeacherProfile(admin) {
  const username = String((admin && admin.username) || '').trim();
  if (!username) return null;

  const exist = await User.scope('withPassword').findOne({ where: { username } });
  if (exist) {
    await bindAdminUser(admin, exist);
    return exist;
  }

  const created = await User.create({
    username,
    password: (admin && admin.password) || null,   // bcrypt 哈希原样搬，不知道明文也能迁
    kind: KIND_TEACHER,
    nickname: (admin && admin.nickname) || username,
    status: Number(admin && admin.status) === 0 ? 0 : 1,
    pwdChangedAt: null,
    loginCount: 0,
    // 老师的年级/班级/座位一律留空 —— 学生端按这些字段算班级，不能给假值
    grade: null,
    classNo: null,
    seatNo: null,
  });
  await bindAdminUser(admin, created);
  return created;
}

/**
 * 新建后台账号时先建对应的 user 行（密码的唯一事实源）。
 * 用户名冲突直接报错，不静默复用 —— 老师工号撞学生学号时，那是两个不同的人。
 */
async function createUserForAdmin({ username, plainPassword, nickname, kind }) {
  const uname = String(username || '').trim();
  if (!uname) throw new ApiError(Codes.PARAM_ERROR, '账号不能为空');

  const exist = await User.scope('withPassword').findOne({ where: { username: uname } });
  if (exist) {
    throw new ApiError(Codes.CONFLICT,
      `账号 ${uname} 已被一个${isTeacher(exist) ? '老师' : '学生'}占用，换一个用户名`);
  }

  return User.create({
    username: uname,
    password: plainPassword ? await bcrypt.hash(String(plainPassword), BCRYPT_COST) : null,
    kind: kind === KIND_STUDENT ? KIND_STUDENT : KIND_TEACHER,
    nickname: nickname || uname,
    status: 1,
    pwdChangedAt: null,
    loginCount: 0,
    grade: null,
    classNo: null,
    seatNo: null,
  });
}

/** 密码校验：只看 user.password。空密码一律判失败，不能因为为空就放行。 */
async function passwordMatches(user, plain) {
  if (!user || !user.password) return false;
  return bcrypt.compare(String(plain == null ? '' : plain), user.password);
}

/**
 * 从学生档案建一条后台账号 —— 直连侧实现，对应云端
 * `cloud/cloudfunctions/api/services/adminAccount.createFromStudent()`。
 *
 * ═══════════ 2026-10-31 第二版口径（陛下定）═══════════
 *   超管(0) / 社干(1) / 站员(2) **三档一律从学生名册选人**，不再支持手打账号密码。
 *   账号 = 学号、密码 = 学生自己那份 ⇒「一个账号登录两端」成立。
 *   手打工号那条线已经撇下，别再往回加（`createUserForAdmin` 只剩存量迁移在用）。
 *
 * ⚠️ 学生档案还没有密码时落初始密码 `user + 学号`，`pwdChangedAt` 保持 null
 *    （pv = 0，与学生端现有 token 对得上，不会平白踢人）。
 */
async function createAdminFromStudent({ userId, role, nickname }) {
  const uid = Number(userId) || 0;
  const roleNum = Number(role);
  if (!uid) {
    throw new ApiError(Codes.PARAM_ERROR, '请从学生名册选人（超管 / 社干 / 站员都要挂学生档案）');
  }
  if (![0, 1, 2].includes(roleNum)) {
    throw new ApiError(Codes.PARAM_ERROR, '角色必须为 0(超管) / 1(社干) / 2(站员)');
  }

  const user = await User.scope('withPassword').findByPk(uid);
  if (!user || !user.username) throw new ApiError(Codes.NOT_FOUND, '关联的学生档案不存在');

  const username = String(user.username);
  const dup = await Admin.findOne({ where: { username } });
  if (dup) {
    throw new ApiError(Codes.CONFLICT, `${username} 已经是后台账号，要改角色请直接编辑`);
  }

  let initPlain = null;
  if (!user.password) {
    initPlain = `user${username.trim()}`;
    user.password = await bcrypt.hash(initPlain, BCRYPT_COST);
    user.pwdChangedAt = null;
    await user.save();
  }

  const admin = await Admin.create({
    username,
    // 只是镜像：MySQL 是 NOT NULL，且回滚登录逻辑时用得上；登录不读它
    password: user.password,
    nickname: String(nickname || user.nickname || user.remark || username),
    role: roleNum,
    userId: Number(user.id),
    status: 1,
  });

  return { admin, user, initPlain };
}

module.exports = {
  KIND_STUDENT,
  KIND_TEACHER,
  BCRYPT_COST,
  kindOf,
  isTeacher,
  bindAdminUser,
  findUserOfAdmin,
  ensureTeacherProfile,
  createUserForAdmin,
  createAdminFromStudent,
  passwordMatches,
};
