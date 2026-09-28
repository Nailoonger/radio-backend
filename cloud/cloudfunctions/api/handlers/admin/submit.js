'use strict';

/**
 * 管理端 · 投稿审核与排期（协议版）
 * 迁移自 src/controllers/admin/submitController.js（1083 行）
 *
 * 这是阶段 7 里**唯一带写排期算法**的模块 —— 阶段 5 移植的 `services/scheduling`
 * 到这一步才第一次从管理端真实调用（用户端零入口，见 README 阶段 5 说明）。
 *
 * ═══════════════ 云化改动（逐条对齐源码语义）═══════════════
 *
 * ① **路由中间件 → handler 第一行**。云函数没有中间件层，`adminAuth + requireAdmin`
 *    与 `adminAuth + requireSuperAdmin` 的差异必须逐个 handler 手写：
 *      asAdmin  → list / capacity / window(读) / notice(读·写) / timeslots / schedule /
 *                 week / rules(读) / batch / detail / approve / statusLogs / reject / remove
 *      asSuper  → setQuota / sweepQueue / saveWindow / saveSlots / previewSchedule /
 *                 runSchedule / lock / unlock / saveRules / purgeSongs /
 *                 revoke / assign / played
 *    ⚠️ 漏写 = 「没登录 / 普管也能调」，接口照样返回 200（静默漂移 #2）。
 *    ⚠️ `admin.submit.capacity` 一个 key 对应两条路由（GET /quota 与 GET /capacity），
 *       `admin.submit.sweepQueue` 对应两条（POST /quota/sweep 与 /queue/sweep）——
 *       好在同组两边的权限一致，合并成同一个 handler 不会串权。
 *
 * ② **`LIKE '%kw%'` → 全量拉 + JS 大小写不敏感子串**。云数据库没有 LIKE，
 *    `_.or` 也表达不了子串。`keyword` 参与 `songName / singer / articleTitle / wishContent`
 *    四个字段（与源码逐字一致）。
 *    ⚠️ **没有 keyword 时把 where + 排序 + 分页整体下推数据库**（`orderBy` + `skip` + `limit`），
 *       这是列表页的热路径；只有带 keyword 时才退化成全量拉 + JS 过滤切片。
 *
 * ③ **多键排序 `create_time ASC, id ASC`**。云数据库的 `orderBy` 可链式（等价多键），
 *    但**带 keyword 的 JS 路径必须自己排**，且比较 Date 只能按值（`_kit.sortRows` 已处理）。
 *    ⚠️ `id` 兜同秒不可省 —— 少了它，同秒提交的多条在跨页边界会重复/漏。
 *
 * ④ **无 `attributes` 投影** → 用 `_kit.pick` 手工挑；缺字段补 `null`
 *    （`undefined` 会被 `JSON.stringify` 整个丢掉）。
 *
 * ⑤ **无跨文档事务** → `purgeSongs` 从「一个事务里删三张表」改成
 *    「分批：先删两张日志的对应行，再删 submit 行」。中途失败会留下
 *    「日志已删、点歌还在」的中间态 —— 这是**可以接受**的方向（重跑一次即幂等收敛），
 *    反方向（点歌没了日志还在）才会产生指向不存在点歌的孤儿行。
 *
 * ⑥ **无 `SUM/MAX` 聚合** → `detail` 的 `MIN/MAX(create_time)` 改用两次
 *    「`orderBy + limit:1`」的轻查询（比全量拉该用户的投稿便宜得多）。
 *
 * ⑦ **`submit.reload()` → 回读一次**。审核通过后要跑排期，排期会**再改一次这条记录**
 *    （scheduleStatus 0 → 1/2）；不回读就会把「已通过 · 待排期」这个中间态回给前端
 *    （界面显示「还没排上」、刷新又变「已排期」，看起来像 bug）。源码也是 reload。
 *
 * ⑧ **`ctx.admin` 就是 JWT payload**（`lib/auth.requireAdmin` 写入），
 *    与源码 `req.admin.id` 同义。
 *
 * ⑨ **并发冲突显式处理**（**有意的小改进**，源码此处是漏的）：
 *    `applyChange` 影响 0 行时返回 `{conflict:true, logs:[]}`，而源码 `approveOne`
 *    无视它、照样报 `changed:true`。云端改成「回读真实状态 + `changed:false`」——
 *    避免把内存里的乐观值当结果返回。frontend 契约不变（`admin-web` 的成功 `message`
 *    本来就被 http 拦截器丢掉，请求体/响应体字段名一个没动）。
 *
 * ⑩ **成功路径的自定义 message 一律不带**：原后端 `success(res, data, msg)` 的 `msg`
 *    被 `admin-web/src/utils/request.js` 的「`if (body?.code === 0) return body.data`」
 *    整条丢弃，所以云端网关统一回 `message:'ok'` 不产生任何可见差异。
 */

const { C, _, findOne, findMany, findAllPaged, removeWhere, count, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asAdmin, asSuper, pager, anyLike, sortRows } = require('./_kit');
const songQueue = require('../../services/songQueue');
const songWindow = require('../../services/songWindow');
const submitRule = require('../../services/submitRule');
const songNotice = require('../../services/songNotice');
const broadcastSlot = require('../../services/broadcastSlot');
const S = require('../../services/songStatus');
const sched = require('../../services/scheduling');
const roster = require('../../services/roster');

/** 列表排序：**先提交先审**（提交时间升序；id 兜同秒，防分页重复/漏） */
const LIST_ORDER = [['createTime', 'asc'], ['id', 'asc']];
/** keyword 路径全量拉的安全上限（超出请改用下推条件，见文件头 ②） */
const LIST_SCAN_MAX = 5000;
/** `_.in([...])` 一批最多几个（命令体大小限制，与 roster.js 同一口径） */
const IN_CHUNK = 100;
/** 按 _id 取单条的集合是文档型，没有 `:id` 主键 —— 统一走 `parseId` + `findOne({id})` */

