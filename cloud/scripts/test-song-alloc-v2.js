'use strict';

/**
 * 「按格审核 + 统筹补派」专项验证（2026-11-14 陛下定案的新口径）
 *
 * 用法（仓库根目录，不需要云环境、不联网）：
 *   node cloud/scripts/test-song-alloc-v2.js
 *
 * 验证的六条规则（每一条都必须有断言，否则改完不知道对不对）：
 *   ① 审核通过 = **当场占住首选格**（review=APPROVED + schedule=APPROVED）
 *   ② 该格已满 → 审核被**拒绝**（40906），而且**不会**把人挪到别的格
 *   ③ 格子相互独立：别的格空着也不外借（拒绝而不是"调剂过去"）
 *   ④ 所有格都满 → 剩下的待审**直接系统驳回**（autoRejected=1）
 *   ⑤ 所有格审完仍有空格 → 按提交时间升序补派，**就近**选格；位子用完则驳回
 *   ⑥ 撤回 / 删除已占位 → 系统从"首选同格的待审"里补一个；锁定后一律拒绝
 *
 * ⚠️ 与旧脚本的分工：`test-admin-submit.js` 盯的是接口契约与并发幂等，
 *    本文件只盯「谁占哪一格、什么时候不占」这一件事。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const S = require(path.join(API_DIR, 'services', 'songStatus'));
const slotSvc = require(path.join(API_DIR, 'services', 'broadcastSlot'));
const winSvc = require(path.join(API_DIR, 'services', 'songWindow'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
const ruleSvc = require(path.join(API_DIR, 'services', 'submitRule'));
const noticeSvc = require(path.join(API_DIR, 'services', 'songNotice'));

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

const WEEK_MS = bj.nextWeekRange(Date.now()).start.getTime();
const DATE0 = bj.ymd(bj.shifted(WEEK_MS));
const DATE1 = bj.ymd(bj.shifted(WEEK_MS + bj.DAY_MS));
const DATE2 = bj.ymd(bj.shifted(WEEK_MS + 2 * bj.DAY_MS));
const DATE3 = bj.ymd(bj.shifted(WEEK_MS + 3 * bj.DAY_MS));
const DATE4 = bj.ymd(bj.shifted(WEEK_MS + 4 * bj.DAY_MS));
/** 整周 10 个格子（周一~周五 × 早间/午间）—— 「全格满」的判定必须以整周为准 */
const ALL_SLOTS = [DATE0, DATE1, DATE2, DATE3, DATE4]
  .flatMap((d) => [`${d} 早间 07:20`, `${d} 午间 12:20`]);

/** 本测试用两个时段：早间 07:20 / 午间 12:20；容量 2 */
const S_EARLY = `${DATE0} 早间 07:20`;
const S_NOON = `${DATE0} 午间 12:20`;
const S_NEXT_EARLY = `${DATE1} 早间 07:20`;
const S_NEXT_NOON = `${DATE1} 午间 12:20`;
const CAP = 2;

function weekRow(opts) {
  const o = opts || {};
  const appEnd = o.appEnd === undefined ? Date.now() - 3600000 : o.appEnd;
  const lockAt = o.lockAt === undefined ? Date.now() + 3600000 : o.lockAt;
  return {
    _id: `week:${DATE0}`,
    id: 1,
    weekStartDate: DATE0,
    applicationStartAt: new Date(Date.now() - 8 * 86400000),
    applicationEndAt: new Date(appEnd),
    reviewStartAt: new Date(appEnd),
    scheduleLockAt: new Date(lockAt),
    reviewEndAt: new Date(lockAt),
    status: o.status || 'SCHEDULING',
    lockPaused: o.lockPaused || 0,
    lockedAt: o.lockedAt || null,
    createdBy: null,
    createTime: new Date(),
    updateTime: new Date(),
  };
}

function baseSeed(extra, weekOpts) {
  const s = {
    admin: [{ _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, createTime: new Date(), updateTime: new Date() }],
    user: [{ _id: 'us1', id: 1, openid: 'op1', username: '20240101', nickname: '小明', remark: '小明', avatar: '', grade: 2024, classNo: 1, seatNo: 1, status: 1, createTime: new Date() }],
    weekly_schedule: [weekRow(weekOpts)],
  };
  return Object.assign(s, extra || {});
}

