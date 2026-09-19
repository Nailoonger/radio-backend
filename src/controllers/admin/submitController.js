'use strict';

/**
 * 管理端 - 投稿审核
 * GET    /api/admin/submit/list            列表（分页、筛选）
 * GET    /api/admin/submit/:id             详情
 * PUT    /api/admin/submit/:id/approve     通过（点歌会占用名额）
 * PUT    /api/admin/submit/:id/reject      驳回（必填驳回理由）
 * DELETE /api/admin/submit/:id             删除
 * POST   /api/admin/submit/batch           批量审核
 *
 * 点歌名额（v4 新增）：
 * GET    /api/admin/submit/quota           名额快照（用量 / 上限 / 待处理）
 * PUT    /api/admin/submit/quota           设置每日、每周上限
 * POST   /api/admin/submit/quota/sweep     手动触发一次自动驳回（幂等）
 *
 * 名额规则：管理员「通过」一条点歌会占一个名额；某周期名额占满后，
 * 该周期内剩余的待审点歌由系统自动驳回（auto_rejected=1）。
 * 并发正确性全部交给 songQuotaService（单条带条件的 UPDATE + 唯一键），
 * 本文件只负责「把状态流转和名额占位放进同一个事务」。
 */
const { Op, fn, col } = require('sequelize');
const dayjs = require('dayjs');
const { Submit, User, Admin, SongQuota, sequelize } = require('../../models');
const { success, fail, ApiError, Codes } = require('../../utils/response');
const songQuota = require('../../services/songQuotaService');
const submitRule = require('../../services/submitRuleService');
const roster = require('../../services/studentRosterService');
const songNotice = require('../../services/songNoticeService');
const broadcastSlot = require('../../services/broadcastSlotService');

/** 名额已满时从事务里抛出，用于强制回滚 */
class QuotaExhaustedError extends Error {
  constructor(info) {
    super('quota exhausted');
    this.info = info;
  }
}

/** 播出时段已排满时从事务里抛出（审核即排期机制，2026-09-19） */
class SlotFullError extends Error {
  constructor(info) {
    super('slot full');
    this.info = info;
  }
}

const SCOPE_TEXT = { daily: '今日', weekly: '本周' };

/* ------------------------------------------------------------------ *
 * 内部：通过一条投稿（含名额占位）
 * 状态流转与名额占位必须在同一个事务 —— 名额不够时状态要还原，
 * 否则会出现「已通过但没占名额」或「占了名额但没过」两种脏数据。
 * ------------------------------------------------------------------ */
async function approveOne(submit, adminId) {
  let maxed = [];
  await sequelize.transaction(async (t) => {
    // ① 条件更新：只有仍是「待审核」才改。
    //    两个管理员同时点同一条时，只有一个能命中，天然防重复占名额。
    const [flipped] = await Submit.update(
      {
        status: 1,
        reviewerId: adminId,
        reviewTime: new Date(),
        rejectReason: null,
        autoRejected: 0,
      },
      { where: { id: submit.id, status: 0 }, transaction: t }
    );
    if (!flipped) return; // 已被别人处理，事务空提交即可

    // ② 点歌占名额（日 + 周一起占）；不足则抛错 → 整个事务回滚，状态还原
    if (Number(submit.type) === 1) {
      const r = await songQuota.claim({ transaction: t });
      if (!r.ok) throw new QuotaExhaustedError(r);
      maxed = r.maxed || [];

      // ③ 时段容量校验（审核即排期）：该时段已通过的条数达到上限时不能再放行。
      //    容量 0/未设置 = 不限；wantBroadcastTime 为空（历史数据 / 文稿）不校验。
      //    ⚠️ 此时本条已在①里被置为 status=1，必须排除自身，否则永远数出「已满」。
      const capacity = await broadcastSlot.getCapacity();
      const slotValue = submit.wantBroadcastTime;
      if (capacity > 0 && slotValue) {
        const approvedCnt = await Submit.count({
          where: { type: 1, status: 1, wantBroadcastTime: slotValue, id: { [Op.ne]: submit.id } },
          transaction: t,
        });
        if (approvedCnt >= capacity) {
          throw new SlotFullError({ slot: slotValue, approved: approvedCnt, capacity });
        }
      }
    }
  });
  return { submit: await Submit.findByPk(submit.id), maxed };
}

