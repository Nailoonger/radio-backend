'use strict';

const path = require('path');
const { success } = require('../../utils/response');
const { handleUpload, UPLOAD_ROOT } = require('../../middlewares/upload');

/**
 * 管理端 - 文件上传
 * POST /api/admin/upload/avatar   头像（单文件，字段名 file）
 */
exports.uploadAvatar = [
  handleUpload,
  (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ code: 40001, message: '未收到文件', data: null });
      }
      // destination 是绝对路径（uploads/avatars/2026-09），取相对 uploads 的子路径
      const rel = path.relative(UPLOAD_ROOT, req.file.destination).replace(/\\/g, '/');
      const url = `/uploads/${rel}/${req.file.filename}`;
      return success(res, {
        url,
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
      }, '上传成功');
    } catch (e) { return next(e); }
  },
];
