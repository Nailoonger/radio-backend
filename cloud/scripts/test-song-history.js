'use strict';

/**
 * 审核记录（状态流水 → 人话）· 2026-11-02
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-song-history.js
 *
 * 守的是陛下这一轮的要求：
 *   「审核记录这些是什么意思」→ 界面上全是 REVIEW_APPROVED / INITIAL_ALLOCATION / REVOKED；
 *   「可不可以改成谁通过的谁撤回的清楚一点」→ 要写操作人实名 + 岗位；
 *   「要 v3b 的方案」→ 名字（岗位）在前、时间右对齐。
 *
 * 这里测的是 `services/songStatus.js#describeHistory`（措辞与合并的唯一实现）以及
 * approve / revoke 两个真接口落出来的流水能不能被它正确归组：
 *   · 一次「通过」连带分配时段 = **一条记录**，不是两条（靠 opId 串起来）
 *   · 谁通过的、谁撤销的 = 真名 + 岗位（超管 / 社干）
 *   · 系统动作写「系统」、学生动作写「本人」，老数据没有操作人 id 的写「管理员」，不瞎编
 *   · 后端哪天加了新动作没进映射表，也只会退回中文「维度：原 → 新」，**绝不把代号甩到界面上**
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const S = require(path.join(API_DIR, 'services', 'songStatus'));

const lines = [];
let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

const HASH = bcrypt.hashSync('password123', 4);
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });
const PLAIN_TOKEN = sign({ id: 2, username: 'reviewer', role: 1 });

const WEEK_MS = bj.nextWeekRange(Date.now()).start.getTime();
const DATE0 = bj.ymd(bj.shifted(WEEK_MS));

function seed() {
  H.reset({
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '王慕之', role: 0, status: 1, createTime: new Date(), updateTime: new Date() },
      { _id: 'ad2', id: 2, username: 'reviewer', password: HASH, nickname: '李思远', role: 1, status: 1, createTime: new Date(), updateTime: new Date() },
    ],
    user: [
      { _id: 'us1', id: 1, openid: 'op1', username: '20240101', nickname: '小明', remark: '小明', avatar: '', grade: 5, classNo: 2, seatNo: 7, status: 1, lastLoginAt: null, loginCount: 3, createTime: new Date() },
    ],
    weekly_schedule: [{
      _id: `week:${DATE0}`,
      id: 1,
      weekStartDate: DATE0,
      // 申请已截止、还没锁定：approve / revoke 都能走，且与「今天是周几」无关
      applicationStartAt: new Date(Date.now() - 9 * 86400000),
      applicationEndAt: new Date(Date.now() - 3600000),
      reviewStartAt: new Date(Date.now() - 3600000),
      scheduleLockAt: new Date(Date.now() + 86400000),
      reviewEndAt: new Date(Date.now() + 86400000),
      status: 'SCHEDULING',
      lockPaused: 0,
      lockedAt: null,
      createdBy: null,
      createTime: new Date(),
      updateTime: new Date(),
    }],
    submit: [{
      _id: 'sb1',
      id: 1,
      openid: 'op1',
      type: 1,
      songName: '晴天',
      singer: '周杰伦',
      wishContent: null,
      wantBroadcastTime: null,     // 不落周 ⇒ 排期阶段不会动别的格子，用例确定
      scheduledSlot: null,
      queueAt: null,
      promotedAt: null,
      reviewStatus: S.REVIEW.PENDING,
      scheduleStatus: S.SCHEDULE.UNASSIGNED,
      playStatus: S.PLAY.NOT_PLAYED,
      allowReschedule: 1,
      assignedAt: null,
      playedAt: null,
      status: S.deriveStatus(S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED, S.PLAY.NOT_PLAYED),
      rejectReason: null,
      reviewerId: null,
      reviewTime: null,
      autoRejected: 0,
      createTime: new Date(),
      updateTime: new Date(),
    }],
  });
}

/** 造一行流水（只给 describeHistory 用，不进库） */
function log(o) {
  return Object.assign({
    requestId: 1,
    operatorId: null,
    operatorName: 'ADMIN',
    dimension: 'review',
    fromStatus: 'PENDING_REVIEW',
    toStatus: 'APPROVED',
    reason: null,
    opId: null,
    createTime: new Date('2026-10-31T08:36:00.000Z'),
  }, o);
}

