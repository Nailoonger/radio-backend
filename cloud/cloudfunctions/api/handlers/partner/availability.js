'use strict';

/**
 * 伙伴端 · 可排时间（站员填报 + 社干代录 + 汇总）
 *
 *   GET    /partner/availability?week=&personId=   读（自己 / 某个成员）+ 全站汇总
 *   PUT    /partner/availability                   写（自己填 / 代录，代录必须留原因）
 *   DELETE /partner/availability?week=&personId=   撤销（只能撤自己的，代录的由代录人撤）
 *
 * ═══════════ 为什么「代录」是一个参数而不是一个接口 ═══════════
 * 代录和自填写入的是**同一份数据、同一套校验**，唯一差别是 source 与 reason。
 * 拆成两个接口会立刻分叉：某天改了校验规则只改了一边，另一边就漏。
 * 这里用 `personId` 是否等于自己来区分，两条路径共用同一段校验代码。
 *
 * ═══════════ slotKey 的语义 ═══════════
 * `<day>-<seq>`，day=0~4（周一~周五），seq 是该天时段按开始时间排序后的序号（从 1 起）。
 * 例：周三第 2 个时段 → `2-2`。
 *
 * ⚠️ seq **只对「某个时段版本」有意义**。超管重新发布时段后，
 *    seq 可能指向不同的时段。所以：
 *    - 存 picks 时同时记下 `slotVersion`（当时依据的时段版本号）
 *    - 读的时候若 `slotVersion` 与当前生效版本不一致，标 `stale: true` 让前端提示重填
 *    这是刻意保留的脏数据可见性 —— 静默丢弃站员填过的东西更糟。
 */

const { C, findById, findMany, insertOne, updateById, removeWhere } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const {
  asPartner, assertWeekStart, currentWeekStart, weekDates,
  templatesToSlots, listPeople,
} = require('./_kit');
const { findPublished } = require('./slots');

const DOC_PREFIX = 'avail';

const docIdOf = (weekStart, personId) => `${DOC_PREFIX}:${weekStart}:${personId}`;

/** 该周生效的时段选项（未发布 → 空数组） */
async function currentSlots() {
  const pub = await findPublished();
  if (!pub) return { version: 0, slots: [], published: null };
  return {
    version: Number(pub.version) || 0,
    slots: templatesToSlots(pub.templates || []),
    published: pub,
  };
}

/**
 * 校验 picks
 * @param {Array} raw      [{ slotKey, can }]
 * @param {Array} validSlots 当前生效的时段选项
 */
function normalizePicks(raw, validSlots) {
  if (!Array.isArray(raw)) throw new ApiError(Codes.PARAM_ERROR, 'picks 必须是数组');
  const byKey = {};
  validSlots.forEach((s) => { byKey[s.slotKey] = s; });

  const seen = {};
  const out = [];
  raw.forEach((p, i) => {
    const slotKey = String((p && p.slotKey) || '').trim();
    if (!slotKey) throw new ApiError(Codes.PARAM_ERROR, `第 ${i + 1} 项缺少 slotKey`);
    if (!byKey[slotKey]) {
      throw new ApiError(Codes.PARAM_ERROR, `时段「${slotKey}」不存在，可能值班时段刚被重新发布，请刷新`);
    }
    if (seen[slotKey]) throw new ApiError(Codes.PARAM_ERROR, `时段「${slotKey}」重复提交`);
    seen[slotKey] = 1;
    out.push({ slotKey, can: !!p.can });
  });

  // 按 slotKey 的天/序号排序，保证存进去的顺序稳定（便于 diff 与人工排查）
  out.sort((a, b) => {
    const [ad, as] = a.slotKey.split('-').map(Number);
    const [bd, bs] = b.slotKey.split('-').map(Number);
    return (ad - bd) || (as - bs);
  });
  return out;
}

/** 一条可排时间记录 → 对外形状 */
function availabilityDto(doc, slots, currentVersion) {
  if (!doc) return null;
  const picks = Array.isArray(doc.picks) ? doc.picks : [];
  const canList = picks.filter((p) => p.can).map((p) => p.slotKey);
  const stale = Number(doc.slotVersion) !== Number(currentVersion);

  // 把 picks 补上时段信息，前端直接渲染「周三 12:00-12:30 能来」
  const slotMap = {};
  (slots || []).forEach((s) => { slotMap[s.slotKey] = s; });

  return {
    personId: Number(doc.personId),
    weekStart: doc.weekStart,
    picks: picks.map((p) => ({
      slotKey: p.slotKey,
      can: !!p.can,
      slot: slotMap[p.slotKey] || null,
    })),
    canCount: canList.length,
    totalCount: (slots || []).length,
    reason: doc.reason || '',
    source: doc.source || 'self',
    slotVersion: Number(doc.slotVersion) || 0,
    stale,
    confirmedAt: doc.confirmedAt || null,
    confirmedBy: doc.confirmedBy || null,
    confirmedByName: doc.confirmedByName || '',
  };
}

