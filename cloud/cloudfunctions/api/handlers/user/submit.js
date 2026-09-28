'use strict';

/**
 * 用户端 · 投稿 / 点歌（协议版）—— 迁移自 src/controllers/user/submitController.js
 *
 *   POST   /user/submit                  提交投稿（点歌 / 文稿）
 *   GET    /user/submit/my               我的投稿（分页）
 *   GET    /user/submit/quota            排期 / 候补 / 时间窗口 状态
 *   GET    /user/submit/window           点歌时间窗口状态（常驻展示用）
 *   GET    /user/submit/week             本周已排期歌单（首页）
 *   GET    /user/submit/notice           点歌注意事项
 *   POST   /user/submit/notice/ack       确认已阅读
 *   GET    /user/submit/timeslots        系统下发的可选播出时段
 *   GET    /user/submit/:id              投稿详情（只能看自己的）
 *   DELETE /user/submit/:id              取消自己的待审投稿
 *   POST   /user/submit/:id/leave-queue  放弃候补
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 与 v2 最重要的一条差别：**提交时不判容量**。
 *   旧：格子满 → 直接进候补（status=3）；格子+候补都满 → 40904 不让提交。
 *   新：一律 PENDING_REVIEW，谁都能投；究竟排不排得上，是**审核通过后**
 *       由排期算法（services/scheduling）按「首选时段 + 提交时间」决定的。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ 拦截顺序 = 前端契约，**不要调整**（原控制器注释里写明的理由）：
 *   ① 点歌窗口最前（fail fast，不浪费后续查询与微信接口调用）
 *   ② 注意事项确认（40303，前端据此弹注意事项）
 *   ③ 时段合法性 / 同曲重复 / 周次数 —— 放在**内容安全检测之前**，
 *      先拦掉注定不能提交的，别白花一次微信接口调用
 *   ④ 字段长度 → 1 分钟防重复（40901）→ 内容安全（60002）→ 落库
 *
 * ⚠️ 本组只有 5 个拦截码在生产路径上：40303 / 40907 / 40001 / 40903 / 40901。
 *    `40902 / 40904 / 40906` 已无任何生产路径，别再引用。
 */

