'use strict';

/**
 * 伙伴端 · 社团密钥（2026-11-07）
 *
 *   GET  /partner/club-keys                列表：5 家社团 + 掩码 + 状态 + 谁重置过
 *   GET  /partner/club-keys/:id            详情（编辑页用）
 *   PUT  /partner/club-keys/:id            改社团信息 body: { avatar?, ownerName?, teacherName? }
 *   POST /partner/club-keys/:id/reset      重置 → **唯一一次**返回明文
 *   PUT  /partner/club-keys/:id/status     启用 / 作废 body: { status: 0|1 }
 *
 * ═══════════ 鉴权只有一道：asClubKeyer ═══════════
 * 超管恒过（他自己就是总闸）；社干必须被超管勾上 `clubkey` 位；站员 40301。
 * 三个动作（看 / 重置 / 作废）**用同一个权限位**，因为它们是同一件事的三步 ——
 * 只让看不让重置没有意义（看的是掩码），只让重置不让作废则留着旧钥匙收不回来。
 *
 * ═══════════ 为什么明文只在 reset 返回、列表和详情永远拿不到 ═══════════
 * 见 services/clubKey.js 文件头。一句话：库里只有 sha256 和 '····M7'，
 * 想再看明文只能再重置一次，这正是「弄丢找社干重新生成」的产品语义 ——
 * 若这里为了「方便」把明文缓存进库，那句话就成了谎话。
 *
 * ⚠️ 前端拿到 `plain` 后必须当场展示（编辑页的六格），离开页面就没有第二次机会；
 *    列表页拿到的一律是 `mask`。
 */

const { ApiError, Codes } = require('../../lib/response');
const { parseId } = require('../../lib/db');
const { asClubKeyer } = require('./_kit');
const clubKey = require('../../services/clubKey');

/** 列表里附带的一句统计，前端标题下的副文案直接用它，不在页面里自己数 */
function countOf(list) {
  return {
    total: list.length,
    active: list.filter((x) => x.status === 1).length,
    blank: list.filter((x) => x.status !== 1).length,
  };
}

/** GET /partner/club-keys */
async function list(ctx) {
  await asClubKeyer(ctx);
  const rows = await clubKey.list();
  return { list: rows, count: countOf(rows) };
}

/** GET /partner/club-keys/:id */
async function detail(ctx) {
  await asClubKeyer(ctx);
  const id = parseId(ctx.params && ctx.params.id);
  if (id === null) throw new ApiError(Codes.PARAM_ERROR, '社团编号不合法');
  const record = await clubKey.detail(id);
  // 掩码之外再给一句人话，前端两种都能用（旧页面只读 mask 也不会坏）
  return { record, canReset: true };
}

/** PUT /partner/club-keys/:id —— 只改社团信息，绝不动密钥 */
async function saveInfo(ctx) {
  const p = await asClubKeyer(ctx);
  const id = parseId(ctx.params && ctx.params.id);
  if (id === null) throw new ApiError(Codes.PARAM_ERROR, '社团编号不合法');

  const b = ctx.body || {};
  const record = await clubKey.saveInfo(id, {
    avatar: b.avatar,
    ownerName: b.ownerName,
    teacherName: b.teacherName,
  }, p.admin.nickname || p.admin.username || `账号${p.id}`);
  return { record };
}

/**
 * POST /partner/club-keys/:id/reset
 *
 * ⚠️⚠️ 这是全站**唯一**能看到某社团明文的地方。返回体里的 `plain` 请前端立刻渲染，
 *    不要写进 localStorage / 不要打日志 —— 一旦落盘，「只能重置一次」就形同虚设。
 */
async function reset(ctx) {
  const p = await asClubKeyer(ctx);
  const id = parseId(ctx.params && ctx.params.id);
  if (id === null) throw new ApiError(Codes.PARAM_ERROR, '社团编号不合法');

  const out = await clubKey.reset(id, p.admin.nickname || p.admin.username || `账号${p.id}`);
  return {
    plain: out.plain,     // 唯一一次
    mask: out.mask,
    record: out.record,
    // 给前端一键复制的现成文案 —— 与原型「发给社长和指导老师」那块逐字一致
    shareText: buildShareText(out.record && out.record.name, out.plain),
  };
}

/** 分享文案：只在这一处拼，前端不要自己再写一份（改词要能一处改完） */
function buildShareText(clubName, plain) {
  return [
    `【菁悠广播站】${clubName || ''}的社团密钥：${plain}`,
    '请在「我的 → 广播通知 → 输入社团密钥」里填写，长期有效。',
    '密钥只发给社长和指导老师，请勿转发。',
  ].join('\n');
}

/** PUT /partner/club-keys/:id/status —— 启用 / 作废 */
async function setStatus(ctx) {
  const p = await asClubKeyer(ctx);
  const id = parseId(ctx.params && ctx.params.id);
  if (id === null) throw new ApiError(Codes.PARAM_ERROR, '社团编号不合法');

  const b = ctx.body || {};
  if (b.status === undefined || b.status === null) {
    throw new ApiError(Codes.PARAM_ERROR, '缺少 status（1 = 启用，0 = 作废）');
  }
  const on = Number(b.status) === 1 ? 1 : 0;
  const record = await clubKey.setStatus(id, on, p.admin.nickname || p.admin.username || `账号${p.id}`);
  return { record };
}

module.exports = { list, detail, saveInfo, reset, setStatus, buildShareText };
