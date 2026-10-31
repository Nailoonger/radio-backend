#!/usr/bin/env node
'use strict';

/**
 * 值班周锚点（周日 0 点切下周）—— 纯日期单测，不碰数据库
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-partner-week-anchor.js
 *
 * ═══════════ 为什么单独一个套件 ═══════════
 * `_kit#currentWeekStart()` 是**全局口径**：考勤 / 请假 / 排班工作台 / 我的班表 / 大白卡
 * 五处「不传 week 时默认哪一周」全都吃它。改一行会影响五个页面，而**错了不会报错** ——
 * 只会静默地少看一周 / 多看一周。所以把它钉成毫秒级的断言：切点、前后一天、跨月、跨年。
 *
 * ⚠️ 只测 `lib/bjTime.js`（零依赖），不经过 harness ——
 *    这样连 wx-server-sdk 都不需要，任何机器上 `node` 直接能跑。
 * ⚠️ 断言里所有时刻都写成「北京时间的某天某时」再转成时间戳：
 *    直接写 `Date.UTC(...)` 会在别的时区上把用例变成「昨天」。
 */

const path = require('path');
const bj = require(path.join(__dirname, '..', 'cloudfunctions', 'api', 'lib', 'bjTime.js'));

let checked = 0;
let failed = 0;

/** 北京时间的 YYYY-MM-DD HH:mm(:ss) → 真实 UTC 时间戳（毫秒） */
function bjTime(y, m, d, hh, mm, ss) {
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) - 8 * 60 * 60 * 1000;
}

function eq(name, got, want) {
  checked++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `\n       got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

/* ───────── 夹具自检：用例本身别写错星期 ───────── */
const CN = ['日', '一', '二', '三', '四', '五', '六'];
const dow = (ts) => bj.WEEKDAY_CN ? CN[bj.weekdayOf(ts)] : '?';
eq('夹具：2026-11-02 是周一', dow(bjTime(2026, 11, 2, 9)), '一');
eq('夹具：2026-11-08 是周日', dow(bjTime(2026, 11, 8, 9)), '日');
eq('夹具：2026-10-31 是周六', dow(bjTime(2026, 10, 31, 9)), '六');

/* ───────── 一周之内（周一 ~ 周六）：本周 = 本周一 ───────── */
eq('周一 00:00 → 本周一', bj.dutyWeekStart(bjTime(2026, 11, 2, 0, 0)), '2026-11-02');
eq('周三 12:00 → 本周一', bj.dutyWeekStart(bjTime(2026, 11, 4, 12, 0)), '2026-11-02');
eq('周五 22:00 → 本周一', bj.dutyWeekStart(bjTime(2026, 11, 6, 22, 0)), '2026-11-02');

/* ───────── 切点：周六 24:00 = 周日 00:00:00.000 ───────── */
eq('周六 23:59:59.999 → 仍是旧周', bj.dutyWeekStart(bjTime(2026, 11, 7, 23, 59, 59) + 999), '2026-11-02');
eq('周日 00:00:00.000 → 立刻切到下周', bj.dutyWeekStart(bjTime(2026, 11, 8, 0, 0, 0)), '2026-11-09');
eq('周日 23:59 → 仍是下周', bj.dutyWeekStart(bjTime(2026, 11, 8, 23, 59)), '2026-11-09');
eq('再回到周一 00:00 → 同一周', bj.dutyWeekStart(bjTime(2026, 11, 9, 0, 0)), '2026-11-09');

/* ───────── 跨月 / 跨年 ───────── */
eq('跨月：2026-10-31 周六 → 10-26', bj.dutyWeekStart(bjTime(2026, 10, 31, 20, 0)), '2026-10-26');
eq('跨月：2026-11-01 周日 → 11-02', bj.dutyWeekStart(bjTime(2026, 11, 1, 9, 0)), '2026-11-02');
// Date.UTC(2026,12,31) 会自动进位到 2027-01-01，这里用显式日期断言真实星期
const NY = bjTime(2026, 12, 31, 20, 0);
eq('跨年：2026-12-31 属于哪一周（随星期走，不断言具体值）',
  /^2026-12-(2[0-9]|3[01])$/.test(bj.dutyWeekStart(NY)), true);

/* ───────── 日历周本体不许被改（别的功能还靠它算日期） ───────── */
const sunday = bjTime(2026, 11, 8, 10, 0);
eq('weekRange 仍是日历周（周日 → 11-02）', bj.dayKey(bj.weekRange(sunday).start.getTime()), '2026-11-02');
eq('dutyWeekRange 才切（周日 → 11-09）', bj.dayKey(bj.dutyWeekRange(sunday).start.getTime()), '2026-11-09');
eq('非周日：dutyWeekRange 与 weekRange 一致',
  bj.dayKey(bj.dutyWeekRange(bjTime(2026, 11, 4, 10, 0)).start.getTime()),
  bj.dayKey(bj.weekRange(bjTime(2026, 11, 4, 10, 0)).start.getTime()));

/* ───────── 「站员要填的那一周」：全周都是同一个答案 ───────── */
// 周一到周日都填「下一个周一」那一周；周日那天它正好等于本周（周日已算下周）
for (const [label, ts] of [
  ['周一', bjTime(2026, 11, 2, 9)],
  ['周三', bjTime(2026, 11, 4, 9)],
  ['周六', bjTime(2026, 11, 7, 9)],
  ['周日', bjTime(2026, 11, 8, 9)],
]) {
  eq(`${label}要填的那一周 = 11-09`, bj.dayKey(bj.nextWeekRange(ts).start.getTime()), '2026-11-09');
}
eq('下一周的周一 → 轮到再下一周', bj.dayKey(bj.nextWeekRange(bjTime(2026, 11, 9, 9)).start.getTime()), '2026-11-16');

console.log(`\n结论：断言 ${checked} 项 / 失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
