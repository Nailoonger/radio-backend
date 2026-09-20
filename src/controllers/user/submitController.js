'use strict';

/**
 * 用户端 - 投稿/点歌
 * POST /api/user/submit           提交投稿（点歌/文稿）
 * GET  /api/user/submit/my        我的投稿（分页）
 * GET  /api/user/submit/quota     名额 / 候补队列 / 时间窗口状态
 * GET  /api/user/submit/window    点歌时间窗口状态（常驻展示用）
 * GET  /api/user/submit/:id       投稿详情（只能看自己的）
 * DELETE /api/user/submit/:id     撤销待审投稿（status=0）
 * POST /api/user/submit/:id/leave-queue  放弃候补（status=3）
 *
 * 规则 v2（docs/song-queue-v2.md）：
 *   提交即占位（status=0）→ 格子满则进全局候补队列（status=3）→
 *   候补队列满则拒绝（40904）；窗口外提交点歌直接 40907。
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

/**
 * 位子发生变化（提交占满 / 学生自己撤回）之后跑一次：递补 + 满额清队（幂等）
 * ⚠️ 必须 await：写成 setImmediate「着火即忘」会和下一个学生的 `decideSeat` 抢同一条记录，
 *    出现「明明已经满了却还让人进候补队列」这种不可复现的怪象。
 *    内部已吞异常，失败只记日志（下次 sweep / 下一位学生提交会重试），不会影响本次响应。
 */
async function afterRelease() {
  try {
    return await songQueue.runAfterRelease();
  } catch (e) {
    return { promoted: 0, closed: 0, full: false, error: e.message };
  }
}

/**
 * 提交投稿
 * body:
 *   点歌: { type:1, songName, singer, wishContent, wantBroadcastTime? }
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
    //   ② 点歌、文稿各自的注意事项都要确认过当前版本（两份内容独立，改了哪份哪份重新确认）
    //   ③ 点歌：播出时段必须是系统下发的（下一周周一到周五）
    //   ④ 点歌：同一首歌一周内不可重复 + 本周个人次数上限
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

    // 内容安全检测（异步失败不影响主流程）
    const token = await getAccessToken();
    const text = type === 1 ? `${body.songName} ${body.singer} ${body.wishContent || ''}` : `${body.articleTitle} ${body.articleContent}`;
    const sec = await msgSecCheck(text, token);
    if (!sec.pass) {
      throw new ApiError(Codes.CONTENT_BLOCKED, '内容包含敏感信息，请修改后重试');
    }

    // ── 落库 ────────────────────────────────────────────────────────────
    // 点歌：先定去向再落库。容量在「提交」这一刻决定，审核只做内容把关。
    //   正式位有空   → status=0 待审（已占位，scheduled_slot = 首选时段）
    //   正式位满、候补有位 → status=3 候补中（scheduled_slot 留空，等补位）
    //   两个都满     → 40904，不落库
    let placement = null;
    let submit;

    if (type === 1) {
      placement = await songQueue.decideSeat({ slotValue: body.wantBroadcastTime });
      if (placement.outcome === 'full') {
        throw new ApiError(
          Codes.SLOT_AND_QUEUE_FULL,
          '该时段已排满，候补队列也满了，换个时段试试',
          200,
          {
            slot: body.wantBroadcastTime,
            queueUsed: placement.queueUsed,
            queueLimit: placement.queueLimit,
          }
        );
      }
      const queued = placement.outcome === 'queued';
      submit = await Submit.create({
        openid,
        type,
        songName: body.songName || null,
        singer: body.singer || null,
        wishContent: body.wishContent || null,
        wantBroadcastTime: body.wantBroadcastTime || null,
        status: queued ? songQueue.ST.QUEUED : songQueue.ST.PENDING,
        scheduledSlot: queued ? null : (body.wantBroadcastTime || null),
        queueAt: queued ? new Date() : null,
      });
    } else {
      submit = await Submit.create({
        openid,
        type,
        articleTitle: body.articleTitle || null,
        articleContent: body.articleContent || null,
        wantBroadcastTime: body.wantBroadcastTime || null,
        status: 0,
      });
      return success(res, { id: submit.id, outcome: 'seated' }, '提交成功，等待审核');
    }

    // 进候补：立刻返回候补态通知卡（位次、上限、截止时间、放弃入口）
    if (placement.outcome === 'queued') {
      const card = await songQueue.cardFor(submit);
      return success(
        res,
        { id: submit.id, outcome: 'queued', queuePos: card.queuePos, card },
        `该时段名额已满，你已进入候补队列（第 ${card.queuePos} 位）`
      );
    }

    // 直接落座：若这条刚好填满最后一个空位 → 立刻清掉候补队列（幂等，失败不影响本次响应）
    await afterRelease();
    return success(
      res,
      { id: submit.id, outcome: 'seated', left: placement.left },
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
    // ?type=song|article，默认 song。两份注意事项内容与版本号各自独立
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
 * 范围：下一周的周一到周五 × 每日时段
 *
 * v2：每格的占用按 **scheduled_slot（实际排期）** 统计，不是 want_broadcast_time；
 *     顶层另外带 queue（全局候补队列）与 window（点歌时间窗口，用于常驻展示）。
 */