const { C, _, findOne, findMany, insertOne, count, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { requireUser } = require('../../lib/auth');
const switchService = require('../../services/switch');
const songQueue = require('../../services/songQueue');
const songWindow = require('../../services/songWindow');
const songNotice = require('../../services/songNotice');
const broadcastSlot = require('../../services/broadcastSlot');
const submitRule = require('../../services/submitRule');
const S = require('../../services/songStatus');
const sched = require('../../services/scheduling');
const { msgSecCheck } = require('../../services/wechat');
const { getAccessToken } = require('../../services/accessToken');

const ARTICLE_CONTENT_MAX = 5000;
const WISH_CONTENT_MAX = 500;

/** 给接口对象塞上三维状态视图（前端从单 status 迁移到三维时用得上） */
function withStatus(o) {
  return { ...o, ...S.statusView(o) };
}

/**
 * 新投稿的完整字段集 —— **刻意把 null 字段也写全**。
 *
 * ⚠️ 云数据库是文档型：没写的字段读出来是 `undefined`，而 `JSON.stringify` 会
 *    **丢掉 undefined 键** → 前端拿到的对象形状会随「这条投稿有没有排过期」而变，
 *    `'scheduledSlot' in obj` 之类的判断直接失效。原 MySQL 表每列都有默认值，
 *    所以这里补齐，保证新旧数据的形状一致（也方便阶段 8 迁移比对）。
 */
function newSubmitDoc(fields) {
  return {
    id: fields.id,
    openid: fields.openid,
    type: fields.type,
    // 点歌字段
    songName: null,
    singer: null,
    wishContent: null,
    // 文稿字段
    articleTitle: null,
    articleContent: null,
    // 通用
    wantBroadcastTime: null,
    // v2 排期 / 候补（协议版仍保留列，语义由三维接管）
    scheduledSlot: null,
    queueAt: null,
    promotedAt: null,
    // 三维状态
    reviewStatus: S.REVIEW.PENDING,
    scheduleStatus: S.SCHEDULE.UNASSIGNED,
    playStatus: S.PLAY.NOT_PLAYED,
    allowReschedule: 1,
    assignedAt: null,
    playedAt: null,
    status: S.deriveStatus(S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED, S.PLAY.NOT_PLAYED),
    rejectReason: null,
    reviewerId: null,
    reviewTime: null,
    autoRejected: 0,
    createTime: fields.now,
    updateTime: fields.now,
    ...fields.extra,
  };
}

/* ══════════════════ 提交投稿 ══════════════════ */
/**
 * body:
 *   点歌: { type:1, songName, singer, wishContent, wantBroadcastTime, allowReschedule? }
 *   文稿: { type:2, articleTitle, articleContent, wantBroadcastTime? }
 */
async function create(ctx) {
  const me = await requireUser(ctx);
  const openid = me.openid;
  const body = ctx.body || {};
  const type = Number(body.type);

  if (![1, 2].includes(type)) {
    throw new ApiError(Codes.PARAM_ERROR, '投稿类型必须为1或2');
  }

  // 模块开关拦截（云函数无预热，必须 await；见 services/switch.js 头注）
  await switchService.assertEnabled(type === 1 ? 'submit_song' : 'submit_article');

  // ① 点歌时间窗口（硬约束，服务端唯一权威判定，不信前端）
  if (type === 1) {
    await songWindow.assertOpen();
  }

  // ② 注意事项必须确认过当前版本
  const gate = await songNotice.assertAcked(openid, type === 1 ? 'song' : 'article');
  if (!gate.ok) {
    throw new ApiError(Codes.NOTICE_UNACKED, gate.reason);
  }

  // ③ 点歌：时段必须是系统下发的 + 提交规则（同曲去重 / 周次数）
  if (type === 1) {
    if (!body.wantBroadcastTime) {
      throw new ApiError(Codes.PARAM_ERROR, '请选择希望播出的时段');
    }
    if (!(await broadcastSlot.isValidSlot(body.wantBroadcastTime))) {
      throw new ApiError(Codes.PARAM_ERROR, '播出时段只能选下周一到周五内的可选时段，请重新选择');
    }
    const rule = await submitRule.checkSubmit({ openid, songName: body.songName });
    if (!rule.ok) {
      throw new ApiError(Codes.SUBMIT_REJECTED, rule.message);
    }
  }

  // ④ 字段校验
  if (type === 1) {
    if (!body.songName || !body.singer) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写歌曲名和歌手');
    }
    if ((body.wishContent || '').length > WISH_CONTENT_MAX) {
      throw new ApiError(Codes.PARAM_ERROR, '祝福语过长');
    }
  } else {
    if (!body.articleTitle || !body.articleContent) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写文稿标题和内容');
    }
    if ((body.articleContent || '').length > ARTICLE_CONTENT_MAX) {
      throw new ApiError(Codes.PARAM_ERROR, `文稿内容不能超过${ARTICLE_CONTENT_MAX}字`);
    }
  }

  // ⑤ 防重复提交：相同 openid/type/歌名(标题) 1 分钟内只允许一次
  const dupWhere = {
    openid,
    type,
    createTime: _.gte(new Date(Date.now() - 60 * 1000)),
  };
  if (type === 1) dupWhere.songName = body.songName;
  else dupWhere.articleTitle = body.articleTitle;
  const recent = await findOne(C.SUBMIT, dupWhere);
  if (recent) {
    throw new ApiError(Codes.CONFLICT, '请勿重复提交');
  }

  // ⑥ 内容安全检测（异常一律 pass，见 services/wechat.js）
  const token = await getAccessToken();
  const text = type === 1
    ? `${body.songName} ${body.singer} ${body.wishContent || ''}`
    : `${body.articleTitle} ${body.articleContent}`;
  const sec = await msgSecCheck(text, token);
  if (!sec.pass) {
    throw new ApiError(Codes.CONTENT_BLOCKED, '内容包含敏感信息，请修改后重试');
  }

  const now = new Date();

  /* ── 文稿：直接落库 ────────────────────────────────────────────── */
  if (type === 2) {
    const id = await nextId(C.SUBMIT);
    await insertOne(C.SUBMIT, newSubmitDoc({
      id,
      openid,
      type,
      now,
      extra: {
        articleTitle: body.articleTitle || null,
        articleContent: body.articleContent || null,
        wantBroadcastTime: body.wantBroadcastTime || null,
      },
    }));
    return { id, outcome: 'submitted' };
  }

  /* ── 点歌落库（不判容量）──────────────────────────────────────────
   *   reviewStatus = PENDING（等审核）
   *   scheduleStatus = UNASSIGNED（还没参与排期）
   *   排期要等审核通过后由 services/scheduling 统一算
   */
  const allowReschedule = (body.allowReschedule === false || Number(body.allowReschedule) === 0) ? 0 : 1;
  const targetWeek = sched.weekStartOfValue(body.wantBroadcastTime);
  if (!targetWeek) {
    throw new ApiError(Codes.PARAM_ERROR, '播出时段无法识别，请重新选择');
  }
  // 排期行懒创建（用户提交即建，管理员不用先「创建下周排期」）
  let week;
  try {
    week = await sched.ensureWeek(targetWeek.getTime());
  } catch (e) {
    throw new ApiError(Codes.SERVER_ERROR, `排期初始化失败：${e.message}`);
  }

  const id = await nextId(C.SUBMIT);
  await insertOne(C.SUBMIT, newSubmitDoc({
    id,
    openid,
    type: 1,
    now,
    extra: {
      songName: body.songName || null,
      singer: body.singer || null,
      wishContent: body.wishContent || null,
      wantBroadcastTime: body.wantBroadcastTime || null,
      allowReschedule,
    },
  }));

  return {
    id,
    outcome: 'submitted',
    reviewStatus: S.REVIEW.PENDING,
    scheduleStatus: S.SCHEDULE.UNASSIGNED,
    allowReschedule: !!allowReschedule,
    week: sched.weekView(week),
    weekText: `${week.weekStartDate} 起那一周`,
    lockAt: week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
  };
}