/** 小块切分（`_.in` 数组不宜过大） */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 把 service 层抛的**裸 Error + `code: 40001`** 翻译成 ApiError。
 *
 * ⚠️ 源控制器里这类 catch 出现三次（saveNotice / saveSlots / assign）：
 *      `catch (e) { if (e.code === 40001) return fail(res, Codes.PARAM_ERROR, e.message); return next(e); }`
 *    漏掉它的后果很具体：`songNotice.save` 的内容超长、`broadcastSlot.setSlotTimes` 的
 *    时段全非法，都会从**明确的 40001 业务提示**退化成 `50001 服务器繁忙，请稍后再试`
 *    —— 管理员看不到「为什么存不上」（实测已复现，见 test-admin-submit M 段）。
 *
 * ⚠️ 注意与 `unlockWeek` 的区别：它抛的也是裸 Error + code 40001，但源控制器**没有**这个
 *    catch，所以源后端返回的就是 500。那里保持 50001 不动（不擅自"修好"线上既有行为）。
 */
function paramError(e) {
  if (e && e.code === 40001) return new ApiError(Codes.PARAM_ERROR, e.message);
  return e;
}

/** 给接口对象塞上三维状态视图 */
function withStatus(o) { return { ...o, ...S.statusView(o) }; }

/** 拿到这条点歌所属周的周一 00:00（绝对时刻） */
function weekMsOf(submit) {
  const ws = sched.weekStartOfRow(submit);
  return ws ? ws.getTime() : null;
}

/** 数字 id → 行（非法 id 直接当不存在，不把 NaN 塞进 where） */
async function submitOf(ctx, label = '投稿') {
  const id = parseId(ctx.params && ctx.params.id);
  const row = id === null ? null : await findOne(C.SUBMIT, { id });
  if (!row) throw new ApiError(Codes.NOT_FOUND, `${label}不存在`);
  return row;
}

/**
 * 《V1 规格》第 11 节：**锁定之后的周不允许人工改动**。
 * 系统自己的动作（`lockWeek` 的最后调度、`markPlayed`）不走这里，不受影响。
 */
async function assertWeekNotLocked(ms, label = '这一周') {
  if (ms === null || ms === undefined) return null;
  const week = await sched.ensureWeek(ms, { now: Date.now() });
  if (week.status === sched.WEEK_STATUS.LOCKED) {
    throw new ApiError(
      Codes.PARAM_ERROR,
      `${label}的排期已锁定（${week.weekStartDate} 当周），不能再改动`
    );
  }
  return week;
}

/** 按记录反推归属周后校验（文稿不参与排期，不受锁定约束） */
async function assertWeekOpen(submit) {
  if (Number(submit.type) !== 1) return null;
  return assertWeekNotLocked(weekMsOf(submit), '这条点歌所属周');
}

/** 审核动作之后让这一周的排期与候补重新对齐（幂等） */
async function runWeekSchedule(submit, opts = {}) {
  const ms = weekMsOf(submit);
  if (ms === null) return { promoted: 0, rescheduled: 0, left: 0 };
  try {
    const a = await sched.initialAllocate(ms, opts);
    const b = await sched.reschedule(ms, opts);
    return { ...b, assigned: a.assigned, waiting: a.waiting };
  } catch (e) {
    // 排期失败不能把审核动作本身搞失败（审核已经落库了），但**必须留痕**
    console.warn(`[songSchedule] 审核后重算排期失败 week=${new Date(ms).toISOString()}：${e.message}`);
    return { promoted: 0, rescheduled: 0, left: 0, error: e.message };
  }
}

/** 把调剂结果拼成给管理员看的话（云端 message 会被前端丢弃，保留只为日志/调试口径一致） */
function releaseMsg(base, rel) {
  if (!rel) return base;
  const bits = [];
  if (rel.promoted) bits.push(`原位递补 ${rel.promoted} 条`);
  if (rel.rescheduled) bits.push(`跨时段调剂 ${rel.rescheduled} 条`);
  return bits.length ? `${base}，已${bits.join('、')}` : base;
}

/** 回读一条（等价 Sequelize 的 `submit.reload()`） */
async function reread(row) {
  const fresh = await findOne(C.SUBMIT, { id: Number(row.id) });
  return fresh || row;
}

/* ------------------------------------------------------------------ *
 * 内部：审核通过 / 驳回
 * ------------------------------------------------------------------ */
/**
 * 协议 §14：这里的 approve **只是审核通过**，不等于拿到位置。
 *   审核通过 → review=APPROVED / schedule=UNASSIGNED → 进排期候选池
 */
async function approveOne(submit, adminId) {
  const review = Number(submit.reviewStatus) || 0;
  const schedule = Number(submit.scheduleStatus) || 0;

  if (review === S.REVIEW.APPROVED) {
    return { submit, changed: false, already: true };
  }
  // v1 的老毛病：通过一条已驳回的记录会静默无操作却返回「已通过」。这里明确报错。
  if (review === S.REVIEW.REJECTED) {
    throw new ApiError(Codes.PARAM_ERROR, '这条已驳回，请先撤销再通过');
  }
  if (review === S.REVIEW.CANCELLED) {
    throw new ApiError(Codes.PARAM_ERROR, '这条已被取消，不能通过');
  }

  // 曾被系统自动驳回（无位 / 逾期）的，审核通过时要把排期维度重置回候选池
  const changes = {
    reviewStatus: S.REVIEW.APPROVED,
    reviewerId: adminId,
    reviewTime: new Date(),
    rejectReason: null,
    autoRejected: 0,
  };
  if (schedule === S.SCHEDULE.AUTO_REJECTED || schedule === S.SCHEDULE.UNASSIGNED) {
    changes.scheduleStatus = S.SCHEDULE.UNASSIGNED;
  }

  const r = await S.applyChange(submit, changes, {
    operatorId: adminId, operatorName: 'ADMIN', reason: 'REVIEW_APPROVED',
  });
  // 文件头 ⑨：抢晚了（影响 0 行）时回读真实状态，别把乐观值当结果
  if (r.conflict) return { submit: await reread(submit), changed: false, conflict: true };
  return { submit: r.row, changed: true };
}

