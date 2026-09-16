'use strict';

const switchService = require('../../services/switchService');
const { success } = require('../../utils/response');

exports.list = async (req, res, next) => {
  try {
    const list = await switchService.publicList();
    return success(res, { list });
  } catch (e) { return next(e); }
};

exports.get = async (req, res, next) => {
  try {
    const data = await switchService.publicGet(req.params.key);
    return success(res, data);
  } catch (e) { return next(e); }
};
