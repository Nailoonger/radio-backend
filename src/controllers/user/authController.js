'use strict';

/**
 * 用户端 · 登录 / 改密 / 当前用户
 *
 * 两条登录通道：
 *   POST /api/user/login/account  学生账号 + 密码（2026-09 起的主通道）
 *   POST /api/user/login          微信 code2session（老通道，开关 account_login_required 打开时会被拒）
 *
 * ⚠️ 账号体系复用 user 表，JWT 的 openid 字段填「账号本身」，
 *    这样 submit / message / notice_ack 等按 req.user.openid 归属的存量逻辑一行都不用改。
 * ⚠️ JWT 额外带 uid / username / pv（密码版本）：
 *    pv 用于「改密或被管理员重置后，旧 token 立刻作废」（最多迟 30 秒，见 studentAccountService）。
 */
const bcrypt = require('bcryptjs');
const { User } = require('../../models');
const { code2Session } = require('../../services/wechatService');
const accountService = require('../../services/studentAccountService');
const roster = require('../../services/studentRosterService');
const { sign } = require('../../utils/jwt');
const { success, Codes, ApiError } = require('../../utils/response');
const logger = require('../../utils/logger');

/** 学生账号的对外形状（绝不包含 password） */
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

/**
 * POST /api/user/login/account
 * body: { username, password }
 */
exports.loginByAccount = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入账号和密码');
    }

    const uname = roster.clean(username);
    const user = await User.scope('withPassword').findOne({ where: { username: uname } });

    // 账号不存在 / 没设过密码 / 密码不对 —— 一律同一句文案，避免被拿来探测有效学号
    if (!user || !user.password) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }
    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }
    if (Number(user.status) !== 1) {
      throw new ApiError(Codes.FORBIDDEN, '账号已停用，请联系广播站');
    }

    await user.update({
      lastLoginAt: new Date(),
      loginCount: Number(user.loginCount || 0) + 1,
    });
    // 登录成功顺手刷新状态缓存（此时状态一定是新的）
    await accountService.invalidate(user.username);

    return success(res, { token: studentToken(user), user: studentDto(user) }, '登录成功');
  } catch (e) {
    return next(e);
  }
};

/**
 * PUT /api/user/change-password
 * body: { oldPassword, newPassword }
 * 成功后返回新 token（旧 token 因 pv 不匹配作废）
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    const username = req.user && req.user.username;
    if (!username) {
      throw new ApiError(Codes.UNAUTHORIZED, '仅学生账号支持修改密码，请重新登录', 401);
    }
    if (!oldPassword || !newPassword) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入原密码和新密码');
    }
    assertPasswordStrength(newPassword);
    if (String(oldPassword) === String(newPassword)) {
      throw new ApiError(Codes.PARAM_ERROR, '新密码不能与原密码相同');
    }

    const user = await User.scope('withPassword').findOne({ where: { username } });
    if (!user || !user.password) {
      throw new ApiError(Codes.NOT_FOUND, '账号不存在');
    }
    const ok = await bcrypt.compare(String(oldPassword), user.password);
    if (!ok) {
      throw new ApiError(Codes.PARAM_ERROR, '原密码不正确');
    }

    await user.update({
      password: await bcrypt.hash(String(newPassword), 10),
      pwdChangedAt: new Date(),
    });
    await accountService.invalidate(username);

    const fresh = await User.findOne({ where: { username } });
    return success(res, { token: studentToken(fresh), user: studentDto(fresh) }, '密码修改成功');
  } catch (e) {
    return next(e);
  }
};

/* ══════════════════ 微信登录（老通道，受开关控制） ══════════════════ */

/**
 * POST /api/user/login
 * body: { code, nickname?, avatar? }
 *
 * 开关 account_login_required 打开时（默认 on）直接拒绝 —— 这是「必须账号密码登录」的
 * 真正强制点：光改小程序页面没用，旧版小程序 / 直接调接口都得在这里被拦住。
 *
 * ⚠️ 头像机制（2026-09-18 定死）：全站头像一律「姓名首字圆形」（姓作图），
 *    用户不允许更换头像 —— 客户端就算传 avatar 也直接丢弃，不落库。
 *    老版本小程序带着这个字段来调用也不会报错，只是不生效。
 */
exports.login = async (req, res, next) => {
  try {
    if (accountService.isWechatLoginBlocked()) {
      throw new ApiError(
        Codes.MODULE_DISABLED,
        '请使用学校分发的学号账号登录（如 20240101）'
      );
    }

    const { code, nickname } = req.body || {};
    if (!code) {
      throw new ApiError(Codes.PARAM_ERROR, 'code不能为空');
    }

    let openid;
    try {
      const session = await code2Session(code);
      openid = session.openid;
    } catch (e) {
      logger.error('code2Session 失败:', e.message);
      // 开发/测试环境下允许 mock openid，方便无 appid 时联调
      if (process.env.MOCK_WECHAT === '1' && process.env.NODE_ENV !== 'production') {
        openid = `mock_${code}`;
        logger.warn(`[dev] 使用 mock openid: ${openid}`);
      } else {
        throw new ApiError(Codes.WECHAT_API_ERROR, '微信登录失败');
      }
    }

    // upsert 用户（隐私最小化；avatar 恒为空串，见上方头像机制说明）
    const [user] = await User.unscoped().findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickname: nickname || '同学',
        avatar: '',
      },
    });

    // 已存在则同步昵称（用户可能修改了微信昵称）。
    // 账号用户（学号导入的）昵称 = 名册姓名，是权威数据，不允许被客户端改写。
    if (nickname && !user.username) {
      await user.update({ nickname });
    }

    const token = sign({ openid });

    return success(res, {
      token,
      user: {
        openid: user.openid,
        nickname: user.nickname,
        avatar: user.avatar,
      },
    });
  } catch (e) {
    return next(e);
  }
};

/* ══════════════════ 当前用户 ══════════════════ */

/**
 * GET /api/user/me
 * 老字段（openid / nickname / avatar）保持不变，账号用户额外多返回年级班级等
 */
exports.me = async (req, res, next) => {
  try {
    const where = req.user.username ? { username: req.user.username } : { openid: req.user.openid };
    const user = await User.findOne({ where });
    if (!user) {
      throw new ApiError(Codes.NOT_FOUND, '用户不存在');
    }

    const base = {
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
    };
    if (!user.username) return success(res, base);

    return success(res, { ...base, ...studentDto(user) });
  } catch (e) {
    return next(e);
  }
};