/**
 * 审核驳回：review → REJECTED，位子随之释放（占位要求 review=APPROVED）
 * schedule 维度**保留原值**，用来回答「他当时排到了哪一格」
 */
async function rejectOne(submit, adminId, reason) {
  const review = Number(submit.reviewStatus) || 0;
  if (review === S.REVIEW.REJECTED) {
    throw new ApiError(Codes.PARAM_ERROR, '这条已是驳回状态，无需重复操作');
  }
  const wasSeated = sched.isSeated(submit);
  const r = await S.applyChange(submit, {
    reviewStatus: S.REVIEW.REJECTED,
    reviewerId: adminId,
    reviewTime: new Date(),
    rejectReason: reason,
    autoRejected: 0,
  }, { operatorId: adminId, operatorName: 'ADMIN', reason: 'REVIEW_REJECTED' });
  return { submit: r.conflict ? await reread(submit) : r.row, wasSeated, conflict: !!r.conflict };
}

/* ------------------------------------------------------------------ *
 * 列表 / 详情
 * ------------------------------------------------------------------ */
/** GET /admin/submit/list */
async function list(ctx) {
  asAdmin(ctx);
  const q = ctx.query || {};
  const { page, pageSize, skip } = pager(q, 10, 200);

  // —— 能下推数据库的等值 / 范围条件 ——
  const base = {};
  const intOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };
  const status = intOf(q.status);
  if (status !== null) base.status = status;
  const type = intOf(q.type);
  if (type !== null) base.type = type;
  const reviewStatus = intOf(q.reviewStatus);
  if (reviewStatus !== null) base.reviewStatus = reviewStatus;
  const scheduleStatus = intOf(q.scheduleStatus);
  if (scheduleStatus !== null) base.scheduleStatus = scheduleStatus;
  // ⚠️ 源码是 `Op.between: [startDate, endDate]`，MySQL 会把 'YYYY-MM-DD' 隐式转成
  //    当天 00:00:00（于是**当天不含末尾**）。这里保持同口径：把字符串解析成同一时刻。
  if (q.startDate && q.endDate) {
    const from = new Date(`${q.startDate}T00:00:00+08:00`);
    const to = new Date(`${q.endDate}T00:00:00+08:00`);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      base.createTime = _.gte(from).and(_.lte(to));
    }
  }

  const slot = q.slot ? String(q.slot) : '';
  const keyword = q.keyword ? String(q.keyword) : '';

  const conds = [];
  if (Object.keys(base).length) conds.push(base);
  // 首选时段 OR 实排时段（两条都要能命中）
  if (slot) conds.push(_.or([{ scheduledSlot: slot }, { wantBroadcastTime: slot }]));
  const where = conds.length === 0 ? {} : (conds.length === 1 ? conds[0] : _.and(conds));

  let rows;
  let total;
  if (!keyword) {
    // 热路径：where + 多键排序 + 分页整体下推（云数据库 orderBy 可链式 = 多键）
    total = await count(C.SUBMIT, where);
    rows = await findMany(C.SUBMIT, where, { orderBy: LIST_ORDER, skip, limit: pageSize });
  } else {
    // LIKE 路径：全量拉 + JS 过滤 + JS 多键排序 + 切片
    const all = await findAllPaged(C.SUBMIT, where, { max: LIST_SCAN_MAX });
    const hit = all.filter((r) => anyLike(r, keyword, ['songName', 'singer', 'articleTitle', 'wishContent']));
    const sorted = sortRows(hit, LIST_ORDER);
    total = sorted.length;
    rows = sorted.slice(skip, skip + pageSize);
  }

  // —— 关联用户昵称/头像（账号体系下投稿的 openid 字段里存的是学号）——
  const keys = [...new Set(rows.map((r) => r.openid).filter((v) => v !== undefined && v !== null && v !== ''))];
  const userMap = new Map();
  for (const part of chunk(keys, IN_CHUNK)) {
    const us = await findAllPaged(C.USER, _.or([{ openid: _.in(part) }, { username: _.in(part) }]), { max: 400 });
    us.forEach((u) => {
      if (u.openid) userMap.set(u.openid, u);
      if (u.username) userMap.set(u.username, u);
    });
  }
  const displayName = (u) => (u && (u.nickname || u.remark)) || '匿名';

  // —— 审核人昵称 ——
  const reviewerIds = [...new Set(rows.map((r) => r.reviewerId).filter((v) => v !== undefined && v !== null && v !== ''))];
  const adminMap = new Map();
  for (const part of chunk(reviewerIds, IN_CHUNK)) {
    const as = await findMany(C.ADMIN, { id: _.in(part) }, { limit: IN_CHUNK });
    as.forEach((a) => adminMap.set(Number(a.id), a));
  }
  const reviewerName = (r) => {
    if (Number(r.autoRejected) === 1) return '系统自动驳回';
    const a = adminMap.get(Number(r.reviewerId));
    return a ? (a.nickname || a.username) : (Number(r.reviewStatus) === 0 ? '' : '—');
  };

  const out = rows.map((r) => {
    const u = userMap.get(r.openid);
    return withStatus({
      ...r,
      nickname: displayName(u),
      studentNo: (u && u.username) || '',
      avatar: (u && u.avatar) || '',
      reviewerName: reviewerName(r),
      reviewTime: r.reviewTime === undefined ? null : r.reviewTime,
      autoRejected: Number(r.autoRejected) === 1,
    });
  });

  // 候补中的行补「第几位」
  await Promise.all(out.map(async (item) => {
    if (Number(item.scheduleStatus) !== S.SCHEDULE.WAITING) return;
    try {
      const p = await sched.waitingPosOf(item);
      item.queuePos = p.pos;
      item.queueAhead = p.ahead;
      item.queueTotal = p.total;
    } catch (e) {
      item.queuePos = null;
    }
  }));

  return { list: out, total, page, pageSize };
}

