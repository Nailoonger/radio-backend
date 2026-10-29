'use strict';

/**
 * 伙伴端 · 互评（当场说一句，不是考核）
 *
 *   GET  /partner/feedback/pending?week=   本周我该评谁（同场次搭班的人 + 已评标记）
 *   POST /partner/feedback                 提交一句 body: { weekStart, day, slot, targetId, text }
 *   GET  /partner/feedback/mine?week=      我收到的（**匿名**：只有内容、时间、场次）
 *   GET  /partner/feedback/overview?week=  本周完成度（社干）
 *
 * ═══════════ 口径（v151 原文） ═══════════
 *   「不是考核，是当场说一句。评语只按人聚合，不显示谁评的。」
 *   ⇒ **不打分、不打标签**，就一段话（≤200 字）。
 *   ⇒ 读接口**永不返回评价人**（`fromId` 只用于「一人对一人一周一次」的去重，不出库）。
 *   ⇒ 社干的总览也只给「谁收到几条 / 这周评了几条」，**不做谁评谁的明细** ——
 *     这条是硬边界：一旦能查到明细，匿名承诺就废了。
 *
 * ═══════════ 谁能评谁 ═══════════
 *   本周班表里**与我同一天同一时段**的人（搭班才看得见对方的表现）。
 *   不跨场次、不评全站 —— 不然就成了背地里打分。
 */

const { C, findOne, findMany, insertOne, count } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asPartner, asManager, assertWeekStart, currentWeekStart, weekDates } = require('./_kit');
const { nextId } = require('../../lib/db');
const { publishedRows } = require('./_published');

const MAX_TEXT = 200;

/** 本周和我同 (day, slot) 的人 —— 这是「该评谁」的唯一来源 */
async function peersOf(weekStart, meId) {
  const mine = await publishedRows(weekStart, { personId: meId }, 100);
  if (!mine.length) return [];
  const keys = mine.map((x) => `${x.day}|${x.slot}`);
  const all = await publishedRows(weekStart);
  const seen = {};
  const out = [];
  all.forEach((a) => {
    const k = `${a.day}|${a.slot}`;
    if (keys.indexOf(k) < 0) return;            // 不同场次，不评
    const pid = Number(a.personId);
    if (pid === Number(meId)) return;           // 不评自己
    if (seen[pid]) return;
    seen[pid] = 1;
    out.push({ personId: pid, personName: a.personName || '', day: a.day, slot: a.slot });
  });
  return out;
}

async function pending(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const dates = weekDates(weekStart);
  const peers = await peersOf(weekStart, p.id);
  const given = await findMany(C.PARTNER_FEEDBACK, { weekStart, fromId: p.id }, { limit: 200 });
  const doneMap = {};
  given.forEach((g) => { doneMap[`${Number(g.targetId)}|${g.day}|${g.slot}`] = true; });

  const rows = peers.map((x) => ({
    personId: x.personId,
    personName: x.personName,
    day: x.day,
    dayName: ['周一', '周二', '周三', '周四', '周五'][dates.indexOf(x.day)] || '',
    slot: x.slot,
    done: !!doneMap[`${x.personId}|${x.day}|${x.slot}`],
  }));
  return {
    weekStart,
    list: rows,
    total: rows.length,
    done: rows.filter((x) => x.done).length,
  };
}

async function create(ctx) {
  const p = await asPartner(ctx);
  const b = ctx.body || {};
  const weekStart = assertWeekStart(b.weekStart);
  const day = String(b.day || '').trim();
  const slot = String(b.slot || '').trim();
  const targetId = Number(b.targetId);
  const text = String(b.text || '').trim();

  if (!day || !slot || !Number.isInteger(targetId) || targetId <= 0) {
    throw new ApiError(Codes.PARAM_ERROR, '缺少评价对象或场次');
  }
  if (targetId === p.id) throw new ApiError(Codes.PARAM_ERROR, '不能评自己');
  if (!text) throw new ApiError(Codes.PARAM_ERROR, '写一句再交');
  if (text.length > MAX_TEXT) throw new ApiError(Codes.PARAM_ERROR, `最多 ${MAX_TEXT} 字`);

  // 必须是同场次的人（服务端权威校验，不信前端）
  const peers = await peersOf(weekStart, p.id);
  const hit = peers.find((x) => x.personId === targetId && x.day === day && x.slot === slot);
  if (!hit) throw new ApiError(Codes.FORBIDDEN, '只能评同一场次搭班的人');

  // 一人对一人一场，一周一次
  const dup = await findMany(C.PARTNER_FEEDBACK, { weekStart, fromId: p.id, targetId, day, slot }, { limit: 2 });
  if (dup.length) throw new ApiError(Codes.CONFLICT, '这一场已经评过了');

  const now = new Date();
  const doc = {
    id: await nextId(C.PARTNER_FEEDBACK),
    weekStart, day, slot,
    targetId,
    targetName: hit.personName || '',
    // ⚠️ fromId 只用于去重与「我评过谁」，任何读接口都不返回它
    fromId: p.id,
    text,
    createTime: now,
  };
  await insertOne(C.PARTNER_FEEDBACK, doc);
  return { id: doc.id, targetId, targetName: doc.targetName, day, slot, text, createTime: now };
}

/** 我收到的评语（匿名：不返回 fromId / 评价人任何信息） */
async function mine(ctx) {
  const p = await asPartner(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const dates = weekDates(weekStart);
  const where = { targetId: p.id };
  if (q.week) where.weekStart = weekStart;
  const rows = await findMany(C.PARTNER_FEEDBACK, where, {
    orderBy: [['createTime', 'desc']], limit: 50,
  });
  return {
    weekStart,
    list: rows.map((x) => ({
      id: x.id,
      text: x.text || '',
      day: x.day || '',
      dayName: dates.indexOf(x.day) >= 0
        ? ['周一', '周二', '周三', '周四', '周五'][dates.indexOf(x.day)]
        : '',
      slot: x.slot || '',
      createTime: x.createTime || null,
    })),
    total: rows.length,
  };
}

/** 本周完成度（社干）：只给计数，不给谁评谁的明细 */
async function overview(ctx) {
  await asManager(ctx);
  const q = ctx.query || {};
  const weekStart = q.week ? assertWeekStart(q.week) : currentWeekStart();
  const rows = await findMany(C.PARTNER_FEEDBACK, { weekStart }, { limit: 500 });
  const perTarget = {};
  rows.forEach((x) => {
    const k = Number(x.targetId);
    if (!perTarget[k]) perTarget[k] = { personId: k, personName: x.targetName || '', received: 0 };
    perTarget[k].received += 1;
  });
  const people = Object.keys(perTarget).map((k) => perTarget[k])
    .sort((a, b) => b.received - a.received);
  const totalAssignments = await publishedRows(weekStart);
  return {
    weekStart,
    given: rows.length,
    people,
    onDuty: totalAssignments.length,
  };
}

module.exports = { pending, create, mine, overview };