/**
 * GET /partner/availability?week=&personId=
 *
 * 一次给全：时段选项 + 人员池 + 我的填报 + 指定成员的填报 + 全站汇总。
 * 为什么合成一个接口：可排时间页打开就要这三块，分三次请求会让「已确认 10/13」
 * 这个数字和下面的名单出现先后不一致的闪烁。
 */
async function get(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const dates = weekDates(weekStart);

  const { version, slots } = await currentSlots();

  // 目标成员：不传就是自己；传别人 = 代录查看
  let targetId = p.id;
  if (q.personId !== undefined && q.personId !== '' && Number(q.personId) !== p.id) {
    targetId = Number(q.personId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new ApiError(Codes.PARAM_ERROR, 'personId 不合法');
    }
  }

  const [mineDoc, targetDoc, people, weekDocs] = await Promise.all([
    findById(C.DUTY_AVAILABILITY, docIdOf(weekStart, p.id)),
    targetId === p.id ? null : findById(C.DUTY_AVAILABILITY, docIdOf(weekStart, targetId)),
    listPeople(),
    findMany(C.DUTY_AVAILABILITY, { weekStart }, { limit: 100 }),
  ]);

  const doneMap = {};
  weekDocs.forEach((d) => { doneMap[Number(d.personId)] = d; });

  const rows = people.map((x) => {
    const d = doneMap[x.personId];
    return {
      personId: x.personId,
      name: x.name,
      department: x.department,
      dutyRoles: x.dutyRoles,
      isSuper: x.isSuper,
      confirmed: !!d,
      canCount: d ? (Array.isArray(d.picks) ? d.picks.filter((i) => i.can).length : 0) : 0,
      source: d ? (d.source || 'self') : '',
      confirmedAt: d ? (d.confirmedAt || null) : null,
      stale: d ? Number(d.slotVersion) !== version : false,
    };
  });

  const confirmed = rows.filter((r) => r.confirmed && !r.stale).length;

  return {
    weekStart,
    weekDates: dates,
    slotVersion: version,
    slots,
    ready: slots.length > 0,
    people,
    me: availabilityDto(mineDoc, slots, version),
    target: targetId === p.id ? null : availabilityDto(targetDoc, slots, version),
    targetId,
    summary: {
      total: rows.length,
      confirmed,
      pending: rows.length - confirmed,
      rows,
    },
    abilities: { canProxy: true },
  };
}

/**
 * PUT /partner/availability   body: { week, personId?, picks, reason }
 *
 * 自填与代录共用这一条路径：
 *   personId 缺省或 == 自己 → source='self'，reason 可空
 *   personId != 自己        → source='proxy'，reason **必填**（至少 2 字）
 *
 * ⚠️ 代录必须留原因（拆解文档 §6「代录与本人」）：
 *    否则事后完全无法区分「本人填的」和「社干替他填的」，
 *    出现「我明明说那天来不了」的争议时没有任何依据。
 */