/** GET /admin/submit/:id */
async function detail(ctx) {
  asAdmin(ctx);
  const submit = await submitOf(ctx);
  const key = submit.openid;
  // ⚠️ `openid` 缺失时显式用 `null` 去比（等价 SQL `WHERE openid IS NULL`），
  //    不能留 `undefined` —— `JSON.stringify` 会丢掉整个键，条件静默失效成「全表统计」。
  const owner = key === undefined ? null : key;
  const user = key
    ? await findOne(C.USER, _.or([{ openid: key }, { username: key }]))
    : null;

  const [totalCount, approved, rejected, pending] = await Promise.all([
    count(C.SUBMIT, { openid: owner }),
    count(C.SUBMIT, { openid: owner, reviewStatus: S.REVIEW.APPROVED }),
    count(C.SUBMIT, { openid: owner, reviewStatus: S.REVIEW.REJECTED }),
    count(C.SUBMIT, { openid: owner, reviewStatus: S.REVIEW.PENDING }),
  ]);

  // 源码用 `MIN/MAX(create_time)` 聚合；云数据库没有聚合 → 两次「排序 + limit:1」轻查询
  const [firstRows, lastRows] = await Promise.all([
    findMany(C.SUBMIT, { openid: owner }, { orderBy: [['createTime', 'asc']], limit: 1 }),
    findMany(C.SUBMIT, { openid: owner }, { orderBy: [['createTime', 'desc']], limit: 1 }),
  ]);
  const firstAt = firstRows[0] ? (firstRows[0].createTime === undefined ? null : firstRows[0].createTime) : null;
  const lastAt = lastRows[0] ? (lastRows[0].createTime === undefined ? null : lastRows[0].createTime) : null;

  let weekly = null;
  try { weekly = await submitRule.checkUserWeeklyLimit(key); } catch (e) { weekly = null; }

  const submitter = {
    key,
    isAccount: !!(user && user.username),
    nickname: (user && (user.nickname || user.remark)) || '匿名',
    username: (user && user.username) || '',
    className: (user && user.grade) ? roster.gradeLabel(user.grade, user.classNo) : '',
    grade: (user && user.grade) || '',
    classNo: (user && user.classNo) || '',
    seatNo: (user && user.seatNo) || '',
    status: user ? Number(user.status) : null,
    lastLoginAt: (user && user.lastLoginAt) || null,
    loginCount: Number((user && user.loginCount) || 0),
    total: totalCount,
    approved,
    rejected,
    pending,
    firstAt,
    lastAt,
    weekUsed: weekly ? weekly.used : null,
    weekLimit: weekly ? weekly.limit : null,
    weekRemaining: weekly ? weekly.remaining : null,
  };

  let reviewer = null;
  if (submit.reviewerId) {
    reviewer = await findOne(C.ADMIN, { id: Number(submit.reviewerId) });
  }
  const reviewerName = Number(submit.autoRejected) === 1
    ? '系统自动驳回'
    : (reviewer ? (reviewer.nickname || reviewer.username) : (Number(submit.reviewStatus) === 0 ? '' : '—'));

  // 协议：处理台要能看到「这首歌为什么现在是这个状态」+ 换过几次时段
  let statusHistory = [];
  let assignments = [];
  if (Number(submit.type) === 1) {
    try { statusHistory = await S.historyOf(submit.id, 50); } catch (e) { statusHistory = []; }
    try {
      assignments = await findMany(C.ASSIGNMENT_LOG, { requestId: Number(submit.id) }, { orderBy: [['id', 'asc']] });
    } catch (e) { assignments = []; }
  }

  const card = Number(submit.type) === 1
    ? await songQueue.cardFor(submit).catch(() => null)
    : null;

  return {
    ...withStatus(submit),
    nickname: submitter.nickname,
    studentNo: submitter.username,
    avatar: (user && user.avatar) || '',
    reviewerName,
    autoRejected: Number(submit.autoRejected) === 1,
    submitter,
    card,
    statusHistory,
    assignments,
  };
}

/* ------------------------------------------------------------------ *
 * 通过 / 驳回 / 删除 / 撤销
 * ------------------------------------------------------------------ */
/** PUT /admin/submit/:id/approve */
async function approve(ctx) {
  asAdmin(ctx);
  const submit = await submitOf(ctx);
  await assertWeekOpen(submit);                 // 已锁定的周不允许再审批

  const result = await approveOne(submit, ctx.admin.id);
  let fresh = result.submit;

  // 审核通过 → 进排期候选池 → 立刻跑一次该周的排期（幂等）
  // 这样管理员点完「通过」就能在矩阵上看到位置变化，不用额外点「执行排期」。
  let rel = null;
  if (result.changed && Number(fresh.type) === 1) {
    rel = await runWeekSchedule(fresh, { operatorId: ctx.admin.id });
    // ⚠️ 排期会**再改一次这条记录**（schedule_status 0 → 1/2）→ 必须回读（文件头 ⑦）
    fresh = await reread(fresh);
  }
  void rel;

  const data = withStatus(fresh);
  if (Number(fresh.type) === 1) {
    try { data.card = await songQueue.cardFor(fresh); } catch (e) { data.card = null; }
  }
  return data;
}

/** PUT /admin/submit/:id/reject */
async function reject(ctx) {
  asAdmin(ctx);
  const { reason } = ctx.body || {};
  if (!reason || String(reason).trim().length === 0) {
    throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');
  }
  const submit = await submitOf(ctx);
  await assertWeekOpen(submit);                 // 已锁定的周不允许再驳回

  const { submit: fresh, wasSeated } = await rejectOne(submit, ctx.admin.id, reason);

  // 驳回使 review 离开 APPROVED → 位子释放 → 立刻让候补重新对齐
  if (wasSeated && Number(fresh.type) === 1) {
    const rel = await runWeekSchedule(fresh, { operatorId: ctx.admin.id });
    void releaseMsg('已驳回，位子已释放', rel);
  }
  return withStatus(await reread(fresh));
}

