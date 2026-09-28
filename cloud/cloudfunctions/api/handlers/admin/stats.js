'use strict';

/**
 * 管理端 · 数据统计
 * 迁移自 src/controllers/admin/statsController.js
 *
 * 路由层挂 `adminAuth + requireAdmin` → 全部 `asAdmin`。
 *
 * ⚠️⚠️ **三处必须改写的实现差异**（不是「可选优化」，是不改就错）：
 *
 *  ① 原实现用**裸 `dayjs()`**。云函数容器是 UTC，裸 `dayjs().startOf('day')`
 *     切的是 UTC 零点（= 北京时间 08:00），「今天/本周」全偏。
 *     → 统一改成 `lib/bjTime`（`dayRange` / `weekRange`），与全项目口径一致。
 *
 *  ② 原实现用 SQL `GROUP BY`（`submit-trend` 的 `DATE(create_time)`、`top-songs` 的
 *     `songName+singer`）。云数据库**没有云端 GROUP BY**（聚合管道自研 harness 不支持）
 *     → 退化成「分页拉全量 + JS 聚合」。
 *     **适用上限**：`submit` 表到「几千条」量级仍可用；再大需要改成物化统计表。
 *
 *  ③ 原实现里 `status: 1` 的语义是「已通过」。协议改版后 `status` 变成了**派生镜像**：
 *     `0 待审 / 1 已排期 / 2 已驳回 / 5 已播放 / 6 已通过·待排期 / 7 已取消`。
 *     `overview.approved` **已按陛下 2026-09-29 裁决改为 `status ∈ {1, 5, 6}`** ——
 *     理由：卡片标题写的就是「已通过」，而审核通过但还没排期的（`6`）与
 *     已经播完的（`5`）都被漏掉了，数字偏小。
 *     ⚠️ 这是统计模块里**唯一一处有意偏离源实现的业务口径**，见 docs/stage7-admin-plan.md §五。
 *     ⚠️ `topSongs()` 仍是源实现的 `status: 1`（**未获授权改动**，且它直接进
 *        Dashboard 的「热门点歌」榜，属可见数字）—— 同一份「已通过」语义在那里
 *        还偏着，等陛下点头再一并改，见 §五 的说明。
 */

const { C, _, count, findAllPaged } = require('../../lib/db');
const bj = require('../../lib/bjTime');
const { asAdmin } = require('./_kit');

/** GET /admin/stats/overview */
async function overview(ctx) {
  asAdmin(ctx);
  const now = Date.now();
  const today = bj.dayRange(now).start;
  const weekStart = bj.weekRange(now).start;

  const [
    submitTotal, submitPending, submitApproved, submitRejected,
    songTotal, articleTotal,
    messageTotal, messagePending,
    noticeTotal, programTotal,
    todaySubmits, weekSubmits,
    userTotal, todayUsers,
  ] = await Promise.all([
    count(C.SUBMIT),
    count(C.SUBMIT, { status: 0 }),
    // 「已通过」= 已排期(1) + 已播放(5) + 已通过·待排期(6)（陛下 2026-09-29 裁决）
    // ⚠️ 别再简化成 `{ status: 1 }` —— `status` 是派生镜像，`1` 只是「已排期」，
    //    会把「审核已过、还没排期」和「已经播完」的一起漏掉（静默偏小，不报错）。
    count(C.SUBMIT, { status: _.in([1, 5, 6]) }),
    count(C.SUBMIT, { status: 2 }),
    count(C.SUBMIT, { type: 1 }),
    count(C.SUBMIT, { type: 2 }),
    count(C.MESSAGE),
    count(C.MESSAGE, { status: 0 }),
    count(C.NOTICE),
    count(C.PROGRAM),
    count(C.SUBMIT, { createTime: _.gte(today) }),
    count(C.SUBMIT, { createTime: _.gte(weekStart) }),
    count(C.USER),
    count(C.USER, { createTime: _.gte(today) }),
  ]);

  return {
    submit: {
      total: submitTotal,
      pending: submitPending,
      approved: submitApproved,
      rejected: submitRejected,
      song: songTotal,
      article: articleTotal,
      today: todaySubmits,
      thisWeek: weekSubmits,
    },
    message: { total: messageTotal, pending: messagePending },
    content: { notice: noticeTotal, program: programTotal },
    user: { total: userTotal, today: todayUsers },
  };
}

