'use strict';

/**
 * 伙伴端 · 权限管理（超管）—— 2026-10-31
 *
 *   GET  /partner/permissions                全局开关 + 社干名单（含生效值）
 *   PUT  /partner/permissions                改全局开关 body: { schedule?, review? }
 *   PUT  /partner/permissions/person/:id     按人设置   body: { schedule?, review? }（null = 跟回全局）
 *   GET  /partner/permissions/mine           我自己能做什么（社干进页面前先问一句）
 *
 * ═══════════ 为什么是「全局总闸 + 按人覆盖」两层 ═══════════
 * 陛下原话是两件事，缺一不可：
 *   ①「是否开启社干进入排班工作台的排班权限」—— 一刀切的总闸
 *   ②「超管可以在这里分发权限给社干，比如让某个社干可以使用排班或者审核功能」—— 按人
 * 只做①，②落不了地；只做②，人一多就要挨个点，且「全部关掉」没有一键。
 * 所以：**全局是默认值，按人是覆盖**（三态：null 跟随 / true 单独开 / false 单独关）。
 *
 * 生效值 = 按人那份是 true/false 就用它，是 null/缺省就取全局。
 * 于是「全局关掉 + 单独开小王」＝ 只有小王能进，这正是「分发」的语义。
 *
 * ═══════════ 落库形态（两条 _id 口径）═══════════
 *   `partner_permissions` / `_id = 'global'`   → { schedule, review, updateTime, by }
 *   `partner_permissions` / `_id = 'p:<id>'`   → { personId, schedule, review, updateTime, by }
 *
 * ⚠️ 为什么不塞进 `system_switch`：那张表的语义是「功能开关」（点歌/投稿这类对外功能），
 *    且 `switchService.KNOWN_SWITCHES` 有「缺行视为 on」的既有口径，
 *    混进权限会让「谁被禁了」和「功能开没开」搅在一起，后台查起来分不清。
 *    独立一张表，改权限不惊动任何现有开关。
 *
 * ⚠️ 缺行 = 全开（与 system_switch 同口径）。上线后行为与升级前完全一致，
 *    不会出现「发版当天所有社干突然进不去」。
 *
 * ⚠️ 读/判的实现在 `_kit.js`（`readGlobalPerm` / `effectivePerm` / `asScheduler`），
 *    这里只做 HTTP 层的编排 —— 放这儿会和 `_kit` 形成循环依赖。
 */

const { C, findOne, findById, insertWithId, updateById, findAllPaged } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const {
  asPartner, asSuperPartner,
  ROLE_MANAGER, ROLE_SUPER,
  PERM_KEYS, PERM_TEXT, triPerm, readGlobalPerm, readPersonPerm, effectivePerm,
} = require('./_kit');

const GLOBAL_ID = 'global';
const personKey = (id) => `p:${Number(id)}`;

/**
 * 写一条（业务键当 _id 的 upsert）
 *
 * ⚠️ 云数据库没有 upsert 语义，`insertWithId` 重复写入会抛错。
 *    先查再插；插入撞车（两个超管同时点）时回落成更新 —— 不吞错，也不重复建文档。
 */
async function upsert(id, patch) {
  const data = { ...patch, updateTime: new Date() };
  const doc = await findById(C.PARTNER_PERMISSION, id);
  if (doc) {
    await updateById(C.PARTNER_PERMISSION, id, data);
    return;
  }
  try {
    await insertWithId(C.PARTNER_PERMISSION, id, data);
  } catch (e) {
    await updateById(C.PARTNER_PERMISSION, id, data);
  }
}

/**
 * body 里的开关值 → { schedule?, review? }
 *
 * 带了非法值就报错，**不悄悄忽略** —— 静默忽略会变成「点了保存但没生效」，
 * 那是最难查的一种「bug」。
 * ⚠️ 按人那层允许 `null`（＝撤销单独设置、跟回全局）；全局那层不允许，由调用方挡。
 */
function pickPatch(body) {
  const patch = {};
  PERM_KEYS.forEach((k) => {
    if (body[k] === undefined) return;
    const v = body[k] === null ? null : triPerm(body[k]);
    if (body[k] !== null && v === null) {
      throw new ApiError(Codes.PARAM_ERROR, `${PERM_TEXT[k].name}的取值只能是 true / false`);
    }
    patch[k] = v;
  });
  if (!Object.keys(patch).length) throw new ApiError(Codes.PARAM_ERROR, '没有要改的权限位');
  return patch;
}

/** 社干名单（只列 role=1 且启用中的人 —— 超管不需要被分配，站员不在这一层） */
async function managers() {
  const rows = await findAllPaged(C.ADMIN, { status: 1 });
  return rows
    .filter((a) => a && Number(a.role) === ROLE_MANAGER && a.id !== undefined && a.id !== null)
    .map((a) => ({
      personId: Number(a.id),
      name: a.nickname || a.username || `账号${a.id}`,
      username: a.username || '',
      department: a.department || '',
      dutyRoles: Array.isArray(a.dutyRoles) ? a.dutyRoles : [],
    }))
    .sort((x, y) => String(x.name).localeCompare(String(y.name), 'zh-Hans-CN'));
}

