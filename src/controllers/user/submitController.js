'use strict';

/**
 * 用户端 - 投稿/点歌（协议版，2026-09-24，docs/song-protocol.md）
 * POST /api/user/submit           提交投稿（点歌/文稿）
 * GET  /api/user/submit/my        我的投稿（分页）
 * GET  /api/user/submit/quota     排期 / 候补 / 时间窗口 状态
 * GET  /api/user/submit/window    点歌时间窗口状态（常驻展示用）
 * GET  /api/user/submit/week      本周已排期歌单（首页）
 * GET  /api/user/submit/:id       投稿详情（只能看自己的）
 * DELETE /api/user/submit/:id     取消自己的待审投稿
 * POST /api/user/submit/:id/leave-queue  放弃候补
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 与 v2 最重要的一条差别：**提交时不判容量**。
 *   旧：格子满 → 直接进候补（status=3）；格子+候补都满 → 40904 不让提交。
 *   新：一律 PENDING_REVIEW，谁都能投；究竟排不排得上，是**审核通过后**
 *       由排期算法（songSchedulingService）按「首选时段 + 提交时间」决定的。
 *
 * 为什么这样更好（协议 §4）：
 *   · 提交那一刻用户只是「提出申请」，还没开始审核，此判名额没有意义；
 *   · 排期完全可以在所有人提交完之后统一算，先到先得由 submitted_at 表达，
 *     而不是把「谁的手快」变成能不能投稿的门槛。
 *
 * 保留不变的三条规则（用户 2026-09-24 确认）：
 *   ① 点歌时间窗口（默认周六 18:00 → 周日 18:00，仅超管可改）
 *   ② 每人每周点歌次数上限
 *   ③ 同一首歌一周内不可重复
 * ═══════════════════════════════════════════════════════════════════════
 */
const dayjs = require('dayjs');
const { Op } = require('sequelize');
const { Submit, User } = require('../../models');
const { success, fail, Codes, ApiError } = require('../../utils/response');
const { msgSecCheck } = require('../../services/wechatService');
const { getAccessToken } = require('../../services/accessTokenService');
const switchService = require('../../services/switchService');
const songQueue = require('../../services/songQueueService');
const songWindow = require('../../services/songWindowService');
const songNotice = require('../../services/songNoticeService');
const broadcastSlot = require('../../services/broadcastSlotService');
const submitRule = require('../../services/submitRuleService');
const S = require('../../services/songStatusService');
const sched = require('../../services/songSchedulingService');

/** 给接口对象塞上三维状态视图（前端从单 status 迁移到三维时用得上） */
function withStatus(o) {
  return { ...o, ...S.statusView(o) };
}

/**
 * 提交投稿
 * body:
 *   点歌: { type:1, songName, singer, wishContent, wantBroadcastTime, allowReschedule? }
 *   文稿: { type:2, articleTitle, articleContent, wantBroadcastTime? }
 */
