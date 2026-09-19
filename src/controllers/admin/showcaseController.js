'use strict';

/**
 * 管理端 - 风采展示（社干 + 部门人员 合并模块）
 *
 * GET    /api/admin/showcase/list?type=cadre|staff|all
 * PUT    /api/admin/showcase/:type/:id/toggle
 *
 * 设计说明（为什么是「模块合并」而不是「合表」）：
 *   社干与部员结构不同 —— cadre 只有职务，staff 多出部门与负责栏目，
 *   且小程序「风采」页分两层展示（/api/user/showcase 返回 {cadre, staff}）。
 *   合表会打断小程序与已有的 /admin/cadre/*、/admin/staff/* 调用，
 *   所以这里只做「归一化读接口」：把两张表映射成同一个形状，供后台一个页面用。
 *   原有的 cadre / staff 增删改查接口全部保留，不受影响。
 *
 * 注: 仅 super admin (role=0) 可访问，中间件 requireSuperAdmin
 */
const { Op } = require('sequelize');
const { Cadre, Staff } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

// 两张表可搜索的字段不一样，混用会直接报 Unknown column
const SEARCH_KEYS = {
  cadre: ['name', 'role', 'grade'],
  staff: ['name', 'role', 'department', 'grade', 'programs'],
};

const TYPES = ['cadre', 'staff'];

function likeWhere(type, keyword) {
  if (!keyword) return {};
  return {
    [Op.or]: SEARCH_KEYS[type].map((k) => ({ [k]: { [Op.like]: `%${keyword}%` } })),
  };
}

/** 把两行不同结构的记录归一成同一形状，前端一个卡片组件就能渲染 */
function normalize(row, type) {
  const p = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  return {
    id: p.id,
    type,
    name: p.name || '',
    avatar: p.avatar || '',
    // 卡片上那行副标题：社干显示职务，部员显示部门
    subtitle: type === 'cadre' ? p.role || '' : p.department || '',
    role: p.role || '',
    department: p.department || '',
    programs: p.programs || '',
    grade: p.grade || '',
    motto: p.motto || '',
    isShow: p.isShow,
    sort: p.sort || 0,
  };
}

function isShowCount(rows) {
  return rows.filter((r) => Number(r.isShow) === 1).length;
}

exports.list = async (req, res, next) => {
  try {
    const type = String(req.query.type || 'all').toLowerCase();
    if (type !== 'all' && !TYPES.includes(type)) {
      throw new ApiError(Codes.PARAM_ERROR, 'type 只能是 cadre / staff / all');
    }
    const keyword = (req.query.keyword || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // 合并视图默认一次给全（24 人量级），需要分页时前端显式传 pageSize
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

    const wantCadre = type === 'all' || type === 'cadre';
    const wantStaff = type === 'all' || type === 'staff';

    const [cadreRows, staffRows] = await Promise.all([
      wantCadre
        ? Cadre.findAll({ where: likeWhere('cadre', keyword), order: [['sort', 'DESC'], ['id', 'ASC']] })
        : Promise.resolve([]),
      wantStaff
        ? Staff.findAll({
            where: likeWhere('staff', keyword),
            order: [['department', 'ASC'], ['sort', 'DESC'], ['id', 'ASC']],
          })
        : Promise.resolve([]),
    ]);

    // 计数不受 keyword 影响，始终给全量，供顶部「全部 / 社干 / 部员」用
    const [cadreAll, staffAll] = await Promise.all([
      Cadre.findAll({ attributes: ['isShow'] }),
      Staff.findAll({ attributes: ['isShow'] }),
    ]);

    const merged = [
      ...cadreRows.map((r) => normalize(r, 'cadre')),
      ...staffRows.map((r) => normalize(r, 'staff')),
    ];

    const offset = (page - 1) * pageSize;
    const allCount = cadreAll.length + staffAll.length;
    const showCadre = isShowCount(cadreAll);
    const showStaff = isShowCount(staffAll);
    const showAll = showCadre + showStaff;
    return success(res, {
      list: merged.slice(offset, offset + pageSize),
      total: merged.length,
      page,
      pageSize,
      counts: {
        cadre: cadreAll.length,
        staff: staffAll.length,
        all: allCount,
      },
      onShow: {
        cadre: showCadre,
        staff: showStaff,
        all: showAll,
      },
      // 说明条 / 状态筛选直接用这两个合计，前端不用再算
      hidden: {
        cadre: cadreAll.length - showCadre,
        staff: staffAll.length - showStaff,
        all: allCount - showAll,
      },
    });
  } catch (e) { return next(e); }
};

exports.toggle = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    if (!TYPES.includes(type)) throw new ApiError(Codes.PARAM_ERROR, 'type 只能是 cadre / staff');
    const Model = type === 'cadre' ? Cadre : Staff;
    const m = await Model.findByPk(id);
    if (!m) throw new ApiError(Codes.NOT_FOUND, type === 'cadre' ? '社干不存在' : '部员不存在');
    m.isShow = m.isShow === 1 ? 0 : 1;
    await m.save();
    return success(res, normalize(m, type), m.isShow === 1 ? '已展示' : '已隐藏');
  } catch (e) { return next(e); }
};
