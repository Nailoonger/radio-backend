'use strict';

/**
 * 用户端 · 社团提报通知（学生 / 社团侧）—— 2026-11-07
 *
 *   POST /user/club-notice                 提报一条        body: { ticket, body, hopeText?, note? }
 *   GET  /user/club-notice/my              本社团的提交     query: { ticket }
 *   GET  /user/club-notice/:id             进度详情         query: { ticket }
 *   PUT  /user/club-notice/:id             未审核前修改     body: { ticket, body, hopeText?, note? }
 *   POST /user/club-notice/:id/withdraw    撤回             body: { ticket }
 *
 * ═══════════ 鉴权**只有一道**：社团票据（2026-11-07 陛下定） ═══════════
 * 提报是社团的事，不是某个学生账号的事 —— 社长可能压根没注册过小程序、或者刚换人。
 * 所以要的只是「你手里有这家社团的钥匙」，不是「你是某个登录用户」。
 * 一开始我写了 `requireUser` + 票据两道，结果没登录的学生一进输码页就被踢去登录，
 * 与他「不登录也能用这个模块」的要求正相反。
 *
 * ⚠️ 票据 = 这家社团的通行证：2 小时、库里只存哈希、社团作废即失效。
 * ⚠️⚠️ 社团归属**只认票据里的 clubId**，绝不读前端传的 clubId ——
 *    否则持有 A 社团票据的人可以把 B 社团的单据改掉。
 * ⚠️ 票据失效统一报 40102 + 「社团密钥已过期，请重新输入」：前端据此回输码页。
 *    报 40101 会**顺手把学生登录态清掉**（request.js 的约定），报 40401 会让页面
 *    以为「这条通知没了」—— 两个都是最容易做错的一步。
 */

const { ApiError, Codes } = require('../../lib/response');
const { requireUser } = require('../../lib/auth');
const clubKey = require('../../services/clubKey');
const clubNotice = require('../../services/clubNotice');

/**
 * 「有登录就用，没有也放行」
 *
 * 提报**不要求**登录；但如果这个学生恰好登录着（小程序里 99% 是这种情况），
 * 落款就用他的学号，比「社长」两个字更像个人。token 过期也不拦 —— 这模块靠票据。
 */
async function optionalUser(ctx) {
  if (!ctx.token) return null;
  try { return await requireUser(ctx); } catch (e) { return null; }
}

/** 取票据 → 社团整行；失败统一 40102（**不是** 40101：那个码会让前端清登录态） */
async function needClub(ctx) {
  const b = ctx.body || {};
  const q = ctx.query || {};
  const ticket = b.ticket || q.ticket;
  const club = await clubKey.readSessionClub(ticket);
  if (!club) throw new ApiError(Codes.TICKET_EXPIRED, '社团密钥已过期，请重新输入');
  ctx.club = club;
  return club;
}

/** POST /user/club-notice */
async function create(ctx) {
  const club = await needClub(ctx);
  // 登不登录都能提；登录了就拿学号当落款（见 optionalUser）
  const user = await optionalUser(ctx);
  const record = await clubNotice.create(club, user, ctx.body || {});
  return { record };
}

/** GET /user/club-notice/my */
async function myList(ctx) {
  const club = await needClub(ctx);
  return clubNotice.myList(club);
}

/** GET /user/club-notice/:id */
async function detail(ctx) {
  const club = await needClub(ctx);
  return clubNotice.detail(club, ctx.params && ctx.params.id);
}

/** PUT /user/club-notice/:id */
async function update(ctx) {
  const club = await needClub(ctx);
  const record = await clubNotice.update(club, ctx.params && ctx.params.id, ctx.body || {});
  return { record };
}

/** POST /user/club-notice/:id/withdraw */
async function withdraw(ctx) {
  const club = await needClub(ctx);
  const record = await clubNotice.withdraw(club, ctx.params && ctx.params.id);
  return { record };
}

module.exports = { create, myList, detail, update, withdraw };
