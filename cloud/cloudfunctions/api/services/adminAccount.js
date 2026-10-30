'use strict';

/**
 * 后台账号 ← 学生档案（2026-10-31 第二版口径，陛下定）
 *
 * ═══════════ 一句话 ═══════════
 *   **超管 / 社干 / 站员 三档，一律从学生名册选人建号**，跟站员同一套逻辑。
 *   不再有「手打工号 + 顺手建一条老师档案」那条线 —— 老师也必须是名册里的人。
 *
 * ═══════════ 为什么这么定 ═══════════
 *   陛下原话：「新增超管或者社干时必须从学生账号里面选择和站员一样的逻辑，
 *   这样方便一些，也可以保证一个账号登录两端，先不做老师的工号，这一部分可以撇下。」
 *
 *   ⇒ 「一个账号登录两端」是目标，不是副作用：
 *     账号就是学号，密码就是学生自己那份，于是学生端和伙伴端天然同一套凭据。
 *
 * ═══════════ 字段口径 ═══════════
 *   admin.username  ← user.username（学号，不接受手打，杜绝打错/建重）
 *   admin.password  ← user.password 的**镜像**（MySQL 侧 NOT NULL，且回滚登录逻辑时用得上）
 *                     登录**不读它**，读 user.password
 *   admin.userId    ← user.id（身份的唯一定义在这儿，admin 只是它的第二角色）
 *   admin.role      ← 0 超管 / 1 社干 / 2 站员（只决定「能做什么」，不决定「是谁」）
 *
 * ⚠️ 学生档案还没有密码时（建号后从没登录过 / 老微信用户）：
 *    必须先落初始密码 `user + 学号`，否则这个号建出来永远登不进去。
 *    这是 `studentAccountService.initPasswordFor()` 的同一口径，别在这里改规则。
 *
 * ⚠️ 为什么不再建 kind=teacher 的 user 行：
 *    那条线是「老师没有学号」时代的补丁。现在三档都从名册来，学生档案本来就在，
 *    再造一条 teacher 行 = 一个人两条档案，登录时到底认哪条会变成运气问题。
 *    存量老师（`ensureTeacherProfile` 惰性补建）**保留** —— 那是为了让已经存在的
 *    超管账号还能登进来，跟"新建"是两回事，别一起删。
 */

const bcrypt = require('bcryptjs');
const { C, findOne, insertOne, updateById, nextId, reserveUnique } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');

/** 初始密码的 bcrypt 成本（与 partner/accounts.import、adminMgr 同口径） */
const BCRYPT_COST = 8;

/** 三档角色，只决定权限，不决定身份 */
const ROLES = [0, 1, 2];

/** 初始密码 = user + 学号（唯一口径，别在这里改规则） */
function initPasswordFor(username) {
  return `user${String(username || '').trim()}`;
}

function roleOf(v, fallback) {
  const n = Number(v);
  return ROLES.includes(n) ? n : fallback;
}

/**
 * 从学生档案建一条后台账号。
 *
 * @param {Object} opt
 * @param {number} opt.userId   学生档案 id（必填）
 * @param {number} opt.role     0 超管 / 1 社干 / 2 站员
 * @param {string} [opt.nickname] 不传就取学生姓名
 * @returns {Promise<{id,userId,username,name,role,initPlain:string|null}>}
 *          `initPlain` 非空 = 这个号刚被落了初始密码，界面要把它告诉操作者
 * @throws {ApiError} 档案不存在 40401 / 这个学号已经是后台账号 40901
 */
async function createFromStudent(opt) {
  const userId = Number(opt && opt.userId) || 0;
  const role = roleOf(opt && opt.role, 2);
  if (!userId) {
    throw new ApiError(Codes.PARAM_ERROR, '请从学生名册选人（超管 / 社干 / 站员都要挂学生档案）');
  }

  const user = await findOne(C.USER, { id: userId });
  if (!user || !user.username) {
    throw new ApiError(Codes.NOT_FOUND, '关联的学生档案不存在');
  }
  const username = String(user.username);

  // 一个学号只能有一个后台身份：已经建过就直说，不静默改角色
  //（改角色请走「编辑」，那里有自保护与至少留一位超管的检查）
  const dup = await findOne(C.ADMIN, { username });
  if (dup) {
    throw new ApiError(Codes.CONFLICT, `${username} 已经是后台账号（${
      Number(dup.role) === 0 ? '超管' : Number(dup.role) === 1 ? '社干' : '站员'
    }），要改角色请直接编辑`);
  }

  const now = new Date();
  const id = await nextId(C.ADMIN);
  // 并发兜底：findOne 可能双双落空，占位键才是真闸
  const got = await reserveUnique('admin', username, id);
  if (!got) throw new ApiError(Codes.CONFLICT, '这个学号已经是后台账号（并发）');

  /**
   * 密码：直接镜像学生的。学生还没有密码就先给他落初始密码。
   * ⚠️ 落初始密码时 `pwdChangedAt` 保持 null ——
   *    这样 pv = 0，与学生端现有 token 对得上，不会把人平白踢下线。
   */
  let pwdHash = user.password || null;
  let initPlain = null;
  if (!pwdHash) {
    initPlain = initPasswordFor(username);
    pwdHash = await bcrypt.hash(initPlain, BCRYPT_COST);
    await updateById(C.USER, user._id, {
      password: pwdHash,
      pwdChangedAt: null,
      updateTime: now,
    });
  }

  await insertOne(C.ADMIN, {
    id,
    username,
    password: pwdHash,
    nickname: String((opt && opt.nickname) || user.name || user.nickname || username),
    role,
    userId: Number(user.id),
    department: '',
    dutyRoles: [],
    status: 1,
    lastLoginAt: null,
    // 标记初始密码，登录页据此引导改密
    initPwd: true,
    createTime: now,
    updateTime: now,
  });

  return {
    id,
    userId: Number(user.id),
    username,
    name: user.name || user.nickname || username,
    role,
    initPlain,
  };
}

module.exports = {
  ROLES,
  BCRYPT_COST,
  initPasswordFor,
  roleOf,
  createFromStudent,
};
