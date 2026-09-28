'use strict';

/**
 * 用户端 · 登录 / 改密 / 当前用户
 * 迁移自 src/controllers/user/authController.js
 *
 * 两条登录通道：
 *   POST /user/login/account    学生账号 + 密码（主通道）
 *   POST /user/login            微信 code2session（老通道，开关 account_login_required 打开时被拒）
 *
 * ⚠️ 账号体系复用 user 集合，JWT 的 openid 字段填「账号本身」，
 *    这样 submit / message / notice_ack 等按 openid 归属的存量逻辑一行都不用改。
 * ⚠️ JWT 额外带 uid / username / pv（密码版本）：pv 用于「改密或被重置后旧 token 立刻作废」。
 * ⚠️ requireUser 现在是异步的（含 assertTokenFresh 查库），必须 await。
 */

const bcrypt = require('bcryptjs');
const { C, findOne, insertOne, updateById, nextId, reserveUnique } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { sign, requireUser } = require('../../lib/auth');
const accountService = require('../../services/studentAccount');
const roster = require('../../services/roster');
const { code2Session } = require('../../services/wechat');

/** 学生账号的对外形状（**绝不包含 password**） */
function studentDto(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname || user.remark || '',
    name: user.remark || '',
    grade: user.grade,
    classNo: user.classNo,
    seatNo: user.seatNo,
    className: user.grade ? roster.gradeLabel(user.grade, user.classNo) : '',
    avatar: user.avatar || '',
    status: Number(user.status),
    isDefaultPwd: !user.pwdChangedAt,
    loginCount: Number(user.loginCount || 0),
    lastLoginAt: user.lastLoginAt,
  };
}

function studentToken(user) {
  return sign({
    openid: user.username, // ← 关键：兼容存量按 openid 归属的逻辑
    uid: user.id,
    username: user.username,
    pv: accountService.pwdVersionOf(user.pwdChangedAt),
  });
}

/** 密码强度：≥8 位且同时含字母和数字 */
function assertPasswordStrength(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) {
    throw new ApiError(Codes.PARAM_ERROR, '新密码长度不能少于 8 位');
  }
  if (pwd.length > 64) {
    throw new ApiError(Codes.PARAM_ERROR, '新密码最长 64 位');
  }
  if (!/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) {
    throw new ApiError(Codes.PARAM_ERROR, '新密码必须同时包含字母和数字');
  }
}

/* ══════════════════ 账号密码登录 ══════════════════ */

/** POST /user/login/account   body: { username, password } */
async function loginByAccount(ctx) {
  const { username, password } = ctx.body || {};
  if (!username || !password) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入账号和密码');
  }

  const uname = roster.clean(username);
  const user = await findOne(C.USER, { username: uname });

  // 账号不存在 / 没设过密码 / 密码不对 —— 一律同一句文案，避免被拿来探测有效学号
  if (!user || !user.password) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
  }
  const okPwd = await bcrypt.compare(String(password), user.password);
  if (!okPwd) {
    throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
  }
  if (Number(user.status) !== 1) {
    throw new ApiError(Codes.FORBIDDEN, '账号已停用，请联系广播站');
  }

  const now = new Date();
  const loginCount = Number(user.loginCount || 0) + 1;
  await updateById(C.USER, user._id, { lastLoginAt: now, loginCount, updateTime: now });

  // 登录成功顺手刷新状态缓存（此时状态一定是新的）
  await accountService.invalidate(user.username);

  // 原实现里 Sequelize 的 update() 会就地改实例，故返回的 dto 是「更新后」的值 —— 这里对齐
  const fresh = { ...user, lastLoginAt: now, loginCount };
  return { token: studentToken(fresh), user: studentDto(fresh) };
}

/**
 * PUT /user/change-password   body: { oldPassword, newPassword }
 * 成功后返回新 token（旧 token 因 pv 不匹配作废）
 */
