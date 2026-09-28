'use strict';

/**
 * 管理端 · 风采展示（社干 + 部门人员 合并视图，仅超管）
 * 迁移自 src/controllers/admin/showcaseController.js
 *
 * 设计说明照抄源文件：**不是合表，而是「归一化读接口」** —— 把 cadre / staff
 * 两张表映射成同一形状供后台一个页面渲染；原有 CRUD 接口全部保留不动。
 *
 * ⚠️ 两处顺序细节别抄错：
 *   · 合并顺序恒为 **社干在前、部员在后**（分页切片依赖它）
 *   · `staffRows` 的排序是 `department ASC, sort DESC, id ASC`
 *     —— 与 `admin/staff/list` 的 `... id DESC` **不同**，源实现就是这样
 */

const { C, findAllPaged, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asSuper, anyLike, sortRows } = require('./_kit');
const { flipShow } = require('./_people');

/** 两张表可搜索的字段不一样，混用会拿不到结果（源注释原话：混用会 Unknown column） */
const SEARCH_KEYS = {
  cadre: ['name', 'role', 'grade'],
  staff: ['name', 'role', 'department', 'grade', 'programs'],
};

const TYPES = ['cadre', 'staff'];

/** 把两行不同结构的记录归一成同一形状，前端一个卡片组件就能渲染 */
function normalize(row, type) {
  return {
    id: row.id,
    type,
    name: row.name || '',
    avatar: row.avatar || '',
    // 卡片上那行副标题：社干显示职务，部员显示部门
    subtitle: type === 'cadre' ? row.role || '' : row.department || '',
    role: row.role || '',
    department: row.department || '',
    programs: row.programs || '',
    grade: row.grade || '',
    motto: row.motto || '',
    isShow: row.isShow,
    sort: row.sort || 0,
  };
}

/** GET /admin/showcase/list?type=cadre|staff|all */
async function list(ctx) {
  asSuper(ctx);
  const q = ctx.query || {};
  const type = String(q.type || 'all').toLowerCase();
  if (type !== 'all' && TYPES.indexOf(type) < 0) {
    throw new ApiError(Codes.PARAM_ERROR, 'type 只能是 cadre / staff / all');
  }
  const keyword = String(q.keyword || '').trim();
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  // 合并视图默认一次给全（24 人量级），需要分页时前端显式传 pageSize
  const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 50));

  const wantCadre = type === 'all' || type === 'cadre';
  const wantStaff = type === 'all' || type === 'staff';

  // ⚠️ 两张表各自全量拉 + JS 过滤：关键字是 LIKE，无法下推（见 _kit 文件头 ②）
  const [cadreRaw, staffRaw] = await Promise.all([
    wantCadre ? findAllPaged(C.CADRE, {}) : Promise.resolve([]),
    wantStaff ? findAllPaged(C.STAFF, {}) : Promise.resolve([]),
  ]);

  const cadreRows = keyword
    ? cadreRaw.filter((r) => anyLike(r, keyword, SEARCH_KEYS.cadre))
    : cadreRaw;
  const staffRows = keyword
    ? staffRaw.filter((r) => anyLike(r, keyword, SEARCH_KEYS.staff))
    : staffRaw;

  // 计数不受 keyword 影响，始终给全量，供顶部「全部 / 社干 / 部员」用。
  // wantXxx 时上面已经拉过全量，直接复用，省两次查询。
  const [cadreAll, staffAll] = await Promise.all([
    wantCadre ? cadreRaw : findAllPaged(C.CADRE, {}),
    wantStaff ? staffRaw : findAllPaged(C.STAFF, {}),
  ]);

  const merged = [
    ...sortRows(cadreRows, [['sort', 'desc'], ['id', 'asc']]).map((r) => normalize(r, 'cadre')),
    ...sortRows(staffRows, [['department', 'asc'], ['sort', 'desc'], ['id', 'asc']]).map((r) => normalize(r, 'staff')),
  ];

  const offset = (page - 1) * pageSize;
  const allCount = cadreAll.length + staffAll.length;
  const showCadre = cadreAll.filter((r) => Number(r.isShow) === 1).length;
  const showStaff = staffAll.filter((r) => Number(r.isShow) === 1).length;
  const showAll = showCadre + showStaff;

  return {
    list: merged.slice(offset, offset + pageSize),
    total: merged.length,
    page,
    pageSize,
    counts: { cadre: cadreAll.length, staff: staffAll.length, all: allCount },
    onShow: { cadre: showCadre, staff: showStaff, all: showAll },
    // 说明条 / 状态筛选直接用这两个合计，前端不用再算
    hidden: {
      cadre: cadreAll.length - showCadre,
      staff: staffAll.length - showStaff,
      all: allCount - showAll,
    },
  };
}

/** PUT /admin/showcase/:type/:id/toggle */
async function toggle(ctx) {
  asSuper(ctx);
  const { type } = ctx.params;
  if (TYPES.indexOf(type) < 0) throw new ApiError(Codes.PARAM_ERROR, 'type 只能是 cadre / staff');

  const id = parseId(ctx.params.id);
  const row = await flipShow(type === 'cadre' ? C.CADRE : C.STAFF, id, type === 'cadre' ? '社干' : '部员');
  return normalize(row, type);
}

module.exports = { list, toggle };
