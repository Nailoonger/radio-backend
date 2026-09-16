'use strict';

/**
 * 用户端 - 个人中心 + 广播站介绍
 * GET /api/user/profile            个人中心聚合数据
 * GET /api/user/station/intro      广播站介绍
 * GET /api/user/station/schedule   开播时间
 * GET /api/user/station/contact    联系方式
 */
const { Submit, Message, SystemSetting } = require('../../models');
const { success, Codes, ApiError } = require('../../utils/response');

/**
 * 个人中心：聚合当前用户的统计 + 通知
 * 包括：投稿统计、待审核数量、最近5条记录
 */
exports.profile = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const [submitTotal, submitPending, submitApproved, messageTotal, recentSubmits] = await Promise.all([
      Submit.count({ where: { openid } }),
      Submit.count({ where: { openid, status: 0 } }),
      Submit.count({ where: { openid, status: 1 } }),
      Message.count({ where: { openid } }),
      Submit.findAll({
        where: { openid },
        order: [['create_time', 'DESC']],
        limit: 5,
      }),
    ]);

    return success(res, {
      stats: {
        submitTotal,
        submitPending,
        submitApproved,
        messageTotal,
      },
      recentSubmits,
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 通用：读取系统设置（key -> value）
 */
async function getSetting(key, res, next) {
  try {
    const item = await SystemSetting.findOne({ where: { key } });
    if (!item) throw new ApiError(Codes.NOT_FOUND, '未配置');
    return success(res, { key: item.key, value: item.value });
  } catch (e) {
    return next(e);
  }
}

exports.stationIntro = (req, res, next) =>
  getSetting('station_intro', res, next);

exports.stationSchedule = (req, res, next) =>
  getSetting('broadcast_schedule', res, next);

exports.stationContact = (req, res, next) =>
  getSetting('contact', res, next);