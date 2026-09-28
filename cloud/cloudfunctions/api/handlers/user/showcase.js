'use strict';

/**
 * 用户端 · 风采展示（社干 + 部门人员）
 * 迁移自 src/controllers/user/showcaseController.js
 *
 * 返回结构（与原实现逐字段一致）：
 *   { cadre: [...], staff: { '播音部': [...], ... }, cadreTotal, staffTotal }
 *
 * ⚠️ 云数据库单次查询上限 100 条（云函数端），这里对两个列表都加了 limit: 100。
 *    社干/部员是**展示类**数据，量级远小于 100；若将来真的超了，需要改成聚合或游标翻页。
 */

const { C, findMany } = require('../../lib/db');

/**
 * GET /user/showcase
 *
 * 排序与原实现逐字段对齐（`sort DESC, id ASC` / `department ASC, sort DESC, id ASC`）。
 * ⚠️ tie-breaker 用**数字 `id`**，不是 `_id` —— 见 lib/db.js 的 parseId 注释。
 */
async function showcase() {
  const [cadreList, staffRows] = await Promise.all([
    findMany(C.CADRE, { isShow: 1 }, { orderBy: [['sort', 'desc'], ['id', 'asc']], limit: 100 }),
    findMany(
      C.STAFF,
      { isShow: 1 },
      { orderBy: [['department', 'asc'], ['sort', 'desc'], ['id', 'asc']], limit: 100 }
    ),
  ]);

  // 按部门分组（保持原实现的 "未分部门" 兜底文案）
  const departmentMap = {};
  staffRows.forEach((m) => {
    const dept = m.department || '未分部门';
    if (!departmentMap[dept]) departmentMap[dept] = [];
    departmentMap[dept].push(m);
  });

  return {
    cadre: cadreList,
    staff: departmentMap,
    cadreTotal: cadreList.length,
    staffTotal: staffRows.length,
  };
}

module.exports = { showcase };
