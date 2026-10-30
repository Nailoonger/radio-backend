'use strict';
/**
 * 工作台大白卡一致性校验（2026-10-30）
 *
 * 陛下当天报的：「班表发布之后三个角色端的工作台首页大白卡都没有变化啊」。
 * 根因是大白卡第 1 张写死了一句「班表还没有发布。」+ onShow 只拉待办数字，
 * 于是排班工作台点了发布、回首页照样写着未发布。
 *
 * 判据（任一不满足即退出码 1）：
 *   ① desk.js 真的去拉 /partner/schedule（大白卡唯一数据源），并且拉到自己的班次
 *   ② buildSlides 四态都有分支：published / withdrawn / draft / 兜底 empty
 *   ③ 「班表还没有发布。」只作为兜底出现一次 —— 再有人把它挪回唯一出口就会红
 *   ④ onShow 与下拉刷新都会重拉（少一个就出现「发布完不刷新」）
 *   ⑤ 撤回在库里是 state:'draft' + withdrawnAt，必须按 withdrawnAt 还原成 withdrawn
 *   ⑥ 已发布形态照原型 v151 homeTop()：「已发布 · 第 N 版」胶囊 + 「本周 N 个班次」+
 *      逐行 myslots（周几 / 时段 / 部门）。**三个角色同一口径 = 我自己的班次**
 *      （2026-10-30 第二版：第一版写成社干看全站汇总「已排 x/y 人」，被原型截图否掉）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram/pages-partner/desk/desk.js');
const WXML = path.join(ROOT, 'miniprogram/pages-partner/desk/desk.wxml');
const WXSS = path.join(ROOT, 'miniprogram/pages-partner/desk/desk.wxss');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const js = read(SRC);
const wxml = read(WXML);
const wxss = read(WXSS);
const count = (re) => (js.match(re) || []).length;

ok('desk.js 存在', !!js);
ok('大白卡拉本周班表状态', /adminRequest\('\/partner\/schedule',\s*'GET'/.test(js), '找不到 /partner/schedule 请求');
ok('拉我自己的班次', /adminRequest\('\/partner\/schedule\/mine',\s*'GET'/.test(js), '找不到 /partner/schedule/mine 请求');
ok('已发布分支', /weekState === 'published'/.test(js), 'buildSlides 没有 published 分支');
ok('已撤回分支', /weekState === 'withdrawn'/.test(js), 'buildSlides 没有 withdrawn 分支');
ok('草稿分支', /weekState === 'draft'/.test(js), 'buildSlides 没有 draft 分支');
ok('撤回按 withdrawnAt 还原', /withdrawnAt/.test(js), 'state 库里落的是 draft，不认 withdrawnAt 就永远显示草稿');
ok('兜底文案只出现一次', count(/'班表还没有发布。'/g) === 1, `作为字符串出现 ${count(/'班表还没有发布。'/g)} 次，应当只有兜底那一处（注释里引用不算）`);
ok('onShow 重拉班表状态', /onShow\(\)[\s\S]{0,400}?fetchSchedule\(\)/.test(js), 'onShow 里没有 fetchSchedule()');
ok('下拉刷新重拉班表状态', /onPullDownRefresh\(\)[\s\S]{0,300}?fetchSchedule\(\)/.test(js), '下拉刷新没有带上班表状态');
ok('接口失败不覆盖已有状态', /if \(this\._gone \|\| !week\) return;/.test(js), '拿不到数据时把卡刷回「未发布」了');

/* 已发布形态：照原型搬，三处（js 文案 / wxml 结构 / wxss 样式）缺一就红 */
ok('已发布胶囊文案', /已发布 · 第 \$\{ver\} 版/.test(js), '缺「已发布 · 第 N 版」');
ok('已发布主句按我的班次数', /本周 \$\{mine\.length\} 个班次/.test(js), '主句不是「本周 N 个班次」');
ok('没排到时给说明句', /本周没有你的班次/.test(js), '没排到时留了空白');
ok('三个角色同一口径（不再有全站汇总句）', !/已排 \$\{filled\}/.test(js) && !/站员已能看到本周班次/.test(js),
  '又给社干/超管塞了全站汇总 —— 原型里他们看的是自己的班次');
ok('wxml 头行 + 胶囊', /class="ebrow"/.test(wxml) && /class="tag-ok"/.test(wxml), 'wxml 缺 .ebrow / .tag-ok');
ok('wxml 班次行', /class="myslots"/.test(wxml) && /class="msl"/.test(wxml), 'wxml 缺 .myslots / .msl');
ok('wxss 胶囊与班次行样式', /\.tag-ok\s*\{/.test(wxss) && /\.msl-p\s*\{/.test(wxss), 'wxss 缺 .tag-ok / .msl-p');
ok('胶囊是浅色（不深色）', /\.tag-ok\s*\{[^}]*background:\s*#EAF3FD/.test(wxss), '.tag-ok 底色不是 --accent-tint #EAF3FD');

/* 第 2 张「本周点歌排期」：接口早就有（/admin/submit/list type=1），别再写成"接口没落地" */
ok('点歌排期不拉假数据、走真接口', /adminRequest\('\/admin\/submit\/list',\s*'GET',\s*\{[^}]*type:\s*1[^}]*reviewStatus:\s*1/.test(js),
  '没有按 type=1 & reviewStatus=1 拉已通过的点歌（与 song-schedule 页同一口径）');
ok('按 scheduleStatus 分已排/候补', /scheduleStatus\) === 1/.test(js) && /scheduleStatus\) === 2/.test(js), '没有区分已排(1) / 候补(2)');
ok('已排/候补主句', /已排 \$\{seated\} 首 · 候补 \$\{waiting\} 首/.test(js), '主句不是「已排 N 首 · 候补 M 首」');
ok('点歌卡拉到之前不渲染', /songs: null/.test(js) && /if \(song\) slides\.push/.test(js), 'songs 还没拉到时也把卡画出来了（会先闪一个 0）');
ok('onShow 也重拉点歌', /onShow\(\)[\s\S]{0,400}?fetchSongs\(\)/.test(js), 'onShow 里没有 fetchSongs()');
ok('下拉刷新也重拉点歌', /onPullDownRefresh\(\)[\s\S]{0,400}?fetchSongs\(\)/.test(js), '下拉刷新没有带点歌');
ok('不再声称点歌排期没接口', !/歌曲排期[^\n]*没有接口/.test(js) && !/点歌排期卡等排期接口落地/.test(js),
  '注释里还写着「点歌排期没有接口」—— 接口早就有了');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 工作台大白卡跟着班表四态走');
process.exit(failed ? 1 : 0);
