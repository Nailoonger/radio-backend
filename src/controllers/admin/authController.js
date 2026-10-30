'use strict';

/**
 * 管理端 - 管理员登录
 * POST /api/admin/login
 * body: { username, password }
 */
const bcrypt = require('bcryptjs');
const { Admin } = require('../../models');
const { sign } = require('../../utils/jwt');
const { success, ApiError, Codes } = require('../../utils/response');
const logger = require('../../utils/logger');
const account = require('../../services/accountPasswordService');
const { pwdVersionOf } = require('../../services/studentAccountService');

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
    }

    const admin = await Admin.findOne({ where: { username: String(username).trim() } });
    if (!admin) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }
    if (admin.status !== 1) {
      throw new ApiError(Codes.FORBIDDEN, '账号已禁用');
    }

    /**
     * 密码唯一事实源 = user.password（2026-10-31 账号密码统一）。
     * 与云端 `/admin/login` 完全同一条口径：站员用学号、老师用工号，
     * 密码都落在 user 表，学生端改一次，伙伴端和后台立刻同密码。
     *
     * ⚠️ 先校验、后补建：存量老师还没有 user 记录，
     *    反过来做的话随便一个错密码都会往 user 表写数据。
     */
    let user = await account.findUserOfAdmin(admin);
    let ok = false;
    if (user) {
      ok = await account.passwordMatches(user, password);
      if (ok) await account.bindAdminUser(admin, user);
    } else {
      ok = Boolean(admin.password) && await bcrypt.compare(password, admin.password);
      if (ok) user = await account.ensureTeacherProfile(admin);
    }
    if (!ok || !user) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    // token 结构不变，只多带 pv（改密后旧 token 立刻作废）
    const token = sign({
      id: admin.id,
      username: admin.username,
      role: admin.role,
      pv: pwdVersionOf(user.pwdChangedAt),
    });

    return success(res, {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        nickname: admin.nickname,
        role: admin.role,
      },
    }, '登录成功');
  } catch (e) {
    return next(e);
  }
};

/**
 * 当前管理员信息
 */
exports.profile = async (req, res, next) => {
  try {
    const admin = await Admin.findByPk(req.admin.id, {
      attributes: ['id', 'username', 'nickname', 'role', 'lastLoginAt', 'createTime'],
    });
    if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号不存在');
    return success(res, admin);
  } catch (e) {
    return next(e);
  }
};

/**
 * 修改自己的密码
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入原密码和新密码');
    }
    if (newPassword.length < 6) {
      throw new ApiError(Codes.PARAM_ERROR, '新密码长度不能少于6位');
    }

    const admin = await Admin.findByPk(req.admin.id);
    if (!admin) throw new ApiError(Codes.UNAUTHORIZED, '账号不存在');

    /**
     * 改密写的是 **user.password**（密码唯一事实源），不是 admin.password。
     * admin.password 仍然跟着写（NOT NULL + 回滚用），但不再是事实源。
     * ⚠️ pwdChangedAt 一变，三端旧 token 下一次请求全部 40101 ——
     *    所以这里必须把新 token 一起吐回去，否则改密的人自己立刻掉线。
     */
    const user = await account.findUserOfAdmin(admin);
    if (!user) throw new ApiError(Codes.NOT_FOUND, '账号资料缺失，请联系超级管理员');

    const ok = await account.passwordMatches(user, oldPassword);
    if (!ok) throw new ApiError(Codes.PARAM_ERROR, '原密码错误');

    const hashed = await bcrypt.hash(newPassword, account.BCRYPT_COST);
    user.password = hashed;
    user.pwdChangedAt = new Date();
    await user.save();

    admin.password = hashed;
    await admin.save();

    return success(res, {
      token: sign({
        id: admin.id,
        username: admin.username,
        role: admin.role,
        pv: pwdVersionOf(user.pwdChangedAt),
      }),
    }, '密码修改成功');
  } catch (e) {
    return next(e);
  }
};

/**
 * 退出登录（前端清除token即可，这里可选做token黑名单）
 */
exports.logout = (req, res) => success(res, null, '已退出');