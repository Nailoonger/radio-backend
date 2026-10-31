'use strict';
/**
 * 权限分发一致性校验（2026-10-31）
 *
 * 陛下要求：「超管在工作台首页『管理』里做权限管理：开关社干进排班工作台的排班权限、
 * 开关社干审核模块的权限；也可以按人分发，让某个社干能用排班或审核，也能全部关闭」。
 *
 * 判据（任一不满足即退出码 1）：
 *   ① 后端有 `handlers/partner/permissions.js`，导出 get / saveGlobal / savePerson / mine
 *   ② 路由表 4 条齐，且 `/mine` 排在 `/person/:id` 之前（字面量优先的硬规矩）
 *   ③ `_kit` 有 asScheduler / asReviewer，且**真接口真的用上了**：
 *        排班写接口（mutation）+ 候选池 + 代录 ⇒ asScheduler
 *        审稿队列 / 通过驳回              ⇒ asReviewer
 *   ④ 拒绝文案就是陛下原话：「暂无权限」「暂无审核权限」（在前端弹窗里当标题用）
 *   ⑤ 前端入口全挂上：desk 管理区有卡片、ROUTES 有跳转、app.json 有分包登记、页面四件套齐
 *   ⑥ 社干进来被拦时**不许静默**：planning 弹窗退回、schedule/index 点击即弹、review 显示拒绝态
 *   ⑦ 新页面不深色（不许 --tile / #272729 这类；白卡 + 浅灰底 + accent）
 *
 * ⚠️ 这个脚本只做**静态文本断言**，跑得很快；真行为在 `cloud/scripts/test-partner-permissions.js`
 *    （51 项，真路由 + 真 handler + 内存库）。两者都要过 —— 静态的防「删了没补」，行为的防「接了没生效」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);
const read = (p) => (fs.existsSync(R(p)) ? fs.readFileSync(R(p), 'utf8') : '');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};
const section = (t) => out.push(`\n---- ${t} ----`);

/* ══════════════ A. 后端：handler 与路由 ══════════════ */
section('A. 后端');

const permJs = read('cloud/cloudfunctions/api/handlers/partner/permissions.js');
ok('handler 存在', !!permJs);
['get', 'saveGlobal', 'savePerson', 'mine'].forEach((fn) => {
  ok(`导出 ${fn}`, new RegExp(`module\\.exports[^;]*\\b${fn}\\b`).test(permJs) || new RegExp(`\\b${fn}\\b[,}]`).test(permJs.slice(permJs.lastIndexOf('module.exports'))));
});

const routerJs = read('cloud/cloudfunctions/api/router.js');
ok('路由：GET /partner/permissions', routerJs.indexOf("['GET /partner/permissions', 'partner.permissions.get']") >= 0);
ok('路由：PUT /partner/permissions', routerJs.indexOf("['PUT /partner/permissions', 'partner.permissions.saveGlobal']") >= 0);
ok('路由：PUT /partner/permissions/person/:id', routerJs.indexOf("['PUT /partner/permissions/person/:id', 'partner.permissions.savePerson']") >= 0);
ok('路由：GET /partner/permissions/mine', routerJs.indexOf("['GET /partner/permissions/mine', 'partner.permissions.mine']") >= 0);

const iMine = routerJs.indexOf('GET /partner/permissions/mine');
const iPerson = routerJs.indexOf('PUT /partner/permissions/person/:id');
ok('字面量 /mine 排在参数路由之前', iMine > 0 && iPerson > 0 && iMine < iPerson, `/mine@${iMine} /person/:id@${iPerson}`);

ok('注册表登记了 partner.permissions',
  read('cloud/cloudfunctions/api/handlers/index.js').indexOf("'partner.permissions': () => require('./partner/permissions')") >= 0);

