'use strict';

/**
 * 管理端 · 文件上传（仅超管）
 * 对齐 src/controllers/admin/uploadController.js 的 `POST /api/admin/upload/avatar`
 *
 * ═══════════════ ⚠️⚠️ 两条通道的传输契约不同（别照抄前端写法）═══════════════
 *
 *   direct（原 Express）：`multipart/form-data`，multer 收 `file` 字段
 *   cloud （本文件）    ：JSON 信封 `{ filename, fileBase64 }`
 *                        由 admin-web `src/utils/http.js` 的 formDataToFilePayload()
 *                        统一适配 —— **调用方仍然只写 FormData，一行都不用改**
 *
 * ═══════════════ ⚠️⚠️ 为什么这里要「魔数」校验，而不是看 filename ═══════════════
 * FormData → base64 的适配层**不会**把 MIME 带过来（只给 filename + fileBase64），
 * 而 filename 是用户可控的字符串。所以类型判定只认**文件头字节**：
 * 伪造扩展名骗不过去，也不会因为前端写错 type 而误拦。
 *
 * ═══════════════ ⚠️⚠️ 体积：这条路是「被 100KB 逼出来的」═══════════════
 * 2026-10-08 实测本环境 HTTP 访问服务（admin-web 走的就是它）：
 *     POST body  80KB → 200 OK
 *     POST body 150KB → **HTTP 413 EXCEED_MAX_PAYLOAD_SIZE**
 * （与 CloudBase 文档一致：云函数「文本类型请求体」上限 100KB。）
 * base64 会让体积 +33% ⇒ **2MB 的原图（2.7MB base64）必然 413**。
 * 因此 admin-web 侧上传前**必须先把图压到 400px 内**（`utils/imageCompress.js`），
 * 压完通常 25~60KB。这里的 2MB 校验是**兜底**，不是可用上界。
 *
 * ⚠️ 反过来：走 `wx.cloud.callFunction` 的小程序通道没有这条限制（上限约 1MB），
 *    但头像本来就该压缩后上传，无差别。
 *
 * ═══════════════ ⚠️ 存库存的是 fileID，不是 https 链接 ═══════════════
 * 返回的 `url` 就是 **fileID（cloud://…）**：
 *   · 小程序 `<image src>` **原生支持** cloud://（基础库 2.3.0+），且不过下载域名校验
 *     —— 这正是当初上云开发的理由，换成 https 链接反而会被「合法域名」拦死；
 *   · admin-web（浏览器）不认 cloud:// → 由前端 `utils/avatar.js` 转成
 *     `https://<bucket>.tcb.qcloud.la/<path>` 直链。
 *
 * ⚠️⚠️ **前置条件（部署时必须做，否则图一律 403）**：
 *    云开发控制台 → 存储 → 权限设置 → 设为「所有用户可读，仅创建者可写」。
 *    默认权限下，非上传者（含网页端、其它学生）读不到该文件。
 */

const { ApiError, Codes } = require('../../lib/response');
const { asSuper } = require('./_kit');

/** 只允许这三种（与本地 multer 的 imageFileFilter 白名单一致） */
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 兜底上界（真正可用上界见文件头的 100KB 说明） */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * 按文件头判类型（不信任 filename 的扩展名）。
 * @returns {string|null} 'image/jpeg' | 'image/png' | 'image/webp' | null
 */
function sniffMime(buf) {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  return null;
}

/** 北京时间 YYYY-MM（与本地 multer 的 `new Date().toISOString().slice(0,7)` 同为按月归档） */
function monthDir(now) {
  const d = new Date(now + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 7);
}

/**
 * 上传头像
 * body: { filename, fileBase64 }
 * 返回: { url, filename, size, mimetype }
 *   ⚠️ `url` = fileID（存库用；语义见文件头）。
 *      与本地通道返回 `/uploads/avatars/…` 一样只占一个字段，调用方零分支。
 */
async function avatar(ctx) {
  asSuper(ctx);

  const body = ctx.body || {};
  if (!body.fileBase64) {
    throw new ApiError(Codes.PARAM_ERROR, '未收到文件');
  }

  let buffer;
  try {
    // 兼容 data URL 前缀（前端两种写法都出现过）
    buffer = Buffer.from(String(body.fileBase64).replace(/^data:[^,]*,/, ''), 'base64');
  } catch (e) {
    throw new ApiError(Codes.PARAM_ERROR, '文件内容不是合法的 base64');
  }
  if (!buffer.length) throw new ApiError(Codes.PARAM_ERROR, '文件内容为空');
  if (buffer.length > MAX_BYTES) {
    throw new ApiError(Codes.PARAM_ERROR, '文件超过 2MB，请先压缩后上传');
  }

  const mime = sniffMime(buffer);
  if (!mime) {
    throw new ApiError(Codes.PARAM_ERROR, '不支持的图片格式，仅允许 jpg / png / webp');
  }

  if (!ctx.cloud || typeof ctx.cloud.uploadFile !== 'function') {
    // 本地 harness 若没装假云存储会走到这里 —— 把原因说清楚，别报一句笼统的“服务器繁忙”
    throw new ApiError(Codes.SERVER_ERROR, '云存储不可用（ctx.cloud.uploadFile 缺失）');
  }

  const ext = MIME_EXT[mime];
  const rand = Math.random().toString(16).slice(2, 10);
  const cloudPath = `avatars/${monthDir(Date.now())}/${Date.now()}-${rand}.${ext}`;

  const up = await ctx.cloud.uploadFile({ cloudPath, fileContent: buffer });
  const fileID = (up && (up.fileID || up.fileId)) || '';
  if (!fileID) {
    throw new ApiError(Codes.SERVER_ERROR, '云存储未返回 fileID');
  }

  return {
    url: fileID,          // ← 存库字段（前端 form.avatar）
    filename: cloudPath,  // 相对云存储路径（与原通道回 filename 的语义对齐）
    size: buffer.length,
    mimetype: mime,
  };
}

module.exports = { avatar };
