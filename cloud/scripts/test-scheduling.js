'use strict';

/**
 * 点歌排期算法本地实测（阶段 5）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-scheduling.js
 *
 * 逐步落地，逐步加段：
 *   【步骤 2】A~G  logAssignment · initialAllocate
 *   【步骤 3】H~   reschedule（待落地）
 *   【步骤 4】     runAllocators · afterRelease
 *   【步骤 5】     lockWeek · unlockWeek · cancelWeek
 *   【步骤 6】     markPlayed · setPlayed · manualAssign · sweep
 *
 * ⚠️ 本脚本盯的是「**不报错的静默错**」，不是「能不能跑通」：
 *   1. 落座顺序（`createTime` 升序 + `id` 兜同秒）—— 错了只是「换个人先安排」，
 *      学生看到的候选位次不对，但接口永远 200。
 *   2. 容量截断 —— 少数一个就超卖，多算一个就白白浪费位置。
 *   3. `dryRun` 必须**真的不写库** —— 预览把正式排期改了，是最坏的一种"预览"。
 *   4. 幂等 —— 第二次跑必须 `assigned=0`（靠 `applyChange` 的乐观锁，不是靠事务）。
 *   5. 周状态推进只对「未锁定 / 未取消」的周生效 —— 顺手把 LOCKED 周改回
 *      SCHEDULING 会让已经定稿的排期"复活"。
 *
 * 日期一律动态计算（bjTime），不写死。
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
const accountService = require(path.join(API_DIR, 'services', 'studentAccount'));
const songWindow = require(path.join(API_DIR, 'services', 'songWindow'));
const broadcastSlot = require(path.join(API_DIR, 'services', 'broadcastSlot'));
const submitRule = require(path.join(API_DIR, 'services', 'submitRule'));
const songNotice = require(path.join(API_DIR, 'services', 'songNotice'));
const S = require(path.join(API_DIR, 'services', 'songStatus'));
const sched = require(path.join(API_DIR, 'services', 'scheduling'));
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));

const lines = [];
let failed = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name} :: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

/** reset + 清掉所有**实例级缓存**（云函数里这些缓存跨调用存活，不清会让用例串味） */
function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  accountService._clearCache();
  songWindow.clearCache();
  broadcastSlot.clearCache();
  submitRule.clearCache();
  songNotice.clearCache();
}

/* ── 时间与格子 ── */
const WEEK_MS = bj.nextWeekRange().start.getTime();
const WEEK_DATE = bj.ymd(bj.shifted(WEEK_MS));
const S1 = `${WEEK_DATE} 早间 07:20`;
const S2 = `${WEEK_DATE} 午间 12:20`;
const S3 = `${WEEK_DATE} 晚间 17:30`;
/** 播出周的第二天（用于验证「跨时段调剂选次近空位」） */
const S_NEXT_AM = `${bj.ymd(bj.shifted(WEEK_MS + 86400000))} 早间 07:20`;
/** 播出周周一~周五的 5 个日期串（判「落点是否在本周内」用） */
const WEEK_DATES = [0, 1, 2, 3, 4].map((i) => bj.ymd(bj.shifted(WEEK_MS + i * 86400000)));

/** KV 文档 helper */
function kv(obj) {
  return Object.keys(obj).map((k) => ({ _id: `setting:${k}`, key: k, value: String(obj[k]) }));
}

/**
 * 一条形状完整的 submit 文档（字段与 handlers/user/submit.newSubmitDoc 对齐）
 * @param {object} o
 *   id            数字业务主键
 *   want          首选时段值
 *   review/sched  三维里的两维（默认 已通过 + 未排期）
 *   createTime    提交时间（决定落座顺序）
 */
let docSeq = 0;
function doc(o = {}) {
  docSeq += 1;
  const id = o.id === undefined ? docSeq : o.id;
  return {
    _id: o._id || `sub_${id}`,
    id,
    openid: o.openid || `openid_${id}`,
    type: o.type === undefined ? 1 : o.type,
    songName: o.songName || `歌曲${id}`,
    singer: o.singer || `歌手${id}`,
    wishContent: null, articleTitle: null, articleContent: null,
    wantBroadcastTime: o.want === undefined ? S1 : o.want,
    scheduledSlot: o.scheduledSlot || null,
    queueAt: null, promotedAt: null,
    reviewStatus: o.review === undefined ? S.REVIEW.APPROVED : o.review,
    scheduleStatus: o.sched === undefined ? S.SCHEDULE.UNASSIGNED : o.sched,
    playStatus: o.play === undefined ? S.PLAY.NOT_PLAYED : o.play,
    allowReschedule: o.allowReschedule === undefined ? 1 : o.allowReschedule,
    assignedAt: null, playedAt: null,
    status: o.status === undefined ? S.ST.APPROVED_WAIT : o.status,
    rejectReason: null, reviewerId: null, reviewTime: null, autoRejected: 0,
    createTime: o.createTime || new Date(),
    updateTime: new Date(),
  };
}

const subs = () => (H.dump().submit || []);
const logs = () => (H.dump().assignment_log || []);
const weeks = () => (H.dump().weekly_schedule || []);
const byId = (id) => subs().find((r) => Number(r.id) === Number(id));