exports.create = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const body = req.body || {};
    const { type } = body;

    if (![1, 2].includes(type)) {
      throw new ApiError(Codes.PARAM_ERROR, '投稿类型必须为1或2');
    }

    // 模块开关拦截
    switchService.assertEnabled(type === 1 ? 'submit_song' : 'submit_article');

    // 提交前置（服务端硬约束，不信前端）：
    //   ① 点歌时间窗口：不在开放时间内直接 40907，不落库（放在最前，fail fast）
    //   ② 点歌、文稿各自的注意事项都要确认过当前版本
    //   ③ 点歌：播出时段必须是系统下发的
    //   ④ 点歌：同一首歌一周内不可重复 + 本周个人次数上限
    //   ⚠️ 协议版**没有第⑤条「容量校验」** —— 容量在排期阶段才算
    if (type === 1) {
      await songWindow.assertOpen();
    }
    const gate = await songNotice.assertAcked(openid, type === 1 ? 'song' : 'article');
    if (!gate.ok) {
      throw new ApiError(Codes.NOTICE_UNACKED, gate.reason);
    }
    if (type === 1) {
      if (!body.wantBroadcastTime) {
        throw new ApiError(Codes.PARAM_ERROR, '请选择希望播出的时段');
      }
      if (!(await broadcastSlot.isValidSlot(body.wantBroadcastTime))) {
        throw new ApiError(Codes.PARAM_ERROR, '播出时段只能选下周一到周五内的可选时段，请重新选择');
      }
      // 放在内容安全检测之前：先拦掉注定不能提交的，别浪费一次微信接口调用
      const rule = await submitRule.checkSubmit({ openid, songName: body.songName });
      if (!rule.ok) {
        throw new ApiError(Codes.SUBMIT_REJECTED, rule.message);
      }
    }

    // 校验字段
    if (type === 1) {
      if (!body.songName || !body.singer) {
        throw new ApiError(Codes.PARAM_ERROR, '请填写歌曲名和歌手');
      }
      if ((body.wishContent || '').length > 500) {
        throw new ApiError(Codes.PARAM_ERROR, '祝福语过长');
      }
    } else if (type === 2) {
      if (!body.articleTitle || !body.articleContent) {
        throw new ApiError(Codes.PARAM_ERROR, '请填写文稿标题和内容');
      }
      if ((body.articleContent || '').length > 5000) {
        throw new ApiError(Codes.PARAM_ERROR, '文稿内容不能超过5000字');
      }
    }

    // 防重复提交：相同 openid/type/songName 1分钟内只允许一次
    const recent = await Submit.findOne({
      where: {
        openid,
        type,
        ...(type === 1 ? { songName: body.songName } : { articleTitle: body.articleTitle }),
        createTime: { [Op.gte]: dayjs().subtract(1, 'minute').toDate() },
      },
    });
    if (recent) {
      throw new ApiError(Codes.CONFLICT, '请勿重复提交');
    }

    // 内容安全检测
    const token = await getAccessToken();
    const text = type === 1 ? `${body.songName} ${body.singer} ${body.wishContent || ''}` : `${body.articleTitle} ${body.articleContent}`;
    const sec = await msgSecCheck(text, token);
    if (!sec.pass) {
      throw new ApiError(Codes.CONTENT_BLOCKED, '内容包含敏感信息，请修改后重试');
    }

    if (type === 2) {
      const submit = await Submit.create({
        openid,
        type,
        articleTitle: body.articleTitle || null,
        articleContent: body.articleContent || null,
        wantBroadcastTime: body.wantBroadcastTime || null,
        reviewStatus: S.REVIEW.PENDING,
        scheduleStatus: S.SCHEDULE.UNASSIGNED,
        playStatus: S.PLAY.NOT_PLAYED,
        status: S.deriveStatus(S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED, S.PLAY.NOT_PLAYED),
      });
      return success(res, { id: submit.id, outcome: 'submitted' }, '提交成功，等待审核');
    }

    // ── 点歌落库（不判容量）─────────────────────────────────────────────
    //   review_status = PENDING（等审核）
    //   schedule_status = UNASSIGNED（还没参与排期）
    //   排期要等审核通过后由 songSchedulingService 统一算
    const allowReschedule = (body.allowReschedule === false || Number(body.allowReschedule) === 0) ? 0 : 1;
    const targetWeek = sched.weekStartOfValue(body.wantBroadcastTime);
    if (!targetWeek) {
      throw new ApiError(Codes.PARAM_ERROR, '播出时段无法识别，请重新选择');
    }
    // 排期行懒创建（用户提交即建，管理员不用先「创建下周排期」）
    const week = await sched.ensureWeek(targetWeek.getTime()).catch((e) => {
      throw new ApiError(Codes.SERVER_ERROR, `排期初始化失败：${e.message}`);
    });

    const submit = await Submit.create({
      openid,
      type: 1,
      songName: body.songName || null,
      singer: body.singer || null,
      wishContent: body.wishContent || null,
      wantBroadcastTime: body.wantBroadcastTime || null,
      reviewStatus: S.REVIEW.PENDING,
      scheduleStatus: S.SCHEDULE.UNASSIGNED,
      playStatus: S.PLAY.NOT_PLAYED,
      allowReschedule,
      status: S.deriveStatus(S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED, S.PLAY.NOT_PLAYED),
    });

    return success(
      res,
      {
        id: submit.id,
        outcome: 'submitted',
        reviewStatus: S.REVIEW.PENDING,
        scheduleStatus: S.SCHEDULE.UNASSIGNED,
        allowReschedule: !!allowReschedule,
        week: sched.weekView(week),
        weekText: `${week.weekStartDate} 起那一周`,
        lockAt: week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
      },
      '提交成功，等待审核'
    );
  } catch (e) {
    return next(e);
  }
};

