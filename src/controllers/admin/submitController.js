'use strict';

/**
 * 管理端 - 投稿审核
 * GET    /api/admin/submit/list           列表（分页、筛选）
 * GET    /api/admin/submit/:id            详情
 * PUT    /api/admin/submit/:id/approve    通过
 * PUT    /api/admin/submit/:id/reject     驳回（必填驳回理由）
 * DELETE /api/admin/submit/:id            删除
 */
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const { Submit, User } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const {
      status, type,
      page = 1, pageSize = 10,
      keyword, startDate, endDate,
    } = req.query;

    const where = {};
    if (status !== undefined && status !== '') where.status = parseInt(status, 10);
    if (type !== undefined && type !== '') where.type = parseInt(type, 10);
    if (startDate && endDate) {
      where.createTime = { [Op.between]: [startDate, endDate] };
    }
    if (keyword) {
      where[Op.or] = [
        { songName: { [Op.like]: `%${keyword}%` } },
        { singer: { [Op.like]: `%${keyword}%` } },
        { articleTitle: { [Op.like]: `%${keyword}%` } },
        { wishContent: { [Op.like]: `%${keyword}%` } },
      ];
    }

    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Submit.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
      offset,
      limit: parseInt(pageSize, 10),
    });

    // 关联用户昵称/头像
    const openids = [...new Set(rows.map(r => r.openid))];
    const users = openids.length
      ? await User.findAll({
          where: { openid: openids },
          attributes: ['openid', 'nickname', 'avatar'],
        })
      : [];
    const userMap = new Map(users.map(u => [u.openid, u]));

    return success(res, {
      list: rows.map(r => ({
        ...r.toJSON(),
        nickname: userMap.get(r.openid)?.nickname || '匿名',
        avatar: userMap.get(r.openid)?.avatar || '',
      })),
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
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const user = await User.findOne({
      where: { openid: submit.openid },
      attributes: ['openid', 'nickname', 'avatar'],
    });
    return success(res, {
      ...submit.toJSON(),
      nickname: user?.nickname || '匿名',
      avatar: user?.avatar || '',
    });
  } catch (e) {
    return next(e);
  }
};

exports.approve = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (submit.status === 1) return success(res, submit, '已是已通过状态');
    await submit.update({
      status: 1,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
      rejectReason: null,
    });
    return success(res, submit, '已通过');
  } catch (e) {
    return next(e);
  }
};

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || reason.trim().length === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');
    }
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    await submit.update({
      status: 2,
      rejectReason: reason,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
    });
    return success(res, submit, '已驳回');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    await submit.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};

/**
 * 批量审核
 * body: { ids: [1,2,3], action: 'approve' | 'reject', reason? }
 */
exports.batch = async (req, res, next) => {
  try {
    const { ids, action, reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '请选择要操作的记录');
    }
    if (!['approve', 'reject'].includes(action)) {
      throw new ApiError(Codes.PARAM_ERROR, '操作类型错误');
    }
    if (action === 'reject' && !reason) {
      throw new ApiError(Codes.PARAM_ERROR, '驳回操作必须填写理由');
    }
    const update = {
      status: action === 'approve' ? 1 : 2,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
      rejectReason: action === 'reject' ? reason : null,
    };
    const [affected] = await Submit.update(update, { where: { id: ids } });
    return success(res, { affected }, '批量操作完成');
  } catch (e) {
    return next(e);
  }
};