/** 造一条投稿；`at` 控制提交时间（升序排序靠它） */
function mkSubmit(id, o) {
  const opt = o || {};
  const review = opt.review === undefined ? S.REVIEW.PENDING : opt.review;
  const schedule = opt.schedule === undefined ? S.SCHEDULE.UNASSIGNED : opt.schedule;
  const play = opt.play === undefined ? S.PLAY.NOT_PLAYED : opt.play;
  return {
    _id: `sb${id}`,
    id,
    openid: opt.openid || 'op1',
    type: opt.type === undefined ? 1 : opt.type,
    songName: opt.songName === undefined ? `曲${id}` : opt.songName,
    singer: '测试歌手',
    wishContent: null,
    articleTitle: null,
    articleContent: null,
    wantBroadcastTime: opt.want === undefined ? null : opt.want,
    scheduledSlot: opt.slot === undefined ? null : opt.slot,
    queueAt: null,
    promotedAt: null,
    reviewStatus: review,
    scheduleStatus: schedule,
    playStatus: play,
    allowReschedule: opt.allow === undefined ? 1 : opt.allow,
    assignedAt: opt.assignedAt === undefined ? null : opt.assignedAt,
    playedAt: null,
    status: S.deriveStatus(review, schedule, play),
    rejectReason: opt.rejectReason === undefined ? null : opt.rejectReason,
    reviewerId: null,
    reviewTime: null,
    autoRejected: opt.autoRejected || 0,
    createTime: opt.at || new Date(Date.now() - (1000 - id) * 60000),
    updateTime: new Date(),
  };
}

/** 把指定格子按容量坐满（id 从 startId 起，返回坐位行） */
function fillSlots(slots, startId) {
  const out = [];
  let id = startId;
  for (const v of slots) {
    for (let k = 0; k < CAP; k++) {
      out.push(mkSubmit(id++, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: v, slot: v }));
    }
  }
  return out;
}

async function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  slotSvc.clearCache();
  winSvc.clearCache();
  ruleSvc.clearCache();
  noticeSvc.clearCache();
  // 容量 2：5 天 × 2 时段看着多，本文件只用同一天两个时段，够了
  await slotSvc.setSlotTimes([{ time: '07:20', label: '早间' }, { time: '12:20', label: '午间' }], CAP);
}

const dump = () => H.dump();
const byId = (id) => (dump().submit || []).find((x) => Number(x.id) === Number(id));

/** 走接口审核（不直接调服务，确保链路真实） */
const approve = (id) => H.call(H.req('PUT', `/admin/submit/${id}/approve`, {}, SUPER_TOKEN));
const revoke = (id) => H.call(H.req('PUT', `/admin/submit/${id}/revoke`, {}, SUPER_TOKEN));
const reject = (id, reason) => H.call(H.req('PUT', `/admin/submit/${id}/reject`, { reason }, SUPER_TOKEN));
/** 兜底统筹（定时器/手动扫一遍） */
const sweep = () => H.call(H.req('POST', '/admin/submit/queue/sweep', {}, SUPER_TOKEN));
/** 锁定排期（force 绕开「未到锁定时刻」闸门 —— 本文件不测时间闸门） */
const lockWeek = () => require(path.join(API_DIR, 'services', 'scheduling')).lockWeek(WEEK_MS, { force: true });