async function changePassword(ctx) {
  const { oldPassword, newPassword } = ctx.body || {};
  const me = await requireUser(ctx);
  const username = me.username;

  if (!username) {
    throw new ApiError(Codes.UNAUTHORIZED, '仅学生账号支持修改密码，请重新登录');
  }
  if (!oldPassword || !newPassword) {
    throw new ApiError(Codes.PARAM_ERROR, '请输入原密码和新密码');
  }
  assertPasswordStrength(newPassword);
  if (String(oldPassword) === String(newPassword)) {
    throw new ApiError(Codes.PARAM_ERROR, '新密码不能与原密码相同');
  }

  const user = await findOne(C.USER, { username });
  if (!user || !user.password) {
    throw new ApiError(Codes.NOT_FOUND, '账号不存在');
  }
  const okPwd = await bcrypt.compare(String(oldPassword), user.password);
  if (!okPwd) {
    throw new ApiError(Codes.PARAM_ERROR, '原密码不正确');
  }

  const now = new Date();
  const password = await bcrypt.hash(String(newPassword), 10);
  await updateById(C.USER, user._id, { password, pwdChangedAt: now, updateTime: now });
  await accountService.invalidate(username);

  const fresh = { ...user, password, pwdChangedAt: now };
  return { token: studentToken(fresh), user: studentDto(fresh) };
}

/* ══════════════════ 微信登录（老通道，受开关控制） ══════════════════ */

/**
 * POST /user/login   body: { code, nickname? }
 *
 * 开关 account_login_required 打开时（默认 on）直接拒绝 —— 这是「必须账号密码登录」的
 * 真正强制点：光改小程序页面没用，旧版小程序 / 直接调接口都得在这里被拦住。
 *
 * ⚠️ 头像机制（2026-09-18 定死）：全站头像一律「姓名首字圆形」，用户不允许更换 ——
 *    客户端就算传 avatar 也直接丢弃、不落库（老版本小程序带着它来也不会报错）。
 */
async function login(ctx) {
  if (await accountService.isWechatLoginBlocked()) {
    throw new ApiError(Codes.MODULE_DISABLED, '请使用学校分发的学号账号登录（如 20240101）');
  }

  const { code, nickname } = ctx.body || {};
  if (!code) {
    throw new ApiError(Codes.PARAM_ERROR, 'code不能为空');
  }

  let openid;
  try {
    const session = await code2Session(code);
    openid = session.openid;
  } catch (e) {
    console.error('[auth] code2Session 失败:', e && e.message);
    // 开发/测试环境下允许 mock openid，方便无 appid 时联调
    if (process.env.MOCK_WECHAT === '1' && process.env.NODE_ENV !== 'production') {
      openid = `mock_${code}`;
      console.warn(`[auth][dev] 使用 mock openid: ${openid}`);
    } else {
      throw new ApiError(Codes.WECHAT_API_ERROR, '微信登录失败');
    }
  }

  // upsert 用户（隐私最小化；avatar 恒为空串，见上方头像机制说明）
  let user = await findOne(C.USER, { openid });
  if (!user) {
    const id = await nextId(C.USER);
    const got = await reserveUnique('user_openid', openid, id);
    if (got) {
      const now = new Date();
      await insertOne(C.USER, {
        id,
        openid,
        username: null,
        password: null,
        nickname: nickname || '同学',
        avatar: '',
        status: 1,
        loginCount: 0,
        createTime: now,
        updateTime: now,
      });
    }
    // 并发下另一个实例可能刚建好，统一重查一次拿权威文档
    user = await findOne(C.USER, { openid });
  } else if (nickname && !user.username) {
    // 已存在则同步昵称。账号用户（学号导入的）昵称 = 名册姓名，是权威数据，不允许被客户端改写。
    const now = new Date();
    await updateById(C.USER, user._id, { nickname, updateTime: now });
    user = { ...user, nickname };
  }

  if (!user) throw new ApiError(Codes.SERVER_ERROR, '登录失败，请重试');

  const token = sign({ openid });
  return {
    token,
    user: { openid: user.openid, nickname: user.nickname, avatar: user.avatar },
  };
}

/* ══════════════════ 当前用户 ══════════════════ */

/**
 * GET /user/me
 * 老字段（openid / nickname / avatar）保持不变，账号用户额外多返回年级班级等
 */
async function me(ctx) {
  const me0 = await requireUser(ctx);
  const where = me0.username ? { username: me0.username } : { openid: me0.openid };
  const user = await findOne(C.USER, where);
  if (!user) {
    throw new ApiError(Codes.NOT_FOUND, '用户不存在');
  }

  const base = {
    openid: user.openid,
    nickname: user.nickname,
    avatar: user.avatar,
  };
  if (!user.username) return base;

  return { ...base, ...studentDto(user) };
}

module.exports = { login, loginByAccount, changePassword, me };
