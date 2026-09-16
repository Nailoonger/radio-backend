'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { ApiError, Codes } = require('../utils/response');

// 上传根目录
const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

/**
 * 通用文件存储工厂：按子目录归档（默认 avatars），文件名 timestamp + random + ext
 * @param {string} subdir  例 'avatars'
 */
function makeStorage(subdir) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const yyyymm = new Date().toISOString().slice(0, 7); // 2026-09
      const dir = path.join(UPLOAD_ROOT, subdir, yyyymm);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(req, file, cb) {
      const random = crypto.randomBytes(4).toString('hex');
      const ts = Date.now();
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${ts}-${random}${ext}`);
    },
  });
}

/**
 * 图片 MIME 校验
 */
const IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
function imageFileFilter(req, file, cb) {
  if (!IMAGE_MIMES.includes(file.mimetype)) {
    return cb(new ApiError(Codes.PARAM_ERROR, `不支持的图片类型：${file.mimetype}，仅允许 jpg/png/webp`));
  }
  cb(null, true);
}

/**
 * 头像上传中间件：单文件，2MB，仅图片
 * 字段名：file
 */
const avatarUpload = multer({
  storage: makeStorage('avatars'),
  fileFilter: imageFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
}).single('file');

/**
 * 把 multer 的 multer.MulterError 转换成 ApiError，确保前端收到友好提示
 */
function handleUpload(req, res, next) {
  avatarUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(Codes.PARAM_ERROR, '文件过大，最大 2MB'));
      }
      return next(new ApiError(Codes.PARAM_ERROR, `上传失败：${err.message}`));
    }
    next(err);
  });
}

module.exports = {
  handleUpload,
  UPLOAD_ROOT,
};
