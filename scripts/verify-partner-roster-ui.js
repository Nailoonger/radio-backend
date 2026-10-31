'use strict';
/**
 * 伙伴名册 · 手机号（2026-10-31）
 *
 * 守的是这一版新加的三件事，以及它们「不能被顺手改掉」的那几条：
 *   ① 三端都有入口 —— me 页的 ROWS.member / ROWS.admin 都要有 roster 那一行
 *      （原来只有 ROWS.admin 有，站员端是漏的）
 *   ② 第一次进必须填手机号 —— 弹层**没有关闭、点遮罩也不收**，按钮没填对就一直是禁用的
 *   ③ 列表底部红字「修改我的个人资料」—— 文案逐字、红色、带下划线
 *
 * ⚠️ 为什么要把「没有关闭」写成断言：这一条看起来像漏写，最容易被下一个人"顺手补一个 ×"。
 *    补上之后功能不会报错，只是「否则无法进入」这条需求静默失效。
 * ⚠️ 解析 wxss 前必须先 strip 注释（本仓已有先例：注释里的旧写法被当成真规则命中）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'miniprogram/pages-partner/roster/roster');
const ME = path.join(ROOT, 'miniprogram/pages-partner/me/me.js');
const API = path.join(ROOT, 'cloud/cloudfunctions/api');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ruleBody = (css, selector) => {
  const re = new RegExp(esc(selector) + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  let body = null;
  while ((m = re.exec(css))) body = m[1];
  return body;
};

const wxml = read(BASE + '.wxml');
const wxss = strip(read(BASE + '.wxss'));
const js = read(BASE + '.js');
const meJs = read(ME);
const routerJs = read(path.join(API, 'router.js'));
const meHandler = read(path.join(API, 'handlers/partner/me.js'));
const kit = read(path.join(API, 'handlers/partner/_kit.js'));

/* ══════════ A. 页面本体 ══════════ */
out.push('---- A. 名册页本体 ----');
['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
  ok(`四件套：roster.${ext}`, !!read(`${BASE}.${ext}`));
});
ok('有返回箭头', /navbar-back/.test(wxml) && /bindtap="goBack"/.test(wxml));

/* ══════════ B. 首次强制弹层 ══════════ */
out.push('---- B. 首次强制填写 ----');
const maskMatch = wxml.match(/<view class="mask"[^>]*>/);
ok('弹层遮罩存在', !!maskMatch);
ok('遮罩只吞事件、不绑关闭',
  !!maskMatch && /catchtap="noop"/.test(maskMatch[0]) && !/bindtap="onCancel"/.test(maskMatch[0]),
  maskMatch ? maskMatch[0] : '找不到 .mask');
ok('弹层里没有 × / 关闭按钮',
  !/关闭|close|✕|×/.test(
    (wxml.match(/<view class="sheet">[\s\S]*?<\/view>\s*<\/view>/) || [''])[0],
  ),
  '弹层里出现了「关闭 / ×」字样 —— 首次态不能有出口');
ok('「取消」只在编辑态出现',
  /wx:if="\{\{sheet\.editing\}\}"[\s\S]{0,40}取消/.test(wxml),
  '取消没有绑 sheet.editing 条件');