/**
 * 点歌注意事项（进模块先看，确认后才能点歌）
 * GET  /api/user/submit/notice
 */
exports.notice = async (req, res, next) => {
  try {
    return success(res, await songNotice.getForUser(req.user.openid, req.query.type));
  } catch (e) {
    return next(e);
  }
};

/**
 * 确认已阅读（前端「滑到底 + 我已知晓」后调用）
 * POST /api/user/submit/notice/ack   body: { version, type? }
 */
exports.ackNotice = async (req, res, next) => {
  try {
    const { version, type } = req.body || {};
    const st = await songNotice.ack(req.user.openid, version, type);
    return success(res, st, '已确认');
  } catch (e) {
    return next(e);
  }
};

/**
 * 可选的播出时段（系统下发，只允许选，不允许手输）
 * GET /api/user/submit/timeslots
 *
 * ⚠️ 协议版语义变化：格子上的 capacity / seated 是**排期结果**，不是「谁先提交谁占住」。
 *    所以 `full` 只是「预计很难排上」的提示，**不阻止提交**（提交后仍可能被调剂到别处）。
 */
exports.timeslots = async (req, res, next) => {
  try {
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

    return success(res, {
      ...slots,
      list,
      // 协议版候补没有人数上限（审核通过的人理应能排队）
      queue: { used: waiting, limit: 0, limitAuto: true, full: false, unlimited: true },
      week: week ? sched.weekView(week, now) : null,
      lockAt: week && week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
      window: win,
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 点歌时间窗口状态（常驻展示在点歌模块用）
 * GET /api/user/submit/window
 * 前端不要硬编码星期与时刻 —— 管理员一改配置，这里立刻变
 */
exports.windowStatus = async (req, res, next) => {
  try {
    const now = Date.now();
    const st = await songWindow.status(now);
    // 顺带把「这一周的排期锁定时刻」给前端，学生端可以显示「本周排期 X 日锁定」
    let week = null;
    try {
      const ws = songWindow.windowRangeAt(st.config, now).weekStart;
      const row = await sched.ensureWeek(ws.getTime(), { now });
      week = sched.weekView(row, now);
    } catch (e) { week = null; }
    return success(res, { ...st, week });
  } catch (e) {
    return next(e);
  }
};

/**
 * 本周点歌排期（小程序首页展示用）
 * GET /api/user/submit/week
 */
exports.weekSchedule = async (req, res, next) => {
  try {
    if (!switchService.isEnabled('home_song_schedule')) {
      return success(res, { visible: false, rangeText: '', days: [] });
    }
    const data = await broadcastSlot.currentWeekSchedule();
    return success(res, { visible: true, ...data });
  } catch (e) {
    return next(e);
  }
};

/**
 * 点歌排期 / 候补 / 时间窗口 一站式状态（投稿页提前提示用）
 * GET /api/user/submit/quota
 */
exports.quota = async (req, res, next) => {
  try {
    const now = Date.now();
    const [win, waiting, capacity, weekCap, mine] = await Promise.all([
      songWindow.status(now),
      songQueue.countWaiting(),
      songQueue.getCapacity(),
      songQueue.weekCapacity(now),
      submitRule.checkUserWeeklyLimit(req.user.openid),
    ]);
    const ws = songWindow.windowRangeAt(win.config, now).weekStart;
    const week = await sched.ensureWeek(ws.getTime(), { now }).catch(() => null);
    return success(res, {
      window: win,
      week: week ? sched.weekView(week, now) : null,
      lockAt: week && week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
      song: {
        capacity,                                    // 每格正式位（0 = 不限）
        weekCapacity: weekCap,                       // 下周正式位总数（0 = 不限）
        queue: { used: waiting, limit: 0, limitAuto: true, full: false, unlimited: true },
      },
      userWeekly: { used: mine.used, limit: mine.limit, remaining: mine.remaining },
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 我的投稿列表
 * GET /api/user/submit/my?status=&page=&pageSize=
 * ⚠️ 旧前端按单 status 筛选；协议版真值是三维，所以筛的是**派生镜像**列，
 *    行为与旧版一致，前端可以慢慢迁到三维。
 */
exports.myList = async (req, res, next) => {
  try {
    const openid = req.user.openid;
    const { status, page = 1, pageSize = 10 } = req.query;
    const where = { openid };
    if (status !== undefined && status !== '') {
      where.status = parseInt(status, 10);
    }
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Submit.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
      offset,
      limit: parseInt(pageSize, 10),
    });

    const list = await Promise.all(rows.map(async (r) => {
      const o = withStatus(r.toJSON());
      if (Number(r.type) === 1) {
        try { o.card = await songQueue.cardFor(r); } catch (e) { o.card = null; }
      } else {
        o.card = null;
      }
      return o;
    }));

    return success(res, {
      list,
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
      cards: list.map((r) => r.card).filter(Boolean),
    });
  } catch (e) {
    return next(e);
  }
};

/**
 * 投稿详情（自己的）
 */
exports.detail = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({
      where: { id: req.params.id, openid: req.user.openid },
    });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const out = withStatus(submit.toJSON());
    if (Number(submit.type) === 1) {
      try { out.card = await songQueue.cardFor(submit); } catch (e) { out.card = null; }
      try { out.statusHistory = await S.historyOf(submit.id, 20); } catch (e) { out.statusHistory = []; }
    }
    return success(res, out);
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 取消 / 放弃候补
 * ------------------------------------------------------------------ */
/**
 * 把一条点歌置为「已取消」（协议里的 CANCELLED 终态）。
 * ⚠️ 不删行 —— 删行会丢掉「他投过什么」，后台就没法回答
 *    「这首歌为什么现在是这个状态」。位子释放＝review 维度离开 APPROVED。
 */
async function cancelRequest(submit, { reason, operatorName }) {
  const wasSeated = sched.isSeated(submit);
  await S.applyChange(submit, {
    reviewStatus: S.REVIEW.CANCELLED,
  }, { operatorName, reason });
  if (wasSeated) {
    await sched.afterRelease(submit).catch(() => null);
  }
}

/**
 * 取消自己的待审投稿
 * DELETE /api/user/submit/:id
 * 允许：还没审核的（review=PENDING）、候补中的（review=APPROVED 且 schedule=WAITING）
 */
exports.cancel = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({ where: { id: req.params.id, openid: req.user.openid } });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');

    const review = Number(submit.reviewStatus) || 0;
    const schedule = Number(submit.scheduleStatus) || 0;
    if (review === S.REVIEW.CANCELLED) {
      return success(res, null, '这条已经取消了');
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
    return success(res, null, '已撤销');
  } catch (e) {
    return next(e);
  }
};

/**
 * 放弃候补
 * POST /api/user/submit/:id/leave-queue
 */
exports.leaveQueue = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({ where: { id: req.params.id, openid: req.user.openid } });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const review = Number(submit.reviewStatus) || 0;
    const schedule = Number(submit.scheduleStatus) || 0;
    if (!(review === S.REVIEW.APPROVED && schedule === S.SCHEDULE.WAITING)) {
      throw new ApiError(Codes.PARAM_ERROR, '这条不在候补队列里');
    }
    await cancelRequest(submit, { reason: 'USER_LEAVE_QUEUE', operatorName: 'USER' });
    return success(res, null, '已退出候补队列');
  } catch (e) {
    return next(e);
  }
};

/** 供内部复用（管理员删除等也有同一套释放逻辑） */
exports._internals = { cancelRequest, withStatus };
