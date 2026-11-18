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
const { Program, Message } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');
const programSlot = require('../../services/programSlotService');

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
 *
 * ⚠️ 2026-11-19 起不再用 `broadcast_date between` 直接查：
 *    栏目库里存的是「每周几 + 第几档」，具体日期是**下发前投影出来的**。
 *    直接查日期会一条都查不到（列表静默变空，最难发现）。
 */
exports.schedule = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let f = from;
    let t = to;
    if (!f || !t) {
      // 默认返回未来7天（含今天）
      f = dayjs().format('YYYY-MM-DD');
      t = dayjs().add(7, 'day').format('YYYY-MM-DD');
    }
    // 节目表体量小（几十条），整表取回来再投影，避免为了"周几"写一堆 SQL 条件
    const rows = await Program.findAll({ where: { isShow: 1 } });
    const list = await programSlot.expand(rows, f, t);
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
    const rows = await Program.findAll({ where: { isShow: 1 } });
    const list = await programSlot.expand(rows, start, end);
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