const kitJs = read('cloud/cloudfunctions/api/handlers/partner/_kit.js');
ok('_kit 有 asScheduler', /async function asScheduler\s*\(/.test(kitJs));
ok('_kit 有 asReviewer', /async function asReviewer\s*\(/.test(kitJs));
ok('_kit 有 asProxyer', /async function asProxyer\s*\(/.test(kitJs));
ok('三个权限位齐全（schedule / review / proxy）',
  /const PERM_KEYS = \['schedule', 'review', 'proxy'\]/.test(kitJs),
  'PERM_KEYS 不是三位：代录又要跟别的开关挤在一起了');
ok('拒绝文案：暂无权限', kitJs.indexOf("deny: '暂无权限'") >= 0);
ok('拒绝文案：暂无审核权限', kitJs.indexOf("deny: '暂无审核权限'") >= 0);
ok('拒绝文案：暂无代录权限', kitJs.indexOf("deny: '暂无代录权限'") >= 0);
ok('全局缺行视为全开（升级当天不改现状）',
  /const out = \{ schedule: true, review: true, proxy: true \}/.test(kitJs),
  'readGlobalPerm 的默认值漏了一位 —— 那一夜所有人都会「暂无XX权限」，而界面还显示着开');
ok('三态：null 表示跟随全局', /function triPerm\s*\(/.test(kitJs) && /return null;/.test(kitJs));
/* 新集合「没建就查不到」的兜底（2026-10-31 线上白屏的真因） */
ok('_kit 有 isMissingCollection', /function isMissingCollection\s*\(/.test(kitJs));
ok('_kit 读权限走 readOr 兜底', /await readOr\(\(\) => findById\(C\.PARTNER_PERMISSION/.test(kitJs));
ok('写路径会自建集合（拨一下开关就建好）',
  /async function ensureCollection\(\)/.test(permJs) && /await ensureCollection\(\)/.test(permJs),
  '删了它 ⇒ 表没建时「页面能开但永远保存不了」');
ok('查不到集合时回 buildNeeded 而不是 50001', /buildNeeded/.test(permJs));
ok('50001 把真实原因接进 message（别再只显示「服务器繁忙」）',
  /function decorateServerError/.test(read('miniprogram/utils/request.js')));

/* 填写窗口（2026-10-31）：周一 0 点 ~ 周六 24 点；周日整页只读 */
ok('_kit 有 availabilityWindow', /function availabilityWindow\s*\(ts\)/.test(kitJs));
ok('_kit 有 assertWindowWritable', /function assertWindowWritable\s*\(p, ts\)/.test(kitJs));
ok('窗口按「今天是不是周日」判，不看目标周',
  /const dow = bj\.weekdayOf\(t\);[\s\S]{0,40}const open = dow !== 0;/.test(kitJs),
  '判据变成看目标周了 ⇒ 「周日整页只读」会时灵时不灵');
ok('窗口只放超管过去（照陛下原话「要改只能超管代录」）',
  /if \(w\.open \|\| \(p && p\.isSuper\)\) return w;/.test(kitJs));

/* 真接口有没有挂在闸上 */
const scheduleJs = read('cloud/cloudfunctions/api/handlers/partner/schedule.js');
ok('排班写接口走 asScheduler',
  /async function mutation\(ctx, fn, superOnly = false\) \{\s*\n\s*const p = superOnly \? await asSuperPartner\(ctx\) : await asScheduler\(ctx\);/.test(scheduleJs),
  'mutation 又回到 asManager 了 ⇒ 关掉开关照样能改班表');
ok('候选池走 asScheduler', /async function candidates\(ctx\) \{[\s\S]{0,200}await asScheduler\(ctx\)/.test(scheduleJs));

const availabilityJs = read('cloud/cloudfunctions/api/handlers/partner/availability.js');
ok('代录吃「代录权限」，不吃排班权限',
  /if \(!p\.isSuper && !\(await permsOf\(p\.admin\)\)\.proxy\)/.test(availabilityJs),
  '代录又绑回 schedule 了 ⇒ 关掉排班权限连收时间都停摆');
ok('代录**查看**也要拦（不能读别人填了什么）',
  /if \(!canProxy\) \{[\s\S]{0,120}PERM_TEXT\.proxy\.deny/.test(availabilityJs));
ok('保存吃填写窗口', /async function save\(ctx\) \{[\s\S]{0,400}assertWindowWritable\(p\)/.test(availabilityJs));
ok('撤销也吃填写窗口', /async function reset\(ctx\) \{[\s\S]{0,200}assertWindowWritable\(p\)/.test(availabilityJs));
ok('GET 把只读态给前端（打开就渲染，不是点完才拒）',
  /const readonly = !win\.open && !p\.isSuper;/.test(availabilityJs) && /readonly,/.test(availabilityJs));

const draftJs = read('cloud/cloudfunctions/api/handlers/partner/draft.js');
ok('审稿队列走 asReviewer', /async function reviewList\(ctx\) \{[\s\S]{0,200}await asReviewer\(ctx\)/.test(draftJs));
ok('通过/驳回走 asReviewer', /async function review\(ctx\) \{[\s\S]{0,160}await asReviewer\(ctx\)/.test(draftJs));
ok('draft 不再用 asManager 兜底', draftJs.indexOf('asManager') < 0, '还留着 asManager，等于谁都能审');

/* 不该被牵连的接口 */
const leaveJs = read('cloud/cloudfunctions/api/handlers/partner/leave.js');
const attJs = read('cloud/cloudfunctions/api/handlers/partner/attendance.js');
ok('请假仍只看角色（关权限不该连请假都进不去）', /asManager\(ctx\)/.test(leaveJs));
ok('考勤仍只看角色', /asManager\(ctx\)/.test(attJs));

/* ══════════════ B. 前端：入口与拦截 ══════════════ */
section('B. 前端');

const deskJs = read('miniprogram/pages-partner/desk/desk.js');
ok('工作台「管理」区有权限管理卡', /\{ go: 'permissions', t: '权限管理'/.test(deskJs), '卡片没加或改名字了');
ok('ROUTES 有 permissions', /permissions: '\/pages-partner\/permissions\/permissions'/.test(deskJs));
ok('卡片只在超管那一段出现（在 roleKey === super 分支里）',
  deskJs.indexOf("go: 'permissions'") > deskJs.indexOf("if (src.roleKey === 'super')"));

const appJson = read('miniprogram/app.json');
ok('app.json 分包登记了新页', appJson.indexOf('"permissions/permissions"') >= 0);

['js', 'wxml', 'wxss', 'json'].forEach((ext) => {
  ok(`页面四件套：permissions.${ext}`, fs.existsSync(R(`miniprogram/pages-partner/permissions/permissions.${ext}`)));
});

const permPageJs = read('miniprogram/pages-partner/permissions/permissions.js');
ok('页面只给超管（role !== 0 退回）', /Number\(info\.role\) !== 0/.test(permPageJs));
ok('改完强制刷新本机权限缓存', /perm\.load\(true\)/.test(permPageJs));
ok('按人拨位走独立接口', /\/partner\/permissions\/person\/\$\{personId\}/.test(permPageJs));
ok('支持「跟回全局」（传 null）', /onFollow/.test(permPageJs) && /\[key\]: null/.test(permPageJs));

const permUtil = read('miniprogram/utils/perm.js');
ok('utils/perm.js 存在', !!permUtil);
ok('取不到权限时放行（fail-open，后端仍会拦）', /\.catch\(\(\) => \{\s*\n\s*inflight = null;\s*\n\s*return null;/.test(permUtil));
ok('换账号会清缓存（app.js）',
  (read('miniprogram/app.js').match(/require\('\.\/utils\/perm\.js'\)\.clear\(\)/g) || []).length >= 2,
  '登录与退出都要清，否则串号');

const planningJs = read('miniprogram/pages-partner/schedule/planning/planning.js');
ok('工作台：进页先问权限', /perm\.load\(\)\.then\(\(pm\) =>/.test(planningJs));
ok('工作台：被拒弹窗 + 退回', /denySchedule\(pm\)/.test(planningJs) && /wx\.showModal/.test(planningJs));
ok('工作台：被拒时不发排班请求', /if \(pm && pm\.schedule === false\) return this\.denySchedule\(pm\);/.test(planningJs));

const schedIndexJs = read('miniprogram/pages-partner/schedule/index/index.js');
ok('班表页：入口点了才弹（不闪一下再退）', /if \(this\.data\.canPlan === false\)/.test(schedIndexJs));
ok('班表页：默认放行（接口挂了不锁人）', /canPlan: true/.test(schedIndexJs));

const reviewJs = read('miniprogram/pages-partner/review/review.js');
const reviewWxml = read('miniprogram/pages-partner/review/review.wxml');
ok('审核页：有 denied 态', /denied: false/.test(reviewJs));
ok('审核页：被拒不发请求', /if \(this\.data\.denied\) return Promise\.resolve\(\);/.test(reviewJs));
ok('审核页：拒绝态显示「暂无审核权限」', /\{\{denyReview\}\}/.test(reviewWxml));
ok('审核页：拒绝态没有假列表', /<view class="deny" wx:if="\{\{denied\}\}">/.test(reviewWxml));

/* ── 可排时间页：填写窗口 + 代录权限 ── */
const availJs = read('miniprogram/pages-partner/availability/availability.js');
const availWxml = read('miniprogram/pages-partner/availability/availability.wxml');
ok('可排时间：只读闸存在', /_blockedByWindow\(\)/.test(availJs));
ok('可排时间：点方块 / 全选 / 勾确认 / 提交 / 清空 都挂了闸',
  (availJs.match(/if \(this\._blockedByWindow\(\)\) return;/g) || []).length >= 5,
  '有入口没挂闸 ⇒ 周日那天还能改，整页只读就是句空话');
ok('可排时间：代录入口问 canProxy（没开只能填自己）',
  /id !== meId && !this\.data\.canProxy/.test(availJs));
ok('可排时间：只读文案来自云函数，不在页面写死',
  /readonlyText: \(data\.window && data\.window\.text\)/.test(availJs));
ok('可排时间：只读提示条在页面上', /class="ro-bar" wx:if="\{\{readonly\}\}"/.test(availWxml));
ok('可排时间：提交 / 清空在只读时 disabled',
  /bindtap="onSubmit" disabled="\{\{readonly\}\}"/.test(availWxml)
  && /bindtap="onReset" disabled="\{\{readonly\}\}"/.test(availWxml));
ok('可排时间：弹层保存也 disabled',
  /bindtap="saveAv" disabled="\{\{readonly\}\}"/.test(availWxml));

/* ── 权限页：三格胶囊由 meta 驱动，不是写死两个 ── */
const permWxml = read('miniprogram/pages-partner/permissions/permissions.wxml');
ok('权限页：胶囊按 meta 循环（加第四个开关不用改页面）',
  /wx:for="\{\{meta\}\}"[\s\S]{0,200}data-key="\{\{m\.key\}\}"/.test(permWxml),
  '又写死成两格了');
ok('权限页：跟回全局也按 meta 循环', /wx:if="\{\{p\.over\[m\.key\] !== null\}\}"/.test(permWxml));

/* ══════════════ C. 契约 ══════════════ */
section('C. 契约');

const contractJs = read('cloud/contracts/partner.js');
['GET /partner/permissions', 'PUT /partner/permissions',
  'PUT /partner/permissions/person/:id', 'GET /partner/permissions/mine'].forEach((k) => {
  ok(`契约登记：${k}`, contractJs.indexOf(`'${k}'`) >= 0);
});
ok('契约：PERM_SET 三位齐全',
  /const PERM_SET = \{ schedule: 'boolean', review: 'boolean', proxy: 'boolean' \}/.test(contractJs));
ok('契约：可排时间给了 window 形状（open / readonly 分开）',
  /window: \{[\s\S]{0,200}readonly: 'boolean'/.test(contractJs));
ok('契约：ABILITIES 补了 canReview / canManagePermissions',
  contractJs.indexOf('canManagePermissions') >= 0 && contractJs.indexOf('canReview') >= 0);

/* ══════════════ C. 新页面不许深色 ══════════════ */
section('D. 视觉底线');

const permWxss = read('miniprogram/pages-partner/permissions/permissions.wxss');
ok('没有 var(--tile)', permWxss.indexOf('var(--tile') < 0);
ok('没有深色底 #272729 / #3A3A3C', !/#272729|#3A3A3C/i.test(permWxss));
ok('用了 accent 强调', permWxss.indexOf('var(--accent') >= 0);

/* 输出 */
console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 权限分发 + 填写窗口口径一致（3 个开关 · 4 个接口 · 前端 4 处拦截 · 1 个新页）');
process.exit(failed ? 1 : 0);