/** 事务提交后再跑自动驳回：幂等、失败只记日志，不影响审核结果本身 */
function scheduleSweep(maxed) {
  if (!maxed || !maxed.length) return;
  setImmediate(() => {
    songQuota.sweepAllExhausted().catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * 列表 / 详情
 * ------------------------------------------------------------------ */
exports.list = async (req, res, next) => {
  try {
    const {
      status, type,
      page = 1, pageSize = 10,
      keyword, startDate, endDate,
      slot,                       // 精确筛选某播出时段（排期矩阵点格子用）
    } = req.query;

    const where = {};
    if (status !== undefined && status !== '') where.status = parseInt(status, 10);
    if (type !== undefined && type !== '') where.type = parseInt(type, 10);
    if (slot) where.wantBroadcastTime = String(slot);
    if (startDate && endDate) {
      where.createTime = { [Op.between]: [startDate, endDate] };
    }
    if (keyword) {
      where[Op.or] = [
        { songName: { [Op.like]: `%${keyword}%` } },
        { singer: { [Op.like]: `%${keyword}%` } },
        { articleTitle: { [Op.like]: `%${keyword}%` } },
        { wishContent: { [Op.like]: `%${keyword}%` } },
      ];
    }

    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Submit.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
      offset,
      limit: parseInt(pageSize, 10),
    });

    // 关联用户昵称/头像
    // ⚠️ 账号体系下 user.openid 为空、投稿的 openid 字段里存的是**学号**，
    //    所以必须 openid / username 两个键一起查，再用「投稿里的那个键」去找人。
    const keys = [...new Set(rows.map(r => r.openid))];
    const users = keys.length
      ? await User.findAll({
          where: { [Op.or]: [{ openid: keys }, { username: keys }] },
          attributes: ['openid', 'username', 'nickname', 'remark', 'avatar'],
        })
      : [];
    const userMap = new Map();
    users.forEach((u) => {
      if (u.openid) userMap.set(u.openid, u);
      if (u.username) userMap.set(u.username, u);
    });
    const displayName = (u) => (u && (u.nickname || u.remark)) || '匿名';

    // ── 审核人（⚠️ 与投稿人是两回事：投稿人 = openid/学号，审核人 = 管理员的 reviewer_id）──
    const reviewerIds = [...new Set(rows.map((r) => r.reviewerId).filter(Boolean))];
    const admins = reviewerIds.length
      ? await Admin.findAll({ where: { id: reviewerIds }, attributes: ['id', 'username', 'nickname'] })
      : [];
    const adminMap = new Map(admins.map((a) => [Number(a.id), a]));
    const reviewerName = (r) => {
      if (Number(r.autoRejected) === 1) return '系统自动驳回';
      const a = adminMap.get(Number(r.reviewerId));
      return a ? (a.nickname || a.username) : (r.status === 0 ? '' : '—');
    };

    return success(res, {
      list: rows.map(r => {
        const u = userMap.get(r.openid);
        return {
          ...r.toJSON(),
          // 投稿人
          nickname: displayName(u),
          studentNo: (u && u.username) || '',
          avatar: (u && u.avatar) || '',
          // 审核人
          reviewerName: reviewerName(r),
          reviewTime: r.reviewTime,
          // 前端据此把「系统自动驳回」和人工驳回区分开
          autoRejected: Number(r.autoRejected) === 1,
        };
      }),
      total: count,
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
    });
  } catch (e) {
    return next(e);
  }
};

exports.detail = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const user = await User.findOne({
      where: { [Op.or]: [{ openid: submit.openid }, { username: submit.openid }] },
      attributes: ['openid', 'username', 'nickname', 'remark', 'grade', 'classNo', 'seatNo', 'avatar', 'status', 'lastLoginAt', 'loginCount'],
    });

    // ── 投稿人画像（审核处理台左侧深色卡用）──
    const key = submit.openid;
    const [totalCount, approved, rejected, pending, agg] = await Promise.all([
      Submit.count({ where: { openid: key } }),
      Submit.count({ where: { openid: key, status: 1 } }),
      Submit.count({ where: { openid: key, status: 2 } }),
      Submit.count({ where: { openid: key, status: 0 } }),
      Submit.findOne({
        where: { openid: key },
        attributes: [
          [fn('MIN', col('create_time')), 'firstAt'],
          [fn('MAX', col('create_time')), 'lastAt'],
        ],
        raw: true,
      }),
    ]);
    // 本周点歌次数（每人每周上限；系统自动驳回不占次数，规则与服务端一致）
    let weekly = null;
    try { weekly = await submitRule.checkUserWeeklyLimit(key); } catch (e) { weekly = null; }

    const submitter = {
      key,
      isAccount: !!user?.username,
      nickname: (user && (user.nickname || user.remark)) || '匿名',
      username: user?.username || '',
      className: user?.grade ? roster.gradeLabel(user.grade, user.classNo) : '',
      grade: user?.grade || '',
      classNo: user?.classNo || '',
      seatNo: user?.seatNo || '',
      status: user ? Number(user.status) : null,
      lastLoginAt: user?.lastLoginAt || null,
      loginCount: Number(user?.loginCount || 0),
      total: totalCount,
      approved,
      rejected,
      pending,
      firstAt: agg?.firstAt || null,
      lastAt: agg?.lastAt || null,
      weekUsed: weekly ? weekly.used : null,
      weekLimit: weekly ? weekly.limit : null,
      weekRemaining: weekly ? weekly.remaining : null,
    };

    // 审核人（与投稿人分开）
    let reviewer = null;
    if (submit.reviewerId) {
      reviewer = await Admin.findOne({ where: { id: submit.reviewerId }, attributes: ['username', 'nickname'] });
    }
    const reviewerName = Number(submit.autoRejected) === 1
      ? '系统自动驳回'
      : (reviewer ? (reviewer.nickname || reviewer.username) : (Number(submit.status) === 0 ? '' : '—'));

    return success(res, {
      ...submit.toJSON(),
      // 投稿人
      nickname: submitter.nickname,
      studentNo: submitter.username,
      avatar: (user && user.avatar) || '',
      // 审核人
      reviewerName,
      autoRejected: Number(submit.autoRejected) === 1,
      submitter,
    });
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 通过 / 驳回 / 删除
 * ------------------------------------------------------------------ */
exports.approve = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (submit.status === 1) return success(res, submit, '已是已通过状态');

    let result;
    try {
      result = await approveOne(submit, req.admin.id);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        const txt = SCOPE_TEXT[e.info.scope] || '本周期';
        return fail(
          res,
          Codes.QUOTA_EXHAUSTED,
          `${txt}点歌名额已满（${e.info.used}/${e.info.limit}），请调整名额上限后再通过`
        );
      }
      if (e instanceof SlotFullError) {
        return fail(
          res,
          Codes.SLOT_FULL,
          `该播出时段已排满（${e.info.approved}/${e.info.capacity}），该时段剩余待审将被自动驳回`
        );
      }
      throw e;
    }

    // 名额刚好占满 → 提交后把本周期剩余的待审点歌自动驳回
    scheduleSweep(result.maxed);
    // 时段容量校验通过后也跑一次时段 sweep：该时段若已满，剩余待审自动驳回（幂等）
    if (Number(result.submit.type) === 1) {
      setImmediate(() => { broadcastSlot.sweepFullSlots().catch(() => {}); });
    }
    const fresh = result.submit;
    return success(res, { ...fresh.toJSON(), maxed: result.maxed.map(s => s.name) }, '已通过');
  } catch (e) {
    return next(e);
  }
};