async function save(ctx) {
  const p = await asPartner(ctx);
  const body = ctx.body || {};
  const weekStart = assertWeekStart(body.week || currentWeekStart());

  const rawTarget = body.personId === undefined || body.personId === null || body.personId === ''
    ? p.id
    : Number(body.personId);
  if (!Number.isInteger(rawTarget) || rawTarget <= 0) {
    throw new ApiError(Codes.PARAM_ERROR, 'personId 不合法');
  }

  const isProxy = rawTarget !== p.id;
  const reason = String(body.reason || '').trim();
  if (isProxy) {
    if (reason.length < 2) throw new ApiError(Codes.PARAM_ERROR, '代录必须填写原因（至少 2 个字）');
    if (reason.length > 200) throw new ApiError(Codes.PARAM_ERROR, '原因过长（上限 200 字）');
  }

  const { version, slots } = await currentSlots();
  if (!slots.length) {
    throw new ApiError(Codes.PARAM_ERROR, '本周的值班时段尚未发布，暂时不能填报');
  }

  const picks = normalizePicks(body.picks, slots);

  /**
   * 「有不能来的时段必须说明」—— 产品规则，放后端而不是只在前端拦。
   *
   * 理由：社干排班时要靠这条说明判断「这个人这周是真的有事，还是随手点错了」。
   * 只在 WXML 里做 required，绕过前端（或将来接网页版）就能写进空说明，
   * 而这类数据缺失**事后无法补救**（当事人早忘了那天为什么不行）。
   */
  if (!isProxy && picks.some((x) => !x.can)) {
    if (reason.length < 2) throw new ApiError(Codes.PARAM_ERROR, '有不能来的时段，请填写说明（至少 2 个字）');
    if (reason.length > 200) throw new ApiError(Codes.PARAM_ERROR, '说明过长（上限 200 字）');
  }
  const now = new Date();
  const _id = docIdOf(weekStart, rawTarget);

  const doc = {
    weekStart,
    personId: rawTarget,
    picks,
    // reason 一个字段两种含义，靠 source 区分：
    //   source='proxy' → 代录原因（谁授权、为什么替他填）
    //   source='self'  → 填报说明（有「不能来」时必填）
    reason,
    source: isProxy ? 'proxy' : 'self',
    slotVersion: version,
    confirmedAt: now,
    confirmedBy: p.id,
    confirmedByName: p.admin.nickname || p.admin.username || '',
    updateTime: now,
  };

  const existing = await findById(C.DUTY_AVAILABILITY, _id);
  if (existing) {
    await updateById(C.DUTY_AVAILABILITY, _id, doc);
  } else {
    try {
      await insertOne(C.DUTY_AVAILABILITY, Object.assign({ _id }, doc, { createTime: now }));
    } catch (e) {
      // 并发下两个请求同时插入：后到的那个转成更新（_id 撞车 → add 失败）
      await updateById(C.DUTY_AVAILABILITY, _id, doc);
    }
  }

  // 代录留痕（自填不记日志：量太大且无争议价值）
  if (isProxy) {
    await insertOne(C.DUTY_LOG, {
      weekStart,
      action: 'availability.proxy',
      actor: p.id,
      actorName: p.admin.nickname || p.admin.username || '',
      target: rawTarget,
      reason,
      before: existing ? (existing.picks || []) : null,
      after: picks,
      at: now,
    });
  }

  const saved = await findById(C.DUTY_AVAILABILITY, _id);
  return {
    weekStart,
    personId: rawTarget,
    isProxy,
    availability: availabilityDto(saved, slots, version),
  };
}

/**
 * DELETE /partner/availability?week=&personId=
 *
 * 撤销填报（填错了重来）。
 * ⚠️ 只允许撤**自己的**或**自己代录的**：不能撤别人的自填，
 *    否则社干一句「清空」就把站员填的东西删了，且没有痕迹。
 */
async function reset(ctx) {
  const p = await asPartner(ctx);
  /**
   * ⚠️⚠️ DELETE 的参数**不在 ctx.query 里**。
   *
   * index.js 只对 GET 做「body → query」收敛（见 `isGet ? (body||{}) : {}`），
   * 而小程序 cloud 模式下 `adminRequest('/partner/availability','DELETE',{week})`
   * 的参数是放在 body 里的。只读 ctx.query 会拿到空对象，
   * 于是「撤销指定周」会静默变成「撤销本周」—— 不报错，删错数据。
   *
   * 这里两个来源都读，是这一层最省事也最稳的写法：
   * 无论前端把参数拼在 URL 上（direct 模式）还是放 body（cloud 模式）都能工作。
   */
  const q = Object.assign({}, ctx.query || {}, ctx.body || {});
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const target = q.personId === undefined || q.personId === '' ? p.id : Number(q.personId);
  if (!Number.isInteger(target) || target <= 0) {
    throw new ApiError(Codes.PARAM_ERROR, 'personId 不合法');
  }

  const _id = docIdOf(weekStart, target);
  const doc = await findById(C.DUTY_AVAILABILITY, _id);
  if (!doc) return { removed: 0 };

  if (target !== p.id && Number(doc.confirmedBy) !== p.id) {
    throw new ApiError(Codes.FORBIDDEN, '只能撤销自己填写或自己代录的记录');
  }

  const n = await removeWhere(C.DUTY_AVAILABILITY, { _id });
  return { removed: n };
}

module.exports = { get, save, reset, currentSlots };