/* ══════════════════ 注意事项 ══════════════════ */

/** GET /user/submit/notice?type=song|article */
async function notice(ctx) {
  const me = await requireUser(ctx);
  return songNotice.getForUser(me.openid, (ctx.query || {}).type);
}

/** POST /user/submit/notice/ack   body: { version, type? } */
async function ackNotice(ctx) {
  const me = await requireUser(ctx);
  const { version, type } = ctx.body || {};
  const st = await songNotice.ack(me.openid, version, type);
  return st;
}

/* ══════════════════ 时段 ══════════════════ */
/**
 * GET /user/submit/timeslots
 *
 * ⚠️⚠️ **必须鉴权** —— 虽然原 controller 里没读 `req.user`，但源路由
 *    `router.get('/submit/timeslots', userAuth, ...)` 挂了中间件，未登录会 40101。
 *    移植时只搬了 controller 函数，**路由层的中间件极易被漏掉**：
 *    漏掉不会报错，只会「未登录也能看」，属于契约漂移。
 *    本组里 `timeslots` / `window` / `notice` / `ackNotice` / `quota` / `my` / `detail`
 *    / `cancel` / `leaveQueue` / `create` 全部需要登录；
 *    **只有 `/user/submit/week` 不需要**（源路由确实没挂 userAuth）。
 *
 * ⚠️ 协议版语义变化：格子上的 capacity / seated 是**排期结果**，不是「谁先提交谁占住」。
 *    所以 `full` 只是「预计很难排上」的提示，**不阻止提交**（提交后仍可能被调剂到别处）。
 */
async function timeslots(ctx) {
  await requireUser(ctx);
  const now = Date.now();
  const slots = await broadcastSlot.getSlots(now);
  const usage = await songQueue.slotUsage(slots.list.map((s) => s.value), now);
  const list = slots.list.map((s) => {
    const u = usage[s.value] || { capacity: slots.capacity, seated: 0, left: null, full: false };
    return {
      ...s,
      capacity: u.capacity,
      seated: u.seated,
      picked: u.seated,          // 兼容旧字段名
      left: u.left,
      full: u.full,
      canBuffer: !u.full,        // 满了也还能提交（会进候补参与调剂）
    };
  });
  const [waiting, win] = await Promise.all([
    songQueue.countWaiting(),
    songWindow.status(now),
  ]);
  const weekStartMs = list.length ? sched.weekStartOfValue(list[0].value).getTime() : null;
  const week = weekStartMs ? await sched.ensureWeek(weekStartMs, { now }) : null;

  return {
    ...slots,
    list,
    // 协议版候补没有人数上限（审核通过的人理应能排队）
    queue: { used: waiting, limit: 0, limitAuto: true, full: false, unlimited: true },
    week: week ? sched.weekView(week, now) : null,
    lockAt: week && week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
    window: win,
  };
}

