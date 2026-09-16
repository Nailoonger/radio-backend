'use strict';

/**
 * 用户端 - 节目
 * GET /api/user/program/current      正在直播节目
 * GET /api/user/program/schedule     节目预告列表（按日期）
 * GET /api/user/program/weekly       本周节目单（聚合视图）
 * GET /api/user/program/:id          节目详情 + 已通过的留言
 */
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(isoWeek);
const { Op } = require('sequelize');
const { Program, Message } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

/**
 * 正在直播的节目（标记 is_live=1 的）
 */
exports.current = async (req, res, next) => {
  try {
    const program = await Program.findOne({
      where: { isLive: 1, isShow: 1 },
      order: [['sort', 'ASC']],
    });
    return success(res, program);
  } catch (e) {
    return next(e);
  }
};

/**
 * 节目预告列表（可选日期范围）
 * GET /api/user/program/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.schedule = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const where = { isShow: 1 };
    if (from && to) {
      where.broadcastDate = { [Op.between]: [from, to] };
    } else {
      // 默认返回未来7天
      const today = dayjs().format('YYYY-MM-DD');
      const next = dayjs().add(7, 'day').format('YYYY-MM-DD');
      where.broadcastDate = { [Op.between]: [today, next] };
    }
    const list = await Program.findAll({
      where,
      order: [['broadcast_date', 'ASC'], ['sort', 'ASC']],
    });
    return success(res, { list });
  } catch (e) {
    return next(e);
  }
};

/**
 * 本周节目单（按周一~周日分组）
 */
exports.weekly = async (req, res, next) => {
  try {
    const start = dayjs().startOf('isoWeek').format('YYYY-MM-DD');
    const end = dayjs().endOf('isoWeek').format('YYYY-MM-DD');
    const list = await Program.findAll({
      where: {
        isShow: 1,
        broadcastDate: { [Op.between]: [start, end] },
      },
      order: [['broadcast_date', 'ASC'], ['sort', 'ASC']],
    });
    return success(res, {
      weekRange: { from: start, to: end },
      list,
    });
  } catch (e) {
    return next(e);
  }
};

exports.detail = async (req, res, next) => {
  try {
    const program = await Program.findOne({
      where: { id: req.params.id, isShow: 1 },
    });
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');

    // 节目已通过的留言（分页加载由前端实现或加 query）
    const messages = await Message.findAll({
      where: { programId: req.params.id, status: 1 },
      order: [['create_time', 'DESC']],
      limit: 50,
    });

    return success(res, { program, messages });
  } catch (e) {
    return next(e);
  }
};