'use strict';

const switchService = require('../../services/switchService');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const rows = await switchService.listAll();
    // updatedBy 存的是 admin.id，给前端换成姓名
    const ids = [...new Set(rows.map((r) => r.updatedBy).filter(Boolean))];
    const { Admin } = require('../../models');
    const admins = ids.length ? await Admin.findAll({ where: { id: ids }, attributes: ['id', 'username', 'nickname'] }) : [];
    const nameMap = new Map(admins.map((a) => [Number(a.id), a.nickname || a.username]));
    return success(res, {
      list: rows.map((r) => ({ ...r, updatedByName: r.updatedBy ? nameMap.get(Number(r.updatedBy)) || null : null })),
    });
  } catch (e) { return next(e); }
};

exports.update = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body || {};
    if (!['on', 'off'].includes(value)) {
      throw new ApiError(Codes.PARAM_ERROR, 'value 必须为 on 或 off');
    }
    const row = await switchService.set(key, value, req.admin?.id || null);
    return success(res, row, '已更新');
  } catch (e) { return next(e); }
};
