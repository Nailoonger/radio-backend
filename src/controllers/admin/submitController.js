'use strict';

/**
 * 管理端 - 投稿审核与排期（协议版，2026-09-24，docs/song-protocol.md）
 *
 * 审核：
 * GET    /api/admin/submit/list            列表（分页、筛选）
 * GET    /api/admin/submit/:id             详情（含三维状态 + 状态变更历史）
 * PUT    /api/admin/submit/:id/approve     审核通过（→ 进排期候选池）
 * PUT    /api/admin/submit/:id/reject      审核驳回（必填理由）
 * PUT    /api/admin/submit/:id/revoke      撤销审核结果（回到待审）
 * DELETE /api/admin/submit/:id             删除
 * POST   /api/admin/submit/batch           批量审核
 *
 * 排期（协议 §16~§20）：
 * GET    /api/admin/submit/schedule        下周排期矩阵（三维）+ 候补队列 + 锁定时刻
 * GET    /api/admin/submit/week            目标周的排期状态与时间锚点
 * POST   /api/admin/submit/schedule/run    执行第一轮排期 + 全局调剂
 * POST   /api/admin/submit/schedule/lock   正式锁定（最后调度 + 无位自动驳回）
 * POST   /api/admin/submit/:id/assign      人工指定时段
 * PUT    /api/admin/submit/:id/played      标记已播放 / 取消
 * GET    /api/admin/submit/capacity        容量与候补快照
 * POST   /api/admin/submit/queue/sweep     手动兜底 sweep（幂等）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 协议版与 v2 最大的区别：
 *   v2  「提交即占位」—— 审核只是内容把关，位子在学生提交那一刻就定了。
 *   协议 「审核通过后才进排期」—— 审核通过只是拿到**候选资格**，
 *        真正的位置由第一轮排期（按首选时段 + 提交时间）决定，
 *        没排上的人是 WAITING，靠原位递补 / 全局调剂再争取。
 *
 * 状态真值是三个维度（review/schedule/play），`status` 只是派生镜像。
 * 本文件所有状态改动一律走 `songStatusService.applyChange()`，不直接写 status。
 * ═══════════════════════════════════════════════════════════════════════
 */
const { Op, fn, col } = require('sequelize');
const { Submit, User, Admin, sequelize } = require('../../models');
const { success, fail, ApiError, Codes } = require('../../utils/response');
const songQueue = require('../../services/songQueueService');
const songWindow = require('../../services/songWindowService');
const submitRule = require('../../services/submitRuleService');
const roster = require('../../services/studentRosterService');
const songNotice = require('../../services/songNoticeService');
const broadcastSlot = require('../../services/broadcastSlotService');
const S = require('../../services/songStatusService');
const sched = require('../../services/songSchedulingService');
const logger = require('../../utils/logger');

const ST = S.ST;

/** 给接口对象塞上三维状态视图 */
function withStatus(o) { return { ...o, ...S.statusView(o) }; }

/** 拿到这条点歌所属周的周一 00:00（绝对时刻） */
function weekMsOf(submit) {
  const ws = sched.weekStartOfRow(submit);
  return ws ? ws.getTime() : null;
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
    // 排期失败不能把审核动作本身搞失败（审核已经落库了），但**必须留痕** ——
    // 静默吞掉会让「审核通过了却一直没有位置」变成一个查不出来的悬案。
    logger.warn(`[songSchedule] 审核后重算排期失败 week=${new Date(ms).toISOString()}：${e.message}`);
    return { promoted: 0, rescheduled: 0, left: 0, error: e.message };
  }
}

/** 把调剂结果拼成给管理员看的话 */
function releaseMsg(base, rel) {
  if (!rel) return base;
  const bits = [];
  if (rel.promoted) bits.push(`原位递补 ${rel.promoted} 条`);
  if (rel.rescheduled) bits.push(`跨时段调剂 ${rel.rescheduled} 条`);
  return bits.length ? `${base}，已${bits.join('、')}` : base;
}

/* ------------------------------------------------------------------ *
 * 内部：审核通过 / 驳回
 * ------------------------------------------------------------------ */
