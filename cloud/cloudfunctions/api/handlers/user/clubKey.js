'use strict';

/**
 * 用户端 · 社团密钥（学生输密钥进社团通知台）—— 2026-11-07
 *
 *   GET  /user/club-key/clubs          轮播用的社团清单（**免登录**，只有名字和头像）
 *   POST /user/club-key/verify         输入密钥 body: { key } → 发票据
 *   GET  /user/club-key/me             凭票据换回当前社团 query: { ticket }
 *   PUT  /user/club-key/avatar         换本社团头像 body: { ticket, fileBase64 }
 *
 * ═══════════ 整个模块**不需要学生账号**（2026-11-07 陛下定） ═══════════
 * 「广播通知」是社团的事，不是某个学生的事：社长可能没注册过小程序账号，或者换人接手。
 * 所以这四条**一律不做 requireUser**，唯一的凭证就是密钥换来的票据。
 * 一开始我按「学生登录 + 社团票据」两道闸写，结果没登录的学生一进输码页就被踢去登录 ——
 * 那是把两件无关的事绑在一起了。
 * ⚠️ 代价：拿到票据就等于是这家社团。所以票据只有 2 小时、库里只存哈希、且
 *    **社团归属只认票据里的 clubId**，不接受前端传的。
 *
 * ═══════════ 为什么「校验密钥」要发一张票据，而不是让前端每次带明文 ═══════════
 * 明文只有 6 位，一旦进了 localStorage / 请求日志 / 剪贴板历史，就等于公开了。
 * 校验一次换一张 2 小时的 ticket，后续接口只认 ticket：
 *   · 泄露面从「永久有效的钥匙」缩小成「两小时的一次性通行证」
 *   · 学生换手机 / 清缓存只需重输，不用找社干重置
 *   · 密钥被重置时，旧 ticket 仍然有效到过期为止 —— 这是有意的：
 *     重置是为了「新人不该再用旧钥匙」，不是为了把正在提报的在校生踢出去。
 *
 * ═══════════ ⚠️ 票据错误一律说成「请重新输入密钥」，不说「密钥错误」 ═══════════
 * 票据过期是最常见的情况（2 小时、下节课就过了），报「密钥错误」会让人以为钥匙被换了。
 * 所以 me/avatar 遇到失效票据返回 `club: null`（HTTP 不报错），前端据此回输密钥页；
 * 只有 verify 本身才可能返回「密钥不对」。
 */

const { ApiError, Codes } = require('../../lib/response');
const { MAX_BYTES, MIME_EXT, sniffMime, monthDir, toBuffer } = require('../../lib/image');
const clubKey = require('../../services/clubKey');

/**
 * 社团行 → 学生端要的那几个字段
 *
 * ⚠️ 带 `mask`（尾号）但**不带 key_hash**：学生本来就知道自己输的那把钥匙，
 *    给个尾号是为了让他确认「进的是对的社团」（原型社团台那行「密钥 ····M7 · 负责人 林溪」）。
 */
function clubView(row) {
  return {
    id: row.id,
    name: row.club_name,
    avatar: row.club_avatar || '',
    mask: row.key_mask || '',
    ownerName: row.owner_name || '',
    teacherName: row.teacher_name || '',
  };
}

/** GET /user/club-key/clubs —— 免登录：首屏轮播要能先出图，再谈登录 */
async function clubs() {
  const list = await clubKey.publicList();
  return { list };
}

/**
 * POST /user/club-key/verify
 * body: { key }
 * 返回: { ticket, expireAt, club: { id, name, avatar } }
 */
