'use strict';

/**
 * 管理端 - 管理员账号管理（仅超级管理员）
 * GET    /api/admin/admin/list
 * POST   /api/admin/admin/create       新增管理员/社员
 * PUT    /api/admin/admin/:id          修改昵称/密码/状态
 * DELETE /api/admin/admin/:id          删除（不能删除自己）
 *
 * 注: 仅 super admin (role=0) 可访问，中间件 requireSuperAdmin
 */
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { Admin } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;
    const where = {};
    if (keyword) {
      where[Op.or] = [
        { username: { [Op.like]: `%${keyword}%` } },
        { nickname: { [Op.like]: `%${keyword}%` } },
      ];
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Admin.findAndCountAll({
      where,
      attributes: ['id', 'username', 'nickname', 'role', 'status', 'lastLoginAt', 'createTime'],
      order: [['id', 'ASC']],
      offset,
      limit: parseInt(pageSize, 10),
    });
    return success(res, {
      list: rows,
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
    });
  } catch (e) {
    return next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { username, password, nickname, role } = req.body || {};
    if (!username || !password) {
      throw new ApiError(Codes.PARAM_ERROR, '请输入用户名和密码');
    }
    if (password.length < 6) {
      throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
    }
    if (![0, 1].includes(role)) {
      throw new ApiError(Codes.PARAM_ERROR, '角色必须为0或1');
    }
    const exists = await Admin.findOne({ where: { username } });
    if (exists) throw new ApiError(Codes.CONFLICT, '用户名已存在');

    const hash = await bcrypt.hash(password, 10);
    const admin = await Admin.create({
      username,
      password: hash,
      nickname: nickname || username,
      role,
      status: 1,
    });
    return success(res, {
      id: admin.id,
      username: admin.username,
      nickname: admin.nickname,
      role: admin.role,
    }, '创建成功');
  } catch (e) {
    return next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const admin = await Admin.findByPk(req.params.id);
    if (!admin) throw new ApiError(Codes.NOT_FOUND, '账号不存在');
    if (req.body.nickname !== undefined) admin.nickname = req.body.nickname;
    if (req.body.status !== undefined) admin.status = req.body.status ? 1 : 0;
    if (req.body.role !== undefined && [0, 1].includes(req.body.role)) {
      admin.role = req.body.role;
    }
    if (req.body.password) {
      if (req.body.password.length < 6) {
        throw new ApiError(Codes.PARAM_ERROR, '密码长度不能少于6位');
      }
      admin.password = await bcrypt.hash(req.body.password, 10);
    }
    await admin.save();
    return success(res, {
      id: admin.id,
      username: admin.username,
      nickname: admin.nickname,
      role: admin.role,
      status: admin.status,
    }, '已更新');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    if (parseInt(req.params.id, 10) === req.admin.id) {
      throw new ApiError(Codes.FORBIDDEN, '不能删除自己');
    }
    const admin = await Admin.findByPk(req.params.id);
    if (!admin) throw new ApiError(Codes.NOT_FOUND, '账号不存在');
    if (admin.role === 0) {
      // 检查是否还有其它超级管理员
      const otherSuper = await Admin.count({ where: { role: 0, id: { [Op.ne]: admin.id } } });
      if (otherSuper === 0) {
        throw new ApiError(Codes.FORBIDDEN, '系统至少保留一个超级管理员');
      }
    }
    await admin.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};