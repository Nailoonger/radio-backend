'use strict';

/**
 * 用户端 - 风采展示（社干 + 部门人员）
 * GET /api/user/showcase
 *
 * 返回结构：
 * {
 *   cadre: [...],         // 社干列表（按 sort DESC, id ASC 排序）
 *   staff: {              // 部门人员按部门分组
 *     '播音部': [...],
 *     '主持部': [...],
 *     '编辑部': [...]
 *   },
 *   staffTotal: 10
 * }
 */
const { Cadre, Staff } = require('../../models');
const { success } = require('../../utils/response');

exports.showcase = async (req, res, next) => {
  try {
    // 社干（is_show=1，按 sort 倒序）
    const cadreList = await Cadre.findAll({
      where: { isShow: 1 },
      order: [['sort', 'DESC'], ['id', 'ASC']],
    });

    // 部门人员（is_show=1，按部门 + sort 倒序）
    const staffRows = await Staff.findAll({
      where: { isShow: 1 },
      order: [['department', 'ASC'], ['sort', 'DESC'], ['id', 'ASC']],
    });

    // 按部门分组
    const departmentMap = {};
    staffRows.forEach((m) => {
      const dept = m.department || '未分部门';
      if (!departmentMap[dept]) departmentMap[dept] = [];
      departmentMap[dept].push(m);
    });

    return success(res, {
      cadre: cadreList,
      staff: departmentMap,
      cadreTotal: cadreList.length,
      staffTotal: staffRows.length,
    });
  } catch (e) { return next(e); }
};