/**
 * GET /user/submit/window
 * 前端不要硬编码星期与时刻 —— 管理员一改配置，这里立刻变
 *
 * ⚠️ 同样必须鉴权（源路由挂了 userAuth），理由见 timeslots 上方注释。
 */
async function windowStatus(ctx) {
  await requireUser(ctx);
  const now = Date.now();
  const st = await songWindow.status(now);
  // 顺带把「这一周的排期锁定时刻」给前端，学生端可以显示「本周排期 X 日锁定」
  let week = null;
  try {
    const ws = songWindow.windowRangeAt(st.config, now).weekStart;
    const row = await sched.ensureWeek(ws.getTime(), { now });
    week = sched.weekView(row, now);
  } catch (e) { week = null; }
  return { ...st, week };
}

/** GET /user/submit/week —— 小程序首页展示用 */
async function weekSchedule() {
  if (!(await switchService.isEnabledAsync('home_song_schedule'))) {
    return { visible: false, rangeText: '', days: [] };
  }
  const data = await broadcastSlot.currentWeekSchedule();
  return { visible: true, ...data };
}

/* ══════════════════ 一站式状态 ══════════════════ */
/** GET /user/submit/quota —— 投稿页提前提示用 */
async function quota(ctx) {
  const me = await requireUser(ctx);
  const now = Date.now();
  const [win, waiting, capacity, weekCap, mine] = await Promise.all([
    songWindow.status(now),
    songQueue.countWaiting(),
    songQueue.getCapacity(),
    songQueue.weekCapacity(now),
    submitRule.checkUserWeeklyLimit(me.openid),
  ]);
  const ws = songWindow.windowRangeAt(win.config, now).weekStart;
  const week = await sched.ensureWeek(ws.getTime(), { now }).catch(() => null);
  return {
    window: win,
    week: week ? sched.weekView(week, now) : null,
    lockAt: week && week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
    song: {
      capacity,                                    // 每格正式位（0 = 不限）
      weekCapacity: weekCap,                       // 下周正式位总数（0 = 不限）
      queue: { used: waiting, limit: 0, limitAuto: true, full: false, unlimited: true },
    },
    userWeekly: { used: mine.used, limit: mine.limit, remaining: mine.remaining },
  };
}

/* ══════════════════ 我的投稿 ══════════════════ */
/**
 * GET /user/submit/my?status=&page=&pageSize=
 * ⚠️ 旧前端按单 status 筛选；协议版真值是三维，所以筛的是**派生镜像**列，
 *    行为与旧版一致，前端可以慢慢迁到三维。
 */
async function myList(ctx) {
  const me = await requireUser(ctx);
  const q = ctx.query || {};
  const page = parseInt(q.page, 10) || 1;
  const pageSize = parseInt(q.pageSize, 10) || 10;
  const where = { openid: me.openid };
  if (q.status !== undefined && q.status !== '') {
    where.status = parseInt(q.status, 10);
  }
  const offset = (page - 1) * pageSize;

  const [rows, total] = await Promise.all([
    findMany(C.SUBMIT, where, { orderBy: [['createTime', 'desc']], skip: offset, limit: pageSize }),
    count(C.SUBMIT, where),
  ]);

  const list = await Promise.all(rows.map(async (r) => {
    const o = withStatus(r);
    if (Number(r.type) === 1) {
      try { o.card = await songQueue.cardFor(r); } catch (e) { o.card = null; }
    } else {
      o.card = null;
    }
    return o;
  }));

  return {
    list,
    total,
    page,
    pageSize,
    cards: list.map((r) => r.card).filter(Boolean),
  };
}

