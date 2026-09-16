'use strict';

/**
 * 管理端 - 公告管理
 * GET    /api/admin/notice/list
 * POST   /api/admin/notice/create
 * PUT    /api/admin/notice/:id
 * DELETE /api/admin/notice/:id
 * PUT    /api/admin/notice/:id/toggle   切换展示/隐藏
 */
const { Notice } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, keyword } = req.query;
    const where = {};
    if (keyword) {
      const { Op } = require('sequelize');
      where[Op.or] = [
        { title: { [Op.like]: `%${keyword}%` } },
        { content: { [Op.like]: `%${keyword}%` } },
      ];
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Notice.findAndCountAll({
      where,
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

exports.create = async (req, res, next) => {
  try {
    const { title, content, isTop, isShow } = req.body || {};
    if (!title || !content) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写标题和内容');
    }
    const notice = await Notice.create({
      title,
      content,
      isTop: isTop ? 1 : 0,
      isShow: isShow === undefined ? 1 : isShow,
      publisherId: req.admin.id,
      publishTime: new Date(),
    });
    return success(res, notice, '发布成功');
  } catch (e) {
    return next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const notice = await Notice.findByPk(req.params.id);
    if (!notice) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
    const fields = ['title', 'content', 'isTop', 'isShow'];
    for (const f of fields) {
      if (req.body[f] !== undefined) notice[f] = req.body[f];
    }
    await notice.save();
    return success(res, notice, '更新成功');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const notice = await Notice.findByPk(req.params.id);
    if (!notice) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
    await notice.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};

exports.toggle = async (req, res, next) => {
  try {
    const notice = await Notice.findByPk(req.params.id);
    if (!notice) throw new ApiError(Codes.NOT_FOUND, '公告不存在');
    notice.isShow = notice.isShow === 1 ? 0 : 1;
    await notice.save();
    return success(res, notice, '已切换');
  } catch (e) {
    return next(e);
  }
};