/**
 * 协议 §14：这里的 approve **只是审核通过**，不等于拿到位置。
 *   审核通过 → review=APPROVED / schedule=UNASSIGNED → 进排期候选池
 *   之后由 initialAllocate 决定谁是 APPROVED、谁是 WAITING
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
  if (schedule === S.SCHEDULE.AUTO_REJECTED) {
    changes.scheduleStatus = S.SCHEDULE.UNASSIGNED;
  } else if (schedule === S.SCHEDULE.UNASSIGNED) {
    changes.scheduleStatus = S.SCHEDULE.UNASSIGNED;
  }

  const r = await S.applyChange(submit, changes, {
    operatorId: adminId, operatorName: 'ADMIN', reason: 'REVIEW_APPROVED',
  });
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
  return { submit: r.row, wasSeated };
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
      slot,
      reviewStatus, scheduleStatus,      // 协议版：可以直接按维度筛
    } = req.query;

    const where = {};
    if (status !== undefined && status !== '') where.status = parseInt(status, 10);
    if (type !== undefined && type !== '') where.type = parseInt(type, 10);
    if (reviewStatus !== undefined && reviewStatus !== '') where.reviewStatus = parseInt(reviewStatus, 10);
    if (scheduleStatus !== undefined && scheduleStatus !== '') where.scheduleStatus = parseInt(scheduleStatus, 10);
    if (startDate && endDate) {
      where.createTime = { [Op.between]: [startDate, endDate] };
    }
    const or = [];
    if (slot) {
      const v = String(slot);
      or.push({ scheduledSlot: v }, { wantBroadcastTime: v });
    }
    if (keyword) {
      or.push(
        { songName: { [Op.like]: `%${keyword}%` } },
        { singer: { [Op.like]: `%${keyword}%` } },
        { articleTitle: { [Op.like]: `%${keyword}%` } },
        { wishContent: { [Op.like]: `%${keyword}%` } }
      );
    }
    if (or.length) where[Op.or] = or;

    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Submit.findAndCountAll({
      where,
      order: [['create_time', 'DESC']],
      offset,
      limit: parseInt(pageSize, 10),
    });

    // 关联用户昵称/头像（账号体系下投稿的 openid 字段里存的是学号）
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

    const reviewerIds = [...new Set(rows.map((r) => r.reviewerId).filter(Boolean))];
    const admins = reviewerIds.length
      ? await Admin.findAll({ where: { id: reviewerIds }, attributes: ['id', 'username', 'nickname'] })
      : [];
    const adminMap = new Map(admins.map((a) => [Number(a.id), a]));
    const reviewerName = (r) => {
      if (Number(r.autoRejected) === 1) return '系统自动驳回';
      const a = adminMap.get(Number(r.reviewerId));
      return a ? (a.nickname || a.username) : (Number(r.reviewStatus) === 0 ? '' : '—');
    };

    const list = rows.map(r => {
      const u = userMap.get(r.openid);
      return withStatus({
        ...r.toJSON(),
        nickname: displayName(u),
        studentNo: (u && u.username) || '',
        avatar: (u && u.avatar) || '',
        reviewerName: reviewerName(r),
        reviewTime: r.reviewTime,
        autoRejected: Number(r.autoRejected) === 1,
      });
    });

    // 候补中的行补「第几位」
    await Promise.all(list.map(async (item) => {
      if (Number(item.scheduleStatus) !== S.SCHEDULE.WAITING) return;
      try {
        const q = await sched.waitingPosOf(item);
        item.queuePos = q.pos;
        item.queueAhead = q.ahead;
        item.queueTotal = q.total;
      } catch (e) { item.queuePos = null; }
    }));

    return success(res, {
      list,
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

    const key = submit.openid;
    const [totalCount, approved, rejected, pending, agg] = await Promise.all([
      Submit.count({ where: { openid: key } }),
      Submit.count({ where: { openid: key, reviewStatus: S.REVIEW.APPROVED } }),
      Submit.count({ where: { openid: key, reviewStatus: S.REVIEW.REJECTED } }),
      Submit.count({ where: { openid: key, reviewStatus: S.REVIEW.PENDING } }),
      Submit.findOne({
        where: { openid: key },
        attributes: [
          [fn('MIN', col('create_time')), 'firstAt'],
          [fn('MAX', col('create_time')), 'lastAt'],
        ],
        raw: true,
      }),
    ]);
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

    let reviewer = null;
    if (submit.reviewerId) {
      reviewer = await Admin.findOne({ where: { id: submit.reviewerId }, attributes: ['username', 'nickname'] });
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
        const { AssignmentLog } = require('../../models');
        assignments = await AssignmentLog.findAll({ where: { requestId: submit.id }, order: [['id', 'ASC']], raw: true });
      } catch (e) { assignments = []; }
    }

    return success(res, {
      ...withStatus(submit.toJSON()),
      nickname: submitter.nickname,
      studentNo: submitter.username,
      avatar: (user && user.avatar) || '',
      reviewerName,
      autoRejected: Number(submit.autoRejected) === 1,
      submitter,
      card: Number(submit.type) === 1
        ? await songQueue.cardFor(submit).catch(() => null)
        : null,
      statusHistory,
      assignments,
    });
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 通过 / 驳回 / 删除 / 撤销
 * ------------------------------------------------------------------ */