/** GET /partner/permissions —— 超管看板 */
async function get(ctx) {
  await asSuperPartner(ctx);
  const [global, list, docs] = await Promise.all([
    readGlobalPerm(),
    managers(),
    // 一次把所有人的按人设置读出来：每人一次 findById 太散，百来条整表扫反而更省
    findAllPaged(C.PARTNER_PERMISSION, {}),
  ]);

  const byId = {};
  docs.forEach((d) => {
    if (d && typeof d._id === 'string' && d._id.indexOf('p:') === 0) {
      byId[d._id.slice(2)] = { schedule: triPerm(d.schedule), review: triPerm(d.review) };
    }
  });

  const people = list.map((m) => {
    const over = byId[String(m.personId)] || { schedule: null, review: null };
    const overridden = over.schedule !== null || over.review !== null;
    return { ...m, over, eff: effectivePerm(global, over), overridden };
  });

  const count = {
    managers: people.length,
    scheduleOn: people.filter((x) => x.eff.schedule).length,
    reviewOn: people.filter((x) => x.eff.review).length,
    overridden: people.filter((x) => x.overridden).length,
  };

  return {
    global,
    people,
    count,
    // 前端的标题/说明/拒绝文案都吃这份，改词只改 _kit 的 PERM_TEXT
    meta: PERM_KEYS.map((k) => PERM_TEXT[k]),
  };
}

/** PUT /partner/permissions —— 改全局总闸 */
async function saveGlobal(ctx) {
  const p = await asSuperPartner(ctx);
  const patch = pickPatch(ctx.body || {});
  const bad = PERM_KEYS.filter((k) => patch[k] === null);
  if (bad.length) {
    throw new ApiError(Codes.PARAM_ERROR, `全局的${PERM_TEXT[bad[0]].name}只能开或关，不能「跟随」`);
  }
  await upsert(GLOBAL_ID, { ...patch, by: p.id });
  return { global: await readGlobalPerm(), changed: Object.keys(patch) };
}

/** PUT /partner/permissions/person/:id —— 给某个社干单独设（null = 跟回全局） */
async function savePerson(ctx) {
  const p = await asSuperPartner(ctx);
  const id = Number((ctx.params && ctx.params.id) || 0);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(Codes.PARAM_ERROR, '人员编号不合法');

  // ⚠️ admin 表的 `_id` 不一定是 `String(id)`（早期手工建过几行），按数字 id 查一条再拿 _id
  const target = await findOne(C.ADMIN, { id });
  if (!target) throw new ApiError(Codes.NOT_FOUND, '该成员不存在');
  if (Number(target.role) === ROLE_SUPER) throw new ApiError(Codes.PARAM_ERROR, '超管不需要分配权限');
  if (Number(target.role) !== ROLE_MANAGER) throw new ApiError(Codes.PARAM_ERROR, '只能给社干分发权限');

  const patch = pickPatch(ctx.body || {});
  const next = { ...(await readPersonPerm(id)), ...patch };
  await upsert(personKey(id), { personId: id, ...next, by: p.id });

  const global = await readGlobalPerm();
  const overridden = next.schedule !== null || next.review !== null;
  // 全都「跟回全局」时把这行删掉更干净，但云库删文档要额外一次调用；
  // 保留一行全 null 不影响任何判定（effectivePerm 会回落全局），省一次写。
  return {
    personId: id,
    name: target.nickname || target.username || `账号${id}`,
    over: next,
    eff: effectivePerm(global, next),
    overridden,
  };
}

/**
 * GET /partner/permissions/mine —— 我自己的生效权限
 *
 * 谁都能调（站员也能，返回全 false）。前端进「排班工作台 / 审核」前先问这里，
 * 被拒时弹窗标题用返回的 `text`，不在页面里硬编码 —— 否则改词就要改两处。
 */
async function mine(ctx) {
  const p = await asPartner(ctx);
  const text = { schedule: PERM_TEXT.schedule.deny, review: PERM_TEXT.review.deny };

  // 超管恒 true：他自己就是总闸，不该被自己关的开关锁在门外
  if (p.isSuper) return { isSuper: true, schedule: true, review: true, text };

  // 站员：这两个模块本来就不属于他，权限位一律 false（这是角色，不是开关）
  if (Number(p.role) !== ROLE_MANAGER) return { isSuper: false, schedule: false, review: false, text };

  const [global, over] = await Promise.all([readGlobalPerm(), readPersonPerm(p.id)]);
  return { isSuper: false, ...effectivePerm(global, over), over, text };
}

module.exports = { get, saveGlobal, savePerson, mine };
