'use strict';
/**
 * 稿件模块 UI 一致性校验（2026-11-01）
 *
 * 陛下当天两句话：
 *   ①「稿件模块那一页……你把草稿箱做回来」
 *   ②「内部稿件审核，也要做审核处理台，不能马虎了」
 *
 * ② 的真实问题不是"好不好看"：内部稿件原来只有列表两个按钮 ——
 *    通过是一键、驳回是 showModal 弹个输入框，**审稿人从头到尾看不到正文**。
 *    列表行只有标题/栏目/字数，凭什么批？所以现在统一进处理台（全文 + 理由）。
 *    这个脚本守的就是"别再退回列表一键通过"。
 *
 * 判据（任一不满足即退出码 1）：
 *   ① 稿件页 4 档，草稿箱在第一格、status=0，点行进编辑器
 *   ② 审核列表对内部稿件不出"通过/驳回"两个按钮，只出"处理"
 *   ③ 内部稿件的通过 / 驳回 / 点行 **都必须先进处理台**（不允许直接调 review 接口）
 *   ④ 处理台认得 kind=draft：换详情接口、换队列、换通过驳回接口、正文整段渲染
 *   ⑤ 处理台的人数统计格由数组驱动（投稿看历史、稿件看版本/字数/时长，两套数据）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');

let failed = 0;
const out = [];
const ok = (name, cond, detail) => {
  if (!cond) failed++;
  out.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond || !detail ? '' : '\n      ' + detail}`);
};

const workJs = read('miniprogram/pages-partner/work/work.js');
const workWxml = read('miniprogram/pages-partner/work/work.wxml');
const reviewJs = read('miniprogram/pages-partner/review/review.js');
const reviewWxml = read('miniprogram/pages-partner/review/review.wxml');
const detailJs = read('miniprogram/pages-partner/review-detail/detail.js');
const detailWxml = read('miniprogram/pages-partner/review-detail/detail.wxml');

/* ══════════════ A. 稿件页：草稿箱回来了 ══════════════ */
out.push('\n---- A. 稿件页四档 ----');

ok('work.js 存在', !!workJs);
ok('四个状态都登记了（草稿箱 / 待审核 / 已通过 / 已驳回）',
  ['draft', 'pending', 'approved', 'rejected'].every((k) => new RegExp(`key:\\s*'${k}'`).test(workJs)),
  '少一档就是某一类稿件永远找不到');
ok('草稿箱排第一格且 status=0',
  /const TABS = \[\s*\{\s*key: 'draft',\s*status: 0,\s*label: '草稿箱'/.test(workJs),
  '草稿箱不在第一格 / status 不是 0（0 才是草稿，1 是待审）');
ok('草稿行点进去是编辑器（接着写），不是只读版本页',
  /status === 0\) \{\s*\n\s*wx\.navigateTo\(\{ url: `\/pages-partner\/work\/editor\/editor\?id=\$\{id\}` \}\)/.test(workJs),
  '草稿点进去还在跳 versions 页 —— 那就只能看不能改');
ok('空态文案与四档对齐',
  /\['草稿箱是空的[^\]]*',\s*'没有在审的稿',\s*'还没有通过的稿',\s*'没有被驳的稿'\]/.test(workJs),
  'emptyText 数组少了/错位，串到下一档的文案');
ok('模板注释与实现一致（不再写着"只有 3 档"）',
  !/tab 就 3 档/.test(workWxml) && !/没有「草稿」/.test(workJs));

/* ══════════════ B. 内部稿件必须走处理台 ══════════════ */
out.push('\n---- B. 内部稿件 → 处理台 ----');

const approveBlock = (reviewJs.match(/onApprove\(e\) \{[\s\S]*?\n  \},/) || [''])[0];
ok('列表「通过」对内部稿件不直接发审稿请求',
  /kind\.key === 'draft'/.test(approveBlock) && /openDetail/.test(approveBlock),
  '内部稿件又回到"列表一键通过"了 —— 那个位置看不到正文');
ok('列表「驳回」对内部稿件也跳处理台',
  /if \(kind\.key !== 'message'\) \{[\s\S]{0,120}openDetail\(id, 'reject', kind\.key\)/.test(reviewJs),
  '内部稿件的驳回又用 showModal 收理由了（收不了长理由、看不到正文）');
ok('点行也进处理台（不再跳 versions 页）',
  /onItemTap\(e\)[\s\S]{0,300}openDetail\(id, '', kind\.key\)/.test(reviewJs));
ok('openDetail 会把 kind=draft 带进 URL',
  /kindKey === 'draft' \? '&kind=draft' : ''/.test(reviewJs));
ok('模板只给内部稿件一个「处理」按钮',
  /item\.byDetail \? '处 理' : '通过'/.test(reviewWxml)
  && /wx:if="\{\{!item\.byDetail\}\}"[\s\S]{0,120}驳回/.test(reviewWxml),
  '内部稿件又出现并排的"通过/驳回"，可以闭着眼批');
ok('行数据带 byDetail 标记', /byDetail: isDraft/.test(reviewJs));

/* ══════════════ C. 处理台认得 kind=draft ══════════════ */
out.push('\n---- C. 处理台两种来源 ----');

ok('onLoad 读 kind', /\(options && options\.kind\) === 'draft'/.test(detailJs));
ok('详情按来源换接口', /adminRequest\(`\/partner\/draft\/\$\{id\}`, 'GET'\)/.test(detailJs)
  && /adminRequest\(`\/admin\/submit\/\$\{id\}`, 'GET'\)/.test(detailJs));
ok('待审队列也按来源换（draft 用 status=1，不是 reviewStatus=0）',
  /adminRequest\('\/partner\/draft\/review', 'GET', \{ status: 1,/.test(detailJs),
  '内部稿件拿 submit 的队列去翻页 —— 上一条/下一条会跳到别的表');
ok('通过：draft 走 /review 且 approve:true',
  /adminRequest\(`\/partner\/draft\/\$\{this\.data\.id\}\/review`, 'PUT', \{ approve: true \}\)/.test(detailJs));
ok('驳回：draft 走 /review 且带 reason',
  /adminRequest\(`\/partner\/draft\/\$\{this\.data\.id\}\/review`, 'PUT', \{ approve: false, reason \}\)/.test(detailJs));
ok('正文整段渲染（不做截断）',
  /\{ k: '正文', v: d\.body \|\| '（空）' \}/.test(detailJs)
  && /完整内容，不做截断/.test(detailWxml));
ok('稿件有自己的一套驳回理由预设（不是学生投稿那套）',
  /const PRESETS_DRAFT = \[/.test(detailJs) && /篇幅超时，需压缩/.test(detailJs),
  '还在用「重复投稿 / 该曲一周内已点过」去驳回伙伴自己的稿');
ok('人数统计格由 stats 数组驱动',
  /wx:for="\{\{stats\}\}"/.test(detailWxml) && /stats: \[/.test(detailJs),
  '模板还写死三格「历史通过/历史驳回/首次投稿」，稿件进来就空着')

console.log(out.join('\n'));
console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 稿件四档 + 内部稿件审核处理台（全文 · 理由 · 队列可翻）');
process.exit(failed ? 1 : 0);