/** DELETE /admin/submit/:id */
async function remove(ctx) {
  asAdmin(ctx);
  const submit = await submitOf(ctx);
  await assertWeekOpen(submit);                 // 已锁定的周不允许再删（会破坏已公布的排期）
  const wasSeated = Number(submit.type) === 1 && sched.isSeated(submit);
  const ms = Number(submit.type) === 1 ? weekMsOf(submit) : null;
  await removeWhere(C.SUBMIT, { id: Number(submit.id) });
  if (wasSeated && ms !== null) {
    await sched.runAllocators(ms, { operatorId: ctx.admin.id }).catch(() => null);
  }
  return null;
}

/**
 * PUT /admin/submit/:id/revoke   撤销审核结果（仅超管）
 *   审核通过(1) → 回到待审(0)；排期维度重置，位子释放并触发调剂
 *   已驳回(2)   → 回到待审(0)，重新走审核
 */
async function revoke(ctx) {
  asSuper(ctx);
  const submit = await submitOf(ctx);
  await assertWeekOpen(submit);                 // 已锁定的周不允许撤销
  const review = Number(submit.reviewStatus) || 0;
  if (review === S.REVIEW.PENDING) {
    throw new ApiError(Codes.PARAM_ERROR, '这条还是待审状态，无需撤销');
  }
  const wasSeated = sched.isSeated(submit);
  const fromSlot = submit.scheduledSlot || null;

  // 撤销 = 把三维一起归零（审核人 / 审核时间也清掉，撤销是操作者自己做的事）
  const r = await S.applyChange(submit, {
    reviewStatus: S.REVIEW.PENDING,
    scheduleStatus: S.SCHEDULE.UNASSIGNED,
    playStatus: S.PLAY.NOT_PLAYED,
    scheduledSlot: null,
    assignedAt: null,
    playedAt: null,
    rejectReason: null,
    reviewTime: null,
    reviewerId: null,
    autoRejected: 0,
  }, { operatorId: ctx.admin.id, operatorName: 'ADMIN', reason: 'REVOKED' });
  const row = r.conflict ? await reread(submit) : r.row;

  if (Number(row.type) === 1) {
    if (fromSlot) {
      await sched.logAssignment(row.id, fromSlot, null, sched.ASSIGN.RELEASED, sched.ASSIGN_REASON.slotReleased, ctx.admin.id);
    }
    if (wasSeated) {
      const rel = await runWeekSchedule(row, { operatorId: ctx.admin.id });
      void releaseMsg('已撤销，回到待审', rel);
    }
  }
  return withStatus(await reread(row));
}

/* ------------------------------------------------------------------ *
 * 批量审核
 * ------------------------------------------------------------------ */
/** POST /admin/submit/batch */
async function batch(ctx) {
  asAdmin(ctx);
  const { ids, action, reason } = ctx.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(Codes.PARAM_ERROR, '请选择要操作的记录');
  }
  if (!['approve', 'reject'].includes(action)) {
    throw new ApiError(Codes.PARAM_ERROR, '操作类型错误');
  }
  if (action === 'reject' && !reason) {
    throw new ApiError(Codes.PARAM_ERROR, '驳回操作必须填写理由');
  }

  let affected = 0;
  const skipped = [];
  const weeks = new Set();

  for (const raw of ids) {
    const id = parseId(raw);
    const submit = id === null ? null : await findOne(C.SUBMIT, { id });
    if (!submit) { skipped.push(raw); continue; }
    try {
      await assertWeekOpen(submit);            // 已锁定的周整条跳过（记 skipped，不报错中断）
      if (action === 'approve') {
        const r = await approveOne(submit, ctx.admin.id);
        if (r.changed) affected += 1; else skipped.push(raw);
      } else {
        const r = await rejectOne(submit, ctx.admin.id, reason);
        affected += 1;
        if (r.wasSeated) { const ms = weekMsOf(submit); if (ms !== null) weeks.add(ms); }
      }
      if (Number(submit.type) === 1) {
        const ms = weekMsOf(submit);
        if (ms !== null) weeks.add(ms);
      }
    } catch (e) {
      if (e instanceof ApiError) { skipped.push(raw); continue; }
      throw e;
    }
  }

  // 涉及的每一周统一重跑排期（一次，而不是每条约一次）
  for (const ms of weeks) {
    await sched.initialAllocate(ms, { operatorId: ctx.admin.id }).catch(() => null);
    await sched.runAllocators(ms, { operatorId: ctx.admin.id }).catch(() => null);
  }

  return { affected, skipped };
}

/* ------------------------------------------------------------------ *
 * 排期：矩阵 / 执行 / 锁定 / 人工调整 / 播放
 * ------------------------------------------------------------------ */
/** 先算一条点歌属于哪个周（没有排期行时用「首选时段」推） */
async function targetWeekMs(now = Date.now()) {
  const slots = await broadcastSlot.getSlots(now);
  if (slots.list.length) {
    const ws = sched.weekStartOfValue(slots.list[0].value);
    if (ws) return ws.getTime();
  }
  return songWindow.windowRangeAt(await songWindow.getConfig(now), now).weekStart.getTime();
}

