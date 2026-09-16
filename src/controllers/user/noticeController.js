'use strict';

/**
 * 用户端 - 公告
 * GET /api/user/notice/list       公告列表（已展示）
 * GET /api/user/notice/:id       公告详情
 */
const { Notice } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 10 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Notice.findAndCountAll({
      where: { isShow: 1 },
      order: [
        ['is_top', 'DESC'],
        ['publish_time', 'DESC'],
      ],
      offset,
      limit: parseInt(pageSize, 10),
    });
    return success(res, {
      list: rows,
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
    });
  } catch (e) {
    return next(e);
  }
};

exports.detail = async (req, res, next) => {
  try {
    const notice = await Notice.findOne({
      where: { id: req.params.id, isShow: 1 },
    });
    if (!notice) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
    return success(res, notice);
  } catch (e) {
    return next(e);
  }
};