exports.approve = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');

    const result = await approveOne(submit, req.admin.id);
    let fresh = result.submit;

    // 审核通过 → 进排期候选池 → 立刻跑一次该周的排期（幂等）
    // 这样管理员点完「通过」就能在矩阵上看到位置变化，不用额外点「执行排期」。
    let rel = null;
    if (result.changed && Number(fresh.type) === 1) {
      rel = await runWeekSchedule(fresh, { operatorId: req.admin.id });
      // ⚠️ 排期会**再改一次这条记录**（schedule_status 0 → 1/2）。
      //    不 reload 就会把「已通过 · 待排期」这个中间态回给前端 —— 界面显示
      //    「还没排上」，刷新一下又变成「已排期」，看起来像 bug。
      await fresh.reload();
    }

    let msg = '已通过审核，进入排期';
    if (result.already) msg = '这条已经是「审核通过」了';
    if (rel && rel.assigned) msg += `（新增落座 ${rel.assigned} 条）`;

    const data = withStatus(fresh.toJSON());
    if (Number(fresh.type) === 1) {
      try { data.card = await songQueue.cardFor(fresh); } catch (e) { data.card = null; }
    }
    return success(res, data, msg);
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

    const { submit: fresh, wasSeated } = await rejectOne(submit, req.admin.id, reason);

    // 驳回使 review 离开 APPROVED → 位子释放 → 立刻让候补重新对齐
    const rel = (wasSeated && Number(fresh.type) === 1) ? await runWeekSchedule(fresh, { operatorId: req.admin.id }) : null;
    return success(res, withStatus(fresh.toJSON()), releaseMsg(wasSeated ? '已驳回，位子已释放' : '已驳回', rel));
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const wasSeated = Number(submit.type) === 1 && sched.isSeated(submit);
    const ms = Number(submit.type) === 1 ? weekMsOf(submit) : null;
    await submit.destroy();
    let rel = null;
    if (wasSeated && ms !== null) {
      rel = await sched.runAllocators(ms, { operatorId: req.admin.id }).catch(() => null);
    }
    return success(res, null, releaseMsg(wasSeated ? '已删除，位子已释放' : '已删除', rel));
  } catch (e) {
    return next(e);
  }
};

/**
 * 撤销审核结果
 *   审核通过(1) → 回到待审(0)；排期维度重置，位子释放并触发调剂
 *   已驳回(2)   → 回到待审(0)，重新走审核
 */
