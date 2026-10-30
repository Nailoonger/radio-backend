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
const { Admin, User } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');
const account = require('../../services/accountPasswordService');

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

    /**
     * 账号密码统一（2026-10-31）：密码唯一事实源是 user.password，
     * 所以建后台账号必须先建一条 user 行（kind=teacher，工号当 username）。
     * 不建的话这个人建出来就登不进去 —— 登录会去找 user 记录。
     */
    const user = await account.createUserForAdmin({
      username,
      plainPassword: password,
      nickname,
      kind: account.KIND_TEACHER,
    });

    // admin.password 仍然写（NOT NULL + 回滚用），但登录不再读它
    const hash = await bcrypt.hash(password, 10);
    const admin = await Admin.create({
      username,
      password: hash,
      nickname: nickname || username,
      role,
      status: 1,
      userId: user.id,
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
      const hash = await bcrypt.hash(req.body.password, 10);
      admin.password = hash;

      /**
       * 真正生效的是 user.password（2026-10-31 账号密码统一）。
       * ⚠️ 升 pwdChangedAt 会让他三端的旧 token 下一次请求全部 40101 ——
       *    「管理员重置密码 = 把人踢下线」是刻意的。
       */
      const target = await account.findUserOfAdmin(admin);
      if (target) {
        target.password = hash;
        target.pwdChangedAt = new Date();
        await target.save();
      }
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

    /**
     * 老师的 user 记录跟着删（2026-10-31）。
     * admin 行删了但 user 行留着，那个工号就被永久占住 —— 再建同名会撞「已被占用」，
     * 而且没有任何界面能清掉它。
     * ⚠️ 站员（role=2）绝不能删 user 行：他首先是学生，还要用同一学号登学生端。
     */
    if (admin.role !== 2 && admin.userId) {
      try {
        const u = await User.findByPk(admin.userId);
        if (u && account.kindOf(u) === account.KIND_TEACHER) {
          const others = await Admin.count({ where: { userId: admin.userId } });
          if (others === 0) await u.destroy();
        }
      } catch (e) {
        console.warn('[admin] 删除账号后清理 user 记录失败', admin.id, admin.userId, e && e.message);
      }
    }

    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};