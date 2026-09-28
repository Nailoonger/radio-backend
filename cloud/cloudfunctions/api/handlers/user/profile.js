'use strict';

/**
 * 用户端 · 个人中心 + 广播站信息（公开 part）
 * 迁移自 src/controllers/user/profileController.js
 *
 *   GET /user/profile           个人中心聚合（投稿统计 + 最近 5 条）【需登录】
 *   GET /user/station/intro     广播站介绍
 *   GET /user/station/schedule  开播时间
 *   GET /user/station/contact   联系方式
 *
 * ⚠️ 未配置时的行为**严格保持原样**：抛 40401「未配置」，不返回空字符串。
 *    前端靠这个码决定「这块区域不渲染」。
 */

const { C, findOne, findMany, count } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { requireUser } = require('../../lib/auth');
const kv = require('../../services/kv');

/** GET /user/profile —— 需登录 */
async function profile(ctx) {
  const user = await requireUser(ctx);
  const openid = user.openid;

  const [submitTotal, submitPending, submitApproved, messageTotal, recentSubmits] = await Promise.all([
    count(C.SUBMIT, { openid }),
    count(C.SUBMIT, { openid, status: 0 }),
    count(C.SUBMIT, { openid, status: 1 }),
    count(C.MESSAGE, { openid }),
    findMany(C.SUBMIT, { openid }, { orderBy: [['createTime', 'desc']], limit: 5 }),
  ]);

  return {
    stats: { submitTotal, submitPending, submitApproved, messageTotal },
    recentSubmits,
  };
}

/** 通用：读取系统设置（key -> { key, value }），未配置抛 40401 */
async function getSetting(key) {
  const doc = await kv.getMany([key]);
  if (doc[key] === undefined || doc[key] === null) {
    throw new ApiError(Codes.NOT_FOUND, '未配置');
  }
  return { key, value: doc[key] };
}

/** GET /user/station/intro */
async function stationIntro() {
  return getSetting('station_intro');
}

/** GET /user/station/schedule */
async function stationSchedule() {
  return getSetting('broadcast_schedule');
}

/** GET /user/station/contact */
async function stationContact() {
  return getSetting('contact');
}

module.exports = { profile, stationIntro, stationSchedule, stationContact };