exports.timeslots = async (req, res, next) => {
  try {
    const slots = await broadcastSlot.getSlots();
    const usage = await songQueue.slotUsage(slots.list.map((s) => s.value));
    const list = slots.list.map((s) => {
      const u = usage[s.value] || { capacity: slots.capacity, seated: 0, left: null, full: false };
      return {
        ...s,
        capacity: u.capacity,
        seated: u.seated,
        picked: u.seated,          // 兼容旧字段名
        left: u.left,
        full: u.full,
        canBuffer: !u.full,        // 满了还能进候补
      };
    });
    const [queueUsed, limitInfo, win] = await Promise.all([
      songQueue.countQueued(),
      songQueue.getQueueLimit(),
      songWindow.status(),
    ]);
    return success(res, {
      ...slots,
      list,
      queue: {
        used: queueUsed,
        limit: limitInfo.limit,
        limitAuto: limitInfo.auto,
        full: limitInfo.limit > 0 && queueUsed >= limitInfo.limit,
      },
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
    return success(res, await songWindow.status());
  } catch (e) {
    return next(e);
  }
};

/**
 * 点歌名额 / 候补队列 / 时间窗口 一站式状态（投稿页提前提示用）
 * GET /api/user/submit/quota
 * v2：不再有日/周名额；容量按「下周排期格子」算
 */
exports.quota = async (req, res, next) => {
  try {
    const [win, limitInfo, queueUsed, capacity, weekCap, mine] = await Promise.all([
      songWindow.status(),
      songQueue.getQueueLimit(),
      songQueue.countQueued(),
      songQueue.getCapacity(),
      songQueue.weekCapacity(),
      submitRule.checkUserWeeklyLimit(req.user.openid),
    ]);
    return success(res, {
      window: win,
      song: {
        capacity,                                    // 每格正式位（0 = 不限）
        weekCapacity: weekCap,                       // 下周正式位总数（0 = 不限）
        queue: {
          used: queueUsed,
          limit: limitInfo.limit,
          limitAuto: limitInfo.auto,
          full: limitInfo.limit > 0 && queueUsed >= limitInfo.limit,
        },
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

    // v2：点歌带一张「状态卡」（候补中带位次、已补位带实际时段、系统驳回带理由）
    const list = await Promise.all(rows.map(async (r) => {
      const o = r.toJSON();
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
      // 顶部通知卡汇总（候补中 / 未补上的）
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
    const out = submit.toJSON();
    if (Number(submit.type) === 1) {
      try { out.card = await songQueue.cardFor(submit); } catch (e) { out.card = null; }
    }
    return success(res, out);
  } catch (e) {
    return next(e);
  }
};

/** 删掉自己的待审投稿 / 退出候补队列的公共实现 */
async function takeBack(req, res, next, allowStatus) {
  try {
    const submit = await Submit.findOne({
      where: { id: req.params.id, openid: req.user.openid },
    });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const status = Number(submit.status);
    if (!allowStatus.includes(status)) {
      throw new ApiError(
        Codes.FORBIDDEN,
        status === songQueue.ST.QUEUED ? '这是候补中的点歌，请用「放弃候补」' : '已审核的投稿不能撤销'
      );
    }
    const wasQueued = status === songQueue.ST.QUEUED;
    await submit.destroy();
    // 位子（正式位或候补位）释放了 → 立刻递补下一位（失败不影响本次响应）
    await afterRelease();
    return success(res, null, wasQueued ? '已退出候补队列' : '已撤销');
  } catch (e) {
    return next(e);
  }
}

/**
 * 撤销自己的待审投稿（status=0，会释放正式位并触发递补）
 * DELETE /api/user/submit/:id
 */
exports.cancel = async (req, res, next) => takeBack(req, res, next, [songQueue.ST.PENDING]);

/**
 * 放弃候补（status=3，出队并触发递补）
 * POST /api/user/submit/:id/leave-queue
 */
exports.leaveQueue = async (req, res, next) => takeBack(req, res, next, [songQueue.ST.QUEUED]);