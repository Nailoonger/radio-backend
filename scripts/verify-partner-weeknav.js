'use strict';
/**
 * 周切换一致性校验（2026-10-30）
 *
 * 陛下要求：「把所有可以切换周的页面都做上本周和非本周的标记统一一下」。
 * 四个页面必须同一套结构，否则某天只改一个页面就会走形：
 *   考勤 attendance · 请假 leave · 值班时间代录 availability · 排班工作台 planning
 *
 * 判据（任一不满足即退出码 1）：
 *   ① wxml 里同时出现 .wk-nav / .wk-mid / .wk-tag / .wk-c，且胶囊文案是「本周 / 非本周」
 *   ② wxss 里定义了 .wk-tag.on（红）与 .wk-tag.off（灰）
 *   ③ 副作用：weekText 不许再自己拼「本周」二字（会和胶囊打架）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = [
  ['考勤', 'miniprogram/pages-partner/attendance/attendance'],
  ['请假', 'miniprogram/pages-partner/leave/leave'],
  ['值班时间代录', 'miniprogram/pages-partner/availability/availability'],
  ['排班工作台', 'miniprogram/pages-partner/schedule/planning/planning'],
];

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

PAGES.forEach(([label, base]) => {
  const wxml = read(path.join(ROOT, base + '.wxml'));
  const wxss = read(path.join(ROOT, base + '.wxss'));
  const js = read(path.join(ROOT, base + '.js'));

  ok(`${label}：有周切换结构`, /class="wk-nav"/.test(wxml) && /class="wk-mid"/.test(wxml));
  ok(`${label}：有本周/非本周胶囊`, /wk-tag \{\{isThisWeek \? 'on' : 'off'\}\}/.test(wxml));
  ok(`${label}：胶囊文案是「本周 / 非本周」`, /\{\{isThisWeek \? '本周' : '非本周'\}\}/.test(wxml), '找不到 {{isThisWeek ? \'本周\' : \'非本周\'}}');
  ok(`${label}：js 里有 isThisWeek`, /isThisWeek/.test(js));
  ok(`${label}：wxss 有 .wk-tag.on`, /\.wk-tag\.on\s*\{/.test(wxss));
  ok(`${label}：wxss 有 .wk-tag.off`, /\.wk-tag\.off\s*\{/.test(wxss));
  ok(`${label}：weekText 不自己拼「本周」`, !/weekText:\s*`本周/.test(js), 'weekText 里拼了「本周 」，会和胶囊重复');
});

// 时间表组件标题也不许恒写「本周」（工作台能翻周）
const tt = read(path.join(ROOT, 'miniprogram/pages-partner/schedule/timetable/index.wxml'));
ok('班表组件：标题按本周/该周切换', /\{\{isThisWeek \? '本周' : '该周'\}\}/.test(tt), '标题还写死「本周」');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : `\n✓ 周切换口径一致（${PAGES.length} 个页面 + 班表组件）`);
process.exit(failed ? 1 : 0);
