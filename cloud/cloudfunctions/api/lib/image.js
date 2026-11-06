'use strict';

/**
 * 图片字节识别 —— 只认**文件头**，不看 filename
 *
 * ═══════════ 为什么单独抽出来（2026-11-07）═══════════
 * `handlers/admin/upload.js`（admin-web 头像）与 `handlers/user/clubKey.js`（社团头像）
 * 是两条完全独立的链路，但「什么样的字节算图片」必须**是同一个判据** ——
 * 两边各抄一份表格，早晚出现「同一个文件后台能传、学生端报格式不支持」这种幽灵。
 * 所以判据沉在这里，两处都 require 它。
 *
 * ⚠️⚠️ 为什么不能看 filename：FormData → base64 的适配层**不带 MIME**（只有
 *    filename + fileBase64），而 filename 是用户可控字符串。伪造扩展名骗不过文件头。
 *
 * ═══════════ 体积：这条路是「被 100KB 逼出来的」═══════════
 * 2026-10-08 实测本环境 HTTP 访问服务：80KB → 200 OK，150KB → **HTTP 413
 * EXCEED_MAX_PAYLOAD_SIZE**（云函数「文本类型请求体」上限 100KB）。
 * base64 让体积 +33% ⇒ 2MB 原图必然 413。`MAX_BYTES` 只是**兜底**上界，
 * 真正可用上界由调用方按通道决定：admin-web 必须先压到 400px 内（约 25~60KB），
 * 小程序走 `wx.cloud.callFunction`（约 1MB）宽松些，但也该压。
 */

/** 兜底上界（真正可用上界见文件头） */
const MAX_BYTES = 2 * 1024 * 1024;

/** 只允许这三种（与原本地 multer 的 imageFileFilter 白名单一致） */
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * 按文件头判类型（不信任 filename 的扩展名）。
 * @returns {string|null} 'image/jpeg' | 'image/png' | 'image/webp' | null
 */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
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
  const d = new Date((now === undefined ? Date.now() : now) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 7);
}

/**
 * base64（可带 data URL 前缀）→ Buffer
 * 两种写法前端都出现过，这里统一剥一次；剥完为空就报错，别把空文件传到云存储。
 */
function toBuffer(fileBase64) {
  const raw = String(fileBase64 || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('empty');
  return buf;
}

module.exports = { MAX_BYTES, MIME_EXT, sniffMime, monthDir, toBuffer };