exports.revoke = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
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
    }, { operatorId: req.admin.id, operatorName: 'ADMIN', reason: 'REVOKED' });

    let rel = null;
    if (Number(r.row.type) === 1) {
      if (fromSlot) {
        await sched.logAssignment(r.row.id, fromSlot, null, sched.ASSIGN.RELEASED, sched.ASSIGN_REASON.slotReleased, req.admin.id);
      }
      if (wasSeated) rel = await runWeekSchedule(r.row, { operatorId: req.admin.id });
    }
    return success(res, withStatus(r.row.toJSON()), releaseMsg('已撤销，回到待审', rel));
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 批量审核
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

    let affected = 0;
    const skipped = [];
    const weeks = new Set();

    for (const id of ids) {
      const submit = await Submit.findByPk(id);
      if (!submit) { skipped.push(id); continue; }
      try {
        if (action === 'approve') {
          const r = await approveOne(submit, req.admin.id);
          if (r.changed) affected += 1; else skipped.push(id);
        } else {
          const r = await rejectOne(submit, req.admin.id, reason);
          affected += 1;
          if (r.wasSeated) { const ms = weekMsOf(submit); if (ms !== null) weeks.add(ms); }
        }
        if (Number(submit.type) === 1) {
          const ms = weekMsOf(submit);
          if (ms !== null) weeks.add(ms);
        }
      } catch (e) {
        if (e instanceof ApiError) { skipped.push(id); continue; }
        throw e;
      }
    }

    // 涉及的每一周统一重跑排期（一次，而不是每条约一次）
    for (const ms of weeks) {
      await sched.initialAllocate(ms, { operatorId: req.admin.id }).catch(() => null);
      await sched.runAllocators(ms, { operatorId: req.admin.id }).catch(() => null);
    }

    return success(res, { affected, skipped }, '批量操作完成');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 排期：矩阵 / 执行 / 锁定 / 人工调整 / 播放
 * ------------------------------------------------------------------ */
/**
 * 先算一条点歌属于哪个周（没有排期行时用「首选时段」推）
 */
async function targetWeekMs(now = Date.now()) {
  const slots = await broadcastSlot.getSlots(now);
  if (slots.list.length) {
    const ws = sched.weekStartOfValue(slots.list[0].value);
    if (ws) return ws.getTime();
  }
  return songWindow.windowRangeAt(await songWindow.getConfig(now), now).weekStart.getTime();
}

/** 排期矩阵（三维）+ 全局候补队列 */
exports.schedule = async (req, res, next) => {
  try {
    const now = Date.now();
    const slots = await broadcastSlot.getSlots(now);
    const values = slots.list.map((s) => s.value);
    const capacity = await songQueue.getCapacity();
    const weekMs = values.length ? sched.weekStartOfValue(values[0]).getTime() : await targetWeekMs(now);
    const week = await sched.ensureWeek(weekMs, { now });

    // ① 每格已占（review=APPROVED AND schedule=APPROVED）
    const seatedMap = await sched.countSeatedBySlot(values);
    // ② 每格「首选这一格但还在候补」的数量
    const waitingRows = await Submit.findAll({
      where: { type: 1, reviewStatus: S.REVIEW.APPROVED, scheduleStatus: S.SCHEDULE.WAITING, wantBroadcastTime: { [Op.in]: values } },
      attributes: ['wantBroadcastTime', [fn('COUNT', col('id')), 'n']],
      group: ['wantBroadcastTime'],
      raw: true,
    });
    const waitingMap = {};
    waitingRows.forEach((r) => { waitingMap[r.wantBroadcastTime] = Number(r.n) || 0; });
    // ③ 每格「还在审核中」的数量
    const pendingRows = await Submit.findAll({
      where: { type: 1, reviewStatus: S.REVIEW.PENDING, wantBroadcastTime: { [Op.in]: values } },
      attributes: ['wantBroadcastTime', [fn('COUNT', col('id')), 'n']],
      group: ['wantBroadcastTime'],
      raw: true,
    });
    const pendingMap = {};
    pendingRows.forEach((r) => { pendingMap[r.wantBroadcastTime] = Number(r.n) || 0; });

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

    return success(res, {
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
      lockAt: week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
      /** @deprecated 旧字段名（= 锁定时刻） */
      finalizeAt: week.scheduleLockAt ? songWindow.toBjsIso(new Date(+new Date(week.scheduleLockAt))) : null,
    });
  } catch (e) {
    return next(e);
  }
};

