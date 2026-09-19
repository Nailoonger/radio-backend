'use strict';

/**
 * 用户端 - 社干
 * GET /api/user/cadre/:id   社干详情（仅 is_show=1）
 */
const { Cadre } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.detail = async (req, res, next) => {
  try {
    const m = await Cadre.findOne({
      where: { id: req.params.id, isShow: 1 },
    });
    if (!m) throw new ApiError(Codes.NOT_FOUND, '成员不存在');
    return success(res, m);
  } catch (e) { return next(e); }
};