ok('主按钮按校验禁用', /disabled="\{\{!sheet\.ok\}\}"/.test(wxml));
ok('主按钮 disabled 时也有独立配色', /button\.pbtn\.dis\s*\{/.test(wxss));
ok('输入框 maxlength=11', /maxlength="11"/.test(wxml));
ok('手机号框走 model:value（不手写 value+setData）',
  /model:value="\{\{sheet\.phone\}\}"/.test(wxml),
  '手写 value + bindinput 会和输入法 composition 抢');
const inputs = wxml.match(/<input[\s\S]*?\/>/g) || [];
ok('弹层里只有手机号一个输入框',
  inputs.filter((x) => /sheet\.phone/.test(x)).length === 1
  && inputs.filter((x) => /sheet\.phone/.test(x)).length === inputs.length - 1,
  `共 ${inputs.length} 个 input（1 个搜索框 + 1 个手机号框才对）`);
ok('姓名是只读文本不是输入框',
  /\{\{me\.name\}\}/.test(wxml) && !/model:value="\{\{me\.name\}\}"/.test(wxml));
ok('学号是只读文本不是输入框',
  /\{\{me\.username/.test(wxml) && !/model:value="\{\{me\.username/.test(wxml));
ok('两个只读字段带「自动识别」标',
  (wxml.match(/自动识别/g) || []).length === 2,
  `应出现 2 次，实际 ${(wxml.match(/自动识别/g) || []).length} 次`);
ok('进来先判 needPhone 再弹（判据来自后端）',
  /needPhone/.test(js) && /openSheet\(false\)/.test(js),
  'js 里没看到用 needPhone 触发首次弹层');
/* ⚠️ 2026-10-31 陛下截图打回：屏幕上号码已经 11 位、按钮也亮着，点保存却弹「手机号要 11 位」。
   根因是 model:value / setData 都是异步落地，输完立刻点保存时 this.data.sheet.phone 还停在上一拍。
   ⇒ 提交必须读 bindinput 里同步赋值的 _lastPhone，不能读 data。 */
ok('输入时同步缓存 _lastPhone（不靠 setData 时序）',
  /onPhone\(e\)\s*\{[\s\S]{0,200}this\._lastPhone\s*=/.test(js),
  'onPhone 里没有 this._lastPhone = v');
ok('保存读的是 _lastPhone 而不是 data 里的值',
  /const phone = digits\(this\._lastPhone/.test(js),
  'onSave 还在读 this.data.sheet.phone —— 输完立刻点保存会判失败');
ok('打开弹层时把提交源对齐', /openSheet\(editing\)\s*\{[\s\S]{0,200}this\._lastPhone\s*=/.test(js));
ok('号码合法时收掉旧提示', /if \(ok\) wx\.hideToast\(\)/.test(js),
  '缺 wx.hideToast() —— 「格式没问题」会和「要 11 位」同屏');

/* ══════════ C. 底部红字入口 ══════════ */
out.push('---- C. 修改我的个人资料 ----');
ok('文案逐字「修改我的个人资料」', wxml.indexOf('修改我的个人资料') >= 0);
ok('红字在名册列表之后（列表底部）',
  wxml.indexOf('class="rows"') < wxml.indexOf('prof-edit'),
  'prof-edit 出现在 rows 之前了');
const peBody = ruleBody(wxss, '.prof-edit') || '';
ok('.prof-edit 带下划线', /text-decoration\s*:\s*underline/.test(peBody), peBody.trim());
ok('.prof-edit 是 --danger 红（#D93025）', /#D93025/i.test(peBody), peBody.trim());
ok('.prof-edit 居中', /text-align\s*:\s*center/.test(peBody), peBody.trim());
ok('点红字开的是编辑态', /onEditProfile[\s\S]{0,60}openSheet\(true\)/.test(js));

/* ══════════ D. 三端入口 ══════════ */
out.push('---- D. 三端都有入口 ----');
const memberBlock = (meJs.match(/member:\s*\[([\s\S]*?)\n\s*\],/) || [])[1] || '';
const adminBlock = (meJs.match(/admin:\s*\[([\s\S]*?)\n\s*\]/) || [])[1] || '';
ok('站员 ROWS 里有伙伴名册', /id:\s*'roster'/.test(memberBlock), '站员端漏了 roster —— 这一版就是来补它的');
ok('社干/超管 ROWS 里有伙伴名册', /id:\s*'roster'/.test(adminBlock));
ok('roster 的跳转路径已登记', /roster:\s*'\/pages-partner\/roster\/roster'/.test(meJs));
ok('me 页会用 needPhone 标「待填手机号」',
  /markRosterState/.test(meJs) && /待填手机号/.test(meJs));

/* ══════════ E. 后端 ══════════ */
out.push('---- E. 后端 ----');
ok('路由已注册 PUT /partner/me/profile',
  /PUT \/partner\/me\/profile/.test(routerJs) && /partner\.me\.saveMyProfile/.test(routerJs));
ok('me.js 导出 saveMyProfile', /module\.exports[\s\S]*saveMyProfile/.test(meHandler));
ok('saveMyProfile 只写 phone 相关字段',
  /updateById\(C\.ADMIN,\s*p\.admin\._id,\s*\{\s*phone,\s*phoneUpdatedAt:/.test(meHandler),
  '写接口不能顺手改 nickname / department');
/** 截出某个函数体（从 `async function X(` 到下一个顶格 `}`）—— 否则正则会把隔壁 saveDuty 的 updateTime 算进来 */
const fnBody = (src, name) => {
  const i = src.indexOf(`async function ${name}(`);
  if (i < 0) return '';
  const j = src.indexOf('\n}', i);
  return j < 0 ? src.slice(i) : src.slice(i, j + 2);
};
const saveMine = fnBody(meHandler, 'saveMyProfile');

ok('写接口不刷 updateTime（那是资料修订时间）',
  !!saveMine && !/updateTime/.test(saveMine),
  'saveMyProfile 里出现了 updateTime');
ok('写接口只要求 asPartner（站员也要能填）',
  /async function saveMyProfile\(ctx\)\s*\{\s*const p = await asPartner\(ctx\);/.test(meHandler),
  'saveMyProfile 不该用 asManager / asSuperPartner');
ok('profile 返回 needPhone', /needPhone:\s*!phone/.test(meHandler));
ok('people 顺带返回 me', /me:\s*mine\s*\?/.test(meHandler));
ok('personDto 带 phone 且空值统一为 ""',
  /phone:\s*normalizePhone\(a\.phone/.test(kit) && /function normalizePhone/.test(kit));
ok('personDto 带 isMember（站员身份要能标出来）', /isMember:\s*Number\(a\.role\)\s*===\s*ROLE_MEMBER/.test(kit));
ok('号码规则与前端一致（1[3-9] 11 位）',
  /\^1\[3-9\]\\d\{9\}\$/.test(kit) && /\^1\[3-9\]\\d\{9\}\$/.test(js),
  '前后端校验规则对不上');

/* ══════════ F. 视觉底线 ══════════ */
out.push('---- F. 视觉底线 ----');
ok('没有深色块 var(--tile)', !/var\(--tile\)/.test(wxss));
ok('没有深色底 #272729 / #3A3A3C', !/#272729|#3A3A3C/i.test(wxss));
ok('按钮用元素+类 button.pbtn（防被全局 button 规则压掉）',
  /button\.pbtn\s*\{/.test(wxss),
  '只写 .pbtn 会被 app.wxss 的 button 规则静默压掉');

console.log(out.join('\n'));
console.log(failed
  ? `\n✗ 失败 ${failed} 项`
  : `\n✓ 伙伴名册手机号：三端入口 · 首次强制弹层无出口 · 红字改资料 · 前后端规则一致（${out.length} 项）`);
process.exit(failed ? 1 : 0);
