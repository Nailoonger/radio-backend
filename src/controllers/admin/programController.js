'use strict';

/**
 * 管理端 - 栏目管理
 * GET    /api/admin/program/list
 * POST   /api/admin/program/create
 * PUT    /api/admin/program/:id
 * DELETE /api/admin/program/:id
 * PUT    /api/admin/program/:id/live      切换"正在直播"标识（保证仅一个节目 live=1）
 * GET    /api/admin/program/slots         读播出编排（每天几个时段、每段几档）
 * PUT    /api/admin/program/slots         写播出编排（仅超管）
 *
 * ⚠️⚠️ 2026-11-19 起栏目**不再填具体日期**：
 *   常规栏目 = 每周哪几天（weekdays）+ 哪个时段（slotLabel）+ 第几档（slotIndex），
 *   具体日期由 services/programSlotService.expand() 在**下发前**投影出来。
 *   只有「特别节目档」（isSpecial=1）才带自己的 broadcastDate。
 *
 *   这么做的原因：broadcast_date 是小程序节目单与首页「今天 12:10 见」唯一的时间依据，
 *   只把字段换成周几会让那些按日期查的接口静默返回空列表（不报错，最难发现）。
 */
const { Program } = require('../../models');
const { success, ApiError, Codes } = require('../../utils/response');
const programSlot = require('../../services/programSlotService');

/** 周几归一化 → '1,2,3' */
function normWeekdays(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (v !== undefined && v !== null && String(v).trim() !== '') {
    arr = String(v).split(',');
  }
  const nums = arr
    .map((x) => parseInt(String(x).trim(), 10))
    .filter((n) => n >= 1 && n <= 7)
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => a - b);
  return nums.join(',');
}

/** 按编排算出这一档的起止文本（服务端算，不信前端传的时间） */
function resolveTime(body, slots) {
  const isSpecial = Number(body.isSpecial) === 1 ? 1 : 0;
  const manual = String(body.broadcastTime || '').trim();
  if (isSpecial) return manual;
  const auto = programSlot.timeTextOf(body.slotLabel, body.slotIndex, slots);
  return auto || manual;
}

exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 200 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(pageSize, 10);
    const { rows, count } = await Program.findAndCountAll({
      order: [['sort', 'ASC'], ['id', 'ASC']],
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

exports.create = async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) throw new ApiError(Codes.PARAM_ERROR, '请填写节目名');

    const isSpecial = Number(b.isSpecial) === 1 ? 1 : 0;
    const weekdays = normWeekdays(b.weekdays);
    const broadcastDate = isSpecial ? String(b.broadcastDate || '').trim() : '';

    if (isSpecial) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(broadcastDate)) {
        throw new ApiError(Codes.PARAM_ERROR, '特别节目档必须选择播出日期');
      }
    } else {
      if (!weekdays) throw new ApiError(Codes.PARAM_ERROR, '请选择每周哪几天播出');
      if (!b.slotLabel) throw new ApiError(Codes.PARAM_ERROR, '请选择播出时段');
      if (!(Number(b.slotIndex) >= 1)) throw new ApiError(Codes.PARAM_ERROR, '请选择第几档');
    }

    const slots = await programSlot.getSlots();
    const broadcastTime = resolveTime({ ...b, isSpecial }, slots);
    if (!broadcastTime) {
      throw new ApiError(Codes.PARAM_ERROR, '这个时段 / 档位在播出编排里不存在，请刷新后重选');
    }

    const program = await Program.create({
      title,
      host: b.host,
      broadcastTime,
      broadcastDate: isSpecial ? broadcastDate : null,
      weekdays: isSpecial ? null : weekdays,
      slotLabel: isSpecial ? null : b.slotLabel,
      slotIndex: isSpecial ? null : parseInt(b.slotIndex, 10),
      isSpecial,
      desc: b.desc,
      cover: b.cover,
      isShow: b.isShow === undefined ? 1 : b.isShow,
      sort: b.sort || 0,
    });
    return success(res, program, '创建成功');
  } catch (e) {
    return next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');

    const b = req.body || {};
    const isSpecial = b.isSpecial === undefined
      ? Number(program.isSpecial) === 1
      : Number(b.isSpecial) === 1;

    if (b.title !== undefined) program.title = String(b.title).trim();
    if (b.host !== undefined) program.host = b.host;
    if (b.desc !== undefined) program.desc = b.desc;
    if (b.cover !== undefined) program.cover = b.cover;
    if (b.isShow !== undefined) program.isShow = b.isShow;
    if (b.sort !== undefined) program.sort = b.sort;

    program.isSpecial = isSpecial ? 1 : 0;

    if (isSpecial) {
      if (b.broadcastDate !== undefined) program.broadcastDate = String(b.broadcastDate || '').trim() || null;
      if (!program.broadcastDate) throw new ApiError(Codes.PARAM_ERROR, '特别节目档必须选择播出日期');
      if (b.broadcastTime !== undefined) program.broadcastTime = String(b.broadcastTime).trim();
      program.weekdays = null;
      program.slotLabel = null;
      program.slotIndex = null;
    } else {
      if (b.weekdays !== undefined) program.weekdays = normWeekdays(b.weekdays);
      if (b.slotLabel !== undefined) program.slotLabel = b.slotLabel;
      if (b.slotIndex !== undefined) program.slotIndex = parseInt(b.slotIndex, 10);
      if (!program.weekdays) throw new ApiError(Codes.PARAM_ERROR, '请选择每周哪几天播出');
      if (!program.slotLabel) throw new ApiError(Codes.PARAM_ERROR, '请选择播出时段');
      if (!(Number(program.slotIndex) >= 1)) throw new ApiError(Codes.PARAM_ERROR, '请选择第几档');

      const slots = await programSlot.getSlots();
      program.broadcastTime = resolveTime(
        { isSpecial: 0, slotLabel: program.slotLabel, slotIndex: program.slotIndex },
        slots
      );
      program.broadcastDate = null;
    }

    await program.save();
    return success(res, program, '更新成功');
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
    await program.destroy();
    return success(res, null, '已删除');
  } catch (e) {
    return next(e);
  }
};

/**
 * 切换"正在直播"：仅一个节目可设置 live=1
 */
exports.setLive = async (req, res, next) => {
  try {
    const { isLive } = req.body || {};
    if (isLive === 1) {
      await Program.update({ isLive: 0 }, { where: {} });
    }
    const program = await Program.findByPk(req.params.id);
    if (!program) throw new ApiError(Codes.NOT_FOUND, '节目不存在');
    program.isLive = isLive ? 1 : 0;
    await program.save();
    return success(res, program, '已更新直播状态');
  } catch (e) {
    return next(e);
  }
};

/* ─────────── 播出编排（时段 / 档数） ─────────── */

exports.getSlots = async (req, res, next) => {
  try {
    const slots = await programSlot.getSlotsWithTicks();
    return success(res, {
      list: slots,
      maxSlots: programSlot.MAX_SLOTS,
      maxCount: programSlot.MAX_COUNT,
    });
  } catch (e) {
    return next(e);
  }
};

exports.saveSlots = async (req, res, next) => {
  try {
    const list = (req.body && req.body.list) || req.body || [];
    const norm = await programSlot.setSlots(list);
    // 服务层只做归一化，不抛业务码（见 programSlotService.setSlots 注释）；
    // 「一个合法时段都没剩」在这里报 40001，与云函数端保持同一码同一文案。
    if (!norm) throw new ApiError(Codes.PARAM_ERROR, '至少要有一个合法时段（名称 + 起止 HH:mm + 档数）');
    return success(res, { list: norm }, '编排已保存');
  } catch (e) {
    return next(e);
  }
};
