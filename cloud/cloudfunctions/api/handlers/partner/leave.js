'use strict';

/**
 * 伙伴端 · 请假（站员申请，社干批）
 *
 *   GET  /partner/leave/mine        我的请假（含待批 / 已批 / 被驳）
 *   GET  /partner/leave/pending     待我批的（社干）
 *   GET  /partner/leave/reviewed    已审批的（社干；请假审批页第二个 tab）
 *   POST /partner/leave             提申请 body: { weekStart, day, slot, reason }
 *   PUT  /partner/leave/:id/review  批 / 驳 body: { approve: bool, reason }
 *   DELETE /partner/leave/:id       撤回（只能撤自己的、且还在待批）
 *
 * ═══════════ 一条请假 = 一个「场次」 ═══════════
 *   `day` + `slot` 指的是值班表上那一格（如「周三 | 午间」）。不按整天请 ——
 *   站员可能只请午间那一场，整天关掉会误伤下午。
 *
 * ═══════════ 批准后谁改班表 ═══════════
 *   ⚠️⚠️ 2026-11-01 陛下定（推翻 10-28 的旧口径）：
 *   「超管批准请假之后，班表那边自动解锁格子把人删掉显示空缺，
 *     然后等待配置成功之后才可重新发布班表，在这期间主页卡片显示班表已撤回，
 *     此时班表为草稿状态，直到配置完成发布新的班表。」
 *
 *   所以批准 = **两件事**：改请假状态 + 让班表退回草稿（见 schedule.releaseCell）。
 *   旧注释写的「只改请假状态，不动班表」是错的 —— 那样批准完班表上还挂着要走的人，
 *   班表页一句「已发布」就把这件事藏住了，只有重新生成才会变，等于没人知道格子空了。
 *
 *   未发布 / 已是草稿的周：releaseCell 不改任何东西（没有正式班次可让），
 *   批准照常生效，之后生成时 `approvedSet` 会把这个人过滤掉。
 */

const { C, findOne, findMany, insertOne, updateWhere, count } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asPartner, asManager, assertWeekStart, currentWeekStart, weekDates, listPeople } = require('./_kit');
const { nextId } = require('../../lib/db');
const { isPublished, publishedRows } = require('./_published');

const STATUS = { PENDING: 0, APPROVED: 1, REJECTED: 2 };
const STATUS_TEXT = { 0: '待批', 1: '已批准', 2: '已驳回' };

function dto(d) {
  if (!d) return null;
  return {
    id: Number(d.id),
    personId: Number(d.personId) || 0,
    personName: d.personName || '',
    weekStart: d.weekStart || '',
    day: d.day || '',
    slot: d.slot || '',
    reason: d.reason || '',
    status: Number(d.status) || 0,
    statusText: STATUS_TEXT[Number(d.status) || 0],
    rejectReason: d.rejectReason || '',
    reviewedByName: d.reviewedByName || '',
    reviewedAt: d.reviewedAt || null,
    createTime: d.createTime || null,
  };
}

async function mine(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const rows = await findMany(C.DUTY_LEAVE, { personId: p.id, weekStart }, {
    orderBy: [['createTime', 'desc']], limit: 50,
  });
  const all = await findMany(C.DUTY_LEAVE, { personId: p.id }, { limit: 200 });
  const monthPrefix = String(weekStart).slice(0, 7);
  const monthUsed = all.filter((x) => Number(x.status) !== STATUS.REJECTED
    && String(x.weekStart || '').slice(0, 7) === monthPrefix).length;
  return {
    weekStart,
    weekDates: weekDates(weekStart),
    list: rows.map(dto),
    monthUsed,                                  // 本月已请（不含被驳）
  };
}

/**
 * 社干待批队列：按周，先请先批
 *
 * ⚠️ 2026-10-31：**列表按周**（不传 week 就是本周，周日 0 点起算下周），
 *    但 `counts` 仍是**全站**的 —— 大白卡角标读的是「还有多少事没处理」，
 *    按周过滤会让周日一过角标突然归零，看着像全批完了。
 * ⚠️ 返回值里带上 `weekStart`：请假页 offset=0 不传 week，靠它标「本周 / 非本周」和日期区间，
 *    前端自己算周一在周日会差一周（后端 10-31 起改了切周口径）。
 */