exports.reject = async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || reason.trim().length === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '请填写驳回理由');
    }
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    // 人工驳回：autoRejected 归零，把「系统驳回」的痕迹清掉
    await submit.update({
      status: 2,
      rejectReason: reason,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
      autoRejected: 0,
    });
    return success(res, submit, '已驳回');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const wasApprovedSong = Number(submit.type) === 1 && Number(submit.status) === 1;
    // 删掉一条已通过的点歌，要把名额还回去，否则名额会一直少一个
    const at = submit.reviewTime ? new Date(submit.reviewTime).getTime() : Date.now();
    await submit.destroy();
    if (wasApprovedSong) await songQuota.release(at);
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};

/**
 * 撤销审核结果（v8 审核处理台 / 列表的「撤销」）
 *   已通过 / 已驳回 → 回到待审；已通过的点歌要归还名额（与删除同规则）
 */
exports.revoke = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (Number(submit.status) === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '这条还是待审状态，无需撤销');
    }
    const wasApprovedSong = Number(submit.type) === 1 && Number(submit.status) === 1;
    const at = submit.reviewTime ? new Date(submit.reviewTime).getTime() : Date.now();
    // 撤销要把「审核人 / 审核时间」一起清掉 —— 撤销是操作者自己做的事，不算审核结果
    await submit.update({ status: 0, rejectReason: null, reviewTime: null, reviewerId: null, autoRejected: 0 });
    if (wasApprovedSong) await songQuota.release(at);
    return success(res, null, '已撤销，回到待审');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 批量审核
 * 逐条走和单条完全相同的事务路径（因此可能中途名额用尽）；
 * 名额耗尽时**保留前面已成功的**，剩下的返回 skipped，
 * 它们会在自动驳回里被处理掉 —— 不会出现「批量过了但没占名额」。
 * ------------------------------------------------------------------ */