async function verify(ctx) {
  // 试错闸：按来源限速。⚠️ 必须在查库之前，别先查再限速。
  // ⚠️ 来源不靠登录态：`ctx.source` 由平台注入（`cloud:<openid>` / `http:<ip>`），
  //    没登录的小程序调用也带着 openid。两者都没有才退到 anon（所有匿名共用一个桶）。
  //    ⚠️ 别改成「按登录用户」—— 这模块本来就不要求登录。
  const source = ctx.source || (ctx.openid ? `cloud:${ctx.openid}` : '');
  await clubKey.guardTry(source);

  const plain = clubKey.normalize((ctx.body || {}).key);
  if (!plain) throw new ApiError(Codes.PARAM_ERROR, '请输入社团密钥');
  if (plain.length !== clubKey.KEY_LEN) {
    throw new ApiError(Codes.PARAM_ERROR, `密钥是 ${clubKey.KEY_LEN} 位，请检查后重填`);
  }

  const row = await clubKey.findByPlain(plain);
  if (!row) {
    // 不区分「没这个码」与「这个社团已作废」：两种都说清楚等于告诉外人哪家还有效
    throw new ApiError(Codes.NOT_FOUND, '密钥不对，或这个社团的密钥已作废');
  }

  await clubKey.clearTry(source);
  const s = await clubKey.issueSession(row);
  return {
    ticket: s.ticket,
    expireAt: s.expireAt,
    club: clubView(row),
  };
}

/**
 * GET /user/club-key/me
 * query: { ticket }
 * 返回: { club } 或 { club: null }（票据没有/过期/被伪造 —— 统一按「该重新输入」处理）
 */
async function me(ctx) {
  const ticket = (ctx.query || {}).ticket || (ctx.body || {}).ticket;
  // readSessionClub：票据过期、伪造、或社团已被作废，都返回 null（前端据此回输码页）
  const row = await clubKey.readSessionClub(ticket);
  if (!row) return { club: null };
  return { club: clubView(row) };
}

/**
 * PUT /user/club-key/avatar
 * body: { ticket, fileBase64 }
 *
 * ⚠️ 只能换**自己这一家**的：社团 id 取自票据，**不接受前端传 clubId** ——
 *    否则任何一家的人都能把别家的头像换掉（一张图就够让全校看错社团）。
 * ⚠️ 上传走 `ctx.cloud.uploadFile`，存库的是 fileID（cloud://…），小程序 <image> 原生支持。
 *    前置条件同 admin/upload.js：云开发控制台存储权限要设「所有用户可读」。
 */
async function avatar(ctx) {
  const b = ctx.body || {};
  const s = await clubKey.readSession(b.ticket);
  // ⚠️ 40102 而不是 40101：后者会让 request.js 清掉学生登录态（这模块不要求登录）
  if (!s) throw new ApiError(Codes.TICKET_EXPIRED, '社团密钥已过期，请重新输入');

  if (!b.fileBase64) throw new ApiError(Codes.PARAM_ERROR, '未收到图片');

  let buffer;
  try { buffer = toBuffer(b.fileBase64); }
  catch (e) { throw new ApiError(Codes.PARAM_ERROR, '文件内容不是合法的 base64'); }
  // ⚠️ 这是**服务端兜底**，实际拦不住手机直出照片：`wx.cloud.callFunction` 的 data 约 1MB 上限，
  //    2MB 照片 base64 后 2.7MB，平台侧就回 `data exceed max`，请求根本到不了这里。
  //    真正的第一道闸在客户端（club-desk `_shrink`：压到 720px、base64 ≤ 700KB）。
  if (buffer.length > MAX_BYTES) throw new ApiError(Codes.PARAM_ERROR, '图片超过 2MB，请先压缩后上传');

  const mime = sniffMime(buffer);
  if (!mime) throw new ApiError(Codes.PARAM_ERROR, '不支持的图片格式，仅允许 jpg / png / webp');
  if (!ctx.cloud || typeof ctx.cloud.uploadFile !== 'function') {
    throw new ApiError(Codes.SERVER_ERROR, '云存储不可用（ctx.cloud.uploadFile 缺失）');
  }

  const rand = Math.random().toString(16).slice(2, 10);
  const cloudPath = `clubs/${monthDir(Date.now())}/${Date.now()}-${rand}.${MIME_EXT[mime]}`;
  const up = await ctx.cloud.uploadFile({ cloudPath, fileContent: buffer });
  const fileID = (up && (up.fileID || up.fileId)) || '';
  if (!fileID) throw new ApiError(Codes.SERVER_ERROR, '云存储未返回 fileID');

  await clubKey.saveInfo(s.clubId, { avatar: fileID }, s.clubName);
  // 回读一次再返回：前端拿到的必须是库里真实的头像（省得它自己拼一个乐观值，与后续列表对不上）
  const fresh = await clubKey.readSessionClub(b.ticket);
  return { club: clubView(fresh) };
}

module.exports = { clubs, verify, me, avatar };
