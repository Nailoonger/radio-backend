'use strict';

/**
 * 管理端 - 留言审核
 * GET    /api/admin/message/list
 * PUT    /api/admin/message/:id/approve
 * PUT    /api/admin/message/:id/reject
 * DELETE /api/admin/message/:id
 */
const { Op } = require('sequelize');
const { Message } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { status, page = 1, pageSize = 10, keyword, programId } = req.query;
    const where = {};
    if (status !== undefined && status !== '') where.status = parseInt(status, 10);
    if (programId) where.programId = parseInt(programId, 10);
    if (keyword) {
      where[Op.or] = [
        { content: { [Op.like]: `%${keyword}%` } },
        { nickname: { [Op.like]: `%${keyword}%` } },
      ];
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Message.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
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

exports.approve = async (req, res, next) => {
  try {
    const msg = await Message.findByPk(req.params.id);
    if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
    await msg.update({
      status: 1,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
      rejectReason: null,
    });
    return success(res, msg, '已通过');
  } catch (e) {
    return next(e);
  }
};

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason) throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');
    const msg = await Message.findByPk(req.params.id);
    if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
    await msg.update({
      status: 2,
      rejectReason: reason,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
    });
    return success(res, msg, '已驳回');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const msg = await Message.findByPk(req.params.id);
    if (!msg) throw new ApiError(Codes.NOT_FOUND, '留言不存在');
    await msg.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};