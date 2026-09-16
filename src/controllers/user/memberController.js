'use strict';

/**
 * 用户端 - 风采展示（公开）
 * GET /api/user/member/list   按职务分组返回 isShow=1 成员
 * GET /api/user/member/:id    详情（仅 isShow=1）
 */
const { Op } = require('sequelize');
const { Member } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

/**
 * 列表 + 按职务分组
 * Query: ?role=社长  可选，按职务筛选（精确匹配）
 * 返回:
 *   {
 *     groups: [
 *       { role: '社长', list: [...] },
 *       { role: '主播', list: [...] },
 *       ...
 *     ],
 *     total: 10,
 *     roles: ['社长', '主播', '编辑', '技术员']
 *   }
 */
exports.list = async (req, res, next) => {
  try {
    const where = { isShow: 1 };
    if (req.query.role) where.role = req.query.role;

    const rows = await Member.findAll({
      where,
      order: [['sort', 'DESC'], ['id', 'DESC']],
    });

    // 提取出现过的角色（去重，按出现顺序）
    const roleSet = [];
    rows.forEach((r) => { if (!roleSet.includes(r.role)) roleSet.push(r.role); });

    let groups;
    if (req.query.role) {
      groups = [{ role: req.query.role, list: rows }];
    } else {
      groups = roleSet.map((role) => ({
        role,
        list: rows.filter((r) => r.role === role),
      }));
    }

    return success(res, {
      groups,
      total: rows.length,
      roles: roleSet,
    });
  } catch (e) { return next(e); }
};

exports.detail = async (req, res, next) => {
  try {
    const m = await Member.findOne({
      where: { id: req.params.id, isShow: 1 },
    });
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在或已下架');
    return success(res, m);
  } catch (e) { return next(e); }
};
