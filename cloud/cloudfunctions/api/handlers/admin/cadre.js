'use strict';

/**
 * 管理端 · 社干 CRUD（仅超管）
 * 迁移自 src/controllers/admin/cadreController.js
 *
 * 通用实现见 `_people.js`（与 staff 同构）。这里只描述差异：
 *   · 搜索字段：name / role / grade（**没有** department）
 *   · 排序：sort DESC, id ASC
 *   · 必填：姓名、职务；长度：name≤32 / role≤32 / grade≤32 / motto≤200
 */

const { C } = require('../../lib/db');
const { asSuper } = require('./_kit');
const { makeCrud } = require('./_people');

const FIELDS = ['id', 'name', 'role', 'grade', 'avatar', 'motto', 'sort', 'isShow', 'createTime', 'updateTime'];

module.exports = makeCrud({
  coll: C.CADRE,
  guard: asSuper,          // 原路由挂 requireSuperAdmin
  label: '社干',
  fields: FIELDS,
  searchFields: ['name', 'role', 'grade'],
  orderBy: [['sort', 'desc'], ['id', 'asc']],
  writable: ['name', 'role', 'grade', 'avatar', 'motto', 'sort', 'isShow'],
  createRequired: [['name', '请填写姓名'], ['role', '请填写职务']],
  defaults: (b) => ({
    name: b.name,
    role: b.role,
    grade: b.grade || '',
    avatar: b.avatar || '',
    motto: b.motto || null,
    sort: b.sort || 0,
    isShow: b.isShow === undefined ? 1 : b.isShow,
  }),
  lens: [
    ['name', 32, '姓名过长'],
    ['role', 32, '职务过长'],
    ['grade', 32, '年级班级过长'],
    ['motto', 200, '座右铭过长'],
  ],
});
