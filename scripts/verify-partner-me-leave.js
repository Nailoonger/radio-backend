'use strict';
/**
 * 伙伴端「我的」页 + 请假审批 + 考勤口径 + 工作台角标（2026-11-01）
 *
 * 陛下这一批要求的原话（逐条对着做，逐条对着守）：
 *   ①「我的页面的卡片排序从上到下为，可排时间，我的考勤，本周互评，请假进度，站内公告，伙伴名册，
 *      三个角色端都要这样排不要乱排，名字不一样的按照我说的来改」
 *   ②「修改密码不要做到卡片上，做到退出登录按钮旁边一左一右」
 *   ③「超管和社干的请假审批功能模块做到工作台站内协作那里作为入口，我的页面依旧是请假进度和站员的一样」
 *   ④「超管和社干进入在我的页面进入考勤是和站员一样只看考勤的不是录入考勤不要搞错了」
 *   ⑤「底部导航栏工作台模块的角标的计数器是不是坏了……有要处理的站内协作你都要亮红点其他不管」
 *   ⑥ 三处文案：删「批完之后班表上那一格会空出来。」/「如有错误请联系社干」/「匿名互评  不作考核」
 *
 * 这个脚本守的是「别再改回去」，不测视觉：所有判据都是结构/口径/文案。
 * 任一不满足即退出码 1。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');
/** 去掉 wxml 注释再判断文案：注释里提到旧句子（「原句是…」）不该算违规 */
const strip = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};

const meJs = read('miniprogram/pages-partner/me/me.js');
const meWxml = read('miniprogram/pages-partner/me/me.wxml');
const meWxss = read('miniprogram/pages-partner/me/me.wxss');
const leaveJs = read('miniprogram/pages-partner/leave/leave.js');
const leaveWxml = read('miniprogram/pages-partner/leave/leave.wxml');
const reviewJs = read('miniprogram/pages-partner/leave-review/leave-review.js');
const reviewWxml = read('miniprogram/pages-partner/leave-review/leave-review.wxml');
const attJs = read('miniprogram/pages-partner/attendance/attendance.js');
const attWxml = read('miniprogram/pages-partner/attendance/attendance.wxml');
const fbWxml = read('miniprogram/pages-partner/feedback/feedback.wxml');
const deskJs = read('miniprogram/pages-partner/desk/desk.js');
const todoJs = read('miniprogram/utils/partnerTodo.js');
const appJson = read('miniprogram/app.json');

/* ══════════════ A. 我的页：六张卡、一个顺序、三端共用 ══════════════ */
out.push('\n---- A. 我的页六张卡 ----');