async function main() {
  seed();

  /* ══════════════ A. 措辞：代号 → 人话 ══════════════ */
  section('A. 动作代号翻人话');

  let h = await S.describeHistory([
    log({ operatorId: 2, reason: 'REVIEW_APPROVED', dimension: 'review', opId: 'opA' }),
  ]);
  eq('「通过」写成人话', [h[0].name, h[0].role, h[0].text], ['李思远', '社干', '通过']);

  h = await S.describeHistory([
    log({ operatorId: 1, reason: 'REVOKED', toStatus: 'PENDING_REVIEW', opId: 'opB' }),
  ]);
  eq('「撤销」写成人话（站里叫撤销，不叫撤回）', h[0].text, '撤销，退回待审核');
  ok('超管岗位标出来', h[0].role === '超管', `role=${h[0].role}`);

  h = await S.describeHistory([
    log({ operatorName: 'SYSTEM', reason: 'INITIAL_ALLOCATION', dimension: 'schedule' }),
  ]);
  eq('系统动作：写「系统」、不挂岗位', [h[0].name, h[0].role, h[0].text], ['系统', '', '分配了播出时段']);

  h = await S.describeHistory([
    log({ operatorName: 'USER', reason: 'USER_CANCEL', toStatus: 'CANCELLED' }),
  ]);
  eq('学生动作：写「本人」，岗位注明投稿人', [h[0].name, h[0].role, h[0].text], ['本人', '投稿人', '自己取消']);

  h = await S.describeHistory([
    log({ operatorId: null, operatorName: 'ADMIN', reason: 'REVIEW_APPROVED' }),
  ]);
  eq('老流水没有操作人 id：退回「管理员」，不瞎编名字', [h[0].name, h[0].role], ['管理员', '']);

  h = await S.describeHistory([
    log({ operatorId: 999, operatorName: 'ADMIN', reason: 'REVIEW_APPROVED' }),
  ]);
  eq('操作人 id 查不到人：也退回「管理员」', h[0].name, '管理员');

  h = await S.describeHistory([
    log({ operatorName: 'SYSTEM', reason: 'BRAND_NEW_ACTION_NOT_IN_TABLE', dimension: 'play', fromStatus: 'NOT_PLAYED', toStatus: 'PLAYED' }),
  ]);
  ok('映射表里没有的新动作：退回中文「维度：原 → 新」',
    h[0].text === '播放：未播放 → 已播放' && !/[A-Z]{4,}/.test(h[0].text),
    `text=${h[0].text}`);

  /* ══════════════ B. 一次操作一条（opId 归组） ══════════════ */
  section('B. 一次操作一条');

  h = await S.describeHistory([
    log({ operatorId: 2, reason: 'REVIEW_APPROVED', dimension: 'review', opId: 'opC' }),
    log({ operatorId: 2, reason: 'INITIAL_ALLOCATION', dimension: 'schedule', opId: 'opC' }),
  ]);
  eq('「通过 + 分配时段」并成一条', h.length, 1);
  eq('并成的那句读得通', h[0].text, '通过，分配了播出时段');

  h = await S.describeHistory([
    log({ operatorId: 1, reason: 'REVOKED', dimension: 'review', toStatus: 'PENDING_REVIEW', opId: 'opD' }),
    log({ operatorId: 1, reason: 'REVOKED', dimension: 'schedule', opId: 'opD' }),
  ]);
  eq('「撤销」两个维度也并成一条（不再像撤了两次）', [h.length, h[0].text], [1, '撤销，退回待审核']);

  h = await S.describeHistory([
    log({ operatorId: 2, reason: 'REVIEW_APPROVED', opId: 'opE' }),
    log({ operatorId: 2, reason: 'REVOKED', toStatus: 'PENDING_REVIEW', opId: 'opF' }),
  ]);
  eq('两次不同的操作各算一条', h.length, 2);

  h = await S.describeHistory([
    log({ operatorId: 2, reason: 'REVIEW_APPROVED' }),
    log({ operatorId: 2, reason: 'INITIAL_ALLOCATION', dimension: 'schedule' }),
  ]);
  eq('老数据没有 opId：不硬并（宁可两行也不错并）', h.length, 2);

  /* ══════════════ C. 真接口：approve 落出来的流水 ══════════════ */
  section('C. 真接口（approve / revoke）');

  let r = await H.call(H.req('PUT', '/admin/submit/1/approve', {}, PLAIN_TOKEN));
  eq('审核通过 → code 0', r.code, 0);

  r = await H.call(H.req('GET', '/admin/submit/1', {}, PLAIN_TOKEN));
  eq('详情接口带回 history（给人看的那份）', r.code, 0);
  const afterApprove = (r.data && r.data.history) || [];
  eq('通过之后：一条记录，不拆成两条', afterApprove.length, 1);
  ok('记录里写着谁通过的（实名 + 岗位）',
    afterApprove[0] && afterApprove[0].name === '李思远' && afterApprove[0].role === '社干',
    JSON.stringify(afterApprove[0]));
  ok('文案以「通过」开头', afterApprove[0] && String(afterApprove[0].text).startsWith('通过'),
    String(afterApprove[0] && afterApprove[0].text));
  ok('原始流水仍然下发（排查用），但界面不渲染它',
    Array.isArray(r.data && r.data.statusHistory) && r.data.statusHistory.length >= 1,
    `statusHistory=${(r.data && r.data.statusHistory || []).length}`);

  r = await H.call(H.req('PUT', '/admin/submit/1/revoke', {}, SUPER_TOKEN));
  eq('超管撤销 → code 0', r.code, 0);

  r = await H.call(H.req('GET', '/admin/submit/1', {}, PLAIN_TOKEN));
  const afterRevoke = (r.data && r.data.history) || [];
  eq('撤销之后：两条记录（通过、撤销）', afterRevoke.length, 2);
  const last = afterRevoke[afterRevoke.length - 1] || {};
  ok('最后一条写着谁撤销的（超管实名）',
    last.name === '王慕之' && last.role === '超管', JSON.stringify(last));
  eq('撤销的措辞', last.text, '撤销，退回待审核');

  // 时间字段原样下发（格式化交给前端，服务端不掺和时区）
  ok('每条记录都带原始时间', afterRevoke.every((x) => !!x.time), JSON.stringify(afterRevoke.map((x) => x.time)));

  console.log(lines.join('\n'));
  console.log(failed ? `\n结论：断言 ${lines.filter((l) => /^(OK|FAIL)/.test(l)).length} 项 / 失败 ${failed} 项`
    : `\n结论：断言 ${lines.filter((l) => /^(OK|FAIL)/.test(l)).length} 项 / 失败 0 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
