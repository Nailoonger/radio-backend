'use strict';
/**
 * 周切换一致性校验（2026-10-30）
 *
 * 陛下要求：「把所有可以切换周的页面都做上本周和非本周的标记统一一下」。
 * 页面必须同一套结构，否则某天只改一个页面就会走形：
 *   考勤 attendance · 请假 leave · 值班时间代录 availability · 排班工作台 planning · 我的班表 schedule/index
 *
 * 判据（任一不满足即退出码 1）：
 *   ① wxml 里同时出现 .wk-nav / .wk-mid / .wk-tag / .wk-c
 *   ② 胶囊有两种口径，各自查各的：
 *        this   → 文案「本周 / 非本周」，跟着 isThisWeek 亮   （考勤/请假/工作台/我的班表）
 *        target → 文案由 weekTag 给，跟着 isTargetWeek 亮     （值班时间代录，见下）
 *   ③ wxss 里定义了 .wk-tag.on（红）与 .wk-tag.off（灰）
 *   ④ 副作用：weekText 不许再自己拼「本周」二字（会和胶囊打架）
 *
 * ⚠️ 为什么「值班时间代录」单独一种口径（2026-10-31 陛下定）：
 *    这页填的是**下一周**（「当然是本周填下一周的啊」），默认打开的就不是本周。
 *    照抄「本周/非本周」会把默认页标成「非本周」，看着像打开错了页面。
 *    所以它的胶囊写「下一周 / 本周 / 往期 / 后续周」，红点落在下一周。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = [
  ['考勤', 'miniprogram/pages-partner/attendance/attendance', 'this'],
  ['请假', 'miniprogram/pages-partner/leave/leave', 'this'],
  ['值班时间代录', 'miniprogram/pages-partner/availability/availability', 'target'],
  ['排班工作台', 'miniprogram/pages-partner/schedule/planning/planning', 'this'],
  ['我的班表', 'miniprogram/pages-partner/schedule/index/index', 'this'],
];

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

PAGES.forEach(([label, base, mode]) => {
  const wxml = read(path.join(ROOT, base + '.wxml'));
  const wxss = read(path.join(ROOT, base + '.wxss'));
  const js = read(path.join(ROOT, base + '.js'));

  ok(`${label}：有周切换结构`, /class="wk-nav"/.test(wxml) && /class="wk-mid"/.test(wxml));
  if (mode === 'target') {
    ok(`${label}：胶囊跟着「要填的那一周」点亮`, /wk-tag \{\{isTargetWeek \? 'on' : 'off'\}\}/.test(wxml));
    ok(`${label}：胶囊文案由 weekTag 给`, /\{\{weekTag\}\}/.test(wxml) && /weekTag = '下一周'/.test(js), '模板要写 {{weekTag}}，JS 里要有 weekTag 的默认值');
    ok(`${label}：js 里有 isTargetWeek`, /isTargetWeek/.test(js));
    ok(`${label}：文案不再自称「本周」`, !/本周(值班时段|可排时间)/.test(wxml + js), '还有「本周可排/本周值班时段」这类写死本周的文案');
  } else {
    ok(`${label}：有本周/非本周胶囊`, /wk-tag \{\{isThisWeek \? 'on' : 'off'\}\}/.test(wxml));
    ok(`${label}：胶囊文案是「本周 / 非本周」`, /\{\{isThisWeek \? '本周' : '非本周'\}\}/.test(wxml), '找不到 {{isThisWeek ? \'本周\' : \'非本周\'}}');
    ok(`${label}：js 里有 isThisWeek`, /isThisWeek/.test(js));
  }
  ok(`${label}：wxss 有 .wk-tag.on`, /\.wk-tag\.on\s*\{/.test(wxss));
  ok(`${label}：wxss 有 .wk-tag.off`, /\.wk-tag\.off\s*\{/.test(wxss));
  ok(`${label}：weekText 不自己拼「本周」`, !/weekText:\s*`本周/.test(js), 'weekText 里拼了「本周 」，会和胶囊重复');
});

// 可排时间的默认周必须是「下一周」（2026-10-31 陛下定）
// ⚠️ 回到 currentWeekStart 的后果不是报错，是**填了白填**：下周排班读的是下周那一份填报，
//    读不到就全员「未确认该时段可排时间」，只能靠超管逐人代录。
const avSrc = read(path.join(ROOT, 'cloud/cloudfunctions/api/handlers/partner/availability.js'));
ok('云函数：可排时间默认周是下一周',
  /q\.week \? assertWeekStart\(q\.week\) : nextWeek\b/.test(avSrc) && /body\.week \|\| nextWeekStart\(\)/.test(avSrc),
  'availability 的默认周又回到 currentWeekStart 了');

/* ══════════ 前端不许自己算周一（2026-10-31 周日切周之后） ══════════
   后端 currentWeekStart 改成「周日 0 点起算下周」之后，小程序端任何一处
   `new Date().getDay()` 推周一都会在周日差一周 —— 而界面不会报错，只是内容不对。
   这里扫一遍分包：只允许「今天是周几」这种当场判断（考勤默认选中今天那格），
   不允许再出现 mondayOf 那种「按 offset 推周一」的函数。 */
const partnerDir = path.join(ROOT, 'miniprogram/pages-partner');
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) jsFiles.push(p);
  }
}(partnerDir));

ok('前端：没有任何页面再自己定义 mondayOf',
  jsFiles.every((f) => !/function\s+mondayOf\s*\(/.test(fs.readFileSync(f, 'utf8'))),
  '有页面又在自己推周一 ⇒ 周日会差一周：' + jsFiles.filter((f) => /function\s+mondayOf\s*\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).join(', '));

// 考勤 / 请假：offset=0 必须不传 week（让云函数给锚点），只保留「今天是周几」的默认选中
for (const [label, rel] of [['考勤', 'attendance/attendance'], ['请假', 'leave/leave']]) {
  const src = read(path.join(ROOT, 'miniprogram/pages-partner', rel + '.js'));
  ok(`${label}：首次加载不传 week，由云函数定本周`,
    /offset === 0 \? '' :/.test(src),
    '又变成前端自己算周一传过去了（周日会打开上一周）');
}

// 时间表组件标题也不许恒写「本周」（工作台能翻周）
const tt = read(path.join(ROOT, 'miniprogram/pages-partner/schedule/timetable/index.wxml'));
ok('班表组件：标题按本周/该周切换', /\{\{isThisWeek \? '本周' : '该周'\}\}/.test(tt), '标题还写死「本周」');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : `\n✓ 周切换口径一致（${PAGES.length} 个页面 + 班表组件）`);
process.exit(failed ? 1 : 0);
