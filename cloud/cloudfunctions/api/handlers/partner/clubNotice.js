'use strict';

/**
 * 伙伴端 · 广播通知处理台（社干 / 超管）—— 2026-11-07
 *
 *   GET /partner/club-notice/queue?status=0|1|3   队列（三段：待审核 / 待播 / 已播出）
 *   GET /partner/club-notice/:id                  详情（含时间线）
 *   PUT /partner/club-notice/:id/review           通过并排期 / 驳回（理由必填）
 *   PUT /partner/club-notice/:id/air              标记已播出
 *
 * ═══════════ 谁有这道门 ═══════════
 * `asReviewer` —— 审稿权限位（社干看超管发的 review 开关，站员一律 40301，超管恒过）。
 * 与「稿件审核」共用一个位是**故意的**：对站里来说这两件事是同一件
 * 「内容能不能上」，分两个开关只会多一处忘记开。
 *
 * ⚠️ 队列**不按社团/部门过滤**：广播通知是全校对外的，谁值班谁审，不分口。
 *
 * ⚠️ 「通过」不强制填排期 —— 站里常常课间先审完、下午排播时再补时段。
 *    强制必填会让社干在十分钟课间审不动一条通知。
 */

const { ApiError, Codes } = require('../../lib/response');
const { parseId } = require('../../lib/db');
const { asReviewer } = require('./_kit');
const clubNotice = require('../../services/clubNotice');

/** 路径参数 → 数字 id（非法直接 40001，别让它变成「查不到」） */
function idOf(ctx) {
  const id = parseId(ctx.params && ctx.params.id);
  if (id === null) throw new ApiError(Codes.PARAM_ERROR, '通知编号不合法');
  return id;
}

/** GET /partner/club-notice/queue */
async function queue(ctx) {
  await asReviewer(ctx);
  const q = ctx.query || {};
  const b = ctx.body || {};
  const raw = q.status !== undefined ? q.status : b.status;

  // 不传 status = 全部（前端自己按段筛）；传了就必须是已知状态，不静默当全部
  if (raw === undefined || raw === null || raw === '') return clubNotice.queue(undefined);
  const st = Number(raw);
  if (![0, 1, 2, 3, 9].includes(st)) {
    throw new ApiError(Codes.PARAM_ERROR, 'status 只能是 0 待审核 / 1 待播 / 3 已播出');
  }
  return clubNotice.queue(st);
}

/** GET /partner/club-notice/:id */
async function detail(ctx) {
  await asReviewer(ctx);
  return clubNotice.adminDetail(idOf(ctx));
}

/**
 * PUT /partner/club-notice/:id/review
 * body: { pass: true, date?, slot?, title? }  或  { pass: false, reason }
 */
async function review(ctx) {
  const p = await asReviewer(ctx);
  const row = await clubNotice.findRow(idOf(ctx));
  const record = await clubNotice.review(row, p.admin, ctx.body || {});
  return { record };
}

/** PUT /partner/club-notice/:id/air */
async function air(ctx) {
  const p = await asReviewer(ctx);
  const row = await clubNotice.findRow(idOf(ctx));
  const record = await clubNotice.markAir(row, p.admin);
  return { record };
}

module.exports = { queue, detail, review, air };