/**
 * GET /admin/stats/submit-trend?days=7
 * 返回: [{ date: '2026-09-08', count: 12, song: 8, article: 4 }, ...]（**缺口补齐 0**）
 */
async function submitTrend(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const days = parseInt(q.days || '7', 10) || 7;
  const now = Date.now();

  // 起点 = 北京「今天」往前推 days-1 天的 00:00
  const todayStart = bj.dayRange(now).start.getTime();
  const start = new Date(todayStart - (days - 1) * bj.DAY_MS);
  const todayKey = bj.dayKey(now);

  const rows = await findAllPaged(C.SUBMIT, { createTime: _.gte(start) });

  const agg = new Map();
  rows.forEach((r) => {
    if (!r.createTime) return;
    const k = bj.dayKey(new Date(r.createTime).getTime());
    if (!agg.has(k)) agg.set(k, { count: 0, song: 0, article: 0 });
    const a = agg.get(k);
    a.count += 1;
    if (Number(r.type) === 1) a.song += 1;
    else if (Number(r.type) === 2) a.article += 1;
  });

  // 补齐没有数据的日期（用北京日历日逐天回推，避免 DST / 时区错位）
  const list = [];
  const todayNoon = bj.dayRange(now).start.getTime() + 12 * 3600 * 1000;
  for (let i = 0; i < days; i++) {
    const ts = todayNoon - (days - 1 - i) * bj.DAY_MS;
    const d = bj.dayKey(ts);
    const a = agg.get(d) || { count: 0, song: 0, article: 0 };
    list.push({ date: d, count: a.count, song: a.song, article: a.article });
  }
  // todayKey 只用于自检（确保最后一天确实是「今天」）
  if (list.length && list[list.length - 1].date !== todayKey) {
    console.warn('[stats] submit-trend 末日与北京今天不一致', list[list.length - 1].date, todayKey);
  }
  return { list };
}

/**
 * GET /admin/stats/top-songs   热门点歌 Top10（已通过）
 *
 * ⚠️⚠️ **这里的 `status: 1` 与 `overview.approved` 的口径已经不一致了** ——
 *    2026-09-29 陛下的裁决只覆盖 `overview`，本接口**保持源实现原样**（后果是
 *    「已通过但还没排期」和「已经播完」的歌都不进榜，而这个榜的标题写的是「已通过」）。
 *    这是**有意保留**的：它直接渲染到 Dashboard 的「热门点歌」，改它就是改可见数字，
 *    需要单独点头。要改的话把 where 换成 `{ type: 1, status: _.in([1, 5, 6]) }` 即可。
 *    → docs/stage7-admin-plan.md §五。
 *
 * ⚠️ 排序只在 `count` 上（与源实现 `order: [[literal('count'),'DESC']]` 一致）；
 *    `count` 相同时的顺序在 MySQL 里本就未定义，这里保留「首次出现顺序」
 *    （V8 的 Array.sort 是稳定的）。
 */
async function topSongs(ctx) {
  asAdmin(ctx);
  const rows = await findAllPaged(C.SUBMIT, { type: 1, status: 1 });

  const map = new Map();
  rows.forEach((r) => {
    const songName = r.songName === undefined ? null : r.songName;
    const singer = r.singer === undefined ? null : r.singer;
    const key = `${songName === null ? '\u0000' : songName}\u0001${singer === null ? '\u0000' : singer}`;
    if (!map.has(key)) map.set(key, { songName, singer, count: 0 });
    map.get(key).count += 1;
  });

  const list = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return { list };
}

module.exports = { overview, submitTrend, topSongs };