exports.batch = async (req, res, next) => {
  try {
    const { ids, action, reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ApiError(Codes.PARAM_ERROR, '请选择要操作的记录');
    }
    if (!['approve', 'reject'].includes(action)) {
      throw new ApiError(Codes.PARAM_ERROR, '操作类型错误');
    }
    if (action === 'reject' && !reason) {
      throw new ApiError(Codes.PARAM_ERROR, '驳回操作必须填写理由');
    }

    if (action === 'reject') {
      const [affected] = await Submit.update(
        {
          status: 2,
          reviewerId: req.admin.id,
          reviewTime: new Date(),
          rejectReason: reason,
          autoRejected: 0,
        },
        { where: { id: ids } }
      );
      return success(res, { affected }, '批量操作完成');
    }

    // 通过：逐条处理，中途名额用尽就停
    let affected = 0;
    const skipped = [];
    const maxedNames = new Set();
    let quotaHit = null;

    for (const id of ids) {
      const submit = await Submit.findByPk(id);
      if (!submit || submit.status === 1) { skipped.push(id); continue; }
      try {
        const r = await approveOne(submit, req.admin.id);
        affected += 1;
        (r.maxed || []).forEach((s) => maxedNames.add(s.name));
      } catch (e) {
        if (e instanceof QuotaExhaustedError) {
          quotaHit = e.info;
          skipped.push(id);
          // 后面的一律不再处理
          const rest = ids.slice(ids.indexOf(id) + 1).filter((x) => x !== id);
          rest.forEach((x) => skipped.push(x));
          break;
        }
        throw e;
      }
    }

    scheduleSweep([...maxedNames].map((name) => ({ name })));
    const payload = { affected, skipped };
    if (quotaHit) {
      payload.exhausted = true;
      payload.scope = quotaHit.scope;
      payload.message = `${SCOPE_TEXT[quotaHit.scope] || '本周期'}名额已满，已通过 ${affected} 条，其余将在自动驳回中处理`;
    }
    return success(res, payload, quotaHit ? payload.message : '批量操作完成');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 点歌名额：快照 / 设置 / 手动自动驳回
 * ------------------------------------------------------------------ */
exports.quota = async (req, res, next) => {
  try {
    return success(res, await songQuota.snapshot());
  } catch (e) {
    return next(e);
  }
};

exports.setQuota = async (req, res, next) => {
  try {
    const { daily, weekly } = req.body || {};
    const d = songQuota.parseLimit(daily);
    const w = songQuota.parseLimit(weekly);
    if (w > 0 && d > 0 && w < d) {
      throw new ApiError(Codes.PARAM_ERROR, '每周上限不能小于每日上限');
    }
    const snap = await songQuota.setLimits({ daily: d, weekly: w }, req.admin.id);
    // 调小上限后可能立刻「已满」，顺手扫一次，行为符合直觉
    await songQuota.sweepAllExhausted();
    return success(res, await songQuota.snapshot(), '名额已更新')
      ;
  } catch (e) {
    return next(e);
  }
};

exports.sweepQuota = async (req, res, next) => {
  try {
    const result = await songQuota.sweepAllExhausted();
    return success(res, { ...result, snapshot: await songQuota.snapshot() }, '已执行自动驳回');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 点歌设置：注意事项（两份）/ 播出时段 / 提交规则
 * ------------------------------------------------------------------ */
/** 一次拿到两份注意事项（点歌 + 文稿），省一次往返 */
exports.notice = async (req, res, next) => {
  try {
    return success(res, await songNotice.getAllForAdmin());
  } catch (e) {
    return next(e);
  }
};

exports.saveNotice = async (req, res, next) => {
  try {
    const { content, type } = req.body || {};
    if (content === undefined) {
      throw new ApiError(Codes.PARAM_ERROR, '请传 content（允许空字符串表示停用）');
    }
    const r = await songNotice.save(content, type);
    return success(
      res,
      r,
      r.bumped
        ? `${r.label}已保存，版本号 +1（所有用户需重新确认）`
        : '内容没有变化，版本号保持不变'
    );
  } catch (e) {
    if (e.code === 40001) return fail(res, Codes.PARAM_ERROR, e.message);
    return next(e);
  }
};

/** 播出时段：读取当前生效的配置（含来源：后台发布 / 台词解析 / 默认） */
exports.timeslots = async (req, res, next) => {
  try {
    return success(res, await broadcastSlot.getAdminConfig());
  } catch (e) {
    return next(e);
  }
};

/**
 * 下周排期矩阵（审核即排期，2026-09-19）：
 * 5 天 × N 时段，每格 已通过 / 待审 / 容量；管理端排期视图 + 待审提醒横幅用。
 */
exports.schedule = async (req, res, next) => {
  try {
    return success(res, await broadcastSlot.scheduleMatrix());
  } catch (e) {
    return next(e);
  }
};

/** 播出时段：发布 / 修改（用户 2026-09-18 要求可在后台维护） */
exports.saveSlots = async (req, res, next) => {
  try {
    const { times, capacity } = req.body || {};
    if (!Array.isArray(times)) {
      throw new ApiError(Codes.PARAM_ERROR, '请传 times 数组，如 [{time:"12:20",label:"午间"}]');
    }
    const r = await broadcastSlot.setSlotTimes(times, capacity);
    return success(res, r, '播出时段已更新');
  } catch (e) {
    if (e.code === 40001) return fail(res, Codes.PARAM_ERROR, e.message);
    return next(e);
  }
};

/** 提交规则：每人每周上限 + 同曲一周内不可重复 */
exports.rules = async (req, res, next) => {
  try {
    const rules = await submitRule.getRules();
    return success(res, { ...rules, defaultUserLimit: submitRule.DEFAULT_USER_LIMIT });
  } catch (e) {
    return next(e);
  }
};

exports.saveRules = async (req, res, next) => {
  try {
    const { weeklyUserLimit, dupBlock } = req.body || {};
    const rules = await submitRule.setRules({ weeklyUserLimit, dupBlock });
    return success(res, { ...rules, defaultUserLimit: submitRule.DEFAULT_USER_LIMIT }, '规则已更新');
  } catch (e) {
    return next(e);
  }
};

/**
 * 一键清空全部点歌数据（仅超级管理员，路由层 requireSuperAdmin 把关）
 * DELETE /api/admin/submit/songs   body: { confirm: 'DELETE' }
 *
 * 范围（有意为之，别扩大）：
 *   - 只删 submit.type = 1（点歌），文稿 type = 2 一条不动；
 *   - song_quota 计数器整表清空（否则「本周已用 N 个名额」和现实对不上）；
 *   - notice_ack（注意事项确认记录）**不动** —— 那是「谁确认过规则」，不是歌单数据；
 *   - 不可恢复，前端必须二次确认弹窗。
 */
exports.purgeSongs = async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE') {
      throw new ApiError(Codes.PARAM_ERROR, '高危操作：请传 confirm: "DELETE" 明确确认');
    }
    let deleted = 0;
    await sequelize.transaction(async (t) => {
      deleted = await Submit.destroy({ where: { type: 1 }, transaction: t });
      await SongQuota.destroy({ where: {}, transaction: t });
    });
    songQuota.clearLimitCache();
    return success(res, { deletedSongs: deleted }, `已清空全部点歌数据（${deleted} 条），文稿不受影响`);
  } catch (e) {
    return next(e);
  }
};

exports._internals = { approveOne, QuotaExhaustedError };
