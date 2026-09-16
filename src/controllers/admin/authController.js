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

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
    }

    const admin = await Admin.findOne({ where: { username } });
    if (!admin) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }
    if (admin.status !== 1) {
      throw new ApiError(Codes.FORBIDDEN, '账号已禁用');
    }

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) {
      throw new ApiError(Codes.UNAUTHORIZED, '账号或密码错误');
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    const token = sign({
      id: admin.id,
      username: admin.username,
      role: admin.role,
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
    const ok = await bcrypt.compare(oldPassword, admin.password);
    if (!ok) throw new ApiError(Codes.PARAM_ERROR, '原密码错误');

    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();

    return success(res, null, '密码修改成功');
  } catch (e) {
    return next(e);
  }
};

/**
 * 退出登录（前端清除token即可，这里可选做token黑名单）
 */
exports.logout = (req, res) => success(res, null, '已退出');