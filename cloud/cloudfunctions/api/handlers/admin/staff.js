'use strict';

/**
 * 管理端 · 部门人员 CRUD（仅超管）
 * 迁移自 src/controllers/admin/staffController.js
 *
 * 通用实现见 `_people.js`。与 cadre 的差异：
 *   · 多一个必填 `department`，多一个字段 `programs`（负责栏目）
 *   · 搜索字段多 `department` / `programs`
 *   · 排序：**department ASC, sort DESC, id DESC**（注意最后是 DESC，与 cadre 的 id ASC 不同）
 *   · 列表支持 `?department=` 精确过滤
 *   · 长度：department≤32 / programs≤200
 */

const { C } = require('../../lib/db');
const { asSuper } = require('./_kit');
const { makeCrud } = require('./_people');

const FIELDS = ['id', 'name', 'role', 'department', 'grade', 'programs', 'avatar', 'motto', 'sort', 'isShow', 'createTime', 'updateTime'];

module.exports = makeCrud({
  coll: C.STAFF,
  guard: asSuper,          // 原路由挂 requireSuperAdmin
  label: '成员',
  fields: FIELDS,
  searchFields: ['name', 'role', 'department', 'grade', 'programs'],
  listFilter: (where, q) => {
    if (q.department) where.department = q.department;
  },
  orderBy: [['department', 'asc'], ['sort', 'desc'], ['id', 'desc']],
  writable: ['name', 'role', 'department', 'grade', 'programs', 'avatar', 'motto', 'sort', 'isShow'],
  createRequired: [['name', '请填写姓名'], ['role', '请填写职务'], ['department', '请填写部门']],
  defaults: (b) => ({
    name: b.name,
    role: b.role,
    department: b.department,
    grade: b.grade || '',
    programs: b.programs || '',
    avatar: b.avatar || '',
    motto: b.motto || null,
    sort: b.sort || 0,
    isShow: b.isShow === undefined ? 1 : b.isShow,
  }),
  lens: [
    ['name', 32, '姓名过长'],
    ['role', 32, '职务过长'],
    ['department', 32, '部门过长'],
    ['grade', 32, '年级班级过长'],
    ['programs', 200, '栏目过长'],
    ['motto', 200, '座右铭过长'],
  ],
});