ok('me.js 的 ROWS 是一份数组（不再是对象里两套）',
  /const ROWS = \[/.test(meJs) && !/const ROWS = \{/.test(meJs)
  && !/rows: roleKey === 'member' \?/.test(meJs),
  '又出现两套顺序 —— 那就是「乱排」的来源：改一处另一处必然走样');

const order = ['可排时间', '我的考勤', '本周互评', '请假进度', '站内公告', '伙伴名册'];
const idx = order.map((label) => meJs.indexOf(`label: '${label}'`));
ok('六个标签一个不差、按陛下给的顺序',
  idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
  `出现位置=${JSON.stringify(idx)}（要严格递增）`);
ok('三端同一份（applyAdmin 不再按角色挑 rows）',
  /rows: rowsForRole\(\)/.test(meJs) && !/roleKey === 'member'\s*\?\s*ROWS/.test(meJs));

ok('「修改密码」不再是卡片里的一行',
  !/id: 'pwd'/.test(meJs) && !/label: '修改密码'/.test(meJs),
  'pwd 又回到 rows 里了 —— 陛下要求它在「退出登录」旁边');
ok('底部一左一右两个按钮（修改密码 / 退出登录）',
  /<view class="acts">/.test(meWxml)
  && /bindtap="openPwd"[^>]*>修改密码/.test(meWxml)
  && /bindtap="onLogout"[^>]*>退出登录/.test(meWxml),
  '模板里找不到并排的两个按钮');
ok('两个按钮样式写成 button.act（元素+类）',
  /button\.act \{/.test(meWxss),
  '单类 .act 会被 app.wxss 的 button 默认样式压掉（宽度/display 全失效）');
ok('openPwd 方法存在（弹层还归它开）', /openPwd\(\) \{/.test(meJs));
ok('卡片里不再有 pwd 的点击分支', !/id === 'pwd'/.test(meJs));

/* ══════════════ B. 请假审批：独立页 + 两个 tab ══════════════ */
out.push('\n---- B. 请假审批独立页 ----');

ok('页面已注册进 app.json 分包',
  /"leave-review\/leave-review"/.test(appJson), '没注册 = 点进去白屏');
ok('两档 tab：待审批 / 已审批',
  /待审批/.test(reviewWxml) && /已审批/.test(reviewWxml)
  && /tabIdx === 0/.test(reviewWxml) && /tabIdx === 1/.test(reviewWxml));
ok('待审批按周（要对着本周班表批）', /\/partner\/leave\/pending/.test(reviewJs) && /wk-nav/.test(reviewWxml));
ok('已审批读新接口 reviewed', /\/partner\/leave\/reviewed/.test(reviewJs),
  '已审批没有数据源 —— 只能拿到 pending，第二个 tab 就是空的');
ok('已审批同时显示已批准与已驳回（tagCls 按 status）',
  /Number\(x\.status\) === 1 \? 'done' : 'no'/.test(reviewJs));
ok('工作台「站内协作」入口指向这个新页',
  /'leave-approve': '\/pages-partner\/leave-review\/leave-review'/.test(deskJs),
  '入口还指着 leave/leave —— 那是「我的请假」，不是审批');
ok('「请假进度」对三端都指向 leave（不是审批页）',
  /leave:\s*'\/pages-partner\/leave\/leave'/.test(meJs));
ok('站内公告走伙伴端自己那一页（admin_token）',
  /notices:\s*'\/pages-partner\/notices\/notices'/.test(meJs)
  && !/notices:\s*'\/pages\/notices\/notices'/.test(meJs)
  && /"notices\/notices"/.test(appJson),
  '指回 /pages/notices 了 —— 那是学生端 token 的页面，社干/超管点进去 40101');
ok('leave 页只剩「我的请假」（审批分支已拆走）',
  !/isManager/.test(leaveJs) && !/onApprove/.test(leaveJs) && !/onReject/.test(leaveJs),
  'leave.js 还留着管理端分支 —— 两件不相干的事又挤回一页了');
ok('批准后前端会告知「班表退回草稿」',
  /scheduleWithdrawn/.test(reviewJs) && /班表退回草稿/.test(reviewJs),
  '批完只弹「已批准」，用户不知道班表已经被撤回');

/* ══════════════ C. 考勤：入口决定形态 ══════════════ */
out.push('\n---- C. 考勤「只看不录」 ----');

ok('考勤页读 mode 参数（不再按角色一刀切）',
  /options\.mode/.test(attJs) && /=== 'entry'/.test(attJs),
  '又改回按 role 判断了 —— 超管从「我的」进去会看到全站名单');
ok('isManager 由 mode 决定且带录入权前置',
  /isManager:\s*canEntry && wantEntry/.test(attJs));
ok('我的页考勤带 mode=my', /'my-att':\s*'\/pages-partner\/attendance\/attendance\?mode=my'/.test(meJs));
ok('工作台考勤录入 / 总览带 mode=entry',
  /attendance:\s*'\/pages-partner\/attendance\/attendance\?mode=entry'/.test(deskJs)
  && /'att-overview':\s*'\/pages-partner\/attendance\/attendance\?mode=entry'/.test(deskJs));
ok('标题随形态切换', /\{\{isManager \? '考勤录入' : '我的考勤'\}\}/.test(attWxml));

/* ══════════════ D. 工作台角标 = 站内协作待处理 ══════════════ */
out.push('\n---- D. 工作台角标 ----');

ok('有唯一事实源 utils/partnerTodo.js', !!todoJs);
ok('角标 = 稿件待审 + 请假待批 + 考勤未录入',
  /drafts, leaves, unmarked, total: drafts \+ leaves \+ unmarked/.test(todoJs)
  || /total: drafts \+ leaves \+ unmarked/.test(todoJs),
  '三个数没加在一起 —— 那样角标和区块标题上的「N 项待处理」会对不上');
ok('站员没有站内协作 ⇒ 工作台角标恒 0（不发请求）',
  /roleKey === 'member'\) return Promise\.resolve/.test(todoJs));
ok('五张 tab 页都读同一个函数',
  [
    'miniprogram/pages-partner/desk/desk.js',
    'miniprogram/pages-partner/review/review.js',
    'miniprogram/pages-partner/work/work.js',
    'miniprogram/pages-partner/me/me.js',
    'miniprogram/pages-partner/schedule/index/index.js',
  ].every((p) => /partnerTodo/.test(read(p))),
  '有一页没接上 —— 停在那页时工作台红点就是灭的，看着像计数器坏了');
ok('不再有写死的 desk: 0 角标',
  !/desk: 0, home: 0/.test(read('miniprogram/pages-partner/me/me.js'))
  && !/desk: 0, home: 0, submissions: a \+ b/.test(read('miniprogram/pages-partner/work/work.js')),
  '还留着写死的 0 —— 就是这个数让陛下以为计数器坏了');
ok('工作台自己的角标与区块数字同源（读 mods）',
  /const coop = s\.roleKey === 'member' \? 0 : \(n\(m\.drafts\) \+ n\(m\.leaves\) \+ n\(m\.unmarked\)\)/.test(deskJs));

/* ══════════════ E. 三处文案 ══════════════ */
out.push('\n---- E. 文案 ----');

ok('请假页删掉「批完之后班表上那一格会空出来。」',
  !/批完之后班表上那一格会空出来/.test(strip(leaveWxml)),
  '这句还在 —— 陛下让删的就是它');
ok('考勤页改「如有错误请联系社干」',
  /如有错误请联系社干/.test(strip(attWxml)) && !/考勤由社干按场点名，这里只看不录/.test(strip(attWxml)));
ok('互评页改「匿名互评  不作考核」',
  /匿名互评  不作考核/.test(strip(fbWxml)) && !/不是考核，是当场说一句/.test(strip(fbWxml)));
ok('页面注释不再自称「只改请假状态、不动班表」',
  !/只改请假状态/.test(leaveJs) && !/批准只改请假状态/.test(read('cloud/cloudfunctions/api/handlers/partner/leave.js')),
  '旧口径的注释留着，下一个人就会照着它把逻辑改回去');

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 我的页六卡同序 · 请假审批独立页 · 考勤只看不录 · 工作台角标 · 三处文案');
process.exit(failed ? 1 : 0);
