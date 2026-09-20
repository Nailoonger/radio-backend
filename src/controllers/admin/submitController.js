'use strict';

/**
 * 管理端 - 投稿审核（规则 v2，docs/song-queue-v2.md）
 * GET    /api/admin/submit/list            列表（分页、筛选）
 * GET    /api/admin/submit/:id             详情
 * PUT    /api/admin/submit/:id/approve     通过
 * PUT    /api/admin/submit/:id/reject      驳回（必填驳回理由）
 * PUT    /api/admin/submit/:id/revoke      撤销审核结果（回到待审）
 * DELETE /api/admin/submit/:id             删除
 * POST   /api/admin/submit/batch           批量审核
 *
 * 排期容量与候补（v2）：
 * GET    /api/admin/submit/schedule        下周排期矩阵 + 全局候补队列 + 定稿时刻
 * GET    /api/admin/submit/capacity        容量 / 候补 / 窗口 快照
 * POST   /api/admin/submit/queue/sweep     手动触发「递补 + 满额清队 + 定稿清理」（幂等）
 * GET    /api/admin/submit/window          点歌时间窗口（读）
 * PUT    /api/admin/submit/window          点歌时间窗口（写，仅超管）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * v2 与 v1 最大的区别：**审核不再改变容量**
 *   占位发生在学生「提交」那一刻（songQueueService.decideSeat）：
 *     正式位有空 → status=0 待审（已占位）
 *     格子满     → status=3 候补中（全局队列，先进先出）
 *   所以本文件只需要把状态流转做对，不再有「占名额 / 还名额」这套两本账，
 *   也就不会出现「驳回已通过件不还名额」这种泄漏。
 *
 * 状态：0 待审 · 1 已排期 · 2 已驳回 · 3 候补中 · 4 已补位·待审
 * 释放正式位的动作（驳回 / 撤销 / 删除）之后统一调 songQueue.runAfterRelease()
 * ——内部会递补队首、并在排期满额时清空候补队列，全部幂等。
 * ═══════════════════════════════════════════════════════════════════════
 */
const { Op, fn, col } = require('sequelize');
const dayjs = require('dayjs');
const { Submit, User, Admin, sequelize } = require('../../models');
const { success, fail, ApiError, Codes } = require('../../utils/response');
const songQueue = require('../../services/songQueueService');
const songWindow = require('../../services/songWindowService');
const submitRule = require('../../services/submitRuleService');
const roster = require('../../services/studentRosterService');
const songNotice = require('../../services/songNoticeService');
const broadcastSlot = require('../../services/broadcastSlotService');

/** 占正式位的状态（= 已排期占用的口径） */
const SEATED = songQueue.SEATED_STATUS;
const ST = songQueue.ST;

/**
 * 释放位子之后跑一次：递补 + 满额清队 + 定稿清理（幂等）
 *
 * ⚠️ 必须 await —— 早先写成 setImmediate 异步「着火即忘」，结果是：
 *   ① 接口回「空出的位子已开始递补」，管理员立刻刷新列表却还是空的，
 *      过一个 tick 才变，看起来像 bug；
 *   ② 与后续请求（学生提交、另一次审核）抢着改同一条记录，行为不可预期。
 * 内部已经吞掉异常（位子已释放，递补失败只记日志，下次 sweep 会重试），
 * 所以 await 不会把审核动作本身搞失败。
 */
async function afterRelease() {
  try {
    return await songQueue.runAfterRelease();
  } catch (e) {
    return { promoted: 0, closed: 0, full: false, error: e.message };
  }
}

/** 把递补结果拼成给管理员看的话 */
function releaseMsg(base, rel) {
  if (!rel || !rel.promoted) return base;
  return `${base}，已由候补队列递补 ${rel.promoted} 条`;
}

/* ------------------------------------------------------------------ *
 * 内部：通过一条投稿
 * v2 不再有「占名额」这一步 —— 位子在学生提交时就占好了，
 * 审核只负责内容把关，因此这里不会出现「过了但没占位」的脏数据。
 * ------------------------------------------------------------------ */
