'use strict';
/**
 * 工作台大白卡一致性校验（2026-10-30）
 *
 * 陛下当天报的：「班表发布之后三个角色端的工作台首页大白卡都没有变化啊」。
 * 根因是大白卡第 1 张写死了一句「班表还没有发布。」+ onShow 只拉待办数字，
 * 于是排班工作台点了发布、回首页照样写着未发布。
 *
 * 判据（任一不满足即退出码 1）：
 *   ① desk.js 真的去拉 /partner/schedule（大白卡唯一数据源），并且拉到自己的场次
 *   ② buildSlides 四态都有分支：published / withdrawn / draft / 兜底 empty
 *   ③ 「班表还没有发布。」只作为兜底出现一次 —— 再有人把它挪回唯一出口就会红
 *   ④ onShow 与下拉刷新都会重拉（少一个就出现「发布完不刷新」）
 *   ⑤ 撤回在库里是 state:'draft' + withdrawnAt，必须按 withdrawnAt 还原成 withdrawn
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram/pages-partner/desk/desk.js');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};

const js = fs.existsSync(SRC) ? fs.readFileSync(SRC, 'utf8') : '';
const count = (re) => (js.match(re) || []).length;

ok('desk.js 存在', !!js);
ok('大白卡拉本周班表状态', /adminRequest\('\/partner\/schedule',\s*'GET'/.test(js), '找不到 /partner/schedule 请求');
ok('站员拉自己的场次', /adminRequest\('\/partner\/schedule\/mine',\s*'GET'/.test(js), '找不到 /partner/schedule/mine 请求');
ok('已发布分支', /weekState === 'published'/.test(js), 'buildSlides 没有 published 分支');
ok('已撤回分支', /weekState === 'withdrawn'/.test(js), 'buildSlides 没有 withdrawn 分支');
ok('草稿分支', /weekState === 'draft'/.test(js), 'buildSlides 没有 draft 分支');
ok('撤回按 withdrawnAt 还原', /withdrawnAt/.test(js), 'state 库里落的是 draft，不认 withdrawnAt 就永远显示草稿');
ok('兜底文案只出现一次', count(/'班表还没有发布。'/g) === 1, `作为字符串出现 ${count(/'班表还没有发布。'/g)} 次，应当只有兜底那一处（注释里引用不算）`);
ok('onShow 重拉班表状态', /onShow\(\)[\s\S]{0,400}?fetchSchedule\(\)/.test(js), 'onShow 里没有 fetchSchedule()');
ok('下拉刷新重拉班表状态', /onPullDownRefresh\(\)[\s\S]{0,300}?fetchSchedule\(\)/.test(js), '下拉刷新没有带上班表状态');
ok('接口失败不覆盖已有状态', /if \(this\._gone \|\| !week\) return;/.test(js), '拿不到数据时把卡刷回「未发布」了');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 工作台大白卡跟着班表四态走');
process.exit(failed ? 1 : 0);
