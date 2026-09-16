'use strict';

/**
 * 用户端 - 留言
 * POST /api/user/message            提交留言（待审核）
 * GET  /api/user/message/my         我的留言列表
 */
const dayjs = require('dayjs');
const { Op } = require('sequelize');
const { Message, User } = require('../../models');
const { success, Codes, ApiError } = require('../../utils/response');
const { msgSecCheck } = require('../../services/wechatService');
const { getAccessToken } = require('../../services/accessTokenService');
const switchService = require('../../services/switchService');

exports.create = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const { programId, content } = req.body || {};

    if (!content || content.trim().length === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '留言内容不能为空');
    }

    // 模块开关拦截
    switchService.assertEnabled('message');
    if (content.length > 500) {
      throw new ApiError(Codes.PARAM_ERROR, '留言不能超过500字');
    }

    // 防刷：1分钟内同openid最多一条
    const recent = await Message.findOne({
      where: {
        openid,
        createTime: { [Op.gte]: dayjs().subtract(1, 'minute').toDate() },
      },
    });
    if (recent) {
      throw new ApiError(Codes.CONFLICT, '留言太频繁，请稍后再试');
    }

    // 内容安全检测
    const token = await getAccessToken();
    const sec = await msgSecCheck(content, token);
    if (!sec.pass) {
      throw new ApiError(Codes.CONTENT_BLOCKED, '留言包含敏感内容');
    }

    // 冗余昵称头像，便于审核展示
    const user = await User.findOne({ where: { openid } });

    const msg = await Message.create({
      openid,
      programId: programId || null,
      nickname: user?.nickname || '同学',
      avatar: user?.avatar || '',
      content,
      status: 0,
    });

    return success(res, { id: msg.id }, '留言成功，等待审核');
  } catch (e) {
    return next(e);
  }
};

exports.myList = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const { page = 1, pageSize = 10 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Message.findAndCountAll({
      where: { openid },
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