/** 解析 body/query 里的 weekStart（'YYYY-MM-DD' → 北京时间当天 00:00） */
function weekStartMsOf(v) {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** GET /admin/submit/schedule   排期矩阵（三维）+ 全局候补队列 */
async function schedule(ctx) {
  asAdmin(ctx);
  const now = Date.now();
  const slots = await broadcastSlot.getSlots(now);
  const values = slots.list.map((s) => s.value);
  const capacity = await songQueue.getCapacity();
  const weekMs = values.length ? sched.weekStartOfValue(values[0]).getTime() : await targetWeekMs(now);
  const week = await sched.ensureWeek(weekMs, { now });

  // ① 每格已占（review=APPROVED AND schedule=APPROVED）
  const seatedMap = await sched.countSeatedBySlot(values);

  // ② 每格「首选这一格但还在候补」/ ③ 「还在审核中」—— 源码用 GROUP BY，
  //    云端无聚合 → 全量拉「首选落在本周格子内」的子集再 JS 计数（集合有天然上限）。
  //
  // ⚠️ ③ 的「审核中」**不能**再加 scheduleStatus 条件：审核中的行 scheduleStatus 恒为
  //    UNASSIGNED，写成 `scheduleStatus: _.in([APPROVED, WAITING])` 会把它们整批滤掉，
  //    于是矩阵上「待审」格子永远显示 0（静默错，不报错）。所以用 `_.or` 分两支：
  const scoped = await findAllPaged(C.SUBMIT, _.and([
    { type: 1, wantBroadcastTime: _.in(values) },
    _.or([
      { reviewStatus: S.REVIEW.PENDING },                                              // 还在审核中
      { reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.WAITING },         // 首选满、在候补
    ]),
  ]), { max: 3000 });
  const waitingMap = {};
  const pendingMap = {};
  scoped.forEach((r) => {
    const v = r.wantBroadcastTime;
    if (r.reviewStatus === S.REVIEW.PENDING) pendingMap[v] = (pendingMap[v] || 0) + 1;
    else if (r.scheduleStatus === S.SCHEDULE.WAITING) waitingMap[v] = (waitingMap[v] || 0) + 1;
  });

  const days = [];
  let byDate = null;
  let totalPending = 0;
  let totalScheduled = 0;
  slots.list.forEach((s) => {
    if (!byDate || byDate.date !== s.date) {
      byDate = { date: s.date, weekday: s.weekday, monthDay: s.monthDay, slots: [] };
      days.push(byDate);
    }
    const seated = seatedMap[s.value] || 0;
    const waiting = waitingMap[s.value] || 0;
    const pending = pendingMap[s.value] || 0;
    totalPending += pending;
    totalScheduled += seated;
    byDate.slots.push({
      value: s.value,
      date: s.date,
      time: s.time,
      period: s.period,
      label: s.label,
      scheduled: seated,          // 已排期（占位）
      waiting,                    // 首选这一格、还在候补
      pending,                    // 还在审核中
      approved: seated,           // 兼容旧字段名
      promoted: 0,                // 兼容旧字段名（协议版没有「补位未审」）
      seated,
      left: capacity > 0 ? Math.max(0, capacity - seated) : null,
      capacity,
      full: capacity > 0 && seated >= capacity,
    });
  });

  const [queue, win] = await Promise.all([songQueue.snapshot(now), songWindow.status(now)]);
  const lockAt = week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null;

  return {
    weekStart: slots.weekStart,
    weekEnd: slots.weekEnd,
    rangeText: slots.rangeText,
    capacity,
    weekCapacity: queue.weekCapacity,
    totalPending,
    totalScheduled,
    totalWaiting: queue.total,
    days,
    queue,
    week: sched.weekView(week, now),
    window: win,
    lockAt,
    /** @deprecated 旧字段名（= 锁定时刻） */
    finalizeAt: lockAt,
  };
}

/** GET /admin/submit/week   目标周的状态与时间锚点 */
async function week(ctx) {
  asAdmin(ctx);
  const now = Date.now();
  const ms = weekStartMsOf(ctx.query && ctx.query.weekStart) || await targetWeekMs(now);
  const row = await sched.ensureWeek(ms, { now });
  const values = await sched.slotValuesOfWeek(ms);
  const counters = await sched.countSeatedBySlot(values);
  const capacity = await songQueue.getCapacity();
  const seated = Object.values(counters).reduce((a, b) => a + b, 0);
  const total = capacity > 0 ? values.length * capacity : 0;
  return {
    ...sched.weekView(row, now),
    slots: values.length,
    capacity,
    seated,
    left: total ? Math.max(0, total - seated) : null,
    total,
  };
}

/** POST /admin/submit/schedule/run   执行第一轮排期 + 全局调剂（仅超管） */
async function runSchedule(ctx) {
  asSuper(ctx);
  const now = Date.now();
  const body = ctx.body || {};
  const ms = weekStartMsOf(body.weekStart) || await targetWeekMs(now);
  await assertWeekNotLocked(ms, '这一周');    // 锁定后不允许重跑排期

  // 超管手动执行 = 完整调度，**显式**放开跨时段调剂：
  // 自动路径要等点播截止才跨时段，手动执行是管理员的明确意图，不受该闸门限制。
  const a = await sched.initialAllocate(ms, { now, operatorId: ctx.admin.id });
  const b = await sched.reschedule(ms, { now, operatorId: ctx.admin.id, crossSlot: true });
  const row = await sched.ensureWeek(ms, { now });
  return {
    week: sched.weekView(row, now),
    crossSlot: b.crossSlot,
    assigned: a.assigned,
    waiting: a.waiting,
    promoted: b.promoted,
    rescheduled: b.rescheduled,
    stillWaiting: b.left,
  };
}

/**
 * POST /admin/submit/schedule/preview   模拟排期（只算不写库，仅超管）
 *
 * body: { weekStart?, crossSlot? }
 *   crossSlot 省略 = 按「点播是否已截止」自动判断（与自动路径一致）；
 *   传 true 可预览「如果现在放开跨时段会怎样」。
 */
async function previewSchedule(ctx) {
  asSuper(ctx);
  const now = Date.now();
  const body = ctx.body || {};
  const ms = weekStartMsOf(body.weekStart) || await targetWeekMs(now);
  const row = await sched.ensureWeek(ms, { now });
  const values = await sched.slotValuesOfWeek(ms);
  const capacity = await sched.getCapacity();
  const counters = await sched.countSeatedBySlot(values);
  const crossSlot = body.crossSlot === undefined || body.crossSlot === null
    ? null                                  // null = 交给算法按点播截止时间判断
    : !!body.crossSlot;

  const a = await sched.initialAllocate(ms, { now, dryRun: true });
  const b = await sched.reschedule(ms, { now, dryRun: true, crossSlot });

  // dryRun 不写库 → 「模拟后各格占用」只能从动作清单自己推
  const after = { ...counters };
  [...a.actions, ...b.actions].forEach((x) => {
    if (x.to) after[x.to] = (after[x.to] || 0) + 1;
  });

  const actions = [...a.actions, ...b.actions];
  const ids = [...new Set(actions.map((x) => Number(x.id)).filter((n) => Number.isInteger(n)))];
  const byId = new Map();
  for (const part of chunk(ids, IN_CHUNK)) {
    const rows = await findMany(
      C.SUBMIT,
      { id: _.in(part) },
      { limit: IN_CHUNK }
    );
    rows.forEach((r) => byId.set(Number(r.id), r));
  }

  const detailOf = (x) => {
    const r = byId.get(Number(x.id)) || {};
    return {
      id: x.id,
      songName: r.songName || x.songName || '',
      singer: r.singer || '',
      submittedAt: r.createTime || null,
      want: x.want || r.wantBroadcastTime || '',
      to: x.to || null,
      cost: x.cost === undefined ? null : x.cost,   // 成本表档位（0/10/20/30/50）
    };
  };

  const assign = a.actions.filter((x) => x.action === 'ASSIGN').map(detailOf);
  const promote = b.actions.filter((x) => x.action === 'PROMOTE').map(detailOf);
  const rescheduled = b.actions.filter((x) => x.action === 'RESCHEDULE').map(detailOf);
  const waiting = [
    ...a.actions.filter((x) => x.action === 'WAITING'),
    ...b.actions.filter((x) => x.action === 'WAITING'),
  ].map(detailOf);

  return {
    dryRun: true,
    week: sched.weekView(row, now),
    crossSlot: b.crossSlot,
    crossSlotReason: b.crossSlot
      ? '点播已截止（或手动指定），允许跨时段调剂'
      : '点播未截止，只做原位递补 —— 别处的空位要留给首选那一格的原申请者',
    slots: values.map((v) => ({
      value: v,
      seated: counters[v] || 0,
      after: after[v] || 0,
      capacity,
      full: capacity > 0 && (after[v] || 0) >= capacity,
    })),
    // waiting = 现在仍排不上的人；到了锁定时刻他们会被 AUTO_REJECTED
    plan: { assign, promote, rescheduled, waiting },
    summary: {
      assigned: a.assigned,
      waiting: a.waiting,
      promoted: b.promoted,
      rescheduled: b.rescheduled,
      stillWaiting: b.left,
      autoRejectedIfLocked: waiting.length,
    },
  };
}

/** POST /admin/submit/schedule/lock   正式锁定（仅超管；body.force 可提前锁） */
async function lock(ctx) {
  asSuper(ctx);
  const now = Date.now();
  const body = ctx.body || {};
  const ms = weekStartMsOf(body.weekStart) || await targetWeekMs(now);
  const force = body.force === true || body.force === 1 || body.force === '1';
  const r = await sched.lockWeek(ms, { now, operatorId: ctx.admin.id, force });
  if (r.tooEarly) {
    throw new ApiError(Codes.PARAM_ERROR, `还没到锁定时刻（${r.lockText}），如需提前锁定请传 force: true`);
  }
  return r;
}

/**
 * POST /admin/submit/schedule/unlock   解锁（撤销锁定，仅超管）
 * body: { weekStart?, restore? }  restore 显式 false 才不解冻被自动驳回的候补
 */
async function unlock(ctx) {
  asSuper(ctx);
  const now = Date.now();
  const body = ctx.body || {};
  const ms = weekStartMsOf(body.weekStart) || await targetWeekMs(now);
  const restore = body.restore === undefined || body.restore === null ? true : !!body.restore;
  return sched.unlockWeek(ms, { now, operatorId: ctx.admin.id, restore });
}

/** POST /admin/submit/:id/assign   人工指定时段（仅超管） */
async function assign(ctx) {
  asSuper(ctx);
  const { slot, reason } = ctx.body || {};
  if (!slot) throw new ApiError(Codes.PARAM_ERROR, '请传 slot（目标时段值）');
  const submit = await submitOf(ctx);
  if (Number(submit.type) !== 1) throw new ApiError(Codes.PARAM_ERROR, '只能对点歌做排期调整');
  // 原归属周 与 目标时段所属周 都不能是已锁定的周
  await assertWeekOpen(submit);
  const targetWs = sched.weekStartOfValue(String(slot));
  const targetMs = targetWs ? targetWs.getTime() : null;
  await assertWeekNotLocked(targetMs, '目标时段所属周');

  try {
    const r = await sched.manualAssign(submit, String(slot), {
      operatorId: ctx.admin.id,
      reason: reason || sched.ASSIGN_REASON.manual,
    });
    // 新位置占了，原位置空了 → 重新对齐候补（targetMs 为 null 时 manualAssign 早已抛错）
    if (targetMs !== null) {
      await sched.runAllocators(targetMs, { operatorId: ctx.admin.id }).catch(() => null);
    }
    return withStatus(await reread(r.row));
  } catch (e) {
    if (e.code === 40001) throw new ApiError(Codes.PARAM_ERROR, e.message);
    throw e;
  }
}

/** PUT /admin/submit/:id/played   标记已播放 / 取消（仅超管） */
async function played(ctx) {
  asSuper(ctx);
  const submit = await submitOf(ctx);
  await assertWeekOpen(submit);                 // 已锁定的周不允许人工改播放标记
  const body = ctx.body || {};
  const want = body.played === undefined ? true : !!body.played;
  const r = await sched.setPlayed(submit, want, { operatorId: ctx.admin.id });
  return withStatus(await reread(r.row));
}

/** GET /admin/submit/:id/status-logs */
async function statusLogs(ctx) {
  asAdmin(ctx);
  const id = parseId(ctx.params && ctx.params.id);
  return S.historyOf(id === null ? -1 : id, 100);
}

/* ------------------------------------------------------------------ *
 * 容量 / 兜底
 * ------------------------------------------------------------------ */
/** GET /admin/submit/capacity（= 旧路径 GET /admin/submit/quota） */
async function capacity(ctx) {
  asAdmin(ctx);
  return songQueue.capacitySnapshot();
}

/**
 * PUT /admin/submit/quota   设置每格容量（仅超管）
 * body: { capacity? }
 * ⚠️ `queueLimit` 在协议版已废弃 —— 候补没有人数上限，传了也不生效（与源码一致）。
 */
async function setQuota(ctx) {
  asSuper(ctx);
  const { capacity: cap } = ctx.body || {};
  if (cap !== undefined && cap !== null && cap !== '') {
    await broadcastSlot.setCapacity(cap);
  }
  await broadcastSlot.clearCache();
  // 改容量后立刻重跑排期（可能多出位置 / 少掉位置），行为符合直觉。
  // ⚠️ 已锁定的周不重算 —— 那是定稿数据，改容量不该反悔它。
  const now = Date.now();
  const ms = await targetWeekMs(now);
  const wk = await sched.ensureWeek(ms, { now });
  const locked = wk.status === sched.WEEK_STATUS.LOCKED;
  if (!locked) {
    await sched.initialAllocate(ms, { now, operatorId: ctx.admin.id }).catch(() => null);
    await sched.runAllocators(ms, { now, operatorId: ctx.admin.id }).catch(() => null);
  }
  return songQueue.snapshot(now);
}

/** POST /admin/submit/queue/sweep（= 旧路径 POST /admin/submit/quota/sweep）幂等，仅超管 */
async function sweepQueue(ctx) {
  asSuper(ctx);
  return sched.sweep({ now: Date.now(), operatorId: ctx.admin.id });
}

/* ------------------------------------------------------------------ *
 * 点歌设置：注意事项 / 播出时段 / 提交规则
 * ------------------------------------------------------------------ */
/** GET /admin/submit/notice */
async function notice(ctx) {
  asAdmin(ctx);
  return songNotice.getAllForAdmin();
}

/** PUT /admin/submit/notice   注意：**管理员即可**（源码此处不是超管） */
async function saveNotice(ctx) {
  asAdmin(ctx);
  const { content, type } = ctx.body || {};
  if (content === undefined) {
    throw new ApiError(Codes.PARAM_ERROR, '请传 content（允许空字符串表示停用）');
  }
  try {
    return await songNotice.save(content, type);
  } catch (e) {
    throw paramError(e);   // 内容超 5000 字 → 源控制器翻成 40001
  }
}

/** GET /admin/submit/timeslots */
async function timeslots(ctx) {
  asAdmin(ctx);
  return broadcastSlot.getAdminConfig();
}

/** GET /admin/submit/window */
async function window(ctx) {
  asAdmin(ctx);
  return songWindow.describe();
}

/** PUT /admin/submit/window（仅超管） */
async function saveWindow(ctx) {
  asSuper(ctx);
  const body = ctx.body || {};
  await songWindow.setConfig(body, ctx.admin.id);
  return songWindow.describe();
}

/** PUT /admin/submit/slots（仅超管） */
async function saveSlots(ctx) {
  asSuper(ctx);
  const { times, capacity: cap } = ctx.body || {};
  if (!Array.isArray(times)) {
    throw new ApiError(Codes.PARAM_ERROR, '请传 times 数组，如 [{time:"12:20",label:"午间"}]');
  }
  try {
    return await broadcastSlot.setSlotTimes(times, cap);
  } catch (e) {
    throw paramError(e);   // 时段全非法 → 源控制器翻成 40001
  }
}

/** GET /admin/submit/rules */
async function rules(ctx) {
  asAdmin(ctx);
  const r = await submitRule.getRules();
  return { ...r, defaultUserLimit: submitRule.DEFAULT_USER_LIMIT };
}

/** PUT /admin/submit/rules（仅超管） */
async function saveRules(ctx) {
  asSuper(ctx);
  const { weeklyUserLimit, dupBlock } = ctx.body || {};
  const r = await submitRule.setRules({ weeklyUserLimit, dupBlock });
  return { ...r, defaultUserLimit: submitRule.DEFAULT_USER_LIMIT };
}

/**
 * DELETE /admin/submit/songs   一键清空全部点歌数据（仅超管）
 * body: { confirm: 'DELETE' }
 *
 * ⚠️ 无跨文档事务（文件头 ⑤）：分批「先删日志、再删点歌」，重跑即收敛。
 */
async function purgeSongs(ctx) {
  asSuper(ctx);
  const { confirm } = ctx.body || {};
  if (confirm !== 'DELETE') {
    throw new ApiError(Codes.PARAM_ERROR, '高危操作：请传 confirm: "DELETE" 明确确认');
  }
  let deleted = 0;
  let logs = 0;
  // 每轮取 100 条（云函数端单次 get 上限），删完再取，直到没有点歌为止
  for (let guard = 0; guard < 10000; guard++) {
    const rows = await findMany(C.SUBMIT, { type: 1 }, { limit: IN_CHUNK });
    const ids = rows.map((r) => r.id).filter((v) => v !== undefined && v !== null);
    if (!ids.length) break;                    // 没有可删的合法 id（或已清空）→ 退出
    // 先删两张日志的对应行（否则会留下指向不存在点歌的孤儿行）
    await removeWhere(C.ASSIGNMENT_LOG, { requestId: _.in(ids) });
    await removeWhere(C.STATUS_LOG, { requestId: _.in(ids) });
    logs += ids.length;
    deleted += await removeWhere(C.SUBMIT, { id: _.in(ids) });
    if (rows.length < IN_CHUNK) break;         // 最后一批
  }
  return { deletedSongs: deleted, logsCleared: logs };
}

module.exports = {
  list,
  detail,
  approve,
  reject,
  revoke,
  remove,
  batch,
  schedule,
  week,
  previewSchedule,
  runSchedule,
  lock,
  unlock,
  assign,
  played,
  statusLogs,
  capacity,
  setQuota,
  sweepQueue,
  notice,
  saveNotice,
  timeslots,
  window,
  saveWindow,
  saveSlots,
  rules,
  saveRules,
  purgeSongs,
};
