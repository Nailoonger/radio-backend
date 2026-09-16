'use strict';

/**
 * 用户端 - 投稿/点歌
 * POST /api/user/submit           提交投稿（点歌/文稿）
 * GET  /api/user/submit/my        我的投稿（分页）
 * GET  /api/user/submit/:id       投稿详情（只能看自己的）
 */
const dayjs = require('dayjs');
const { Op } = require('sequelize');
const { Submit, User } = require('../../models');
const { success, fail, Codes, ApiError } = require('../../utils/response');
const { msgSecCheck } = require('../../services/wechatService');
const { getAccessToken } = require('../../services/accessTokenService');
const switchService = require('../../services/switchService');

/**
 * 提交投稿
 * body:
 *   点歌: { type:1, songName, singer, wishContent, wantBroadcastTime? }
 *   文稿: { type:2, articleTitle, articleContent, wantBroadcastTime? }
 */
exports.create = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const body = req.body || {};
    const { type } = body;

    if (![1, 2].includes(type)) {
      throw new ApiError(Codes.PARAM_ERROR, '投稿类型必须为1或2');
    }

    // 模块开关拦截
    switchService.assertEnabled(type === 1 ? 'submit_song' : 'submit_article');

    // 校验字段
    if (type === 1) {
      if (!body.songName || !body.singer) {
        throw new ApiError(Codes.PARAM_ERROR, '请填写歌曲名和歌手');
      }
      if ((body.wishContent || '').length > 500) {
        throw new ApiError(Codes.PARAM_ERROR, '祝福语过长');
      }
    } else if (type === 2) {
      if (!body.articleTitle || !body.articleContent) {
        throw new ApiError(Codes.PARAM_ERROR, '请填写文稿标题和内容');
      }
      if ((body.articleContent || '').length > 5000) {
        throw new ApiError(Codes.PARAM_ERROR, '文稿内容不能超过5000字');
      }
    }

    // 防重复提交：相同 openid/type/songName 1分钟内只允许一次
    const recent = await Submit.findOne({
      where: {
        openid,
        type,
        ...(type === 1 ? { songName: body.songName } : { articleTitle: body.articleTitle }),
        createTime: { [Op.gte]: dayjs().subtract(1, 'minute').toDate() },
      },
    });
    if (recent) {
      throw new ApiError(Codes.CONFLICT, '请勿重复提交');
    }

    // 内容安全检测（异步失败不影响主流程）
    const token = await getAccessToken();
    const text = type === 1 ? `${body.songName} ${body.singer} ${body.wishContent || ''}` : `${body.articleTitle} ${body.articleContent}`;
    const sec = await msgSecCheck(text, token);
    if (!sec.pass) {
      throw new ApiError(Codes.CONTENT_BLOCKED, '内容包含敏感信息，请修改后重试');
    }

    const submit = await Submit.create({
      openid,
      type,
      songName: body.songName || null,
      singer: body.singer || null,
      wishContent: body.wishContent || null,
      articleTitle: body.articleTitle || null,
      articleContent: body.articleContent || null,
      wantBroadcastTime: body.wantBroadcastTime || null,
      status: 0,
    });

    return success(res, { id: submit.id }, '提交成功，等待审核');
  } catch (e) {
    return next(e);
  }
};

/**
 * 我的投稿列表
 * GET /api/user/submit/my?status=&page=&pageSize=
 */
exports.myList = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const { status, page = 1, pageSize = 10 } = req.query;
    const where = { openid };
    if (status !== undefined && status !== '') {
      where.status = parseInt(status, 10);
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Submit.findAndCountAll({
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

/**
 * 投稿详情（自己的）
 */
exports.detail = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({
      where: { id: req.params.id, openid: req.user.openid },
    });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    return success(res, submit);
  } catch (e) {
    return next(e);
  }
};

/**
 * 撤销自己的待审核投稿
 */
exports.cancel = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({
      where: { id: req.params.id, openid: req.user.openid },
    });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (submit.status !== 0) throw new ApiError(Codes.FORBIDDEN, '已审核的投稿不能撤销');
    await submit.destroy();
    return success(res, null, '已撤销');
  } catch (e) {
    return next(e);
  }
};