async function approveOne(submit, adminId) {
  const status = Number(submit.status);

  if (status === ST.SCHEDULED) {
    return { submit, changed: false, already: true };
  }
  // v1 的老毛病：通过一条已驳回的记录会静默无操作却返回「已通过」。
  // v2 明确报错，让管理员知道要先撤销。
  if (status === ST.REJECTED) {
    throw new ApiError(Codes.PARAM_ERROR, '这条已驳回，请先撤销再通过');
  }

  // 候补中：只记审核痕迹，留在队列等位（补位时会直接进「已排期」）
  if (status === ST.QUEUED) {
    const [n] = await Submit.update(
      { reviewerId: adminId, reviewTime: new Date(), rejectReason: null, autoRejected: 0 },
      { where: { id: submit.id, status: ST.QUEUED } }
    );
    return { submit: await Submit.findByPk(submit.id), changed: !!n, queued: !!n };
  }

  // 待审(0) / 已补位待审(4) → 已排期
  const [n] = await Submit.update(
    {
      status: ST.SCHEDULED,
      reviewerId: adminId,
      reviewTime: new Date(),
      rejectReason: null,
      autoRejected: 0,
    },
    { where: { id: submit.id, status: { [Op.in]: [ST.PENDING, ST.PROMOTED] } } }
  );
  return { submit: await Submit.findByPk(submit.id), changed: !!n };
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
    if (startDate && endDate) {
      where.createTime = { [Op.between]: [startDate, endDate] };
    }
    /* 时段筛选（排期矩阵点格子）与关键词搜索都走 OR —— 必须合并成一个数组，
       否则后写的 `where[Op.or] = ...` 会把前一个直接覆盖掉。
       ⚠️ v2 里「排到哪一格」的权威字段是 scheduledSlot（实际排期），
          wantBroadcastTime 只是学生首选（候补件还没排期，只有首选）。
          所以两个都查，点某一格时既能看到排进去的、也能看到首选它的候补件。 */
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

    const list = rows.map(r => {
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
    });

    /* v2：候补中的行补一个「第几位」—— 列表要直接写出位次，管理员才知道谁快补上了。
       只对 status=3 的行算（每行一条 COUNT），其它状态没有位次这个概念。 */
    await Promise.all(list.map(async (item) => {
      if (Number(item.status) !== ST.QUEUED) return;
      try {
        const q = await songQueue.queuePosOf(item);
        item.queuePos = q.pos;
        item.queueAhead = q.ahead;
      } catch (e) {
        item.queuePos = null;   // 读不到位次不该让整个列表失败
      }
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
      /* v2：点歌的候补/补位说明 —— 处理台要靠它显示「候补第几位 / 首选 vs 实际排到 /
         定稿时刻」。cardFor 是学生端同一份实现（docs/song-queue-v2.md §7），
         取不到就返回 null，处理台退回「只显示列表字段」的形态，不影响审核动作。 */
      card: Number(submit.type) === 1
        ? await songQueue.cardFor(submit).catch(() => null)
        : null,
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

    const result = await approveOne(submit, req.admin.id);
    const fresh = result.submit;

    // 通过可能刚好占满最后一个空位 → 立刻检查是否需要清空候补队列（幂等）
    if (result.changed && Number(fresh.type) === 1) await afterRelease();

    let msg = '已通过';
    if (result.already) msg = '已是已排期状态';
    else if (result.queued) msg = '已通过审核，仍在候补队列中等待空位';

    const data = { ...fresh.toJSON() };
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
    // v1 的老毛病：可以把已驳回的再驳回一次，把审核人/时间覆盖成别人的。v2 拦住。
    if (Number(submit.status) === ST.REJECTED) {
      throw new ApiError(Codes.PARAM_ERROR, '这条已是驳回状态，无需重复操作');
    }

    const wasSeated = SEATED.includes(Number(submit.status));
    // 人工驳回：auto_rejected 归零，把「系统驳回」的痕迹清掉
    await submit.update({
      status: ST.REJECTED,
      rejectReason: reason,
      reviewerId: req.admin.id,
      reviewTime: new Date(),
      autoRejected: 0,
    });

    // 原来占着正式位 → 位子立即释放 → 立刻从候补队列递补（v1 漏了这一步，名额会泄漏）
    const rel = wasSeated ? await afterRelease() : null;
    return success(res, submit, releaseMsg(wasSeated ? '已驳回，位子已释放' : '已驳回', rel));
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const wasSeated = Number(submit.type) === 1 && SEATED.includes(Number(submit.status));
    await submit.destroy();
    const rel = wasSeated ? await afterRelease() : null;
    return success(res, null, releaseMsg(wasSeated ? '已删除，位子已释放' : '已删除', rel));
  } catch (e) {
    return next(e);
  }
};

/**
 * 撤销审核结果（v8 审核处理台 / 列表的「撤销」）
 *   已排期(1) / 已补位(4) → 回到待审(0)，位子还在他手上
 *   已驳回(2) → 回到待审(0)；若该格已经满了，则改回到候补队列(3)，避免超容
 */
exports.revoke = async (req, res, next) => {
  try {
    const submit = await Submit.findByPk(req.params.id);
    if (!submit) throw new ApiError(Codes.NOT_FOUND, '投稿不存在');
    const status = Number(submit.status);
    if (status === ST.PENDING) {
      throw new ApiError(Codes.PARAM_ERROR, '这条还是待审状态，无需撤销');
    }

    const wasSeated = SEATED.includes(status);
    // 撤销要把「审核人 / 审核时间」一起清掉 —— 撤销是操作者自己做的事，不算审核结果
    const reset = {
      rejectReason: null,
      reviewTime: null,
      reviewerId: null,
      autoRejected: 0,
    };

    if (status === ST.REJECTED && Number(submit.type) === 1) {
      // 驳回件复活：能坐回原格就坐，坐不下就排队（否则会直接超容）
      const slotValue = submit.scheduledSlot || submit.wantBroadcastTime;
      const { outcome } = await songQueue.decideSeat({ slotValue });
      if (outcome === 'seated') {
        await submit.update({ ...reset, status: ST.PENDING, scheduledSlot: slotValue });
      } else {
        await submit.update({ ...reset, status: ST.QUEUED, scheduledSlot: null, queueAt: new Date() });
      }
    } else {
      await submit.update({ ...reset, status: ST.PENDING });
      if (wasSeated) await afterRelease();
    }

    return success(res, null, status === ST.REJECTED ? '已撤销，回到待审' : '已撤销，回到待审');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 批量审核
 * 通过：逐条走和单条完全相同的路径；已驳回的跳过（不报错、不假成功）
 * 驳回：必须带状态过滤 —— 已驳回的不许二次驳回（v1 会覆盖审核人）
 * 都不再涉及「名额耗尽中途停」：容量在提交时就定好了
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
          status: ST.REJECTED,
          reviewerId: req.admin.id,
          reviewTime: new Date(),
          rejectReason: reason,
          autoRejected: 0,
        },
        { where: { id: ids, status: { [Op.in]: [ST.PENDING, ST.SCHEDULED, ST.QUEUED, ST.PROMOTED] } } }
      );
      await afterRelease();
      return success(res, { affected, skipped: ids.length - affected }, '批量操作完成');
    }

    // 通过：逐条处理
    let affected = 0;
    const skipped = [];
    for (const id of ids) {
      const submit = await Submit.findByPk(id);
      if (!submit) { skipped.push(id); continue; }
      try {
        const r = await approveOne(submit, req.admin.id);
        if (r.changed) affected += 1;
        else skipped.push(id);
      } catch (e) {
        if (e instanceof ApiError) { skipped.push(id); continue; }   // 已驳回件跳过，不中断整批
        throw e;
      }
    }
    await afterRelease();
    return success(res, { affected, skipped }, '批量操作完成');
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 排期容量：快照 / 设置 / 手动兜底
 * v2 没有「日/周名额」了 —— 容量 = 每格正式位 × 格子数，候补 = 一条全局队列
 * ------------------------------------------------------------------ */
exports.capacity = async (req, res, next) => {
  try {
    const [queue, win, capacity] = await Promise.all([
      songQueue.snapshot(),
      songWindow.status(),
      songQueue.getCapacity(),
    ]);
    const ws = songQueue.weekStartOfValue((await broadcastSlot.getSlots()).list[0]?.value);
    return success(res, {
      capacity,
      weekCapacity: queue.weekCapacity,
      queue,
      window: win,
      finalizeAt: ws ? songWindow.toBjsIso(songQueue.windowEndOfWeek(win.config, ws.getTime())) : null,
    });
  } catch (e) {
    return next(e);
  }
};

/** 兼容旧路径 GET /admin/submit/quota（内容与 /capacity 一致） */
exports.quota = exports.capacity;

/**
 * 设置排期容量与候补上限（兼容旧路径 PUT /admin/submit/quota）
 * body: { capacity?, queueLimit? }
 */
exports.setQuota = async (req, res, next) => {
  try {
    const { capacity, queueLimit } = req.body || {};
    if (capacity !== undefined && capacity !== null && capacity !== '') {
      await broadcastSlot.setCapacity(capacity);
    }
    if (queueLimit !== undefined && queueLimit !== null && queueLimit !== '') {
      const n = Math.max(parseInt(queueLimit, 10) || 0, 0);
      await broadcastSlot.clearCache();
      const kvSvc = require('../../services/kvService');
      await kvSvc.set(songQueue.KV_QUEUE_LIMIT, n, '全局候补队列人数上限（0=自动=下周正式位总数）');
    }
    // 改小上限 / 增加候补位后，顺手跑一次递补，行为符合直觉
    await songQueue.sweepAll();
    return success(res, await songQueue.snapshot(), '容量设置已更新');
  } catch (e) {
    return next(e);
  }
};

/**
 * 手动兜底（POST /admin/submit/queue/sweep，幂等）：
 * 递补队首 → 满额清队 → 窗口截止定稿清理
 */
exports.sweepQueue = async (req, res, next) => {
  try {
    const result = await songQueue.sweepAll();
    return success(res, result, '已执行递补与定稿检查');
  } catch (e) {
    return next(e);
  }
};

/** 兼容旧路径 POST /admin/submit/quota/sweep */
exports.sweepQuota = exports.sweepQueue;

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
 * 下周排期矩阵 + 全局候补队列 + 定稿时刻（v2 重写）
 *
 * 每格口径（全部按 scheduled_slot = 实际排期）：
 *   approved  已排期（status=1）
 *   pending   待审（status=0，已占位）
 *   promoted  已补位 · 待审（status=4，候补递补上来的，第 ① 优先审）
 *   seated = approved + pending + promoted（= 该格已占位总数）
 *   left / capacity / full
 *
 * queue 是**全局**候补队列（跨所有时段，先进先出），不挂在格子上。
 */
exports.schedule = async (req, res, next) => {
  try {
    const now = Date.now();
    const slots = await broadcastSlot.getSlots(now);
    const values = slots.list.map((s) => s.value);
    const usage = await songQueue.slotUsage(values, now);

    const rows = await Submit.findAll({
      where: {
        type: 1,
        status: { [Op.in]: [ST.PENDING, ST.SCHEDULED, ST.PROMOTED] },
        scheduledSlot: { [Op.in]: values },
      },
      attributes: ['scheduledSlot', 'status', [fn('COUNT', col('id')), 'n']],
      group: ['scheduledSlot', 'status'],
      raw: true,
    });
    const counters = {};
    rows.forEach((r) => {
      const k = r.scheduledSlot;
      if (!counters[k]) counters[k] = { approved: 0, pending: 0, promoted: 0 };
      const n = Number(r.n) || 0;
      if (Number(r.status) === ST.SCHEDULED) counters[k].approved += n;
      else if (Number(r.status) === ST.PENDING) counters[k].pending += n;
      else counters[k].promoted += n;
    });

    const days = [];
    let byDate = null;
    let totalPending = 0;
    slots.list.forEach((s) => {
      if (!byDate || byDate.date !== s.date) {
        byDate = { date: s.date, weekday: s.weekday, monthDay: s.monthDay, slots: [] };
        days.push(byDate);
      }
      const c = counters[s.value] || { approved: 0, pending: 0, promoted: 0 };
      const u = usage[s.value] || { capacity: slots.capacity, seated: 0, left: null, full: false };
      totalPending += c.pending + c.promoted;
      byDate.slots.push({
        value: s.value,
        date: s.date,
        time: s.time,
        period: s.period,
        label: s.label,
        approved: c.approved,
        pending: c.pending,
        promoted: c.promoted,
        seated: u.seated,
        left: u.left,
        capacity: u.capacity,
        full: u.full,
      });
    });

    const [queue, win] = await Promise.all([songQueue.snapshot(now), songWindow.status(now)]);
    const ws = values.length ? songQueue.weekStartOfValue(values[0]) : null;
    const finalizeAt = ws ? songWindow.toBjsIso(songQueue.windowEndOfWeek(win.config, ws.getTime())) : null;

    return success(res, {
      weekStart: slots.weekStart,
      weekEnd: slots.weekEnd,
      rangeText: slots.rangeText,
      capacity: slots.capacity,
      weekCapacity: queue.weekCapacity,
      totalPending,
      days,
      queue,
      window: win,
      finalizeAt,
    });
  } catch (e) {
    return next(e);
  }
};

/* ------------------------------------------------------------------ *
 * 点歌时间窗口（读：管理员可看；写：仅超管，路由层 requireSuperAdmin）
 * 窗口时间必须常驻展示在点歌模块，前端一律用这里的字段，不许硬编码
 * ------------------------------------------------------------------ */
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
    const saved = await songWindow.setConfig(body, req.admin.id);
    const st = await songWindow.describe();
    return success(res, st, `点歌时间已更新：${st.windowText}（窗口结束即审核截止）`);
  } catch (e) {
    if (e instanceof ApiError) return next(e);
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
      // v2 起没有独立计数器表了（容量直接数 submit 行），所以这里不用再清 song_quota
    });
    return success(res, { deletedSongs: deleted }, `已清空全部点歌数据（${deleted} 条），文稿不受影响`);
  } catch (e) {
    return next(e);
  }
};

exports._internals = { approveOne };