/** 目标周的状态与时间锚点 */
exports.week = async (req, res, next) => {
  try {
    const now = Date.now();
    const ms = req.query.weekStart
      ? new Date(`${req.query.weekStart}T00:00:00+08:00`).getTime()
      : await targetWeekMs(now);
    const week = await sched.ensureWeek(ms, { now });
    const values = await sched.slotValuesOfWeek(ms);
    const counters = await sched.countSeatedBySlot(values);
    const capacity = await songQueue.getCapacity();
    const seated = Object.values(counters).reduce((a, b) => a + b, 0);
    const total = capacity > 0 ? values.length * capacity : 0;
    return success(res, {
      ...sched.weekView(week, now),
      slots: values.length,
      capacity,
      seated,
      left: total ? Math.max(0, total - seated) : null,
      total,
    });
  } catch (e) {
    return next(e);
  }
};

/** 执行第一轮排期 + 全局调剂（管理端「执行调度」按钮） */
exports.runSchedule = async (req, res, next) => {
  try {
    const now = Date.now();
    const body = req.body || {};
    const ms = body.weekStart
      ? new Date(`${body.weekStart}T00:00:00+08:00`).getTime()
      : await targetWeekMs(now);
    const a = await sched.initialAllocate(ms, { now, operatorId: req.admin.id });
    const b = await sched.reschedule(ms, { now, operatorId: req.admin.id });
    const week = await sched.ensureWeek(ms, { now });
    return success(res, {
      week: sched.weekView(week, now),
      assigned: a.assigned,
      waiting: a.waiting,
      promoted: b.promoted,
      rescheduled: b.rescheduled,
      stillWaiting: b.left,
    }, `排期完成：落座 ${a.assigned} 条、进候补 ${a.waiting} 条、递补 ${b.promoted + b.rescheduled} 条`);
  } catch (e) {
    return next(e);
  }
};

/**
 * 正式锁定（协议 §18）
 * 到锁定时刻由调度器自动执行；也可以管理员手动锁（force）
 */
exports.lock = async (req, res, next) => {
  try {
    const now = Date.now();
    const body = req.body || {};
    const ms = body.weekStart
      ? new Date(`${body.weekStart}T00:00:00+08:00`).getTime()
      : await targetWeekMs(now);
    const force = body.force === true || body.force === 1 || body.force === '1';
    const r = await sched.lockWeek(ms, { now, operatorId: req.admin.id, force });
    if (r.tooEarly) {
      throw new ApiError(Codes.PARAM_ERROR, `还没到锁定时刻（${r.lockText}），如需提前锁定请传 force: true`);
    }
    return success(res, r, r.already
      ? '这一周已经锁定过了'
      : `已锁定：最后调度完成，无可用位置的 ${r.rejected} 条已自动驳回`);
  } catch (e) {
    return next(e);
  }
};

/** 人工指定时段（协议 §20） */
exports.assign = async (req, res, next) => {
  try {
    const { slot, reason } = req.body || {};
    if (!slot) throw new ApiError(Codes.PARAM_ERROR, '请传 slot（目标时段值）');
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    if (Number(submit.type) !== 1) throw new ApiError(Codes.PARAM_ERROR, '只能对点歌做排期调整');

    try {
      const r = await sched.manualAssign(submit, String(slot), {
        operatorId: req.admin.id,
        reason: reason || sched.ASSIGN_REASON.manual,
      });
      // 新位置占了，原位置空了 → 重新对齐候补
      const old = Number(submit.scheduleStatus) === S.SCHEDULE.APPROVED ? submit.scheduledSlot : null;
      void old;
      await sched.runAllocators(sched.weekStartOfValue(String(slot)).getTime(), { operatorId: req.admin.id }).catch(() => null);
      return success(res, withStatus(r.row.toJSON()), '已调整播出时段');
    } catch (e) {
      if (e.code === 40001) throw new ApiError(Codes.PARAM_ERROR, e.message);
      throw e;
    }
  } catch (e) {
    return next(e);
  }
};

/** 标记已播放 / 取消已播放 */
exports.played = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const played = (req.body || {}).played === undefined ? true : !!(req.body || {}).played;
    const r = await sched.setPlayed(submit, played, { operatorId: req.admin.id });
    return success(res, withStatus(r.row.toJSON()), played ? '已标记为已播放' : '已取消播放标记');
  } catch (e) {
    return next(e);
  }
};

