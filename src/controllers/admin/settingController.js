'use strict';

/**
 * 管理端 - 系统设置
 * GET   /api/admin/setting/list        列出所有设置
 * GET   /api/admin/setting/:key       读取
 * PUT   /api/admin/setting/:key       更新（不存在则创建）
 */
const { SystemSetting } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const list = await SystemSetting.findAll({ order: [['key', 'ASC']] });
    return success(res, { list });
  } catch (e) {
    return next(e);
  }
};

exports.get = async (req, res, next) => {
  try {
    const item = await SystemSetting.findOne({ where: { key: req.params.key } });
    if (!item) throw new ApiError(Codes.NOT_FOUND, '配置不存在');
    return success(res, item);
  } catch (e) {
    return next(e);
  }
};

exports.upsert = async (req, res, next) => {
  try {
    const { value, desc } = req.body || {};
    const [item, created] = await SystemSetting.findOrCreate({
      where: { key: req.params.key },
      defaults: { key: req.params.key, value: value || '', desc: desc || '' },
    });
    if (!created) {
      item.value = value !== undefined ? value : item.value;
      if (desc !== undefined) item.desc = desc;
      await item.save();
    }
    return success(res, item, created ? '已创建' : '已更新');
  } catch (e) {
    return next(e);
  }
};