(async () => {
  /* ══════════════════ A. logAssignment ══════════════════ */
  section('A. logAssignment（排期日志，失败不能影响主流程）');

  reset({ system_setting: kv({ song_slot_capacity: '2' }) });
  await sched.logAssignment(7, null, S1, sched.ASSIGN.INITIAL, sched.ASSIGN_REASON.INITIAL, null);
  eq('写了一条日志', logs().length, 1);
  const lg = logs()[0];
  eq('日志 requestId', lg.requestId, 7);
  eq('日志 fromSlot 首轮为 null', lg.fromSlot, null);
  eq('日志 toSlot', lg.toSlot, S1);
  eq('日志 assignmentType', lg.assignmentType, 'INITIAL');
  eq('日志 reason', lg.reason, 'INITIAL_ALLOCATION');
  eq('日志 operatorId 系统为 null', lg.operatorId, null);
  ok('日志 createTime 是 Date（不是字符串 —— 否则时间条件会静默失效）', lg.createTime instanceof Date, typeof lg.createTime);
  ok('日志写了数字 id（不用业务键当 _id）', Number.isInteger(Number(lg.id)) && Number(lg.id) > 0, lg.id);
  ok('日志 _id 不是 assignment_log 业务键形态', !/^[a-z]+:/.test(String(lg._id)), lg._id);

  await sched.logAssignment(8, S2, S3, sched.ASSIGN.MANUAL, sched.ASSIGN_REASON.manual, 3);
  eq('第二条日志带上 operatorId', logs()[1].operatorId, 3);
  eq('第二条日志 id 递增不撞号', Number(logs()[1].id), Number(logs()[0].id) + 1);
  eq('operatorId 为空串时归一为 null（源写 `|| null`）',
    (await (async () => { await sched.logAssignment(9, null, null, 'X', null, 0); return logs()[2].operatorId; })()), null);

  /* ══════════════════ B. initialAllocate 基本落座 + 容量截断 ══════════════════ */
  section('B. initialAllocate · 落座与容量截断');

  reset({
    system_setting: kv({ song_slot_capacity: '2' }),
    submit: [
      doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 }), doc({ id: 3, want: S1 }),
    ],
  });
  let r = await sched.initialAllocate(WEEK_MS);
  eq('B1 落座 2 条', r.assigned, 2);
  eq('B2 候补 1 条', r.waiting, 1);
  eq('B3 weekId 取数字主键', r.weekId, weeks()[0].id);
  eq('B4 幂等锚点：第 1、2 条 APPROVED', JSON.stringify([byId(1).scheduleStatus, byId(2).scheduleStatus]), JSON.stringify([1, 1]));
  eq('B5 第 3 条 WAITING', byId(3).scheduleStatus, 2);
  eq('B6 落座者写入 scheduledSlot', byId(1).scheduledSlot, S1);
  eq('B7 候补者不写 scheduledSlot', byId(3).scheduledSlot, null);
  ok('B8 落座者写 assignedAt', byId(1).assignedAt instanceof Date);
  eq('B9 派生镜像 status=已排期(1)', byId(1).status, S.ST.SCHEDULED);
  eq('B10 候补派生镜像 status=候补中(3)', byId(3).status, S.ST.QUEUED);
  eq('B11 落座写了两条 assignment_log', logs().length, 2);
  ok('B12 日志全是 INITIAL', logs().every((l) => l.assignmentType === 'INITIAL'));
  eq('B13 日志 toSlot 全是首选格', new Set(logs().map((l) => l.toSlot)).size, 1);

  // 其他时段不受影响（容量是按格算的，不是全局）
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 }), doc({ id: 3, want: S2 })],
  });
  r = await sched.initialAllocate(WEEK_MS);
  eq('B14 容量按格独立：S1 满 1、S2 落 1', r.assigned, 2);
  eq('B15 S1 的第二个进候补', byId(2).scheduleStatus, 2);
  eq('B16 S2 的照样落座', byId(3).scheduleStatus, 1);
  eq('B17 S2 落在自己的格', byId(3).scheduledSlot, S2);

  // 容量 0 = 不限
  reset({
    system_setting: kv({ song_slot_capacity: '0' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 }), doc({ id: 3, want: S1 })],
  });
  r = await sched.initialAllocate(WEEK_MS);
  eq('B18 容量 0 = 不限：全落座', r.assigned, 3);
  eq('B19 容量 0 时候补 0', r.waiting, 0);

  // 没配置容量键（缺行）同样视为不限
  reset({ submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })] });
  r = await sched.initialAllocate(WEEK_MS);
  eq('B20 容量键缺失 = 不限', r.assigned, 2);

  /* ══════════════════ C. 落座顺序 ══════════════════ */
  section('C. initialAllocate · 排序（createTime 升序 + id 兜同秒）');

  const T0 = new Date('2026-01-01T00:00:00Z');
  const T1 = new Date('2026-01-02T00:00:00Z');

  // 提交更早的那个先落座，**即使它的 id 更大**
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 9, want: S1, createTime: T1 }), doc({ id: 5, want: S1, createTime: T0 })],
  });
  await sched.initialAllocate(WEEK_MS);
  eq('C1 提交早的先落座（与 id 大小无关）', byId(5).scheduleStatus, 1);
  eq('C2 提交晚的进候补', byId(9).scheduleStatus, 2);
  eq('C3 日志记的是先落座的人', logs()[0].requestId, 5);

  // 同一时刻（同秒）→ 用 id 兜，保证顺序稳定、不重复不漏
  reset({
    system_setting: kv({ song_slot_capacity: '2' }),
    submit: [
      doc({ id: 30, want: S1, createTime: T0 }),
      doc({ id: 10, want: S1, createTime: T0 }),
      doc({ id: 20, want: S1, createTime: T0 }),
    ],
  });
  await sched.initialAllocate(WEEK_MS);
  eq('C4 同秒按 id 升序：10 落座', byId(10).scheduleStatus, 1);
  eq('C5 同秒按 id 升序：20 落座', byId(20).scheduleStatus, 1);
  eq('C6 同秒按 id 升序：30 候补', byId(30).scheduleStatus, 2);

  /* ══════════════════ D. 幂等 ══════════════════ */
  section('D. initialAllocate · 幂等（重复跑只命中更少行）');

  reset({
    system_setting: kv({ song_slot_capacity: '2' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 }), doc({ id: 3, want: S1 })],
  });
  const r1 = await sched.initialAllocate(WEEK_MS);
  const logsAfterFirst = logs().length;
  const r2 = await sched.initialAllocate(WEEK_MS);
  eq('D1 第一次 assigned=2', r1.assigned, 2);
  eq('D2 第二次 assigned=0', r2.assigned, 0);
  eq('D3 第二次 waiting=0', r2.waiting, 0);
  eq('D4 第二次不新增日志', logs().length, logsAfterFirst);
  eq('D5 状态没被改坏：3 仍是候补', byId(3).scheduleStatus, 2);
  eq('D6 状态没被改坏：1 仍是已排期', byId(1).scheduleStatus, 1);

  /* ══════════════════ E. dryRun 必须真的不写库 ══════════════════ */
  section('E. initialAllocate · dryRun 不写库');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })],
  });
  await sched.ensureWeek(WEEK_MS);            // 先把周行建出来，隔离出「dryRun 不改 submit」
  const before = JSON.stringify(H.dump());
  const dry = await sched.initialAllocate(WEEK_MS, { dryRun: true });
  const after = JSON.stringify(H.dump());
  eq('E1 dryRun 预览出 1 个落座动作', dry.actions.filter((a) => a.action === 'ASSIGN').length, 1);
  eq('E2 dryRun 预览出 1 个候补动作', dry.actions.filter((a) => a.action === 'WAITING').length, 1);
  eq('E3 ★ dryRun 不写库（全库快照一字不差）', after === before, true);
  eq('E4 dryRun 时 submit 仍是未排期', byId(1).scheduleStatus, 0);
  eq('E5 dryRun 不写日志', logs().length, 0);
  ok('E6 dryRun 的 ASSIGN 动作带 cost=0', dry.actions.find((a) => a.action === 'ASSIGN').cost === 0);
  ok('E7 dryRun 的 WAITING 动作 cost=null',
    dry.actions.find((a) => a.action === 'WAITING').cost === null);

  /* ══════════════════ F. 周状态推进 ══════════════════ */
  section('F. initialAllocate · 周状态 → SCHEDULING');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
  });
  await sched.initialAllocate(WEEK_MS);
  eq('F1 有落座 → 周 SCHEDULING', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);
  ok('F2 周行用业务键当 _id', /^week:\d{4}-\d{2}-\d{2}$/.test(String(weeks()[0]._id)), weeks()[0]._id);
  eq('F3 周行同时有数字 id', Number.isInteger(Number(weeks()[0].id)), true);

  // ⚠️ LOCKED 的周不能被排期"复活"
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
    weekly_schedule: [{
      _id: `week:${WEEK_DATE}`, id: 1, weekStartDate: WEEK_DATE,
      applicationStartAt: new Date(WEEK_MS - 86400000 * 8),
      applicationEndAt: new Date(WEEK_MS - 1000),
      reviewStartAt: new Date(WEEK_MS - 1000),
      scheduleLockAt: new Date(WEEK_MS - 1000),
      reviewEndAt: new Date(WEEK_MS - 1000),
      status: sched.WEEK_STATUS.LOCKED, lockPaused: 0, lockedAt: new Date(),
      createTime: new Date(), updateTime: new Date(),
    }],
  });
  await sched.initialAllocate(WEEK_MS);
  eq('F4 ★ LOCKED 周不会被排期改成 SCHEDULING',
    weeks()[0].status, sched.WEEK_STATUS.LOCKED);

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
    weekly_schedule: [{
      _id: `week:${WEEK_DATE}`, id: 1, weekStartDate: WEEK_DATE,
      applicationStartAt: new Date(WEEK_MS - 86400000 * 8),
      applicationEndAt: new Date(WEEK_MS - 1000),
      reviewStartAt: new Date(WEEK_MS - 1000),
      scheduleLockAt: new Date(WEEK_MS - 1000),
      reviewEndAt: new Date(WEEK_MS - 1000),
      status: sched.WEEK_STATUS.CANCELLED, lockPaused: 0,
      createTime: new Date(), updateTime: new Date(),
    }],
  });
  await sched.initialAllocate(WEEK_MS);
  eq('F5 ★ CANCELLED 周不会复活', weeks()[0].status, sched.WEEK_STATUS.CANCELLED);

  /* ══════════════════ G. 只动「该动的」行 ══════════════════ */
  section('G. initialAllocate · 候选筛选边界');

  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [
      doc({ id: 1, want: S1 }),                                              // 命中
      doc({ id: 2, want: S1, review: S.REVIEW.PENDING }),                    // 未审
      doc({ id: 3, want: S1, review: S.REVIEW.REJECTED }),                   // 已驳回
      doc({ id: 4, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }), // 已排期
      doc({ id: 5, want: S1, sched: S.SCHEDULE.WAITING }),                   // 已在候补
      doc({ id: 6, want: null }),                                           // 没填首选时段
      doc({ id: 7, want: S1, type: 2 }),                                     // 非点歌（征文）
    ],
  });
  r = await sched.initialAllocate(WEEK_MS);
  eq('G1 只排 1 条', r.assigned, 1);
  eq('G2 未审的不动', byId(2).scheduleStatus, 0);
  eq('G3 已驳回的不动', byId(3).scheduleStatus, 0);
  eq('G4 已排期的不动（幂等锚点）', byId(4).scheduleStatus, 1);
  eq('G5 已在候补的不动', byId(5).scheduleStatus, 2);
  eq('G6 没填首选的（null）不会被匹配到', byId(6).scheduleStatus, 0);
  eq('G7 非点歌(type=2)的不动', byId(7).scheduleStatus, 0);
  eq('G8 没写多余的日志', logs().length, 1);

  /* ══════════════════ H. reschedule · 闸门（原位递补 vs 跨时段） ══════════════════ */
  section('H. reschedule · canCrossSlot 闸门');

  /** 造一个「周行已存在、且锚点可控」的场景 */
  function weekRow(extra = {}) {
    return {
      _id: `week:${WEEK_DATE}`, id: 100, weekStartDate: WEEK_DATE,
      applicationStartAt: new Date(WEEK_MS - 86400000 * 8),
      applicationEndAt: extra.applicationEndAt === undefined ? new Date(WEEK_MS - 1000) : extra.applicationEndAt,
      reviewStartAt: new Date(WEEK_MS - 1000),
      /**
       * ⚠️ 默认放**过去**（1 小时前）—— `lockWeek` 的判据是 `now >= scheduleLockAt`，
       *    而 `WEEK_MS` 是**下周一**（未来）。若照搬源码里 `WEEK_MS - 1000`，
       *    `lockWeek` 会永远走 `tooEarly` 分支、静默不锁（这条断言就是防这个）。
       *    需要 tooEarly 的用例自己显式传未来的时刻。
       */
      scheduleLockAt: extra.scheduleLockAt === undefined ? new Date(Date.now() - 3600000) : extra.scheduleLockAt,
      reviewEndAt: new Date(Date.now() - 3600000),
      status: extra.status || sched.WEEK_STATUS.SCHEDULING,
      lockPaused: extra.lockPaused === undefined ? 0 : extra.lockPaused,
      lockedAt: extra.lockedAt || null,
      createTime: new Date(), updateTime: new Date(),
    };
  }

  // 点播**未**截止（applicationEndAt 在未来）→ 自动判定不跨时段
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }), // 占住 S1
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING }),                     // 首选 S1 满了
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() + 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS);
  eq('H1 点播未截止 → crossSlot=false', r.crossSlot, false);
  eq('H2 原位递补不到 → 保持 WAITING', byId(2).scheduleStatus, 2);
  eq('H3 不动 scheduledSlot', byId(2).scheduledSlot, null);
  eq('H4 left 计数 1', r.left, 1);
  eq('H5 不写日志', logs().length, 0);

  // 点播**已**截止（applicationEndAt 在过去）→ 自动放开跨时段
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS);
  eq('H6 点播已截止 → crossSlot=true', r.crossSlot, true);
  eq('H7 跨时段调剂 1 条', r.rescheduled, 1);
  eq('H8 被排到别的格（不是首选 S1）', byId(2).scheduleStatus, 1);
  ok('H9 落点不是 S1（S1 已满）', byId(2).scheduledSlot !== S1, byId(2).scheduledSlot);
  ok('H10 落点在本周内', String(byId(2).scheduledSlot).startsWith(WEEK_DATE), byId(2).scheduledSlot);
  eq('H11 日志 assignmentType=RESCHEDULED', logs()[0].assignmentType, 'RESCHEDULED');
  eq('H12 日志 fromSlot=首选格', logs()[0].fromSlot, S1);
  eq('H13 日志 toSlot=落点', logs()[0].toSlot, byId(2).scheduledSlot);

  // 显式 crossSlot:false 覆盖「已截止」的自动判断
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS, { crossSlot: false });
  eq('H14 显式 crossSlot:false 压过自动判定', r.crossSlot, false);
  eq('H15 于是不跨时段 → 仍候补', byId(2).scheduleStatus, 2);

  // 不接受调剂的人永不跨时段
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS, { crossSlot: true });
  eq('H16 allowReschedule=0 → 即使放开跨时段也不动', byId(2).scheduleStatus, 2);
  eq('H17 计入 left', r.left, 1);

  /* ══════════════════ I. reschedule · 原位递补（PROMOTE） ══════════════════ */
  section('I. reschedule · 原位递补');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING }),   // S1 空着 → 应原位递补
    ],
    weekly_schedule: [weekRow()],
  });
  r = await sched.reschedule(WEEK_MS);
  eq('I1 原位递补 1 条', r.promoted, 1);
  eq('I2 调剂 0 条', r.rescheduled, 0);
  eq('I3 落到首选格', byId(1).scheduledSlot, S1);
  eq('I4 状态 APPROVED', byId(1).scheduleStatus, 1);
  eq('I5 日志 assignmentType=PROMOTED', logs()[0].assignmentType, 'PROMOTED');
  eq('I6 日志 fromSlot=toSlot=首选格', JSON.stringify([logs()[0].fromSlot, logs()[0].toSlot]), JSON.stringify([S1, S1]));
  eq('I7 日志 reason=rescheduleOk', logs()[0].reason, S.SYSTEM_REASON.rescheduleOk);

  /* ══════════════════ J. reschedule · 三级排序 ══════════════════ */
  section('J. reschedule · 三级排序（可接受位少 → 提交早 → 离首选近）');

  // J1：可接受位数量少的优先。
  //   ⚠️ 关键在「接受调剂」这一档：`allowReschedule=1` + 跨时段放开时，
  //      可接受位 = **全部空位**（不是 1 个）；`allowReschedule=0` 才是只有首选格。
  //   场景：capacity=1，S2/S3 被占，S1 空。
  //     A(id=1) 不接受调剂 → 可接受 = [S1]      → 1 个
  //     B(id=2) 接受调剂   → 可接受 = 除 S2/S3 外全部 → 13 个
  //   两人都首选 S1 → A 先拿 S1（原位递补），B 只能被调剂到次近的空位。
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0, createTime: new Date('2026-01-09T00:00:00Z') }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, createTime: new Date('2026-01-01T00:00:00Z') }),
      doc({ id: 3, want: S2, sched: S.SCHEDULE.APPROVED, scheduledSlot: S2 }),
      doc({ id: 4, want: S3, sched: S.SCHEDULE.APPROVED, scheduledSlot: S3 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS, { crossSlot: true });
  eq('J1 一条原位递补 + 一条跨时段调剂', JSON.stringify([r.promoted, r.rescheduled]), JSON.stringify([1, 1]));
  eq('J2 ★ 可接受位少的先拿首选格 S1（即使提交更晚）', byId(1).scheduledSlot, S1);
  eq('J3 原位递补者日志 assignmentType=PROMOTED', logs()[0].requestId, 1);
  eq('J4 被调剂者拿不到 S1', (byId(2).scheduledSlot === S1), false);
  eq('J5 被调剂者落到次近空位（次日早间：同天两格已占 → 成本 20）', byId(2).scheduledSlot, S_NEXT_AM);
  ok('J6 被调剂者落点在本周的周一~周五之内',
    WEEK_DATES.includes(String(byId(2).scheduledSlot).slice(0, 10)), byId(2).scheduledSlot);

  // J2：同「可接受位数量」时，提交早的先安排
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING, createTime: new Date('2026-01-09T00:00:00Z') }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, createTime: new Date('2026-01-01T00:00:00Z') }),
      doc({ id: 3, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS, { crossSlot: true });
  eq('J7 ★ 提交早的先被安排（id2 早于 id1）', logs()[0].requestId, 2);

  /* ══════════════════ K. reschedule · 容量收缩 + 并发冲突 ══════════════════ */
  section('K. reschedule · free 收缩 与 并发冲突跳过');

  // free 会随分配收缩：capacity=1、S1 空，两条都首选 S1、都已截止
  // → 第一条原位递补占掉 S1；第二条不能再进 S1（free 已删）
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING, createTime: new Date('2026-01-01T00:00:00Z') }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, createTime: new Date('2026-01-02T00:00:00Z') }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  r = await sched.reschedule(WEEK_MS, { crossSlot: false });
  eq('K1 只有 1 条拿到 S1', r.promoted, 1);
  eq('K2 另一条仍在候补', r.left, 1);
  eq('K3 只能有一个占 S1', subs().filter((x) => x.scheduledSlot === S1).length, 1);
  eq('K4 S1 上占位者数 = capacity', subs().filter((x) => x.scheduledSlot === S1 && x.scheduleStatus === 1).length, 1);

  // 并发冲突：applyChange 影响 0 行 → 跳过，且不写日志、不计数
  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow()],
  });
  // 把库里那条改成「已被别人改过」的状态，但传进 reschedule 的候选仍是快照里的旧值
  const origApply = S.applyChange;
  let calls = 0;
  S.applyChange = async (row, changes, opts) => {
    calls += 1;
    return { row, status: row.status, logs: [], conflict: true };   // 模拟「没抢到」
  };
  r = await sched.reschedule(WEEK_MS);
  S.applyChange = origApply;
  eq('K5 冲突时不计 promoted', r.promoted, 0);
  eq('K6 冲突时不计 rescheduled', r.rescheduled, 0);
  eq('K7 冲突时不写日志', logs().length, 0);
  eq('K8 确实调了 applyChange', calls, 1);

  /* ══════════════════ L. reschedule · dryRun 与空候选 ══════════════════ */
  section('L. reschedule · dryRun / 无候选');

  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [],
    weekly_schedule: [weekRow()],
  });
  r = await sched.reschedule(WEEK_MS);
  eq('L1 无候选 → 全零', JSON.stringify([r.promoted, r.rescheduled, r.left]), JSON.stringify([0, 0, 0]));

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  const beforeR = JSON.stringify(H.dump());
  const dryR = await sched.reschedule(WEEK_MS, { dryRun: true, crossSlot: true });
  const afterR = JSON.stringify(H.dump());
  ok('L2 dryRun 给出动作清单', dryR.actions.length > 0, JSON.stringify(dryR.actions));
  eq('L3 ★ dryRun 不写库', afterR === beforeR, true);
  eq('L4 dryRun 动作名是 RESCHEDULE（跨时段）', dryR.actions[0].action, 'RESCHEDULE');
  ok('L5 dryRun 动作带 cost 数字', typeof dryR.actions[0].cost === 'number', dryR.actions[0].cost);
  eq('L6 dryRun 不写日志', logs().length, 0);
  eq('L7 dryRun 时那条仍是候补', byId(1).scheduleStatus, 2);

  /* ══════════════════ M. runAllocators / afterRelease ══════════════════ */
  section('M. runAllocators / afterRelease（转发壳）');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow()],
  });
  r = await sched.runAllocators(WEEK_MS);
  eq('M1 runAllocators 正常转发', r.promoted, 1);

  // 异常必须被吞掉（否则「下次审核会重试」的兜底就没了）
  // ⚠️ 不能靠传 null 制造异常 —— `weekStartOfRow` 有 nextWeekRange 兜底、ensureWeek 会懒建，
  //    传 null 反而**正常跑通**。所以直接让 applyChange 抛，制造真实的中途失败。
  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow()],
  });
  const origApplyThrow = S.applyChange;
  S.applyChange = async () => { throw new Error('模拟写库失败'); };
  const bad = await sched.runAllocators(WEEK_MS);
  S.applyChange = origApplyThrow;
  eq('M2 ★ runAllocators 吞异常并返回 error 字段', bad.error, '模拟写库失败');
  eq('M3 异常时计数全 0', JSON.stringify([bad.promoted, bad.rescheduled, bad.left]), JSON.stringify([0, 0, 0]));
  ok('M4 异常时结果里没有 actions（与原实现一致，兜底只关心计数）', bad.actions === undefined);
  eq('M5 异常时没有半途写日志', logs().length, 0);

  // afterRelease 用的是**这条记录所属周**
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow()],
  });
  r = await sched.afterRelease(doc({ id: 1, want: S1 }));
  eq('M6 afterRelease 跑的那一周被递补', r.promoted, 1);
  eq('M7 落点仍在该周', byId(1).scheduledSlot, S1);

  // weekStartOfRow 拿不到周 → 安全返回空结果，不抛
  r = await sched.afterRelease({ id: 99, scheduledSlot: null, wantBroadcastTime: null, queueAt: null, createTime: null });
  ok('M8 无周可归属时不抛', r && r.promoted === 0, JSON.stringify(r));

  /* ══════════════════ N. lockWeek ══════════════════ */
  section('N. lockWeek · 装填 / 自动驳回 / already / tooEarly');

  // N1：到点锁定 → 最后调度（跨时段）+ 剩余候补 AUTO_REJECTED + 周 LOCKED
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),  // 已占 S1
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING }),                      // 首选满 → 会被调剂到别处
      doc({ id: 3, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0 }),  // 首选也是满的 S1 + 不接受调剂 → 会被自动驳回
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  let lk = await sched.lockWeek(WEEK_MS);
  eq('N1 锁定成功', lk.already, false);
  eq('N2 周状态 LOCKED', lk.status, sched.WEEK_STATUS.LOCKED);
  eq('N3 ★ 返回体里的周状态也是 LOCKED（内存同步）', weeks()[0].status, sched.WEEK_STATUS.LOCKED);
  eq('N4 lockedAt 已写入', weeks()[0].lockedAt instanceof Date, true);
  eq('N5 lockPaused 清零（恢复自动锁定）', weeks()[0].lockPaused, 0);
  eq('N6 最后调度把人塞进去了（跨时段）', byId(2).scheduleStatus, 1);
  eq('N7 不接受调剂且首选满的 → AUTO_REJECTED', byId(3).scheduleStatus, 3);
  eq('N8 自动驳回写了 autoRejected=1', byId(3).autoRejected, 1);
  eq('N9 自动驳回写了 rejectReason', byId(3).rejectReason, S.SYSTEM_REASON.lockedNoSlot);
  ok('N10 自动驳回写了 reviewTime', byId(3).reviewTime instanceof Date);
  eq('N11 lastAlloc 回传', typeof lk.lastAlloc, 'object');
  eq('N12 rejected 计数', lk.rejected, 1);

  // N2：already 短路 —— 已 LOCKED 的周再锁，不改任何东西
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.LOCKED, lockedAt: new Date('2026-01-01T00:00:00Z') })],
  });
  lk = await sched.lockWeek(WEEK_MS);
  eq('N13 already=true', lk.already, true);
  eq('N14 already 时 rejected=0', lk.rejected, 0);
  eq('N15 ★ already 时不写库（lockedAt 保持原值）',
    +new Date(weeks()[0].lockedAt), +new Date('2026-01-01T00:00:00Z'));
  eq('N16 already 时不排期', byId(1).scheduleStatus, 2);

  // N3：tooEarly —— 未到锁定时刻且没 force
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [{
      ...weekRow(),
      scheduleLockAt: new Date(Date.now() + 86400000),   // 锁定时刻在未来
    }],
  });
  lk = await sched.lockWeek(WEEK_MS);
  eq('N17 tooEarly=true', lk.tooEarly, true);
  eq('N18 tooEarly 时 rejected=0', lk.rejected, 0);
  eq('N19 ★ tooEarly 时不写库（周状态不变）', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);
  eq('N20 tooEarly 时不动点歌', byId(1).scheduleStatus, 2);

  // N4：force 绕过 tooEarly
  lk = await sched.lockWeek(WEEK_MS, { force: true });
  eq('N21 force 绕过时间闸门', lk.already, false);
  eq('N22 force 锁定成功', lk.status, sched.WEEK_STATUS.LOCKED);

  /* ══════════════════ O. unlockWeek ══════════════════ */
  section('O. unlockWeek · 恢复候补 + lockPaused 闸门');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  await sched.lockWeek(WEEK_MS);
  eq('O1 锁定后 id2 被自动驳回', byId(2).scheduleStatus, 3);
  let ul = await sched.unlockWeek(WEEK_MS);
  eq('O2 恢复 1 条', ul.restored, 1);
  eq('O3 周退回 SCHEDULING', ul.status, sched.WEEK_STATUS.SCHEDULING);
  eq('O4 ★ lockedAt 清空', weeks()[0].lockedAt, null);
  eq('O5 ★★ lockPaused=1（拦住 sweep 自动锁回）', weeks()[0].lockPaused, 1);
  eq('O6 返回体 lockPaused=true', ul.lockPaused, true);
  eq('O7 被自动驳回的退回 WAITING', byId(2).scheduleStatus, 2);
  eq('O8 清掉 autoRejected', byId(2).autoRejected, 0);
  eq('O9 清掉 rejectReason', byId(2).rejectReason, null);

  // restore:false → 不恢复
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  await sched.lockWeek(WEEK_MS);
  ul = await sched.unlockWeek(WEEK_MS, { restore: false });
  eq('O10 restore:false 不恢复', ul.restored, 0);
  eq('O11 那条仍停在 AUTO_REJECTED', byId(2).scheduleStatus, 3);
  eq('O12 但 lockPaused 照旧置 1', weeks()[0].lockPaused, 1);

  // 管理员手动动过的「不原封不动」→ 不恢复
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.WAITING, allowReschedule: 0 }),
    ],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  await sched.lockWeek(WEEK_MS);
  // 模拟管理员事后手动改了这条（不再「原封不动」）
  const d = H.dump().submit.find((x) => Number(x.id) === 2);
  d.scheduleStatus = S.SCHEDULE.APPROVED;
  d.scheduledSlot = S3;
  ul = await sched.unlockWeek(WEEK_MS);
  eq('O13 ★ 已被人手动动过的不恢复', ul.restored, 0);
  eq('O14 保持管理员改后的状态', byId(2).scheduleStatus, 1);

  // 没锁定的周 → 抛 40001
  reset({ system_setting: kv({ song_slot_capacity: '1' }), weekly_schedule: [weekRow()] });
  let oErr = null;
  try { await sched.unlockWeek(WEEK_MS); } catch (e) { oErr = e; }
  eq('O15 未锁定的周解锁 → 抛错', oErr !== null, true);
  eq('O16 错误码 40001', oErr && oErr.code, 40001);
  eq('O17 错误文案', oErr && oErr.message, '这一周没有锁定，无需解锁');

  /* ══════════════════ P. cancelWeek ══════════════════ */
  section('P. cancelWeek');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow()],
  });
  let cw = await sched.cancelWeek(WEEK_MS);
  eq('P1 取消后周状态 CANCELLED', cw.status, sched.WEEK_STATUS.CANCELLED);
  eq('P2 ★ 库里也是 CANCELLED（内存同步）', weeks()[0].status, sched.WEEK_STATUS.CANCELLED);
  eq('P3 取消不动点歌', byId(1).scheduleStatus, 2);

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.LOCKED, lockedAt: new Date() })],
  });
  let cErr = null;
  try { await sched.cancelWeek(WEEK_MS); } catch (e) { cErr = e; }
  eq('P4 已锁定的周不能取消', cErr !== null, true);
  eq('P5 错误码 40001', cErr && cErr.code, 40001);
  eq('P6 错误文案', cErr && cErr.message, '这一周已经锁定，不能取消');
  eq('P7 状态未被改动', weeks()[0].status, sched.WEEK_STATUS.LOCKED);

  /* ══════════════════ Q. 解锁后 sweep 不能再锁回（步骤 6 的 sweep 到位后补强） ══════════════════ */
  section('Q. 解锁语义完整性');

  // lockPaused=1 时即便锁定时刻已过，也不该被自动锁回。
  // 这里先直接验证「周行上的闸门标记」确实留下了；真正的 sweep 行为在步骤 6 补测。
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1 })],
    weekly_schedule: [weekRow({ applicationEndAt: new Date(Date.now() - 86400000) })],
  });
  await sched.lockWeek(WEEK_MS);
  await sched.unlockWeek(WEEK_MS);
  eq('Q1 解锁后周行 lockPaused=1', weeks()[0].lockPaused, 1);
  eq('Q2 解锁后周行 SCHEDULING', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);
  eq('Q3 解锁后 revisiting 一次 ensureWeek 不会把 lockPaused 抹掉',
    (await sched.ensureWeek(WEEK_MS)).lockPaused, 1);

  /* ══════════════════ R. markPlayed ══════════════════ */
  section('R. markPlayed · 播出时刻已过的才标记');

  const pastSlot = `${WEEK_DATES[0]} 早间 07:20`;
  const futureSlot = `${WEEK_DATES[4]} 晚间 17:30`;

  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [
      doc({ id: 1, want: pastSlot, sched: S.SCHEDULE.APPROVED, scheduledSlot: pastSlot, status: S.ST.SCHEDULED }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: futureSlot, status: S.ST.SCHEDULED }),
      doc({ id: 3, want: S1, sched: S.SCHEDULE.WAITING, status: S.ST.QUEUED }),
    ],
  });
  // now 设在「播出周周四 12:00」：周一早间已过、周五晚间未到
  const midWeek = bj.shifted(WEEK_MS + 3 * 86400000) - 12 * 3600000;
  let mp = await sched.markPlayed({ now: midWeek });
  eq('R1 只标记已过播出时刻的 1 条', mp.played, 1);
  eq('R2 已过的那条变成已播放', byId(1).playStatus, S.PLAY.PLAYED);
  eq('R3 派生镜像 status=已播放(5)', byId(1).status, S.ST.PLAYED);
  ok('R4 playedAt 是 Date', byId(1).playedAt instanceof Date);
  eq('R5 未来的那条不动', byId(2).playStatus, S.PLAY.NOT_PLAYED);
  eq('R6 候补的不动', byId(3).playStatus, S.PLAY.NOT_PLAYED);
  eq('R7 幂等：再来一次 played=0', (await sched.markPlayed({ now: midWeek })).played, 0);
  eq('R8 ★ 批量 UPDATE 不写状态日志（只有 applyChange 才写）', (H.dump().request_status_log || []).length, 0);
  eq('R9 也不写排期日志', logs().length, 0);

  // scheduledSlot 为 null / 解析不出 → 不参与
  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: null }),
      doc({ id: 2, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: '乱码' }),
    ],
  });
  eq('R10 无有效播出时刻 → 0 条', (await sched.markPlayed({ now: Date.now() })).played, 0);

  /* ══════════════════ S. setPlayed ══════════════════ */
  section('S. setPlayed · 人工置位/取消');

  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1, status: S.ST.SCHEDULED })],
  });
  let sp = await sched.setPlayed(byId(1), true, { operatorId: 7 });
  eq('S1 置为已播放', byId(1).playStatus, S.PLAY.PLAYED);
  eq('S2 镜像 status=5', byId(1).status, S.ST.PLAYED);
  ok('S3 playedAt 写入', byId(1).playedAt instanceof Date);
  eq('S4 写了 1 条状态日志', (H.dump().request_status_log || []).length, 1);
  eq('S5 日志维度是 play', (H.dump().request_status_log || [])[0].dimension, 'play');
  eq('S6 日志操作人=7', (H.dump().request_status_log || [])[0].operatorId, 7);

  sp = await sched.setPlayed(byId(1), false, { operatorId: 7 });
  eq('S7 取消已播放', byId(1).playStatus, S.PLAY.NOT_PLAYED);
  eq('S8 镜像回到 1', byId(1).status, S.ST.SCHEDULED);
  eq('S9 playedAt 清空', byId(1).playedAt, null);

  /* ══════════════════ T. manualAssign ══════════════════ */
  section('T. manualAssign · 人工指派时段');

  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
  });
  let ma = await sched.manualAssign(byId(1), S3, { operatorId: 9 });
  eq('T1 指派后 APPROVED', byId(1).scheduleStatus, 1);
  eq('T2 落到目标格', byId(1).scheduledSlot, S3);
  eq('T3 写了排期日志', logs().length, 1);
  eq('T4 日志类型 MANUAL', logs()[0].assignmentType, 'MANUAL');
  eq('T5 日志 from=null（原来没排）', logs()[0].fromSlot, null);
  eq('T6 日志 to=目标格', logs()[0].toSlot, S3);
  eq('T7 日志操作人', logs()[0].operatorId, 9);
  eq('T8 也写了状态日志', (H.dump().request_status_log || []).length, 1);

  // 从已排期改到另一格 → from 有值
  ma = await sched.manualAssign(byId(1), S2, { operatorId: 9 });
  eq('T9 再改一格', byId(1).scheduledSlot, S2);
  eq('T10 第二条日志 from=S3', logs()[1].fromSlot, S3);

  // 目标不属于任何可选周 → 40001
  // ⚠️ 「非法」只有两种：① 非周一~周五（如周六）② 非系统下发的时段。
  //    别拿「很久以前的某个工作日」当非法样本 —— 时段值是按**周**派生的，
  //    任何 Mon-Fri 都能算出来，那样会静默通过、把这条断言变成假绿。
  reset({ system_setting: kv({ song_slot_capacity: '5' }), submit: [doc({ id: 1, want: S1 })] });
  let tErr = null;
  try { await sched.manualAssign(byId(1), '2020-01-04 早间 07:20', {}); } catch (e) { tErr = e; }
  eq('T11 ✅ 周六（不属于可选播出周）抛错', tErr !== null, true);
  eq('T12 错误码 40001', tErr && tErr.code, 40001);
  eq('T13 错误文案', tErr && tErr.message, '目标时段不属于任何一个可选播出周');
  eq('T14 抛错时不写日志', logs().length, 0);

  let tErr2 = null;
  try { await sched.manualAssign(byId(1), `${WEEK_DATES[0]} 凌晨 03:00`, {}); } catch (e) { tErr2 = e; }
  eq('T15 ✅ 非系统下发的时刻（03:00）也抛错', tErr2 !== null && tErr2.code, 40001);

  // 合法时段仍然能指派（证明上面拦的是「非法」而不是「全都拦」）
  await sched.manualAssign(byId(1), S3, { operatorId: 9 });
  eq('T16 合法时段仍可指派', byId(1).scheduledSlot, S3);

  /* ══════════════════ U. sweep ══════════════════ */
  section('U. sweep · 三分支 + ★★ 独立扫周表');

  // U-a：未到锁定时刻 → 排期 + 调剂，不锁
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })],
    weekly_schedule: [weekRow({ scheduleLockAt: new Date(Date.now() + 86400000) })],
  });
  let swp = await sched.sweep();
  eq('U1 处理了 1 个周', swp.weeks.length, 1);
  eq('U2 未到点 → 只排期不锁', swp.weeks[0].locked === undefined, true);
  eq('U3 落座 1、候补 1', JSON.stringify([swp.weeks[0].assigned, swp.weeks[0].waiting]), JSON.stringify([1, 1]));
  eq('U4 周仍是 SCHEDULING', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);

  // U-b：已到锁定时刻 → 锁定
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
    weekly_schedule: [weekRow()],   // scheduleLockAt = 1 小时前
  });
  swp = await sched.sweep();
  eq('U5 到点 → 锁定', swp.weeks[0].locked, true);
  eq('U6 周状态 LOCKED', weeks()[0].status, sched.WEEK_STATUS.LOCKED);

  // U-c：已解锁（lockPaused=1）→ 到点也不锁，只排期
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })],
    weekly_schedule: [weekRow({ lockPaused: 1 })],
  });
  swp = await sched.sweep();
  eq('U7 ★★ 解锁后 sweep 不再自动锁回', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);
  eq('U8 但仍然补空位', swp.weeks[0].assigned, 1);
  eq('U9 entry.lockPaused 标记', swp.weeks[0].lockPaused, true);
  eq('U10 lockPaused 标记仍在', weeks()[0].lockPaused, 1);

  // U-d：LOCKED / CANCELLED 的周跳过
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.LOCKED, lockedAt: new Date() })],
  });
  swp = await sched.sweep();
  eq('U11 LOCKED 周跳过', swp.weeks[0].skipped, 'LOCKED');
  eq('U12 跳过时不动点歌', byId(1).scheduleStatus, 2);

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.CANCELLED })],
  });
  swp = await sched.sweep();
  eq('U13 CANCELLED 周跳过', swp.weeks[0].skipped, 'CANCELLED');

  /* ── U-e ★★★ 最关键的一条：所有点歌都排好、一条候补不剩的周，也必须被锁上 ── */
  // 这正是源码注释专门警告的那个陷阱：
  //   若只按「还有 UNASSIGNED/WAITING 的周」收集待处理周，这个周根本不会进循环
  //   → 永远锁不上 → play_status 与「排期已定稿」展示全都不对。
  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [
      // 已经全部排好了：没有一条 UNASSIGNED / WAITING
      doc({ id: 1, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1, status: S.ST.SCHEDULED }),
    ],
    weekly_schedule: [weekRow()],   // 到锁定时刻了
  });
  swp = await sched.sweep();
  eq('U14 ★★★ 无候补的周也进循环', swp.weeks.length, 1);
  eq('U15 ★★★ 无候补的周照样被锁上', weeks()[0].status, sched.WEEK_STATUS.LOCKED);
  eq('U16 entry.locked=true', swp.weeks[0].locked, true);

  // U-f：sweep 末尾带 played
  reset({
    system_setting: kv({ song_slot_capacity: '5' }),
    submit: [doc({ id: 1, want: pastSlot, sched: S.SCHEDULE.APPROVED, scheduledSlot: pastSlot, status: S.ST.SCHEDULED })],
    weekly_schedule: [weekRow()],
  });
  swp = await sched.sweep({ now: midWeek });
  eq('U17 sweep 末尾标记已播放', swp.played, 1);
  eq('U18 那条确实变已播放', byId(1).playStatus, S.PLAY.PLAYED);

  // U-g：sweep 幂等（连跑两次第二次没有新变化）
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })],
    weekly_schedule: [weekRow({ scheduleLockAt: new Date(Date.now() + 86400000) })],
  });
  const s1st = await sched.sweep();
  const s2nd = await sched.sweep();
  eq('U19 sweep 第一次落座 1', s1st.weeks[0].assigned, 1);
  eq('U20 sweep 第二次幂等：不再落座', s2nd.weeks[0].assigned, 0);
  eq('U21 sweep 第二次不再调剂', s2nd.weeks[0].promoted, 0);

  /* ══════════════════ V. 端到端：用户端入口边界（重要结论） ══════════════════ */
  section('V. 用户端到排期算法的「入口边界」');

  /**
   * ⚠️⚠️ **重要结论（订正了阶段 5 方案里的一个假设）**
   *
   * 用户端 `cancel` 的可撤销判定是：
   *     revocable = review===PENDING || (review===APPROVED && schedule===WAITING)
   * 而 `cancelRequest` 里触发 `afterRelease` 的条件是 `isSeated()`
   * （= review APPROVED **且** schedule APPROVED）。
   *
   * 两者**互斥** —— 也就是说 **`if (wasSeated)` 这条分支在学生端永远不可达**，
   * 阶段 5 的排期算法在**用户端一个入口都没有**，真实入口全在管理端（阶段 7）。
   *
   * 所以这条链路**不能在云端用用户端接口验收**：本地 harness 全绿 + 产物自证
   * 是阶段 5 当下能拿到的最强证据，云端真跑要等阶段 7 的管理端接口接上。
   * （原文写「user 侧唯一入口是 cancel」是错的，已订正到 docs 与记忆里。）
   */
  const USER = '20240101';
  const OTHERU = '20240202';
  const TOKEN = sign({ openid: USER, uid: 1, username: USER, pv: 0 });
  const ACCOUNT = { _id: 'u1', id: 1, openid: null, username: USER, status: 1, pwdChangedAt: null };

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    user: [ACCOUNT],
    submit: [
      // 已排期、属于本人 → **学生无权取消**
      doc({ id: 1, openid: USER, want: S1, sched: S.SCHEDULE.APPROVED, scheduledSlot: S1, status: S.ST.SCHEDULED }),
      // 候补中、属于本人 → 走「放弃候补」
      doc({ id: 2, openid: USER, want: S1, sched: S.SCHEDULE.WAITING, status: S.ST.QUEUED }),
      // 别人占着 S2，用来观察「没人释放时不该被动」
      doc({ id: 3, openid: OTHERU, want: S2, sched: S.SCHEDULE.APPROVED, scheduledSlot: S2, status: S.ST.SCHEDULED }),
    ],
    weekly_schedule: [weekRow()],
  });

  // ① 学生取消「已排期」的歌 → 40301（座位不可自行释放）
  let vr = await H.call(H.req('DELETE', '/user/submit/1', {}, TOKEN));
  eq('V1 学生取消已排期的歌 → 40301', vr.code, 40301);
  eq('V2 那条没被动过', byId(1).scheduleStatus, S.SCHEDULE.APPROVED);
  eq('V3 没触发任何排期动作（无日志）', logs().length, 0);

  // ② 学生「放弃候补」→ 成功，且因为本来就没占座，不触发 afterRelease
  vr = await H.call(H.req('POST', '/user/submit/2/leave-queue', {}, TOKEN));
  eq('V4 放弃候补成功', vr.code, 0);
  eq('V5 那条进入 CANCELLED', byId(2).reviewStatus, S.REVIEW.CANCELLED);
  eq('V6 派生镜像 status=已取消(7)', byId(2).status, S.ST.CANCELLED);
  eq('V7 ★ 未占座 → 不触发递补（这正是用户端到不了排期算法的证据）', logs().length, 0);
  eq('V8 别人的座位纹丝不动', byId(3).scheduledSlot, S2);

  // ③ 未登录 → 40101（路由层挂了 userAuth）
  eq('V9 未登录取消 → 40101', (await H.call(H.req('DELETE', '/user/submit/1'))).code, 40101);
  eq('V10 未登录放弃候补 → 40101', (await H.call(H.req('POST', '/user/submit/2/leave-queue'))).code, 40101);

  /* ══════════════════ W. 定时闸门 hasPendingWork / sweepTick（阶段 6） ══════════════════ */
  /**
   * 阶段 6 把「进程内 60s setInterval」换成「平台定时触发器 + 廉价闸门」。
   * 这里钉死两件事：
   *   ① **不许漏**：闸门说没活时，`sweep()` 必须一条都不碰（否则定时任务会悄悄丢活）。
   *   ② **不许白跑**：真没活时 `hasPendingWork` 必须返回 false（否则空转烧额度）。
   * 两端都要断言 —— 只测一端会让「保守超集」退化成恒 true（等于没加闸门）。
   */
  section('W. 定时闸门 hasPendingWork / sweepTick');

  eq('W0-1 hasPendingWork 已导出', typeof sched.hasPendingWork, 'function');
  eq('W0-2 sweepTick 已导出', typeof sched.sweepTick, 'function');

  const NOW = Date.now();
  const TODAY = bj.ymd(bj.shifted(NOW));
  const TOMORROW = bj.ymd(bj.shifted(NOW + 86400000));
  const YESTERDAY = bj.ymd(bj.shifted(NOW - 86400000));

  /** 「闸门关闭 ⇒ sweep 必须无动作」—— 阶段 6 的核心安全断言 */
  async function gateIsSafe(label, seed, now = NOW) {
    reset(seed);
    const pending = await sched.hasPendingWork(now);
    if (pending) {
      lines.push(`OK  ${label} :: 闸门放行（保守超集，允许多跑）`);
      return;
    }
    const swp = await sched.sweep({ now });
    const touched = swp.weeks.length > 0 || swp.played > 0;
    ok(`${label} :: 闸门关闭 ⇒ sweep 必须无动作`, !touched,
      `weeks=${swp.weeks.length} played=${swp.played}`);
  }

  const CAP = kv({ song_slot_capacity: '5' });

  // ── W1 三类都是 0 → 闸门关闭 ──
  reset({ system_setting: CAP });
  eq('W1a 完全空库 → 闸门关闭', await sched.hasPendingWork(NOW), false);
  await gateIsSafe('W1b 完全空库', { system_setting: CAP });

  // ── W2 只剩「余波」：周已锁定 + 歌已播放 → 也要关闭（否则永远空转） ──
  const LOCKED_SEED = {
    system_setting: CAP,
    submit: [doc({ id: 1, want: pastSlot, sched: S.SCHEDULE.APPROVED, scheduledSlot: pastSlot, play: S.PLAY.PLAYED, status: S.ST.PLAYED })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.LOCKED })],
  };
  reset(LOCKED_SEED);
  eq('W2a 周已锁 + 歌已播放 → 闸门关闭', await sched.hasPendingWork(NOW), false);
  await gateIsSafe('W2b 只剩余波', LOCKED_SEED);

  // ── W3 ① 开放周 ──
  reset({ system_setting: CAP, weekly_schedule: [weekRow()] });
  eq('W3a 有开放周 → 命中', await sched.hasPendingWork(NOW), true);
  reset({ system_setting: CAP, weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.CANCELLED })] });
  eq('W3b 周已取消 → 不命中', await sched.hasPendingWork(NOW), false);
  await gateIsSafe('W3c 只有已取消的周', { system_setting: CAP, weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.CANCELLED })] });

  // ── W4 ② 还没排上的点歌（⚠️ 不按 type 过滤） ──
  reset({ system_setting: CAP, submit: [doc({ id: 1, want: S1 })] });
  eq('W4a 未排期的点歌 → 命中', await sched.hasPendingWork(NOW), true);
  reset({ system_setting: CAP, submit: [doc({ id: 1, want: S1, sched: S.SCHEDULE.WAITING, status: S.ST.QUEUED })] });
  eq('W4b 候补中的点歌 → 命中', await sched.hasPendingWork(NOW), true);
  // 征文（type=2）默认也是 UNASSIGNED —— 若闸门写死 type:1，这类周会被漏掉
  reset({ system_setting: CAP, submit: [doc({ id: 1, type: 2, want: S1 })] });
  eq('W4c ★ type=2 的未排期也命中（闸门不能只查 type:1）', await sched.hasPendingWork(NOW), true);

  // ── W5 ③ 「播出日期已到、还没标记播放」 ──
  /**
   * ⚠️⚠️ **反例钉死（阶段 6 修掉的一个静默漂移）**
   *
   * 旧写法：`scheduledSlot: _.lte('<今天> 23:59')` —— 想表达「日期 ≤ 今天」。
   * 但串是 `YYYY-MM-DD 中文时段名 时刻`，同一天的串前 11 位全同，
   * 第 11 位开始比「中文名 vs 数字」：`'早'`(U+65E9) > `'2'`(0x32)，
   * 于是**当天**的串被判为「不小于今天末」→ 当天的歌被当成「没活」→
   * **要等第二天才被标记已播放**（原 Express 是 60s tick、播完即标）。
   *
   * 正确写法：`_.lt('<明天>')`（日期定长零填充 → 时间序 == 字典序）。
   * 下面这一条先把「旧写法为什么错」钉成可执行断言，再验闸门行为。
   */
  ok('W5-0 ★ 反例钉死：中文时段名的串在字典序上大于数字',
    !(`${TODAY} 早间 07:20` <= `${TODAY} 23:59`),
    `'${TODAY} 早间 07:20' <= '${TODAY} 23:59' 为 false ⇒ 旧写法必然漏掉「当天」`);

  const TODAY_SLOT = `${TODAY} 早间 07:20`;
  const TODAY_SEED = {
    system_setting: CAP,
    submit: [doc({ id: 1, want: TODAY_SLOT, sched: S.SCHEDULE.APPROVED, scheduledSlot: TODAY_SLOT, status: S.ST.SCHEDULED })],
  };
  reset(TODAY_SEED);
  eq('W5a ★★★ 今天播出、未标记播放 → 必须命中', await sched.hasPendingWork(NOW), true);

  const YESTERDAY_SLOT = `${YESTERDAY} 早间 07:20`;
  reset({ system_setting: CAP, submit: [doc({ id: 1, want: YESTERDAY_SLOT, sched: S.SCHEDULE.APPROVED, scheduledSlot: YESTERDAY_SLOT, status: S.ST.SCHEDULED })] });
  eq('W5b 昨天播出、未标记播放 → 命中', await sched.hasPendingWork(NOW), true);

  const TOMORROW_SLOT = `${TOMORROW} 早间 07:20`;
  const TOMORROW_SEED = {
    system_setting: CAP,
    submit: [doc({ id: 1, want: TOMORROW_SLOT, sched: S.SCHEDULE.APPROVED, scheduledSlot: TOMORROW_SLOT, status: S.ST.SCHEDULED })],
  };
  reset(TOMORROW_SEED);
  eq('W5c 明天播出 → 不命中（还没到）', await sched.hasPendingWork(NOW), false);
  await gateIsSafe('W5d 只有明天的歌', TOMORROW_SEED);

  // 已播放的当日歌 → 与 ③ 无关（playStatus 已 PLAYED）→ 关
  reset({ system_setting: CAP, submit: [doc({ id: 1, want: TODAY_SLOT, sched: S.SCHEDULE.APPROVED, scheduledSlot: TODAY_SLOT, play: S.PLAY.PLAYED, status: S.ST.PLAYED })] });
  eq('W5e 当天但已标记播放 → 不命中', await sched.hasPendingWork(NOW), false);

  // ── W6 sweepTick：空转短路 ──
  reset({ system_setting: CAP });
  const tk1 = await sched.sweepTick({ now: NOW });
  eq('W6a 空转 skipped=true', tk1.skipped, true);
  eq('W6b reason=NO_PENDING_WORK', tk1.reason, 'NO_PENDING_WORK');
  eq('W6c weeks=0', tk1.weeks, 0);
  eq('W6d played=0', tk1.played, 0);
  ok('W6e 短路时不带 detail（证明真的没跑 sweep）', tk1.detail === undefined);

  // ── W7 sweepTick：有活 → 真跑 ──
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 }), doc({ id: 2, want: S1 })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.APPLICATION, scheduleLockAt: new Date(NOW + 86400000) })],
  });
  const tk2 = await sched.sweepTick({ now: NOW });
  eq('W7a skipped=false', tk2.skipped, false);
  eq('W7b 涉及 1 个周', tk2.weeks, 1);
  eq('W7c 真排上 1 条（容量截断）', tk2.detail.weeks[0].assigned, 1);
  eq('W7d 周状态推进到 SCHEDULING', weeks()[0].status, sched.WEEK_STATUS.SCHEDULING);

  // ── W8 sweepTick：异常必须被吞掉（抛出去会记成函数执行失败） ──
  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.APPLICATION, scheduleLockAt: new Date(NOW + 86400000) })],
  });
  const origApplyW = S.applyChange;
  S.applyChange = async () => { throw new Error('boom'); };
  const tk3 = await sched.sweepTick({ now: NOW });
  S.applyChange = origApplyW;
  eq('W8a 异常被吞、函数正常返回', tk3.error, 'boom');
  eq('W8b skipped=false（不是短路）', tk3.skipped, false);
  eq('W8c 异常时 played=0', tk3.played, 0);
  eq('W8d 抛错的那条没被改', byId(1).scheduleStatus, S.SCHEDULE.UNASSIGNED);

  // ── W9 端到端：定时事件真的能走通 index.js（不是只调 service） ──
  const TIMER = { Type: 'Timer', TriggerName: 'songSweepTick', TriggerTime: new Date(NOW).toISOString() };

  reset({ system_setting: CAP });
  let tr = await H.call(TIMER);
  eq('W9a 定时事件返回 code=0', tr.code, 0);
  eq('W9b 带 cron 标记', tr.data.cron, true);
  eq('W9c 空库 → 短路', tr.data.skipped, true);
  eq('W9d 短路原因', tr.data.reason, 'NO_PENDING_WORK');

  reset({
    system_setting: kv({ song_slot_capacity: '1' }),
    submit: [doc({ id: 1, want: S1 })],
    weekly_schedule: [weekRow({ status: sched.WEEK_STATUS.APPLICATION, scheduleLockAt: new Date(NOW + 86400000) })],
  });
  tr = await H.call(TIMER);
  eq('W9e 有活 → code=0', tr.code, 0);
  eq('W9f 有活 → skipped=false', tr.data.skipped, false);
  eq('W9g 有活 → weeks=1', tr.data.weeks, 1);
  ok('W9h 定时事件不会掉进路由（没有「接口不存在」）', tr.message !== '接口不存在', `message=${tr.message}`);

  /* ══════════════════ 汇总 ══════════════════ */
  console.log(lines.join('\n'));
  const total = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  console.log(`\n结论：${total} 行 / 失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 2);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
