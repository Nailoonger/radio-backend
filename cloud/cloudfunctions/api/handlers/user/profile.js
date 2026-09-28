'use strict';

/**
 * 用户端 · 广播站信息（公开接口）
 * 迁移自 src/controllers/user/profileController.js 的三个 station 接口
 *
 * ⚠️ 未配置时的行为严格保持原样：抛 40401「未配置」，不返回空值。
 */

const kv = require('../../services/kv');
const { ApiError, Codes } = require('../../lib/response');

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

module.exports = { stationIntro, stationSchedule, stationContact };
