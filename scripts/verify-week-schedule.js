'use strict';

/**
 * 本周点歌排期（currentWeekSchedule）+ home_song_schedule 开关 验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-week-schedule.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖：
 *   A. currentWeekSchedule：本周一~周五 / isToday / 只含 status=1 /
 *      下周·待审·候补·驳回·文稿不出现 / payload 不带点歌人信息
 *   B. 控制器 + 开关：缺行视为 on；off → visible=false 且不下发；再开恢复
 *
 * 结果同时写到 stdout 与同目录 verify-week-output.txt。
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';

const fs = require('fs');
const path = require('path');

const ok = [];
const bad = [];
function check(name, cond, extra) {
  (cond ? ok : bad).push(name + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : ''));
}

(async () => {
  try {
    const { sequelize, Submit, SystemSwitch } = require('../src/models');
    await sequelize.sync();

    const slot = require('../src/services/broadcastSlotService');
    const sw = require('../src/services/switchService');
    const bj = require('../src/utils/bjTime');
    const submit = require('../src/controllers/user/submitController');

    // ── 造数：本周一到周五的槽位值 ──
    const { start } = bj.weekRange(Date.now());
    const dayN = (i) => bj.ymd(bj.shifted(start.getTime() + i * bj.DAY_MS));
    const monday = dayN(0);
    const tuesday = dayN(1);
    const friday = dayN(4);

    await Submit.bulkCreate([
      // 本周一早间两首已排期（容量不限时应都显示）
      { openid: 'u1', type: 1, songName: '《晴天》', status: 1, scheduledSlot: `${monday} 早间 07:20`, wantBroadcastTime: `${monday} 早间 07:20` },
      { openid: 'u2', type: 1, songName: '《起风了》', status: 1, scheduledSlot: `${monday} 午间 12:20`, wantBroadcastTime: `${monday} 午间 12:20` },
      // 本周五晚间
      { openid: 'u3', type: 1, songName: '《夜空中最亮的星》', status: 1, scheduledSlot: `${friday} 晚间 17:30`, wantBroadcastTime: `${friday} 晚间 17:30` },
      // 干扰项：下周的（不该出现）
      { openid: 'u4', type: 1, songName: '《下周的歌》', status: 1, scheduledSlot: `2026-09-28 早间 07:20`, wantBroadcastTime: `2026-09-28 早间 07:20` },
      // 干扰项：本周但状态不对（待审/候补/驳回，都不该出现）
      { openid: 'u5', type: 1, songName: '《待审的歌》', status: 0, scheduledSlot: `${tuesday} 午间 12:20`, wantBroadcastTime: `${tuesday} 午间 12:20` },
      { openid: 'u6', type: 1, songName: '《候补的歌》', status: 3, scheduledSlot: null, wantBroadcastTime: `${tuesday} 晚间 17:30` },
      { openid: 'u7', type: 1, songName: '《驳回的歌》', status: 2, scheduledSlot: `${friday} 午间 12:20`, wantBroadcastTime: `${friday} 午间 12:20` },
      // 干扰项：文稿（type=2）
      { openid: 'u8', type: 2, articleTitle: '一篇文稿', status: 1, scheduledSlot: `${monday} 早间 07:20` },
    ]);

    // ── 开关：缺行视为 on ──
    check('开关缺行视为 on', sw.isEnabled('home_song_schedule') === true);

    // ── 数据形状 ──
    const data = await slot.currentWeekSchedule();
    check('rangeText 是本周一~周五', data.rangeText === `${monday.slice(5)} ~ ${friday.slice(5)}`, data.rangeText);
    check('5 天', data.days.length === 5, data.days.length);
    check('第一天是周一', data.days[0].weekday === '周一' && data.days[0].date === monday, data.days[0]);
    const todayFlag = data.days.filter((d) => d.isToday).length;
    check('恰好一天标 isToday', todayFlag === 1, todayFlag);

    const mondaySongs = data.days[0].songs.map((s) => s.title);
    check('周一有《晴天》+《起风了》', mondaySongs.includes('《晴天》') && mondaySongs.includes('《起风了》'), mondaySongs);
    const fridaySongs = data.days[4].songs.map((s) => s.title);
    check('周五有《夜空中最亮的星》', fridaySongs.length === 1 && fridaySongs[0] === '《夜空中最亮的星》', fridaySongs);

    const allTitles = data.days.flatMap((d) => d.songs.map((s) => s.title));
    check('下周的歌不出现', !allTitles.includes('《下周的歌》'), allTitles);
    check('待审/候补/驳回都不出现', !allTitles.some((t) => t.includes('待审') || t.includes('候补') || t.includes('驳回')), allTitles);
    check('文稿不出现', !allTitles.includes('一篇文稿'), allTitles);

    const first = data.days[0].songs[0];
    check('song 形状 = time/period/title', first && first.time === '07:20' && first.period === '早间' && first.title === '《晴天》', first);

    // 点歌人信息不下发：整个 payload 里不允许出现 user 关联字段
    const raw = JSON.stringify(data);
    check('payload 无 openid/name/remark 字段', !raw.includes('openid') && !raw.includes('remark') && !raw.includes('"nickname"') && !raw.includes('singer'), null);

    // ── 控制器：开 on → visible:true；开 off → visible:false 且无数据 ──
    const resOk = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await submit.weekSchedule({}, resOk, (e) => { throw e; });
    check('控制器 on：visible=true 且带 days', resOk.body && resOk.body.data && resOk.body.data.visible === true && Array.isArray(resOk.body.data.days), resOk.body && resOk.body.data && resOk.body.data.visible);

    // 走正式写入口（set 内部 invalidate + ensureLoaded，与管理员操作同路径）
    await sw.set('home_song_schedule', 'off');
    await submit.weekSchedule({}, resOk, (e) => { throw e; });
    check('控制器 off：visible=false 且 days 空', resOk.body.data.visible === false && resOk.body.data.days.length === 0, resOk.body.data);

    // 再开回来，确认来回切都生效
    await sw.set('home_song_schedule', 'on');
    await submit.weekSchedule({}, resOk, (e) => { throw e; });
    check('控制器再开：visible=true', resOk.body.data.visible === true, resOk.body.data.visible);
  } catch (e) {
    bad.push('脚本异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
  }

  const lines = [];
  lines.push(`=== 通过 ${ok.length} 项 ===`);
  ok.forEach((l) => lines.push('ok   ' + l));
  if (bad.length) {
    lines.push(`=== 失败 ${bad.length} 项 ===`);
    bad.forEach((l) => lines.push('FAIL ' + l));
  }
  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(__dirname, 'verify-week-output.txt'), text + '\n', 'utf8');
  process.exit(bad.length ? 1 : 0);
})();
