'use strict';
/**
 * 审核记录（审核处理台的「审核记录」块）· 2026-11-02
 *
 * 陛下的原话：「审核记录这些是什么意思」→「可不可以改成谁通过的谁撤回的清楚一点」→「要 v3b 的方案」。
 *
 * 病根有两层，这个脚本两层都守：
 *   ① `status_log.reason` 存的是**动作代号**（REVIEW_APPROVED / REVOKED / INITIAL_ALLOCATION），
 *      前端以前直接当文案例显示 ⇒ 界面上全是英文代号。
 *   ② 一次「通过」会连带分配时段，写两条不同维度的流水 ⇒ 看着像重复、像撤了两次。
 *
 * 定稿口径（v3-b）：
 *   一行 = 「谁（岗位） 干了什么」+ 右侧时间（右对齐成一列）；
 *   翻译与合并都在后端 services/songStatus.js#describeHistory，**措辞只有一份**；
 *   一次操作的多维度流水靠 opId 归组；查不到人不瞎编，退回「管理员」。
 *
 * 任一不满足即退出码 1。
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
/** 跳过（不算失败）：只在「本来就不该有这个文件」的前提下用，比如 mini 范围不构建产物 */
const skip = (name, why) => out.push(`SKIP ${name}\n      ${why}`);

const cloudStatus = read('cloud/cloudfunctions/api/services/songStatus.js');
const cloudSubmit = read('cloud/cloudfunctions/api/handlers/admin/submit.js');
const cloudSchedule = read('cloud/cloudfunctions/api/services/scheduling.js');
const bundle = read('miniprogram/cloudfunctions/api/index.js');
const srcStatus = read('src/services/songStatusService.js');
const srcSubmit = read('src/controllers/admin/submitController.js');
const detailJs = read('miniprogram/pages-partner/review-detail/detail.js');
const detailWxml = read('miniprogram/pages-partner/review-detail/detail.wxml');
const detailWxss = read('miniprogram/pages-partner/review-detail/detail.wxss');

/* ══════════════ A. 措辞只在后端一处 ══════════════ */
out.push('\n---- A. 动作代号 → 人话（只有一份） ----');

const REASONS = ['REVIEW_APPROVED', 'REVIEW_REJECTED', 'REVOKED', 'INITIAL_ALLOCATION',
  'USER_CANCEL', 'USER_LEAVE_QUEUE', 'SCHEDULE_LOCKED_NO_AVAILABLE_SLOT', 'MANUAL'];

ok('云端有 REASON_TEXT 映射表',
  /const REASON_TEXT = \{/.test(cloudStatus),
  '映射表没了 —— 那界面又会把 REVOKED / INITIAL_ALLOCATION 这些代号直接甩给用户');
ok('会出现的动作代号一个不落',
  REASONS.filter((r) => r !== 'MANUAL').every((r) => cloudStatus.includes(`${r}:`)),
  `缺了：${REASONS.filter((r) => r !== 'MANUAL' && !cloudStatus.includes(`${r}:`)).join(' / ')}`);
ok('没有代号时退回「维度：原 → 新」，不显示英文',
  /function fallbackPhrase/.test(cloudStatus) && /STATE_CN\[row\.dimension\]/.test(cloudStatus),
  '兜底没了 —— 后端加一个新动作就会在界面上露出英文代号');
ok('导出 describeHistory / reasonPhrase / newOpId',
  /describeHistory,/.test(cloudStatus) && /reasonPhrase,/.test(cloudStatus) && /newOpId,/.test(cloudStatus));
ok('措辞写「撤销」不写「撤回」（站里按钮/提示都这个词）',
  /撤销，退回待审核/.test(cloudStatus) && !/REVOKED: '撤回/.test(cloudStatus));

/* ══════════════ B. 一次操作一条：opId 串起来 ══════════════ */
out.push('\n---- B. 一次「通过」不拆成两行 ----');

ok('applyChange 给每条流水带 opId',
  /const opId = opts\.opId \|\| newOpId\(\)/.test(cloudStatus) && /opId,\s+\/\/ 同一次操作/.test(cloudStatus),
  '没把 opId 写进日志 —— 一次通过（审核 + 分配时段）就会拆成两行');
ok('审核通过时生成本次 opId 并传给排期',
  /const opId = S\.newOpId\(\)/.test(cloudSubmit)
  && /approveOne\(submit, ctx\.admin\.id, opId\)/.test(cloudSubmit)
  && /runWeekSchedule\(fresh, \{ operatorId: ctx\.admin\.id, opId \}\)/.test(cloudSubmit));
ok('驳回时同样带 opId',
  /rejectOne\(submit, ctx\.admin\.id, reason, opId\)/.test(cloudSubmit));
ok('排期侧把 opId 透传到 applyChange（initialAllocate / reschedule）',
  /opId = null \} = \{\}\) \{/.test(cloudSchedule)
  && /reason: S\.SYSTEM_REASON\.initial, opId \}/.test(cloudSchedule)
  && /reason: isSame \? S\.SYSTEM_REASON\.rescheduleOk : ASSIGN_REASON\.originalFull,\s*\n\s*opId,/.test(cloudSchedule),
  '排期那段没接 opId —— 「分配了播出时段」还是会单独占一行');
