'use strict';

/** v151 原生班表：草稿独立存储，正式人员只在发布时写 duty_assignments。
 * 所有写操作按周抢占数据库租约，并校验客户端 revision；不能用 force 绕过正式版。
 * 时段版本随周冻结，slotKey 区分并行部门/岗位；手动固定与自动排班共用硬条件。
 */
const crypto = require('crypto');
const { C, findOne, findMany, findAllPaged, insertOne, insertWithId, updateWhere, removeWhere, nextId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const bj = require('../../lib/bjTime');
const { asPartner, asManager, asSuperPartner, assertWeekStart, currentWeekStart, weekDates, templatesToSlots, listPeople } = require('./_kit');
const { effectiveLimits } = require('./rule');
const { approvedSet } = require('./leave');
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const ACTIONS = { generate: '生成草稿', cell: '调整人选', fixed: '调整固定状态', clear: '清空草稿', publish: '发布班表', withdraw: '撤回发布' };
const actorName = (p) => (p.admin && (p.admin.nickname || p.admin.username)) || '';
const revisionOf = (doc) => Number(doc && doc.revision) || 0;
const plain = (v) => JSON.parse(JSON.stringify(v));

async function publishedTemplates() {
  const list = await findMany(C.DUTY_SLOT_VERSION, { state: 'published' }, { orderBy: [['version', 'desc']], limit: 1 });
  const v = list[0];
  return { version: v ? Number(v.version) || 0 : 0, templates: v && Array.isArray(v.templates) ? v.templates : [] };
}

async function loadWeek(weekStart) {
  const [doc, published, formal] = await Promise.all([
    findOne(C.DUTY_WEEK, { _id: weekStart }), publishedTemplates(),
    findAllPaged(C.DUTY_ASSIGNMENT, { weekStart }),
  ]);
  const templates = doc && Array.isArray(doc.templates) ? doc.templates : published.templates;
  const slotVersion = doc && Array.isArray(doc.templates) ? Number(doc.slotVersion) || 0 : published.version;
  const rows = doc && doc.state !== 'published' && Array.isArray(doc.draftRows)
    ? doc.draftRows : formal;
  return { weekStart, doc, templates, slotVersion, slots: templatesToSlots(templates), rows, formal };
}

function slotForRow(row, slots, dates) {
  if (row.slotKey) return slots.find((s) => s.slotKey === row.slotKey && dates[s.day] === row.day) || null;
  const matches = slots.filter((s) => dates[s.day] === row.day && s.title === row.slot
    && (!row.department || s.dept === row.department));
  return matches.length === 1 ? matches[0] : null;
}

function isFixed(row) { return row.fixed === true || (row.fixed === undefined && row.source === 'manual'); }

function publicWeek(w, p) {
  const { doc, slots, weekStart } = w;
  const dates = weekDates(weekStart);
  const visible = !p.isMember || !!(doc && doc.state === 'published');
  const rows = visible ? w.rows : [];
  const summary = { needed: 0, filled: 0, missing: 0, fixed: 0 };
  const days = dates.map((day, i) => {
    const groups = [];
    slots.filter((s) => s.day === i).forEach((s) => {
      const people = rows.filter((r) => {
        const def = slotForRow(r, slots, dates);
        return def && def.slotKey === s.slotKey;
      }).map((r) => ({
        slot: s.title, slotKey: s.slotKey, timeText: s.timeText,
        personId: Number(r.personId), personName: r.personName || '',
        department: s.dept || '', role: s.role || '', source: r.source || 'auto',
        fixed: !p.isMember && isFixed(r),
      }));
      const g = { slotKey: s.slotKey, department: s.dept || '', role: s.role || '', count: Number(s.count) || 1, people };
      summary.needed += g.count;
      summary.filled += people.length;
      summary.missing += Math.max(0, g.count - people.length);
      summary.fixed += people.filter((r) => r.fixed).length;
      let bucket = groups.find((x) => x.slot === s.title && x.timeText === s.timeText);
      if (!bucket) { bucket = { slot: s.title, timeText: s.timeText, start: s.start, end: s.end, groups: [], people: [] }; groups.push(bucket); }
      bucket.groups.push(g); bucket.people.push(...people);
    });
    return { day, dayName: DAY_NAMES[i], slots: groups, total: groups.reduce((n, s) => n + s.people.length, 0) };
  });
  return {
    weekStart, state: doc ? doc.state || 'draft' : 'empty',
    version: Number(doc && doc.version) || 0, revision: revisionOf(doc), slotVersion: w.slotVersion,
    publishedAt: doc && doc.state === 'published' ? doc.publishedAt || null : null,
    publishedByName: doc && doc.publishedByName || '', withdrawnAt: doc && doc.withdrawnAt || null,
    slotOrder: Array.from(new Set(slots.map((s) => s.title))), days,
    total: rows.length, summary, canManage: !p.isMember, canWithdraw: p.isSuper && !!(doc && doc.state === 'published'),
  };
}

async function get(ctx) {
  const p = await asPartner(ctx);
  const weekStart = ctx.query && ctx.query.week ? assertWeekStart(ctx.query.week) : currentWeekStart();
  return publicWeek(await loadWeek(weekStart), p);
}

async function mine(ctx) {
  const p = await asPartner(ctx);
  const weekStart = ctx.query && ctx.query.week ? assertWeekStart(ctx.query.week) : currentWeekStart();
  const w = await loadWeek(weekStart);
  const dates = weekDates(weekStart);
  const list = w.doc && w.doc.state === 'published' ? w.rows.filter((a) => Number(a.personId) === p.id).map((a) => ({
    day: a.day, dayName: DAY_NAMES[dates.indexOf(a.day)] || '', slot: a.slot || '', slotKey: a.slotKey || '',
    timeText: a.timeText || '', department: a.department || '',
  })).sort((a, b) => a.day.localeCompare(b.day) || a.timeText.localeCompare(b.timeText)) : [];
  return { weekStart, list, count: list.length };
}

async function contextFor(w) {
  const [limits, leaveSet, avail, people] = await Promise.all([
    effectiveLimits(), approvedSet(w.weekStart), findAllPaged(C.DUTY_AVAILABILITY, { weekStart: w.weekStart }), listPeople(),
  ]);
  const byId = {}; const canMap = {};
  people.forEach((x) => { byId[x.personId] = x; });
  avail.forEach((a) => { if (Number(a.slotVersion) === w.slotVersion && a.confirmedAt) canMap[Number(a.personId)] = new Set((a.picks || []).filter((x) => x.can === true).map((x) => x.slotKey)); });
  return { ...limits, leaveSet, people, byId, canMap, dates: weekDates(w.weekStart), slots: w.slots };
}

function reasonsFor(person, def, rows, c) {
  const reasons = [];
  if (!person) return ['账号已停用或不在人员池'];
  const id = Number(person.personId); const day = c.dates[def.day];
  /**
   * ⚠️ 部门与岗位要**分开报**（2026-10-30 陛下被合并提示坑过）：
   *    原来一句「尚未配置部门与岗位资格」把两件事糊在一起 ——
   *    他只配了岗位、没配部门，看到这句完全不知道该去补哪一样。
   *    现在分开说，并且「不匹配」时把双方的值打出来，一眼能看出差在哪。
   */
  if (!person.department) reasons.push('尚未配置部门');
  if (!person.dutyRoles.length) reasons.push('尚未配置值班岗位');
  if (def.dept && person.department !== def.dept) {
    reasons.push(`部门不匹配（当前：${person.department || '未配置'}，这个时段要：${def.dept}）`);
  }
  if (def.role && person.dutyRoles.length && !person.dutyRoles.includes(def.role)) {
    reasons.push(`岗位资格不匹配（当前：${person.dutyRoles.join('/')}，这个时段要：${def.role}）`);
  }
  if (!c.canMap[id] || !c.canMap[id].has(def.slotKey)) reasons.push('未确认该时段可排时间或填报已过期');
  if (c.leaveSet[`${day}|${def.title}|${id}`]) reasons.push('该场次已批准请假');
  const own = rows.filter((r) => Number(r.personId) === id);
  if (own.length >= c.weekMax) reasons.push(`已达每周 ${c.weekMax} 场上限`);
  if (own.filter((r) => r.day === day).length >= c.dayMax) reasons.push(`已达每天 ${c.dayMax} 场上限`);
  if (own.some((r) => {
    const s = slotForRow(r, c.slots, c.dates);
    return r.day === day && s && s.start < def.end && def.start < s.end;
  })) reasons.push('同一时段已有值班安排');
  return reasons;
}

function validate(w, c) {
  const issues = []; const missing = [];
  const summary = { needed: w.slots.reduce((n, s) => n + Number(s.count), 0), filled: w.rows.length, missing: 0, fixed: w.rows.filter(isFixed).length };
  w.rows.forEach((r, i) => {
    const def = slotForRow(r, w.slots, c.dates);
    const reasons = def ? reasonsFor(c.byId[Number(r.personId)], def, w.rows.filter((_, n) => n !== i), c) : ['原时段不存在或旧数据无法定位岗位'];
    reasons.forEach((message) => issues.push({ code: 'HARD_CONSTRAINT', message, day: r.day || '', slot: r.slot || '', slotKey: r.slotKey || '', personId: Number(r.personId) || 0 }));
  });
  w.slots.forEach((def) => {
    const day = c.dates[def.day];
    const got = w.rows.filter((r) => { const s = slotForRow(r, w.slots, c.dates); return s && s.slotKey === def.slotKey; }).length;
    const need = Number(def.count);
    if (got < need) { const item = { day, slot: def.title, slotKey: def.slotKey, department: def.dept || '', role: def.role || '', need, got };
      const counts = {};
      c.people.forEach((person) => reasonsFor(person, def, w.rows, c).forEach((reason) => { counts[reason] = (counts[reason] || 0) + 1; }));
      item.reasons = Object.keys(counts).map((reason) => ({ reason, count: counts[reason] }));
      missing.push(item); summary.missing += need - got;
      issues.push({ code: 'MISSING', message: `${DAY_NAMES[def.day]}${def.title}${def.dept || ''}缺 ${need - got} 人`, ...item });
    }
    if (got > need) issues.push({ code: 'CAPACITY', message: `${DAY_NAMES[def.day]}${def.title}${def.dept || ''}超出所需人数`, day, slot: def.title, slotKey: def.slotKey, personId: 0 });
  });
  if (!w.slots.length) issues.push({ code: 'NO_SLOTS', message: '尚未发布值班时段', day: '', slot: '', slotKey: '', personId: 0 });
  return { valid: issues.length === 0, issues, missing, summary };
}

function failCheck(report, message) { throw new ApiError(Codes.CONFLICT, message, 200, report); }

async function check(ctx) {
  await asManager(ctx);
  const q = ctx.query || {}; const w = await loadWeek(q.week ? assertWeekStart(q.week) : currentWeekStart());
  return { weekStart: w.weekStart, revision: revisionOf(w.doc), ...validate(w, await contextFor(w)) };
}

function requestedSlot(w, b) {
  const day = String(b.day || '').trim();
  const matches = w.slots.filter((s) => weekDates(w.weekStart)[s.day] === day
    && (b.slotKey ? s.slotKey === String(b.slotKey) : s.title === String(b.slot || '')));
  if (matches.length !== 1) throw new ApiError(Codes.PARAM_ERROR, '请选择具体的日期、部门与岗位时段');
  return matches[0];
}

async function candidates(ctx) {
  await asManager(ctx);
  const q = ctx.query || {}; const w = await loadWeek(q.week ? assertWeekStart(q.week) : currentWeekStart());
  const def = requestedSlot(w, q); const c = await contextFor(w);
  const chosen = w.rows.filter((r) => { const s = slotForRow(r, w.slots, c.dates); return s && s.slotKey === def.slotKey; });
  const others = w.rows.filter((r) => !chosen.includes(r));
  const list = c.people.map((p) => { const selected = chosen.find((r) => Number(r.personId) === p.personId); const reasons = reasonsFor(p, def, others, c);
    return { personId: p.personId, name: p.name, department: p.department, eligible: !reasons.length, reasons, selected: !!selected, fixed: !!selected && isFixed(selected), count: others.filter((r) => Number(r.personId) === p.personId).length };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.count - b.count || a.personId - b.personId);
  return { weekStart: w.weekStart, revision: revisionOf(w.doc), slotKey: def.slotKey, count: def.count, list };
}

/** 数据库租约而非进程内锁，多个云函数实例也不能交错改同一周。 */
async function withWeekLock(weekStart, fn) {
  const _id = `duty-week:${weekStart}`; const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 300000;
  try { await insertWithId(C.UNIQUE_KEYS, _id, { scope: 'duty-week', token, expiresAt }); }
  catch (e) {
    const old = await findOne(C.UNIQUE_KEYS, { _id });
    if (!old) throw e;
    if (Number(old.expiresAt) >= Date.now() || !(await updateWhere(C.UNIQUE_KEYS, { _id, token: old.token }, { token, expiresAt }))) {
      throw new ApiError(Codes.CONFLICT, '这一周正在保存，请稍后刷新重试');
    }
  }
  try { return await fn(); } finally { await removeWhere(C.UNIQUE_KEYS, { _id, token }); }
}

function assertRevision(w, b) {
  const raw = b.revision === undefined ? b.expectedRevision : b.revision;
  if (!Number.isInteger(raw) || raw < 0) throw new ApiError(Codes.PARAM_ERROR, '请刷新班表后再操作（缺少 revision）');
  if (raw !== revisionOf(w.doc)) throw new ApiError(Codes.CONFLICT, '班表已被其他人更新，请刷新后再操作');
}
function assertEditable(w) {
  if (w.doc && w.doc.state === 'published') throw new ApiError(Codes.CONFLICT, '这一周已经发布，须由超管先撤回再修改');
}

async function writeWeek(w, p, patch) {
  const now = new Date();
  const data = { ...patch, revision: revisionOf(w.doc) + 1, updateTime: now, updatedBy: p.id, updatedByName: actorName(p) };
  if (w.doc) await updateWhere(C.DUTY_WEEK, { _id: w.weekStart }, data);
  else await insertWithId(C.DUTY_WEEK, w.weekStart, { weekStart: w.weekStart, version: 0, publishedAt: null, publishedBy: null, publishedByName: '', createTime: now, ...data });
}
async function log(w, p, action, reason, version) {
  const report = validate(w, await contextFor(w));
  await insertOne(C.DUTY_LOG, {
    id: await nextId(C.DUTY_LOG), weekStart: w.weekStart, action, actionText: ACTIONS[action] || action,
    operatorId: p.id, operatorName: actorName(p), reason: reason || '', version: Number(version) || 0,
    summary: report.summary, createTime: new Date(),
    snapshot: { weekStart: w.weekStart, slotVersion: w.slotVersion, templates: w.templates, assignments: plain(w.rows) },
  });
}
async function mutation(ctx, fn, superOnly = false) {
  const p = superOnly ? await asSuperPartner(ctx) : await asManager(ctx);
  const b = ctx.body || {}; const weekStart = assertWeekStart(b.weekStart);
  return withWeekLock(weekStart, async () => { const w = await loadWeek(weekStart); assertRevision(w, b); return fn(w, p, b); });
}
function draftPatch(w, rows) { return { state: 'draft', templates: w.templates, slotVersion: w.slotVersion, draftRows: rows, total: rows.length }; }

async function generate(ctx) {
  return mutation(ctx, async (w, p, b) => {
    assertEditable(w);
    if (weekDates(w.weekStart)[4] < bj.dayKey(Date.now())) throw new ApiError(Codes.CONFLICT, '这一周已经过去了');
    if (!w.slots.length) throw new ApiError(Codes.CONFLICT, '请先发布值班时段');
    const c = await contextFor(w);
    const out = w.rows.filter(isFixed).map((r) => ({ ...r, fixed: true }));
    const fixedReport = validate({ ...w, rows: out }, c);
    if (fixedReport.issues.some((i) => i.code !== 'MISSING')) failCheck(fixedReport, '固定人员存在冲突，请先调整固定人选');
    const sorted = w.slots.slice().sort((a, b2) => a.day - b2.day || a.start - b2.start || a.seq - b2.seq);
    for (const def of sorted) {
      const day = c.dates[def.day];
      const current = out.filter((r) => { const s = slotForRow(r, w.slots, c.dates); return s && s.slotKey === def.slotKey; }).length;
      for (let n = current; n < Number(def.count); n++) {
        const eligible = c.people.filter((x) => !reasonsFor(x, def, out, c).length).sort((a, b2) => {
          const countA = out.filter((r) => Number(r.personId) === a.personId).length;
          const countB = out.filter((r) => Number(r.personId) === b2.personId).length;
          return countA - countB || a.name.localeCompare(b2.name, 'zh') || a.personId - b2.personId;
        });
        if (!eligible.length) break;
        const who = eligible[0];
        out.push({ weekStart: w.weekStart, day, slot: def.title, slotKey: def.slotKey, timeText: def.timeText,
          department: def.dept || '', role: def.role || '', personId: who.personId, personName: who.name, source: 'auto', fixed: false });
      }
    }
    await writeWeek(w, p, draftPatch(w, out));
    const saved = await loadWeek(w.weekStart); await log(saved, p, 'generate', b.reason, saved.doc.version);
    const report = validate(saved, c);
    return { week: publicWeek(saved, p), generated: out.length, missing: report.missing, limits: { dayMax: c.dayMax, weekMax: c.weekMax } };
  });
}

async function setCell(ctx) {
  return mutation(ctx, async (w, p, b) => {
    assertEditable(w);
    const def = requestedSlot(w, b); const day = weekDates(w.weekStart)[def.day];
    if (!Array.isArray(b.personIds) || b.personIds.some((id) => !Number.isInteger(id) || id < 1)) throw new ApiError(Codes.PARAM_ERROR, 'personIds 必须是有效人员编号数组');
    const ids = [...new Set(b.personIds)];
    if (ids.length !== b.personIds.length || ids.length > Number(def.count)) throw new ApiError(Codes.PARAM_ERROR, '人选重复或超出岗位所需人数');
    const c = await contextFor(w); const before = w.rows.filter((r) => { const s = slotForRow(r, w.slots, c.dates); return s && s.slotKey === def.slotKey; });
    const unchanged = ids.slice().sort((a,b2) => a-b2).join(',') === before.map((r) => Number(r.personId)).sort((a,b2) => a-b2).join(',');
    const reason = String(b.reason || '').trim();
    if (!unchanged && reason.length < 2) throw new ApiError(Codes.PARAM_ERROR, '调整人选请填写至少 2 字原因');
    if (reason.length > 200) throw new ApiError(Codes.PARAM_ERROR, '调整原因最多 200 字');
    const others = w.rows.filter((r) => !before.includes(r)); const selected = [];
    for (const id of ids) {
      const who = c.byId[id]; const reasons = reasonsFor(who, def, others.concat(selected), c);
      if (reasons.length) failCheck({ valid: false, issues: reasons.map((message) => ({ code: 'HARD_CONSTRAINT', message, personId: id, day, slot: def.title, slotKey: def.slotKey })), missing: [] }, `${who ? who.name : '该成员'}不满足排班条件：${reasons[0]}`);
      selected.push({ weekStart: w.weekStart, day, slot: def.title, slotKey: def.slotKey, timeText: def.timeText,
        department: def.dept || '', role: def.role || '', personId: id, personName: who.name,
        source: 'manual', fixed: b.fixed !== false, reason });
    }
    await writeWeek(w, p, draftPatch(w, others.concat(selected)));
    const saved = await loadWeek(w.weekStart); await log(saved, p, unchanged ? 'fixed' : 'cell', reason, saved.doc.version);
    return { week: publicWeek(saved, p), cell: { day, slot: def.title, slotKey: def.slotKey, personIds: ids } };
  });
}

/** 发布时才同步正式 assignment，草稿生成与换人不会污染正式人员池。 */
async function replaceFormal(weekStart, rows, oldRows) {
  async function replace(list) {
    await removeWhere(C.DUTY_ASSIGNMENT, { weekStart });
    for (const r of list) { const row = { ...r }; delete row._id; row.id = await nextId(C.DUTY_ASSIGNMENT); await insertOne(C.DUTY_ASSIGNMENT, row); }
  }
  try { await replace(rows); } catch (e) { await replace(oldRows); throw e; }
}

async function publish(ctx) {
  return mutation(ctx, async (w, p, b) => {
    assertEditable(w);
    if (!w.doc) throw new ApiError(Codes.CONFLICT, '请先生成草稿');
    const report = validate(w, await contextFor(w));
    const hard = report.issues.filter((i) => i.code !== 'MISSING');
    if (hard.length || (report.missing.length && b.allowMissing !== true)) failCheck(report, hard.length ? '班表存在人员冲突，不能发布' : '仍有缺岗，请补齐或明确确认保留缺岗');
    if (!w.rows.length) failCheck(report, '空班表不能发布');
    const version = Number(w.doc.version) + 1 || 1; const now = new Date();
    await replaceFormal(w.weekStart, w.rows, w.formal);
    try {
      await writeWeek(w, p, { state: 'published', version, publishedAt: now, publishedBy: p.id,
        publishedByName: actorName(p), withdrawnAt: null, publishedRows: plain(w.rows), draftRows: [],
        templates: w.templates, slotVersion: w.slotVersion, total: w.rows.length, allowMissing: b.allowMissing === true });
    } catch (e) { await replaceFormal(w.weekStart, w.formal, w.rows); throw e; }
    const saved = await loadWeek(w.weekStart); await log(saved, p, 'publish', b.reason, version);
    return { week: publicWeek(saved, p) };
  });
}

async function withdraw(ctx) {
  return mutation(ctx, async (w, p, b) => {
    if (!w.doc || w.doc.state !== 'published') throw new ApiError(Codes.CONFLICT, '本周尚未发布，无需撤回');
    const rows = w.rows.map((r) => ({ ...r, fixed: true }));
    await writeWeek(w, p, { ...draftPatch(w, rows), publishedAt: null, withdrawnAt: new Date(), withdrawnBy: p.id, withdrawnByName: actorName(p) });
    const saved = await loadWeek(w.weekStart); await log(saved, p, 'withdraw', b.reason, w.doc.version);
    return { week: publicWeek(saved, p) };
  }, true);
}

async function clear(ctx) {
  return mutation(ctx, async (w, p, b) => {
    assertEditable(w);
    await writeWeek(w, p, draftPatch(w, []));
    const saved = await loadWeek(w.weekStart); await log(saved, p, 'clear', b.reason, saved.doc.version);
    return { week: publicWeek(saved, p) };
  });
}

async function history(ctx) {
  const p = await asManager(ctx); const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const [doc, rows] = await Promise.all([findOne(C.DUTY_WEEK, { _id: weekStart }), findAllPaged(C.DUTY_LOG, { weekStart })]);
  const sorted = rows.filter((r) => ACTIONS[r.action]).sort((a,b) => Number(b.id) - Number(a.id));
  const list = sorted.map((r) => ({
    id: Number(r.id) || 0, action: r.action || '', actionText: r.actionText || ACTIONS[r.action] || r.action || '',
    operatorName: r.operatorName || '', actorName: r.operatorName || '', reason: r.reason || '',
    createdAt: r.createTime || null, createTime: r.createTime || null, version: Number(r.version) || 0,
    summary: r.summary || { needed: 0, filled: 0, missing: 0, fixed: 0 },
    ...(p.isSuper ? { snapshot: r.snapshot || null } : {}),
  }));
  const versions = sorted.filter((r) => r.action === 'publish').map((r) => ({ version: Number(r.version) || 0, publishedAt: r.createTime || null, publishedByName: r.operatorName || '', total: Number(r.summary && r.summary.filled) || 0 }));
  return { weekStart, version: Number(doc && doc.version) || 0, publishedAt: doc && doc.publishedAt || null, publishedByName: doc && doc.publishedByName || '', list, versions };
}

async function month(ctx) {
  await asPartner(ctx); const q = ctx.query || {};
  const ym = q.month ? String(q.month) : bj.dayKey(Date.now()).slice(0,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new ApiError(Codes.PARAM_ERROR, 'month 需为 YYYY-MM 格式');
  const [weeks, people] = await Promise.all([findAllPaged(C.DUTY_WEEK, { state: 'published' }), listPeople()]);
  const selected = weeks.filter((w) => String(w.weekStart || w._id).slice(0,7) === ym);
  const per = {};
  people.forEach((p) => { per[p.personId] = { personId: p.personId, personName: p.name, department: p.department, count: 0, lastDay: '' }; });
  for (const doc of selected) {
    const w = await loadWeek(doc.weekStart || doc._id);
    w.rows.forEach((r) => {
      const id = Number(r.personId);
      if (!per[id]) per[id] = { personId: id, personName: r.personName || '', department: r.department || '', count: 0, lastDay: '' };
      per[id].count++; if (r.day > per[id].lastDay) per[id].lastDay = r.day;
    });
  }
  const list = Object.values(per).sort((a,b) => b.count - a.count || a.personId - b.personId);
  return { month: ym, weeks: selected.map((w) => w.weekStart || w._id).sort(), list, total: list.reduce((n,p) => n+p.count,0) };
}

module.exports = { get, mine, month, generate, check, candidates, publish, withdraw, setCell, clear, history, withWeekLock };
