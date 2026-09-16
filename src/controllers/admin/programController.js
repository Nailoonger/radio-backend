'use strict';

/**
 * 管理端 - 节目排期管理
 * GET    /api/admin/program/list
 * POST   /api/admin/program/create
 * PUT    /api/admin/program/:id
 * DELETE /api/admin/program/:id
 * PUT    /api/admin/program/:id/live    切换"正在直播"标识（保证仅一个节目 live=1）
 */
const { Op } = require('sequelize');
const { Program } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, startDate, endDate } = req.query;
    const where = {};
    if (startDate && endDate) {
      where.broadcastDate = { [Op.between]: [startDate, endDate] };
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Program.findAndCountAll({
      where,
      order: [['broadcast_date', 'ASC'], ['sort', 'ASC']],
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

exports.create = async (req, res, next) => {
  try {
    const { title, host, broadcastTime, broadcastDate, desc, cover, isShow, sort } = req.body || {};
    if (!title || !broadcastTime) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写节目名和开播时间');
    }
    const program = await Program.create({
      title,
      host,
      broadcastTime,
      broadcastDate: broadcastDate || null,
      desc,
      cover,
      isShow: isShow === undefined ? 1 : isShow,
      sort: sort || 0,
    });
    return success(res, program, '创建成功');
  } catch (e) {
    return next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
    const fields = ['title', 'host', 'broadcastTime', 'broadcastDate', 'desc', 'cover', 'isShow', 'sort'];
    for (const f of fields) {
      if (req.body[f] !== undefined) program[f] = req.body[f];
    }
    await program.save();
    return success(res, program, '更新成功');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
    await program.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};

/**
 * 切换"正在直播"：仅一个节目可设置 live=1
 */
exports.setLive = async (req, res, next) => {
  try {
    const { isLive } = req.body || {};
    if (isLive === 1) {
      await Program.update({ isLive: 0 }, { where: {} });
    }
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
    program.isLive = isLive ? 1 : 0;
    await program.save();
    return success(res, program, '已更新直播状态');
  } catch (e) {
    return next(e);
  }
};