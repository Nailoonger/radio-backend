'use strict';

const switchService = require('../../services/switchService');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const rows = await switchService.listAll();
    return success(res, { list: rows });
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