(async () => {
  /* ══════════ ① 审核通过 = 当场占住首选格 ══════════ */
  section('① 审核通过 = 当场占住首选格');
  await reset(baseSeed({ submit: [mkSubmit(1, { want: S_EARLY })] }));
  let r = await approve(1);
  eq('通过成功', r.code, 0);
  eq('三维：review=APPROVED schedule=APPROVED', [byId(1).reviewStatus, byId(1).scheduleStatus], [S.REVIEW.APPROVED, S.SCHEDULE.APPROVED]);
  eq('实际时段 = 首选格（不做任何调剂）', byId(1).scheduledSlot, S_EARLY);
  eq('派生 status = 1 已排期', r.data.status, 1);

  /* ══════════ ② 该格满了 → 拒绝审核，绝不挪去别格 ══════════ */
  section('② 满格后拒绝审核（40906），不跨格');
  await reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(3, { want: S_EARLY }),
    ],
  }));
  r = await approve(3);
  eq('早间已 2/2 → 40906', r.code, 40906);
  eq('被拒后仍是待审（不是候补）', [byId(3).reviewStatus, byId(3).scheduleStatus], [S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED]);
  eq('被拒后没有占任何格', byId(3).scheduledSlot, null);
  ok('错误信息里带「已排满」', /已排满/.test(r.message || ''), r.message);

  /* ══════════ ③ 别的格空着也不外借 ══════════ */
  section('③ 格子相互独立：午间空着也不收早间的人');
  eq('午间确实空着', (dump().submit || []).filter((x) => x.scheduledSlot === S_NOON).length, 0);
  // 同一次重置里 3 号仍待审；这里只验证它没被"调剂"到午间
  eq('3 号没有被塞进午间', byId(3).scheduledSlot === S_NOON, false);

  /* ══════════ ④ 全格满 ══════════ */
  // ⚠️「全格满」以**整周**为准（5 天 × 2 时段 = 10 格 × 容量 2 = 20 个位子），
  //    只塞满周一两个时段不算满 —— 那 8 个空格算法当然还要往里排。
  section('④ 全格满：审核阶段不赶人，锁定那一刻才统一驳回');
  const allSeated = fillSlots(ALL_SLOTS, 1);
  const LATE_A = allSeated.length + 1;
  const LATE_B = allSeated.length + 2;
  allSeated.push(mkSubmit(LATE_A, { want: S_EARLY }));
  allSeated.push(mkSubmit(LATE_B, { want: S_NOON }));
  await reset(baseSeed({ submit: allSeated }));
  eq('前提：整周 20 个位子全坐满', (dump().submit || []).filter((x) => x.scheduledSlot).length, ALL_SLOTS.length * CAP);

  r = await approve(LATE_A);
  eq('满格后再审 → 40906', r.code, 40906);
  ok('文案说清「整周都满了，锁定时会自动驳回」', /自动驳回/.test(r.message || ''), r.message);
  eq('被拒的那条仍是待审（没被赶走）', [byId(LATE_A).reviewStatus, byId(LATE_A).scheduleStatus], [S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED]);

  await sweep();
  eq('★ sweep 不会因为「满格」就把待审清空（否则撤回就没人可补）',
    [byId(LATE_A).reviewStatus, byId(LATE_B).scheduleStatus], [S.REVIEW.PENDING, S.SCHEDULE.UNASSIGNED]);

  await lockWeek();
  eq('锁定那一刻：剩下的统一系统驳回（autoRejected=1）',
    [byId(LATE_A).scheduleStatus, byId(LATE_A).autoRejected, byId(LATE_B).scheduleStatus, byId(LATE_B).autoRejected],
    [S.SCHEDULE.AUTO_REJECTED, 1, S.SCHEDULE.AUTO_REJECTED, 1]);
  ok('驳回理由写明「没有可用位置」', /没有可用位置/.test(String(byId(LATE_A).rejectReason || '')), byId(LATE_A).rejectReason);
  eq('已占位的 20 条不受影响', (dump().submit || []).filter((x) => x.scheduledSlot).length, ALL_SLOTS.length * CAP);

  /* ══════════ ⑤ 有空格 + 审核做完 → 按时间补派（就近） ══════════ */
  // 场景：整周只留「周一午间」两个空位，三条都首选已满的「周一早间」。
  // 按提交时间升序 → 前两条进午间，第三条没位子 → 驳回。
  section('⑤ 统筹：按提交时间升序补派到空余格，位子用完则驳回');
  const onlyNoonFree = fillSlots(ALL_SLOTS.filter((v) => v !== S_NOON), 1);
  const Q3 = onlyNoonFree.length + 1;
  const Q4 = onlyNoonFree.length + 2;
  const Q5 = onlyNoonFree.length + 3;
  await reset(baseSeed({
    submit: [
      ...onlyNoonFree,
      mkSubmit(Q3, { want: S_EARLY, at: new Date(Date.now() - 300000) }),
      mkSubmit(Q4, { want: S_EARLY, at: new Date(Date.now() - 200000) }),
      mkSubmit(Q5, { want: S_EARLY, at: new Date(Date.now() - 100000) }),
    ],
  }));
  eq('前提：整周只剩周一午间 2 个位子', ALL_SLOTS.length * CAP - (dump().submit || []).filter((x) => x.scheduledSlot).length, CAP);
  await sweep();
  eq('提交最早的 3 号被补派', [byId(Q3).scheduleStatus, byId(Q3).scheduledSlot], [S.SCHEDULE.APPROVED, S_NOON]);
  eq('次早的 4 号被补派', [byId(Q4).scheduleStatus, byId(Q4).scheduledSlot], [S.SCHEDULE.APPROVED, S_NOON]);
  eq('最晚的 5 号没有位子 → 驳回', [byId(Q5).scheduleStatus, byId(Q5).autoRejected], [S.SCHEDULE.AUTO_REJECTED, 1]);
  eq('午间不超容', (dump().submit || []).filter((x) => x.scheduledSlot === S_NOON).length, CAP);

  /* ══════════ ⑤-b 就近：同日另一时段优先于次日 ══════════ */
  section('⑤-b 就近选址：同日 12:20 → 同日 07:20 优于次日');
  await reset(baseSeed({
    submit: [
      // 午间满 2，早间(同日)空、次日早间空
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_NOON, slot: S_NOON }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_NOON, slot: S_NOON }),
      mkSubmit(3, { want: S_NOON }),
    ],
  }));
  await sweep();
  eq('落到同日早间（cost 10）而不是次日（cost 20）', byId(3).scheduledSlot, S_EARLY);

  /* ══════════ ⑥ 撤回 → 从待审里自动补派 ══════════ */
  section('⑥ 撤回已占位 → 系统按时间补一个人进来');
  await reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(3, { want: S_EARLY, at: new Date(Date.now() - 500000) }),
      mkSubmit(4, { want: S_EARLY, at: new Date(Date.now() - 400000) }),
    ],
  }));
  eq('撤回前：3/4 号都还是待审', [byId(3).reviewStatus, byId(4).reviewStatus], [S.REVIEW.PENDING, S.REVIEW.PENDING]);
  r = await revoke(1);
  eq('撤回成功', r.code, 0);
  eq('被撤回的 1 号停在待审（既不补回原格、也不被统筹走）', [byId(1).reviewStatus, byId(1).scheduledSlot], [S.REVIEW.PENDING, null]);
  eq('提交最早的 3 号被自动补进早间', [byId(3).reviewStatus, byId(3).scheduledSlot], [S.REVIEW.APPROVED, S_EARLY]);
  eq('只有 2 个人占位（不超容）', (dump().submit || []).filter((x) => x.scheduledSlot === S_EARLY).length, 2);
  eq('较晚的 4 号：首选已满 → 统筹到空着的午间', [byId(4).reviewStatus, byId(4).scheduledSlot], [S.REVIEW.APPROVED, S_NOON]);

  /* ══════════ ⑦ 驳回不自动补人（人工优先） ══════════ */
  section('⑦ 驳回释放的位子留给人工，不自动补');
  await reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(2, { want: S_EARLY }),
    ],
  }));
  r = await reject(1, '音质太差');
  eq('驳回成功', r.code, 0);
  eq('待审的 2 号没有被自动通过', byId(2).reviewStatus, S.REVIEW.PENDING);

  /* ══════════ ⑧ 锁定后不可撤回、不可再审 ══════════ */
  section('⑧ 锁定后冻结');
  await reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, want: S_EARLY, slot: S_EARLY }),
      mkSubmit(2, { want: S_EARLY }),
    ],
  }, { status: 'LOCKED', lockedAt: new Date() }));
  r = await revoke(1);
  eq('锁定周撤回 → 40001', r.code, 40001);
  r = await approve(2);
  eq('锁定周审核 → 40001', r.code, 40001);

  /* ══════════ ⑨ 文稿不受影响 ══════════ */
  section('⑨ 文稿（type=2）通过不占格');
  await reset(baseSeed({ submit: [mkSubmit(1, { type: 2, want: null })] }));
  r = await approve(1);
  eq('文稿通过成功', r.code, 0);
  eq('文稿只改审核维度，不占格', [byId(1).reviewStatus, byId(1).scheduleStatus, byId(1).scheduledSlot], [S.REVIEW.APPROVED, S.SCHEDULE.UNASSIGNED, null]);

  /* ══════════ 收尾 ══════════ */
  console.log(lines.join('\n'));
  console.log(`\n结论：断言 ${lines.filter((l) => l.startsWith('OK  ') || l.startsWith('FAIL')).length} 项 / 失败 ${failed} 项`);
  if (failed) process.exitCode = 1;
})().catch((e) => {
  console.log(lines.join('\n'));
  console.error('\n脚本自身异常：' + (e && e.stack || e));
  process.exit(1);
});
