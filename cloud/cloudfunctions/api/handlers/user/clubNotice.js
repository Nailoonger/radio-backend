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
 * ═══════════ 鉴权是两道，缺一不可 ═══════════
 *   ① `requireUser`：必须是登录学生（单据里的 submit_by_user_id 要用它）
 *   ② `readSessionClub`：必须持有**未过期的社团票据**（club_sessions）
 * 为什么两道都要：密钥是「社团的钥匙」，学生 token 是「这个人的身份」。
 * 只有①，任何学生都能以任何社团名义提报；只有②，票据泄露后不知道是谁提的。
 *
 * ⚠️⚠️ 社团归属**只认票据里的 clubId**，绝不读前端传的 clubId ——
 *    否则持有 A 社团票据的人可以把 B 社团的单据改掉。
 *
 * ⚠️ 票据失效统一报 40101 + 「请重新输入社团密钥」：前端据此回输码页。
 *    报 40401 会让页面以为「这条通知没了」，那是最容易做错的一步。
 */

const { ApiError, Codes } = require('../../lib/response');
const { requireUser } = require('../../lib/auth');
const clubKey = require('../../services/clubKey');
const clubNotice = require('../../services/clubNotice');

/** 取票据 → 社团整行；失败统一 40101 */
async function needClub(ctx) {
  const b = ctx.body || {};
  const q = ctx.query || {};
  const ticket = b.ticket || q.ticket;
  const club = await clubKey.readSessionClub(ticket);
  if (!club) throw new ApiError(Codes.UNAUTHORIZED, '登录已过期，请重新输入社团密钥');
  ctx.club = club;
  return club;
}

/** POST /user/club-notice */
async function create(ctx) {
  const user = await requireUser(ctx);
  const club = await needClub(ctx);
  const record = await clubNotice.create(club, user, ctx.body || {});
  return { record };
}

/** GET /user/club-notice/my */
async function myList(ctx) {
  await requireUser(ctx);
  const club = await needClub(ctx);
  return clubNotice.myList(club);
}

/** GET /user/club-notice/:id */
async function detail(ctx) {
  await requireUser(ctx);
  const club = await needClub(ctx);
  return clubNotice.detail(club, ctx.params && ctx.params.id);
}

/** PUT /user/club-notice/:id */
async function update(ctx) {
  await requireUser(ctx);
  const club = await needClub(ctx);
  const record = await clubNotice.update(club, ctx.params && ctx.params.id, ctx.body || {});
  return { record };
}

/** POST /user/club-notice/:id/withdraw */
async function withdraw(ctx) {
  await requireUser(ctx);
  const club = await needClub(ctx);
  const record = await clubNotice.withdraw(club, ctx.params && ctx.params.id);
  return { record };
}

module.exports = { create, myList, detail, update, withdraw };