async function pending(ctx) {
  await asManager(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const where = { status: STATUS.PENDING, weekStart };
  const rows = await findMany(C.DUTY_LEAVE, where, {
    orderBy: [['createTime', 'asc'], ['id', 'asc']], limit: 100,
  });
  const [total, approved, rejected] = await Promise.all([
    count(C.DUTY_LEAVE, { status: STATUS.PENDING }),
    count(C.DUTY_LEAVE, { status: STATUS.APPROVED }),
    count(C.DUTY_LEAVE, { status: STATUS.REJECTED }),
  ]);
  return { weekStart, list: rows.map(dto), total: rows.length, counts: { pending: total, approved, rejected } };
}

/**
 * 已审批队列（请假审批页的第二个 tab，2026-11-01 新增）
 *
 * 「超管我的页面的请假进度名字改为请假审批，进入之后可以看到待审批和已审批两个。」
 *
 * 口径：
 *   · 不分周 —— 「已审批」是处理记录，按处理时间倒序，翻周没有意义
 *     （待审批那档才按周，因为要对着本周班表批）
 *   · 已批准 + 已驳回**都算已审批**，各自带 statusText，页面用标签区颜色
 *   · 带 weekStart / day / slot：页面要显示「周三 午间」和日期
 */
async function reviewed(ctx) {
  await asManager(ctx);
  const [approved, rejected] = await Promise.all([
    findMany(C.DUTY_LEAVE, { status: STATUS.APPROVED }, { orderBy: [['reviewedAt', 'desc'], ['id', 'desc']], limit: 60 }),
    findMany(C.DUTY_LEAVE, { status: STATUS.REJECTED }, { orderBy: [['reviewedAt', 'desc'], ['id', 'desc']], limit: 60 }),
  ]);
  const list = approved.concat(rejected)
    // ⚠️ 「本人撤回」也落在 status=REJECTED，但它没有 reviewedAt（没人审过）⇒ 不进已审批
    .filter((x) => !!x.reviewedAt)
    .sort((a, b) => new Date(b.reviewedAt || b.updateTime || 0) - new Date(a.reviewedAt || a.updateTime || 0))
    .slice(0, 100)
    .map(dto);
  return { list, counts: { approved: list.filter((x) => x.status === STATUS.APPROVED).length, rejected: list.filter((x) => x.status === STATUS.REJECTED).length } };
}

async function create(ctx) {
  const p = await asPartner(ctx);
  const b = ctx.body || {};
  const weekStart = assertWeekStart(b.weekStart);
  const day = String(b.day || '').trim();
  const slot = String(b.slot || '').trim();
  const reason = String(b.reason || '').trim();
  if (!day || !slot) throw new ApiError(Codes.PARAM_ERROR, '请选择要请假的场次');
  if (!reason) throw new ApiError(Codes.PARAM_ERROR, '请写一下请假事由');
  if (reason.length > 200) throw new ApiError(Codes.PARAM_ERROR, '事由最多 200 字');
  const assigned = await publishedRows(weekStart, { day, slot, personId: p.id }, 1);
  if (!assigned.length) {
    throw new ApiError(Codes.CONFLICT, '只能申请已发布班表中本人的班次，班表未发布或已撤回请刷新');
  }

  // 同一格不许重复请（撤回了才能重提）
  const dup = await findMany(C.DUTY_LEAVE, { personId: p.id, weekStart, day, slot }, { limit: 5 });
  if (dup.some((x) => Number(x.status) !== STATUS.REJECTED)) {
    throw new ApiError(Codes.CONFLICT, '这一场已经请过了');
  }

  const now = new Date();
  const doc = {
    id: await nextId(C.DUTY_LEAVE),
    personId: p.id,
    personName: (p.admin && (p.admin.nickname || p.admin.username)) || '',
    weekStart, day, slot, reason,
    status: STATUS.PENDING,
    rejectReason: '',
    reviewedBy: null,
    reviewedByName: '',
    reviewedAt: null,
    createTime: now,
    updateTime: now,
  };
  await insertOne(C.DUTY_LEAVE, doc);
  return dto(doc);
}

async function review(ctx) {
  const p = await asManager(ctx);
  const id = Number(ctx.params && ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(Codes.PARAM_ERROR, 'id 不合法');
  const b = ctx.body || {};
  const approve = b.approve === true || b.approve === 'true' || b.approve === 1;
  const reason = String(b.reason || '').trim();
  if (!approve && !reason) throw new ApiError(Codes.PARAM_ERROR, '驳回要写理由');

  const initial = await findOne(C.DUTY_LEAVE, { id });
  if (!initial) throw new ApiError(Codes.NOT_FOUND, '这条请假不在了');
  // 与班表发布共用数据库周锁，避免“发布已校验、请假随后获批、仍发出旧安排”。
  // 在运行时 require，避免 schedule 的 approvedSet 依赖形成初始化循环。
  return require('./schedule').withWeekLock(initial.weekStart, async () => {
    const doc = await findOne(C.DUTY_LEAVE, { id });
    if (!doc) throw new ApiError(Codes.NOT_FOUND, '这条请假不在了');
    if (Number(doc.status) !== STATUS.PENDING) {
      throw new ApiError(Codes.CONFLICT, '这条已经被处理过了');
    }
    if (approve) {
      const assigned = await publishedRows(doc.weekStart, {
        day: doc.day, slot: doc.slot, personId: Number(doc.personId),
      }, 1);
      if (!assigned.length) {
        throw new ApiError(Codes.CONFLICT, '班表未发布、已撤回或该人员已不在正式班次中，请刷新后处理');
      }
    }
    const now = new Date();
    const patch = {
      status: approve ? STATUS.APPROVED : STATUS.REJECTED,
      rejectReason: approve ? '' : reason,
      reviewedBy: p.id,
      reviewedByName: (p.admin && (p.admin.nickname || p.admin.username)) || '',
      reviewedAt: now,
      updateTime: now,
    };
    const affected = await updateWhere(C.DUTY_LEAVE, { id, status: STATUS.PENDING }, patch);
    if (!affected) throw new ApiError(Codes.CONFLICT, '这条刚被别人处理过');
    /**
     * 批准 ⇒ 这一格让开（见文件头「批准后谁改班表」）。
     * 已经在 withWeekLock 里，releaseCell 直接用这把锁，不再抢。
     * 驳回 / 本周没发布 ⇒ changed=false，班表一个字段都不动。
     */
    let released = false;
    if (approve) {
      const r = await require('./schedule').releaseCell(
        doc.weekStart, doc.day, doc.slot, doc.personId, p,
        `批准 ${doc.personName || ''} ${doc.day} ${doc.slot} 请假`
      );
      released = !!r.changed;
    }
    return Object.assign(dto(Object.assign({}, doc, patch)), { scheduleWithdrawn: released });
  });
}

async function remove(ctx) {
  const p = await asPartner(ctx);
  const id = Number(ctx.params && ctx.params.id);
  const doc = id ? await findOne(C.DUTY_LEAVE, { id }) : null;
  if (!doc) throw new ApiError(Codes.NOT_FOUND, '这条请假不在了');
  if (Number(doc.personId) !== p.id) throw new ApiError(Codes.FORBIDDEN, '只能撤回自己的请假');
  if (Number(doc.status) !== STATUS.PENDING) {
    throw new ApiError(Codes.CONFLICT, '已经批过的不在撤回范围，找社干改');
  }
  await updateWhere(C.DUTY_LEAVE, { id }, { status: STATUS.REJECTED, rejectReason: '本人撤回', updateTime: new Date() });
  return { id, status: STATUS.REJECTED };
}

/** 给班表生成用：某周已批准的请假集合（key = day|slot|personId） */
async function approvedSet(weekStart) {
  const rows = await findMany(C.DUTY_LEAVE, { weekStart, status: STATUS.APPROVED }, { limit: 200 });
  const set = {};
  rows.forEach((r) => { set[`${r.day}|${r.slot}|${Number(r.personId)}`] = true; });
  return set;
}

/**
 * GET /partner/leave/:id/impact —— 批假之前先看一眼「这一格让开后班表会空成什么样」
 *
 * 只做**只读推演**，一行 assignment 都不动。真批准走 review。
 *
 * 返回三件事：
 *   willEmpty   —— 批准后班表上会空出来的那一格（该周没排这个人就是 null）
 *   slot        —— 这一格「应到几人 / 现在几人」（来自已发布的时段模板）
 *   candidates  —— 能补上来的人 + 不能补的原因（没填可排 / 已请假 / 到上限）
 *
 * ⚠️ 候选人的上限判断用的是**当前**已排数：一个人本周已排 3 场、周上限 3，
 *    批准别人后他自己不会变少，所以他确实补不进来。这是真实约束，不是显示 bug。
 */
async function impact(ctx) {
  await asManager(ctx);
  const id = Number(ctx.params && ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(Codes.PARAM_ERROR, 'id 不合法');
  const doc = await findOne(C.DUTY_LEAVE, { id });
  if (!doc) throw new ApiError(Codes.NOT_FOUND, '这条请假不在了');

  const weekStart = String(doc.weekStart || '');
  const day = String(doc.day || '');
  const slotName = String(doc.slot || '');
  const dates = weekDates(weekStart);
  const dayIdx = dates.indexOf(day);

  // 这一格在班表上有没有这个人
  const published = await isPublished(weekStart);
  const onDutyRows = await publishedRows(weekStart, { day, slot: slotName, personId: Number(doc.personId) }, 1);
  const onDuty = onDutyRows[0] || null;

  // 应到几人（来自已发布时段模板）
  const { findPublished } = require('./slots');
  const { templatesToSlots } = require('./_kit');
  const pub = await findPublished();
  const slots = templatesToSlots((pub && pub.templates) || []);
  const slotDef = slots.find((s) => s.title === slotName && (dayIdx < 0 || Number(s.day) === dayIdx))
    || slots.find((s) => s.title === slotName)
    || null;

  // 现在这一格排了几人
  const sameSlot = await publishedRows(weekStart, { day, slot: slotName }, 100);
  const filled = sameSlot.filter((a) => !onDuty || Number(a.personId) !== Number(doc.personId)).length;

  // ── 候选人 ──
  const { effectiveLimits } = require('./rule');
  const [{ dayMax, weekMax }, weekRows, availRows, people] = await Promise.all([
    effectiveLimits(),
    publishedRows(weekStart),
    findMany(C.DUTY_AVAILABILITY, { weekStart }, { limit: 200 }),
    listPeople(),
  ]);
  const leaveSet = await approvedSet(weekStart);

  const weekCount = {};
  const dayCount = {};
  weekRows.forEach((a) => {
    const pid = Number(a.personId) || 0;
    weekCount[pid] = (weekCount[pid] || 0) + 1;
    if (!dayCount[pid]) dayCount[pid] = {};
    dayCount[pid][a.day] = (dayCount[pid][a.day] || 0) + 1;
  });

  const canMap = {};
  availRows.forEach((r) => {
    const set = {};
    (Array.isArray(r.picks) ? r.picks : []).forEach((x) => { if (x && x.can) set[x.slotKey] = true; });
    canMap[Number(r.personId)] = set;
  });

  const candidates = (published && onDuty ? people : [])
    .filter((x) => Number(x.personId) !== Number(doc.personId))
    .map((x) => {
      const pid = Number(x.personId);
      let blocked = '';
      if (!canMap[pid] || (slotDef && !canMap[pid][slotDef.slotKey])) blocked = '没填「能来」';
      else if (leaveSet[`${day}|${slotName}|${pid}`]) blocked = '这一场已请假';
      else if ((weekCount[pid] || 0) >= weekMax) blocked = `本周已满 ${weekMax} 场`;
      else if (((dayCount[pid] || {})[day] || 0) >= dayMax) blocked = `当天已满 ${dayMax} 场`;
      else if (sameSlot.some((a) => Number(a.personId) === pid)) blocked = '这一场已经是他';
      return {
        personId: pid,
        name: x.name || '',
        department: x.department || '',
        weekShifts: weekCount[pid] || 0,
        dayShifts: (dayCount[pid] || {})[day] || 0,
        ok: !blocked,
        blocked,
      };
    })
    .sort((a, b) => (Number(b.ok) - Number(a.ok))
      || (a.weekShifts - b.weekShifts)
      || String(a.name).localeCompare(String(b.name), 'zh'));

  return {
    leave: dto(doc),
    willEmpty: onDuty
      ? { day, dayName: dayIdx >= 0 ? ['周一', '周二', '周三', '周四', '周五'][dayIdx] : '', slot: slotName, personName: onDuty.personName || '' }
      : null,
    slot: {
      name: slotName,
      need: !published ? 0 : (slotDef ? Math.max(1, Number(slotDef.count) || 1) : Math.max(1, sameSlot.length)),
      timeText: slotDef ? (slotDef.timeText || '') : '',
      filled,
      afterFilled: filled,
    },
    limits: { dayMax, weekMax },
    candidates,
    candidateCount: candidates.filter((c) => c.ok).length,
  };
}

module.exports = { mine, pending, reviewed, create, review, remove, approvedSet, impact, STATUS };
