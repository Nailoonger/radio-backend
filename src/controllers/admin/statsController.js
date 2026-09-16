'use strict';

/**
 * 管理端 - 数据统计
 * GET /api/admin/stats/overview        概览（总数、待审、本周新增）
 * GET /api/admin/stats/submit-trend    投稿近7天趋势（按天）
 * GET /api/admin/stats/top-songs       热门点歌 Top10（已通过）
 */
const dayjs = require('dayjs');
const { Op, fn, col, literal } = require('sequelize');
const { Submit, Message, Notice, Program, User } = require('../../models');
const { success } = require('../../utils/response');

exports.overview = async (req, res, next) => {
  try {
    const today = dayjs().startOf('day').toDate();
    const weekStart = dayjs().startOf('isoWeek').toDate();

    const [
      submitTotal, submitPending, submitApproved, submitRejected,
      songTotal, articleTotal,
      messageTotal, messagePending,
      noticeTotal, programTotal,
      todaySubmits, weekSubmits,
      userTotal, todayUsers,
    ] = await Promise.all([
      Submit.count(),
      Submit.count({ where: { status: 0 } }),
      Submit.count({ where: { status: 1 } }),
      Submit.count({ where: { status: 2 } }),
      Submit.count({ where: { type: 1 } }),
      Submit.count({ where: { type: 2 } }),
      Message.count(),
      Message.count({ where: { status: 0 } }),
      Notice.count(),
      Program.count(),
      Submit.count({ where: { createTime: { [Op.gte]: today } } }),
      Submit.count({ where: { createTime: { [Op.gte]: weekStart } } }),
      User.count(),
      User.count({ where: { createTime: { [Op.gte]: today } } }),
    ]);

    return success(res, {
      submit: {
        total: submitTotal,
        pending: submitPending,
        approved: submitApproved,
        rejected: submitRejected,
        song: songTotal,
        article: articleTotal,
        today: todaySubmits,
        thisWeek: weekSubmits,
      },
      message: {
        total: messageTotal,
        pending: messagePending,
      },
      content: {
        notice: noticeTotal,
        program: programTotal,
      },
      user: {
        total: userTotal,
        today: todayUsers,
      },
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 近7天投稿趋势
 * 返回: [{ date: '2026-09-08', count: 12, song: 8, article: 4 }, ...]
 */
exports.submitTrend = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const start = dayjs().subtract(days - 1, 'day').startOf('day').toDate();
    const rows = await Submit.findAll({
      where: { createTime: { [Op.gte]: start } },
      attributes: [
        [fn('DATE', col('create_time')), 'date'],
        [fn('COUNT', col('id')), 'count'],
        [literal("SUM(CASE WHEN type=1 THEN 1 ELSE 0 END)"), 'song'],
        [literal("SUM(CASE WHEN type=2 THEN 1 ELSE 0 END)"), 'article'],
      ],
      group: [fn('DATE', col('create_time'))],
      order: [[fn('DATE', col('create_time')), 'ASC']],
      raw: true,
    });

    // 补齐没有数据的日期
    const map = new Map(rows.map(r => [r.date, r]));
    const list = [];
    for (let i = 0; i < days; i++) {
      const d = dayjs().subtract(days - 1 - i, 'day').format('YYYY-MM-DD');
      list.push({
        date: d,
        count: Number(map.get(d)?.count || 0),
        song: Number(map.get(d)?.song || 0),
        article: Number(map.get(d)?.article || 0),
      });
    }
    return success(res, { list });
  } catch (e) {
    return next(e);
  }
};

/**
 * 热门点歌 Top10（已通过）
 */
exports.topSongs = async (req, res, next) => {
  try {
    const rows = await Submit.findAll({
      where: { type: 1, status: 1 },
      attributes: [
        'songName',
        'singer',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: ['songName', 'singer'],
      order: [[literal('count'), 'DESC']],
      limit: 10,
      raw: true,
    });
    return success(res, { list: rows });
  } catch (e) {
    return next(e);
  }
};