/** GET /user/submit/:id —— 只能看自己的 */
async function detail(ctx) {
  const me = await requireUser(ctx);
  const id = parseId((ctx.params || {}).id);
  const submit = id === null ? null : await findOne(C.SUBMIT, { id, openid: me.openid });
  if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');

  const out = withStatus(submit);
  if (Number(submit.type) === 1) {
    try { out.card = await songQueue.cardFor(submit); } catch (e) { out.card = null; }
    try { out.statusHistory = await S.historyOf(submit.id, 20); } catch (e) { out.statusHistory = []; }
  }
  return out;
}

/* ══════════════════ 取消 / 放弃候补 ══════════════════ */
/**
 * 把一条点歌置为「已取消」（协议里的 CANCELLED 终态）。
 * ⚠️ 不删行 —— 删行会丢掉「他投过什么」，后台就没法回答
 *    「这首歌为什么现在是这个状态」。位子释放 = review 维度离开 APPROVED。
 */
async function cancelRequest(submit, { reason, operatorName }) {
  const wasSeated = sched.isSeated(submit);
  await S.applyChange(submit, { reviewStatus: S.REVIEW.CANCELLED }, { operatorName, reason });
  if (wasSeated) {
    // 释放位子后跑「原位递补 + 全局调剂」。
    // ⚠️ 仍保留 `.catch(() => null)`：取消是**用户可见的终态动作**，必须成功；
    //    排期失败只能靠下一次审核 / 手动 sweep 兜底重试，绝不能因此让取消本身失败。
    //    （阶段 5 已把 afterRelease/reschedule 移植到位，正常路径不会再抛。）
    await sched.afterRelease(submit).catch(() => null);
  }
}

/**
 * DELETE /user/submit/:id
 * 允许：还没审核的（review=PENDING）、候补中的（review=APPROVED 且 schedule=WAITING）
 *
 * ⚠️ 原实现遗留（**如实保留，不擅自修正**）：
 *    下面 `!revocable` 分支里那条「请用『放弃候补』」的文案实际**不可达** ——
 *    `APPROVED + WAITING` 落在 `revocable` 里，走不到抛错分支。
 *    也就是说候补中的点歌既能 DELETE 也能 leave-queue，两者等价。
 *    这是原后端的既有行为（不是移植引入的），改它属于改业务语义，得单独提。
 */
async function cancel(ctx) {
  const me = await requireUser(ctx);
  const id = parseId((ctx.params || {}).id);
  const submit = id === null ? null : await findOne(C.SUBMIT, { id, openid: me.openid });
  if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');

  const review = Number(submit.reviewStatus) || 0;
  const schedule = Number(submit.scheduleStatus) || 0;
  if (review === S.REVIEW.CANCELLED) {
    return null;   // 幂等：已经取消过了
  }
  const revocable = review === S.REVIEW.PENDING
    || (review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.WAITING);
  if (!revocable) {
    throw new ApiError(
      Codes.FORBIDDEN,
      schedule === S.SCHEDULE.WAITING ? '这是候补中的点歌，请用「放弃候补」' : '已审核的投稿不能撤销'
    );
  }
  await cancelRequest(submit, { reason: 'USER_CANCEL', operatorName: 'USER' });
  return null;
}

/** POST /user/submit/:id/leave-queue */
async function leaveQueue(ctx) {
  const me = await requireUser(ctx);
  const id = parseId((ctx.params || {}).id);
  const submit = id === null ? null : await findOne(C.SUBMIT, { id, openid: me.openid });
  if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
  const review = Number(submit.reviewStatus) || 0;
  const schedule = Number(submit.scheduleStatus) || 0;
  if (!(review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.WAITING)) {
    throw new ApiError(Codes.PARAM_ERROR, '这条不在候补队列里');
  }
  await cancelRequest(submit, { reason: 'USER_LEAVE_QUEUE', operatorName: 'USER' });
  return null;
}

module.exports = {
  create,
  notice,
  ackNotice,
  timeslots,
  windowStatus,
  weekSchedule,
  quota,
  myList,
  detail,
  cancel,
  leaveQueue,
  // 供内部复用（管理端删除等也有同一套释放逻辑）
  _internals: { cancelRequest, withStatus, newSubmitDoc },
};
