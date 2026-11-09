'use strict';

/**
 * 伙伴端 · 社团密钥（2026-11-07）
 *
 *   GET  /partner/club-keys                列表：5 家社团 + 掩码 + 状态 + 谁重置过
 *   POST /partner/club-keys                新建一家（**仅超管**）+ 当场发第一把密钥
 *   GET  /partner/club-keys/:id            详情（编辑页用）
 *   PUT  /partner/club-keys/:id            改社团信息 body: { avatar?, ownerName?, teacherName? }
 *   POST /partner/club-keys/:id/reset      重置 → **唯一一次**返回明文
 *   PUT  /partner/club-keys/:id/status     启用 / 作废 body: { status: 0|1 }
 *
 * ═══════════ 鉴权有两道：asClubKeyer（四个动作）+ asSuperPartner（只有「新建」） ═══════════
 * 超管恒过（他自己就是总闸）；社干必须被超管勾上 `clubkey` 位；站员 40301。
 * 三个动作（看 / 重置 / 作废）**用同一个权限位**，因为它们是同一件事的三步 ——
 * 只让看不让重置没有意义（看的是掩码），只让重置不让作废则留着旧钥匙收不回来。
 * ⚠️ 但**新建社团不是密钥操作，是增减组织**：加一家会立刻出现在全校学生的社团轮播里
 *    （publicList 不筛 status），所以只给超管，`clubkey` 位不够。
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
const { asClubKeyer, asSuperPartner } = require('./_kit');
const clubKey = require('../../services/clubKey');

/** 操作人名字（写进 reset_by / update_by）—— 四处都用同一句，别各写一遍三元 */
function whoOf(p) {
  return (p && p.admin && (p.admin.nickname || p.admin.username)) || `账号${(p && p.id) || ''}`;
}

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

/**
 * POST /partner/club-keys —— 新建一家社团，同时把第一把钥匙发出来
 *
 * body: { name, ownerName?, teacherName? }
 * →    { record, plain, mask, shareText }
 *
 * ⚠️⚠️ 只有超管：多一家社团会立刻出现在**全校学生**的轮播里，这不是密钥操作。
 * ⚠️ 响应里的 `plain` 与 reset 同口径 —— **只这一次**，前端拿到必须当场摊开成六格；
 *    库里只有 sha256 + 掩码，关掉页面就再也看不到（产品语义：弄丢找社干重新生成）。
 * ⚠️ 名称建好不可改：`_id = club:<名称>` 是主键的一半，改名＝换主键。
 */
async function create(ctx) {
  const p = await asSuperPartner(ctx);
  const b = ctx.body || {};
  const out = await clubKey.create({
    name: b.name,
    ownerName: b.ownerName,
    teacherName: b.teacherName,
  }, whoOf(p));

  return {
    record: out.record,
    plain: out.plain,       // 唯一一次
    mask: out.mask,
    shareText: buildShareText(out.record && out.record.name, out.plain),
  };
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

module.exports = { list, create, detail, saveInfo, reset, setStatus, buildShareText };