ok('老流水没有 opId 时兜一层（同一人 + 同一动作 + 3 秒内）',
  /sameLegacyOp/.test(cloudStatus) && /LEGACY_WINDOW_MS = 3000/.test(cloudStatus),
  '老数据那两条一模一样的「撤销」会原样显示两遍 —— 正是陛下说的"重复"');
ok('兜底只并同名动作，不同动作宁可两行',
  /String\(a\.reason \|\| ''\) === String\(b\.reason\)/.test(cloudStatus));

/* ══════════════ C. 接口：把「谁」查出来 ══════════════ */
out.push('\n---- C. 谁通过的、谁撤销的 ----');

ok('describeHistory 用 operatorId 查 admin 表拿真名 + 岗位',
  /findOne\(C\.ADMIN, \{ id \}\)/.test(cloudStatus) && /ROLE_CN\[Number\(a\.role\)\]/.test(cloudStatus),
  '只显示「管理员」三个字，陛下要的是具体哪个人');
ok('没有 id 的老流水不瞎编（退回 系统 / 本人 / 管理员）',
  /first\.operatorName === 'SYSTEM' \? '系统'/.test(cloudStatus)
  && /first\.operatorName === 'USER' \? '本人'/.test(cloudStatus)
  && /'管理员'/.test(cloudStatus));
ok('详情接口下发 history（人话）并保留 statusHistory（排查用）',
  /history = await S\.describeHistory\(statusHistory\)/.test(cloudSubmit)
  && /statusHistory,       \/\/ 原始流水/.test(cloudSubmit)
  && /history,             \/\/ 给人看的记录/.test(cloudSubmit));
ok('直连模式（src）同源同口径',
  /function describeHistory/.test(srcStatus) && /REASON_TEXT/.test(srcStatus)
  && /history = await S\.describeHistory\(statusHistory\)/.test(srcSubmit),
  '只改了云端 —— 直连模式下还是英文代号');
/**
 * 产物断言：只在「该有产物」的范围里算数。
 * ⚠️ miniprogram/cloudfunctions/api/ 在 .gitignore 里，mini 范围的契约是「不构建线上产物」
 *    ⇒ 干净检出里没有这个文件是**正常**的，不能判红（2026-11-02 CI #43 就是被这一条误杀的）。
 *    产物不存在且不是 full 范围 ⇒ SKIP，说明白为什么不查。
 */
if (!bundle && process.env.VERIFY_SCOPE !== 'full') {
  skip('云端产物已重新打包（index.js 里有 describeHistory）',
    'mini 范围不构建云函数产物；要不要查产物由 full 范围的 verify 负责');
} else {
  ok('云端产物已重新打包（index.js 里有 describeHistory）',
    /describeHistory/.test(bundle) && /REASON_TEXT/.test(bundle),
    bundle
      ? '改了源码没跑 node cloud/scripts/sync.js ⇒ 部署上去的还是旧产物，界面上看不到变化'
      : '读不到 miniprogram/cloudfunctions/api/index.js —— full 范围里产物必须先于校验生成');
}

/* ══════════════ D. 前端只排版，不再自己拼 ══════════════ */
out.push('\n---- D. 界面 ----');

ok('前端不再读原始流水的 reason 当文案',
  !/h\.reason/.test(detailJs) && !/d\.statusHistory/.test(detailJs),
  '又拿 statusHistory[].reason 上屏了 —— 那是代号，不是人话');
ok('不再出现「本条目尚未处理。」（与下面的记录自相矛盾）',
  !/本条目尚未处理/.test(detailJs) && !/本条目尚未处理/.test(detailWxml));
ok('第一行是「当前 + 状态」',
  /`当前\$\{stText\}`/.test(detailJs) && /statusText/.test(detailJs));
ok('记录行渲染成「名字（岗位） 干了什么 …… 时间」',
  /class="rec-line[^"]*"/.test(detailWxml)
  && /class="rec-name"/.test(detailWxml)
  && /class="rec-role"/.test(detailWxml)
  && /class="rec-tm"/.test(detailWxml),
  '结构退回单段文字 —— 名字就没法加重、时间也没法对齐');
ok('时间右对齐成一列（flex + tabular-nums）',
  /\.rec-line \{[^}]*display: flex/.test(detailWxss)
  && /\.rec-line \{[^}]*align-items: baseline/.test(detailWxss)
  && /\.rec-tm \{[^}]*tabular-nums/.test(detailWxss),
  '时间跟句子走 ⇒ 每条长短不同，四行时间参差（v2 就是这么被否的）');
ok('名字加重、岗位灰（v3-b 的写法）',
  /\.rec-name \{[^}]*font-weight: 600/.test(detailWxss) && /\.rec-role \{/.test(detailWxss));
ok('内部稿件（草稿）也用同一套行结构',
  /recordLines\.push\(\{ name: '作者'/.test(detailJs) && /当前\$\{draftState\}/.test(detailJs),
  '草稿那支还在往数组里塞字符串 ⇒ 渲染出 [object Object] 或空行');

console.log(out.join('\n'));
console.log(failed
  ? `\n✗ 失败 ${failed} 项`
  : '\n✓ 审核记录：代号翻人话 · 一次操作一行 · 谁通过的谁撤销的写实名 · 时间右对齐');
process.exit(failed ? 1 : 0);