/** 状态变更历史（后台「这首歌为什么是这个状态」） */
exports.statusLogs = async (req, res, next) => {
  try {
    return success(res, await S.historyOf(req.params.id, 100));
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 容量 / 兜底
 * ------------------------------------------------------------------ */
exports.capacity = async (req, res, next) => {
  try {
    return success(res, await songQueue.capacitySnapshot());
  } catch (e) {
    return next(e);
  }
};

/** 兼容旧路径 GET /admin/submit/quota */
exports.quota = exports.capacity;

/**
 * 设置每格容量（`queueLimit` 在协议版已废弃 —— 候补没有人数上限，传了也不生效）
 * body: { capacity? }
 */
exports.setQuota = async (req, res, next) => {
  try {
    const { capacity } = req.body || {};
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      await broadcastSlot.setCapacity(capacity);
    }
    await broadcastSlot.clearCache();
    // 改容量后立刻重跑排期（可能多出位置 / 少掉位置），行为符合直觉
    const now = Date.now();
    const ms = await targetWeekMs(now);
    await sched.initialAllocate(ms, { now, operatorId: req.admin.id }).catch(() => null);
    await sched.runAllocators(ms, { now, operatorId: req.admin.id }).catch(() => null);
    return success(res, await songQueue.snapshot(now), '每格容量已更新，排期已重算');
  } catch (e) {
    return next(e);
  }
};

/** 手动兜底（POST /admin/submit/queue/sweep，幂等） */
exports.sweepQueue = async (req, res, next) => {
  try {
    const result = await sched.sweep({ now: Date.now(), operatorId: req.admin.id });
    return success(res, result, '已执行排期兜底（含锁定与播放标记）');
  } catch (e) {
    return next(e);
  }
};

/** 兼容旧路径 POST /admin/submit/quota/sweep */
exports.sweepQuota = exports.sweepQueue;

/* ------------------------------------------------------------------ *
 * 点歌设置：注意事项 / 播出时段 / 提交规则
 * ------------------------------------------------------------------ */
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

exports.timeslots = async (req, res, next) => {
  try {
    return success(res, await broadcastSlot.getAdminConfig());
  } catch (e) {
    return next(e);
  }
};

exports.window = async (req, res, next) => {
  try {
    return success(res, await songWindow.describe());
  } catch (e) {
    return next(e);
  }
};

exports.saveWindow = async (req, res, next) => {
  try {
    const body = req.body || {};
    await songWindow.setConfig(body, req.admin.id);
    const st = await songWindow.describe();
    return success(res, st, `点歌时间已更新：${st.windowText}（窗口结束即审核开始）`);
  } catch (e) {
    if (e instanceof ApiError) return next(e);
    return next(e);
  }
};

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
 * 一键清空全部点歌数据（仅超级管理员）
 * DELETE /api/admin/submit/songs   body: { confirm: 'DELETE' }
 */
exports.purgeSongs = async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE') {
      throw new ApiError(Codes.PARAM_ERROR, '高危操作：请传 confirm: "DELETE" 明确确认');
    }
    const { AssignmentLog, RequestStatusLog } = require('../../models');
    let deleted = 0;
    let logs = 0;
    await sequelize.transaction(async (t) => {
      const ids = (await Submit.findAll({ where: { type: 1 }, attributes: ['id'], raw: true, transaction: t })).map((r) => r.id);
      if (ids.length) {
        // 日志一并清（协议版新增的两张表，否则会留下指向不存在点歌的孤儿行）
        await AssignmentLog.destroy({ where: { requestId: ids }, transaction: t });
        await RequestStatusLog.destroy({ where: { requestId: ids }, transaction: t });
      }
      logs = ids.length;
      deleted = await Submit.destroy({ where: { type: 1 }, transaction: t });
    });
    return success(res, { deletedSongs: deleted, logsCleared: logs }, `已清空全部点歌数据（${deleted} 条），文稿不受影响`);
  } catch (e) {
    return next(e);
  }
};

exports._internals = { approveOne, rejectOne, runWeekSchedule, targetWeekMs };
