'use strict';

/**
 * 管理端 - 部门人员 CRUD
 * GET    /api/admin/staff/list
 * GET    /api/admin/staff/:id
 * POST   /api/admin/staff/create
 * PUT    /api/admin/staff/:id
 * DELETE /api/admin/staff/:id
 * PUT    /api/admin/staff/:id/toggle
 *
 * 注: 仅 super admin (role=0) 可访问，中间件 requireSuperAdmin
 */
const { Op } = require('sequelize');
const { Staff } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, keyword, department } = req.query;
    const where = {};
    if (department) where.department = department;
    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { role: { [Op.like]: `%${keyword}%` } },
        { department: { [Op.like]: `%${keyword}%` } },
        { grade: { [Op.like]: `%${keyword}%` } },
      ];
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Staff.findAndCountAll({
      where,
      order: [['department', 'ASC'], ['sort', 'DESC'], ['id', 'DESC']],
      offset,
      limit: parseInt(pageSize, 10),
    });
    return success(res, {
      list: rows,
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
    });
  } catch (e) { return next(e); }
};

exports.detail = async (req, res, next) => {
  try {
    const m = await Staff.findByPk(req.params.id);
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');
    return success(res, m);
  } catch (e) { return next(e); }
};

exports.create = async (req, res, next) => {
  try {
    const { name, role, department, grade, programs, avatar, motto, sort, isShow } = req.body || {};
    if (!name) throw new ApiError(Codes.PARAM_ERROR, '请填写姓名');
    if (!role) throw new ApiError(Codes.PARAM_ERROR, '请填写职务');
    if (!department) throw new ApiError(Codes.PARAM_ERROR, '请填写部门');
    // 照片改为可选（2026-09-19）：不传就用「姓名首字」头像兜底，各端已支持
    if (String(name).length > 32) throw new ApiError(Codes.PARAM_ERROR, '姓名过长');
    if (String(role).length > 32) throw new ApiError(Codes.PARAM_ERROR, '职务过长');
    if (department && String(department).length > 32) throw new ApiError(Codes.PARAM_ERROR, '部门过长');
    if (grade && String(grade).length > 32) throw new ApiError(Codes.PARAM_ERROR, '年级班级过长');
    if (programs && String(programs).length > 200) throw new ApiError(Codes.PARAM_ERROR, '栏目过长');
    if (motto && String(motto).length > 200) throw new ApiError(Codes.PARAM_ERROR, '座右铭过长');

    const m = await Staff.create({
      name, role, department,
      grade: grade || '',
      programs: programs || '',
      avatar: avatar || '',
      motto: motto || null,
      sort: sort || 0,
      isShow: isShow === undefined ? 1 : isShow,
    });
    return success(res, m, '创建成功');
  } catch (e) { return next(e); }
};

exports.update = async (req, res, next) => {
  try {
    const m = await Staff.findByPk(req.params.id);
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');

    const fields = ['name', 'role', 'department', 'grade', 'programs', 'avatar', 'motto', 'sort', 'isShow'];
    for (const f of fields) {
      if (req.body[f] !== undefined) m[f] = req.body[f];
    }
    if (m.name && m.name.length > 32) throw new ApiError(Codes.PARAM_ERROR, '姓名过长');
    if (m.role && m.role.length > 32) throw new ApiError(Codes.PARAM_ERROR, '职务过长');
    if (m.department && m.department.length > 32) throw new ApiError(Codes.PARAM_ERROR, '部门过长');
    if (m.grade && m.grade.length > 32) throw new ApiError(Codes.PARAM_ERROR, '年级班级过长');
    if (m.programs && m.programs.length > 200) throw new ApiError(Codes.PARAM_ERROR, '栏目过长');
    if (m.motto && m.motto.length > 200) throw new ApiError(Codes.PARAM_ERROR, '座右铭过长');

    await m.save();
    return success(res, m, '已更新');
  } catch (e) { return next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    const m = await Staff.findByPk(req.params.id);
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');
    await m.destroy();
    return success(res, null, '已删除');
  } catch (e) { return next(e); }
};

exports.toggle = async (req, res, next) => {
  try {
    const m = await Staff.findByPk(req.params.id);
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');
    m.isShow = m.isShow === 1 ? 0 : 1;
    await m.save();
    return success(res, m, '已切换');
  } catch (e) { return next(e); }
};