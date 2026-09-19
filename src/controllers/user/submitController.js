'use strict';

/**
 * 用户端 - 投稿/点歌
 * POST /api/user/submit           提交投稿（点歌/文稿）
 * GET  /api/user/submit/my        我的投稿（分页）
 * GET  /api/user/submit/:id       投稿详情（只能看自己的）
 */
const dayjs = require('dayjs');
const { Op } = require('sequelize');
const { Submit, User } = require('../../models');
const { success, fail, Codes, ApiError } = require('../../utils/response');
const { msgSecCheck } = require('../../services/wechatService');
const { getAccessToken } = require('../../services/accessTokenService');
const switchService = require('../../services/switchService');
const songQuota = require('../../services/songQuotaService');
const songNotice = require('../../services/songNoticeService');
const broadcastSlot = require('../../services/broadcastSlotService');
const submitRule = require('../../services/submitRuleService');

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
    //   ① 点歌、文稿各自的注意事项都要确认过当前版本（两份内容独立，改了哪份哪份重新确认）
    //   ② 点歌：播出时段必须是系统下发的（下一周周一到周五）
    //   ③ 点歌：同一首歌一周内不可重复 + 本周个人次数上限
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

    const submit = await Submit.create({
      openid,
      type,
      songName: body.songName || null,
      singer: body.singer || null,
      wishContent: body.wishContent || null,
      articleTitle: body.articleTitle || null,
      articleContent: body.articleContent || null,
      wantBroadcastTime: body.wantBroadcastTime || null,
      status: 0,
    });

    // 点歌名额已满：新提交立刻由系统驳回，而不是挂着「待审核」骗人。
    // 仍然落一条记录，这样学生在「我的投稿」里能看到明确原因（也便于后台统计）。
    if (type === 1) {
      const st = await songQuota.exhausted();
      if (st.daily || st.weekly) {
        const period = st.daily ? songQuota.PERIOD.DAY : songQuota.PERIOD.WEEK;
        const reason = songQuota.SYSTEM_REASON[period];
        await submit.update({
          status: 2,
          rejectReason: reason,
          autoRejected: 1,
          reviewTime: new Date(),
        });
        // 顺手把本周期还挂着的待审点歌一起驳掉（幂等、失败不影响本次响应）
        setImmediate(() => { songQuota.sweepAllExhausted().catch(() => {}); });
        return success(res, { id: submit.id, autoRejected: true, rejectReason: reason }, reason);
      }
    }

    return success(res, { id: submit.id }, '提交成功，等待审核');
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
 * 范围：下一周的周一到周五 × 每日时段（取自 broadcast_schedule 设置）
 */
exports.timeslots = async (req, res, next) => {
  try {
    return success(res, await broadcastSlot.getSlots());
  } catch (e) {
    return next(e);
  }
};

/**
 * 点歌名额状态（公开给小程序，用于投稿页提前提示）
 * GET /api/user/submit/quota
 * 只暴露学生需要知道的：还能不能点、还剩几个
 */
exports.quota = async (req, res, next) => {
  try {
    const st = await songQuota.status();
    const pick = (s) => (s && s.limit > 0
      ? { limit: s.limit, used: s.used, remaining: s.remaining, exhausted: s.exhausted }
      : null);
    // 当前用户本周还能点几次（每人每周上限），投稿页提前提示
    const mine = await submitRule.checkUserWeeklyLimit(req.user.openid);
    return success(res, {
      song: {
        daily: pick(st.daily),
        weekly: pick(st.weekly),
        exhausted: !!(st.daily && st.daily.exhausted) || !!(st.weekly && st.weekly.exhausted),
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

    return success(res, {
      list: rows,
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
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
    return success(res, submit);
  } catch (e) {
    return next(e);
  }
};

/**
 * 撤销自己的待审核投稿
 */
exports.cancel = async (req, res, next) => {
  try {
    const submit = await Submit.findOne({
      where: { id: req.params.id, openid: req.user.openid },
    });
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (submit.status !== 0) throw new ApiError(Codes.FORBIDDEN, '已审核的投稿不能撤销');
    await submit.destroy();
    return success(res, null, '已撤销');
  } catch (e) {
    return next(e);
  }
};