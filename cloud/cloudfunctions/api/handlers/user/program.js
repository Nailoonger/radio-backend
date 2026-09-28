'use strict';

/**
 * 用户端 · 节目
 * 迁移自 src/controllers/user/programController.js
 *
 *   GET /user/program/current    正在直播（isLive=1 且 isShow=1，取 sort 最小）；无则 data=null
 *   GET /user/program/schedule   节目预告（默认未来 7 天；带 from/to 走区间）
 *   GET /user/program/weekly     本周节目单（周一~周日）
 *   GET /user/program/:id        节目详情 + 该节目已通过的留言（最多 50 条）
 *
 * ⚠️ 日期一律按**北京时间**算（云函数是 UTC）。原实现用裸 `dayjs()` 取服务器本地日历日，
 *    容器为 UTC 时会整体偏 8 小时 → 周二凌晨仍算作周一。这里改用 lib/bjTime，行为修正。
 *
 * ⚠️ 主键口径：详情用**数字 `id`**（见 lib/db.js 的 parseId 注释），不是 `_id`。
 */

const { C, findOne, findMany, parseId, _ } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const bj = require('../../lib/bjTime');

// 原实现在 sort 相同时没有 tie-breaker（MySQL 不保证稳定序）；这里补 id 升序，
// 让「同 sort 的节目」在每次查询里顺序一致（否则前端列表会莫名跳动）。
const SCHEDULE_ORDER = [['broadcastDate', 'asc'], ['sort', 'asc'], ['id', 'asc']];

/** 'YYYY-MM-DD' + n 天（纯日历运算，不涉时区换算） */
function datePlus(dateStr, days) {
  const parts = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * bj.DAY_MS);
  return `${t.getUTCFullYear()}-${bj.pad2(t.getUTCMonth() + 1)}-${bj.pad2(t.getUTCDate())}`;
}

/** GET /user/program/current */
async function current() {
  const rows = await findMany(C.PROGRAM, { isLive: 1, isShow: 1 }, { orderBy: [['sort', 'asc']], limit: 1 });
  return rows[0] || null;
}

/** GET /user/program/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD */
async function schedule(ctx) {
  const q = ctx.query || {};
  let from = q.from;
  let to = q.to;
  if (!from || !to) {
    // 默认未来 7 天（含今天），与原来一致
    from = bj.dayKey();
    to = datePlus(from, 7);
  }

  const list = await findMany(
    C.PROGRAM,
    { isShow: 1, broadcastDate: _.gte(from).and(_.lte(to)) },
    { orderBy: SCHEDULE_ORDER }
  );
  return { list };
}

/** GET /user/program/weekly */
async function weekly() {
  const r = bj.weekRange();
  const from = bj.ymd(bj.shifted(r.start.getTime()));
  const to = bj.ymd(bj.shifted(r.end.getTime() - 1)); // end 是下周一 00:00，故 -1ms 取到周日

  const list = await findMany(
    C.PROGRAM,
    { isShow: 1, broadcastDate: _.gte(from).and(_.lte(to)) },
    { orderBy: SCHEDULE_ORDER }
  );
  return { weekRange: { from, to }, list };
}

/** GET /user/program/:id */
async function detail(ctx) {
  const id = parseId(ctx.params.id);
  const program = id === null ? null : await findOne(C.PROGRAM, { id, isShow: 1 });
  if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');

  // 该节目下已通过审核的留言（上限 50，与原实现一致）
  const messages = await findMany(
    C.MESSAGE,
    { programId: id, status: 1 },
    { orderBy: [['createTime', 'desc']], limit: 50 }
  );

  return { program, messages };
}

module.exports = { current, schedule, weekly, detail };
