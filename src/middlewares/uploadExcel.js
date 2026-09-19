'use strict';

/**
 * 名册表格上传中间件（内存存储，不落磁盘）
 *   字段名：file
 *   限制：2MB，.xlsx / .xls / .csv
 *
 * 为什么用内存存储：名册只解析一次就进数据库，没有留档价值；
 * 落磁盘还要考虑清理和隐私（表格里有姓名），直接用 buffer 更干净。
 */

const multer = require('multer');
const path = require('path');
const { ApiError, Codes } = require('../utils/response');

const ALLOW_EXT = ['.xlsx', '.xls', '.csv'];
const ALLOW_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // 部分浏览器对 xlsx 会给这个
  'text/csv',
  'application/csv',
  'text/plain',
  'text/comma-separated-values',
];

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOW_EXT.includes(ext)) {
    return cb(new ApiError(Codes.PARAM_ERROR, `不支持的文件类型 ${ext || '(无扩展名)'}，仅允许 xlsx / xls / csv`));
  }
  if (file.mimetype && !ALLOW_MIME.includes(file.mimetype)) {
    return cb(new ApiError(Codes.PARAM_ERROR, `不支持的文件类型 ${file.mimetype}，仅允许 xlsx / xls / csv`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
}).single('file');

function uploadExcel(req, res, next) {
  upload(req, res, (err) => {
    if (!err) {
      if (!req.file) return next(new ApiError(Codes.PARAM_ERROR, '请选择要导入的表格文件（字段名 file）'));
      // multer/busboy 按 latin1 解码 multipart 的 filename，中文文件名会乱码（2026-09-19 实测：
      // 「带名字的.xlsx」→「Â²ï¿½Ö·Ã»...xlsx」）。按 latin1 还原成 utf8；纯 ASCII 名转换后原样不变。
      try {
        const fixed = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');
        if (fixed && !fixed.includes('\uFFFD')) req.file.originalname = fixed;
      } catch { /* 解不动就保持原值，不影响解析 */ }
      return next();
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(Codes.PARAM_ERROR, '文件过大，最大 2MB'));
      }
      return next(new ApiError(Codes.PARAM_ERROR, `上传失败：${err.message}`));
    }
    return next(err);
  });
}

module.exports = { uploadExcel };
