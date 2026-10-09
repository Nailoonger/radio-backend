'use strict';

/**
 * 管理端本地实测 · 点歌 30 条接口（阶段 7 的核心）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-admin-submit.js
 *
 * ⚠️⚠️ 这份脚本是**阶段 5 排期算法第一次被真实调用**。
 *    用户端零入口（提交不判容量、不落座），所以 `services/scheduling.js` 的
 *    `initialAllocate / reschedule / lockWeek / unlockWeek / manualAssign /
 *     setPlayed / sweep` 在阶段 5/6 只有单测级别的覆盖 —— 真正「管理员点一下按钮、
 *    算法跑起来、数据被改写」的整链路验证落在**这里**。
 *
 * 断言围绕几条最容易悄悄错掉的口径展开：
 *  · `list` 的**先提交先审**顺序（createTime ASC, id ASC）与同秒 id 兜底
 *  · `schedule` 矩阵里「待审 / 候补 / 已占」三路计数互不串味
 *  · `reschedule` 的 **canCrossSlot 闸门**：点播截止前只做原位递补、绝不跨时段
 *  · `lockWeek` 的自动驳回 + `unlockWeek` 的恢复 + `lockPaused` 必须置 1
 *  · `assertWeekOpen`：已锁定的周一律不许人工改动
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
const ruleSvc = require(path.join(API_DIR, 'services', 'submitRule'));
const noticeSvc = require(path.join(API_DIR, 'services', 'songNotice'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));

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

/** 目标播出周（下周一 00:00）与它的日期串 —— 全部时段值都由它派生 */
const WEEK_MS = bj.nextWeekRange(Date.now()).start.getTime();
const DATE0 = bj.ymd(bj.shifted(WEEK_MS));
const DATE1 = bj.ymd(bj.shifted(WEEK_MS + bj.DAY_MS));
const DATE2 = bj.ymd(bj.shifted(WEEK_MS + 2 * bj.DAY_MS));

function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  slotSvc.clearCache();
  winSvc.clearCache();
  ruleSvc.clearCache();
  noticeSvc.clearCache();
}

/**
 * 周行（weekly_schedule）—— `status: 'SCHEDULING'` 属于 **ANCHOR_FROZEN_STATUS**，
 * `refreshAnchors()` 不会再拿 KV 去覆盖它，于是 `applicationEndAt` / `scheduleLockAt`
 * 完全由测试掌控（否则「点播是否已截止」会随当天是周几而变，用例就不确定了）。
 */
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
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, createTime: new Date(), updateTime: new Date() },
      { _id: 'ad2', id: 2, username: 'reviewer', password: HASH, nickname: '审核员', role: 1, status: 1, createTime: new Date(), updateTime: new Date() },
    ],
    user: [
      { _id: 'us1', id: 1, openid: 'op1', username: '20240101', nickname: '小明', remark: '小明', avatar: 'a1.png', grade: 5, classNo: 2, seatNo: 7, status: 1, lastLoginAt: null, loginCount: 3, createTime: new Date() },
      { _id: 'us2', id: 2, openid: 'op2', username: '20240102', nickname: '小红', remark: '小红', avatar: '', grade: 5, classNo: 3, seatNo: 1, status: 1, lastLoginAt: null, loginCount: 0, createTime: new Date() },
    ],
    weekly_schedule: [weekRow(weekOpts)],
  };
  return Object.assign(s, extra || {});
}

/** 造一条投稿（status 由三维派生，保证镜像一致） */
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
    songName: opt.songName === undefined ? '晴天' : opt.songName,
    singer: opt.singer === undefined ? '周杰伦' : opt.singer,
    wishContent: opt.wishContent === undefined ? null : opt.wishContent,
    articleTitle: opt.articleTitle === undefined ? null : opt.articleTitle,
    articleContent: opt.articleContent === undefined ? null : opt.articleContent,
    wantBroadcastTime: opt.want === undefined ? null : opt.want,
    scheduledSlot: opt.slot === undefined ? null : opt.slot,
    queueAt: null,
    promotedAt: null,
    reviewStatus: review,
    scheduleStatus: schedule,
    playStatus: play,
    allowReschedule: opt.allow === undefined ? 1 : opt.allow,
    assignedAt: opt.assignedAt === undefined ? null : opt.assignedAt,
    playedAt: opt.playedAt === undefined ? null : opt.playedAt,
    status: opt.status === undefined ? S.deriveStatus(review, schedule, play) : opt.status,
    rejectReason: opt.rejectReason === undefined ? null : opt.rejectReason,
    reviewerId: opt.reviewerId === undefined ? null : opt.reviewerId,
    reviewTime: opt.reviewTime === undefined ? null : opt.reviewTime,
    autoRejected: opt.autoRejected || 0,
    createTime: opt.createTime || new Date(),
    updateTime: new Date(),
  };
}

/** 取某行（按 id） */
function byId(id) {
  return (H.dump().submit || []).find((x) => Number(x.id) === Number(id));
}

(async () => {
  /* ══════════════════ A. list：排序 / 过滤 / 富化 / 候补位次 ══════════════════ */
  section('A. GET /admin/submit/list');
  reset(baseSeed({
    submit: [
      // 同秒两条 → 必须靠 id 兜住顺序
      mkSubmit(1, { createTime: new Date('2026-09-01T10:00:00+08:00'), songName: 'Alpha', want: `${DATE0} 早间 07:20`, review: S.REVIEW.APPROVED }),
      mkSubmit(2, { createTime: new Date('2026-09-01T10:00:00+08:00'), songName: 'beta', singer: 'Li', openid: 'op2', want: `${DATE0} 早间 07:20`, review: S.REVIEW.APPROVED }),
      mkSubmit(3, { createTime: new Date('2026-09-02T10:00:00+08:00'), songName: 'GAMMA', type: 2, articleTitle: '散文一篇' }),
      mkSubmit(4, { createTime: new Date('2026-09-03T10:00:00+08:00'), songName: 'Delta', review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE1} 午间 12:20`, reviewerId: 2, reviewTime: new Date('2026-09-03T11:00:00+08:00') }),
      mkSubmit(5, { createTime: new Date('2026-09-04T10:00:00+08:00'), songName: 'Echo', review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: `${DATE0} 早间 07:20` }),
      mkSubmit(6, { createTime: new Date('2026-09-05T10:00:00+08:00'), songName: 'Foxtrot', review: S.REVIEW.REJECTED, rejectReason: '重复', reviewerId: 2, autoRejected: 1 }),
      mkSubmit(7, { createTime: new Date('2026-09-06T10:00:00+08:00'), songName: 'Golf', want: `${DATE0} 早间 07:20` }),
    ],
  }));

  let r = await H.call(H.req('GET', '/admin/submit/list', {}, PLAIN_TOKEN));
  eq('普管可读列表', r.code, 0);
  eq('**先提交先审**：createTime ASC, id ASC（同秒靠 id 兜）',
    r.data.list.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7]);
  eq('默认 pageSize=10 / page=1', [r.data.page, r.data.pageSize, r.data.total], [1, 10, 7]);

  const row1 = r.data.list[0];
  eq('三维 + 名称 + 派生 status 一次给全',
    [row1.reviewStatus, row1.reviewStatusName, row1.scheduleStatus, row1.scheduleStatusName, row1.playStatus, row1.playStatusName, row1.status, row1.statusText],
    [1, 'APPROVED', 0, 'UNASSIGNED', 0, 'NOT_PLAYED', 6, '已通过 · 待排期']);
  eq('富化昵称/学号/头像（openid → user 表）', [row1.nickname, row1.studentNo, row1.avatar], ['小明', '20240101', 'a1.png']);
  eq('未审核（reviewStatus=0）→ reviewerName 为空串', r.data.list[6].reviewerName, '');
  eq('已审核但查不到审核人 → 占位「—」', row1.reviewerName, '—');
  eq('autoRejected → reviewerName 显示「系统自动驳回」', r.data.list[5].reviewerName, '系统自动驳回');
  eq('已审核 → reviewerName 取 nickname', r.data.list[3].reviewerName, '审核员');
  eq('autoRejected 归一成布尔', [row1.autoRejected, r.data.list[5].autoRejected], [false, true]);

  const waiting = r.data.list.find((x) => x.id === 5);
  eq('候补行补位次', [waiting.queuePos, waiting.queueAhead, waiting.queueTotal], [1, 0, 1]);

  r = await H.call(H.req('GET', '/admin/submit/list', { status: '6' }, PLAIN_TOKEN));
  eq('status=6（已通过·待排期）过滤', r.data.list.map((x) => x.id), [1, 2]);
  r = await H.call(H.req('GET', '/admin/submit/list', { type: '2' }, PLAIN_TOKEN));
  eq('type=2 文稿过滤', r.data.list.map((x) => x.id), [3]);
  r = await H.call(H.req('GET', '/admin/submit/list', { reviewStatus: '2' }, PLAIN_TOKEN));
  eq('reviewStatus 直接按维度筛', r.data.list.map((x) => x.id), [6]);
  r = await H.call(H.req('GET', '/admin/submit/list', { scheduleStatus: '2' }, PLAIN_TOKEN));
  eq('scheduleStatus=2（候补）', r.data.list.map((x) => x.id), [5]);
  r = await H.call(H.req('GET', '/admin/submit/list', { scheduleStatus: '0' }, PLAIN_TOKEN));
  eq('scheduleStatus=0（未排期）', r.data.list.map((x) => x.id), [1, 2, 3, 6, 7]);

  r = await H.call(H.req('GET', '/admin/submit/list', { slot: `${DATE1} 午间 12:20` }, PLAIN_TOKEN));
  eq('slot 过滤命中**实排**时段', r.data.list.map((x) => x.id), [4]);
  r = await H.call(H.req('GET', '/admin/submit/list', { slot: `${DATE0} 早间 07:20` }, PLAIN_TOKEN));
  eq('slot 过滤命中**首选**时段', r.data.list.map((x) => x.id), [1, 2, 5, 7]);

  r = await H.call(H.req('GET', '/admin/submit/list', { keyword: 'alpha' }, PLAIN_TOKEN));
  eq('keyword 命中 songName 且**大小写不敏感**', r.data.list.map((x) => x.id), [1]);
  r = await H.call(H.req('GET', '/admin/submit/list', { keyword: 'li' }, PLAIN_TOKEN));
  eq('keyword 命中的是**子串**（singer=Li 用 "li" 也能中）', r.data.list.map((x) => x.id), [2]);
  r = await H.call(H.req('GET', '/admin/submit/list', { keyword: '散文' }, PLAIN_TOKEN));
  eq('keyword 命中 articleTitle', r.data.list.map((x) => x.id), [3]);
  r = await H.call(H.req('GET', '/admin/submit/list', { keyword: 'gamma' }, PLAIN_TOKEN));
  eq('keyword + 多键排序仍然生效', r.data.total, 1);

  r = await H.call(H.req('GET', '/admin/submit/list', { page: '2', pageSize: '2' }, PLAIN_TOKEN));
  eq('分页切片', [r.data.list.map((x) => x.id), r.data.page, r.data.pageSize, r.data.total], [[3, 4], 2, 2, 7]);
  r = await H.call(H.req('GET', '/admin/submit/list', { pageSize: '9999' }, PLAIN_TOKEN));
  eq('pageSize 上限被收敛到 200', r.data.pageSize, 200);
  r = await H.call(H.req('GET', '/admin/submit/list', { page: 'abc', pageSize: 'x' }, PLAIN_TOKEN));
  eq('非法分页参数退回默认（不把 NaN 透出去）', [r.data.page, r.data.pageSize], [1, 10]);

  /* ══════════════════ B. detail ══════════════════ */
  section('B. GET /admin/submit/:id');
  reset(baseSeed({
    submit: [
      mkSubmit(10, { createTime: new Date('2026-09-01T10:00:00+08:00'), review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, reviewerId: 2, reviewTime: new Date('2026-09-01T12:00:00+08:00') }),
      mkSubmit(11, { createTime: new Date('2026-09-05T10:00:00+08:00'), review: S.REVIEW.REJECTED }),
      mkSubmit(12, { createTime: new Date('2026-09-03T10:00:00+08:00') }),
    ],
    assignment_log: [
      { _id: 'al1', id: 1, requestId: 10, fromSlot: null, toSlot: `${DATE0} 早间 07:20`, type: 'INITIAL', reason: 'INITIAL_ALLOCATION', operatorId: 1, createTime: new Date() },
    ],
    request_status_log: [
      { _id: 'rs1', id: 1, requestId: 10, operatorId: 1, operatorName: 'ADMIN', dimension: 'review', fromStatus: 'PENDING_REVIEW', toStatus: 'APPROVED', reason: 'REVIEW_APPROVED', createTime: new Date() },
    ],
  }));

  r = await H.call(H.req('GET', '/admin/submit/10', {}, PLAIN_TOKEN));
  eq('detail → code 0', r.code, 0);
  eq('提交人画像：昵称/学号/班级', [r.data.nickname, r.data.studentNo, r.data.submitter.className], ['小明', '20240101', '5 级 2 班']);
  eq('提交人画像：isAccount / grade / classNo / seatNo', [r.data.submitter.isAccount, r.data.submitter.grade, r.data.submitter.classNo, r.data.submitter.seatNo], [true, 5, 2, 7]);
  eq('提交人统计：total/approved/rejected/pending', [r.data.submitter.total, r.data.submitter.approved, r.data.submitter.rejected, r.data.submitter.pending], [3, 1, 1, 1]);
  ok('firstAt/lastAt 由 MIN/MAX 等价查询得出',
    r.data.submitter.firstAt instanceof Date && r.data.submitter.lastAt instanceof Date
    && +new Date(r.data.submitter.firstAt) < +new Date(r.data.submitter.lastAt),
    `${r.data.submitter.firstAt} → ${r.data.submitter.lastAt}`);
  eq('reviewerName', r.data.reviewerName, '审核员');
  eq('statusHistory 已被回读', r.data.statusHistory.length, 1);
  eq('assignments 已被回读', r.data.assignments.map((x) => x.id), [1]);
  ok('card 已生成（type=1）', r.data.card !== null && r.data.card !== undefined);

  r = await H.call(H.req('GET', '/admin/submit/999999', {}, PLAIN_TOKEN));
  eq('不存在 → 40401', [r.code, r.message], [40401, '投稿不存在']);
  r = await H.call(H.req('GET', '/admin/submit/abc', {}, PLAIN_TOKEN));
  eq('非法 id → 40401（不把 NaN 塞进查询）', r.code, 40401);

  /* ══════════════════ C. approve（含「通过即落座」） ══════════════════ */
  section('C. PUT /admin/submit/:id/approve');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { want: `${DATE0} 早间 07:20` }),
      mkSubmit(3, { review: S.REVIEW.REJECTED }),
      mkSubmit(4, { review: S.REVIEW.CANCELLED }),
      mkSubmit(5, { review: S.REVIEW.APPROVED }),
    ],
  }));

  r = await H.call(H.req('PUT', '/admin/submit/1/approve', {}, PLAIN_TOKEN));
  eq('通过 → code 0', r.code, 0);
  eq('review 维度已置 APPROVED', [r.data.reviewStatus, r.data.reviewStatusName], [1, 'APPROVED']);
  eq('通过后**立刻跑排期**→ 容量不限时直接落座',
    [r.data.scheduleStatus, r.data.scheduleStatusName, r.data.scheduledSlot], [1, 'APPROVED', `${DATE0} 早间 07:20`]);
  eq('派生镜像 status = 1（已排期）', r.data.status, 1);
  eq('reviewerId / rejectReason / autoRejected', [byId(1).reviewerId, byId(1).rejectReason, byId(1).autoRejected], [2, null, 0]);
  ok('reviewTime 已写入', byId(1).reviewTime instanceof Date);

  r = await H.call(H.req('PUT', '/admin/submit/5/approve', {}, PLAIN_TOKEN));
  eq('已是通过状态 → 幂等不报错', r.code, 0);
  eq('幂等时不重复落状态日志', (H.dump().request_status_log || []).filter((x) => x.requestId === 5).length, 0);

  r = await H.call(H.req('PUT', '/admin/submit/3/approve', {}, PLAIN_TOKEN));
  eq('已驳回 → 40001（不能静默通过）', [r.code, r.message], [40001, '这条已驳回，请先撤销再通过']);
  r = await H.call(H.req('PUT', '/admin/submit/4/approve', {}, PLAIN_TOKEN));
  eq('已取消 → 40001', [r.code, r.message], [40001, '这条已被取消，不能通过']);
  eq('审不存在 → 40401', (await H.call(H.req('PUT', '/admin/submit/999/approve', {}, PLAIN_TOKEN))).code, 40401);
  eq('普管即可通过（不需要超管）', (await H.call(H.req('PUT', '/admin/submit/2/approve', {}, PLAIN_TOKEN))).code, 0);

  /* ══════════════════ D. reject / revoke ══════════════════ */
  section('D. reject / revoke');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: `${DATE0} 早间 07:20` }),
      mkSubmit(3, { review: S.REVIEW.REJECTED, rejectReason: '旧理由' }),
      mkSubmit(4, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 午间 12:20` }),
    ],
  }));

  r = await H.call(H.req('PUT', '/admin/submit/1/reject', {}, PLAIN_TOKEN));
  eq('缺理由 → 40001', [r.code, r.message], [40001, '请填写驳回理由']);
  r = await H.call(H.req('PUT', '/admin/submit/1/reject', { reason: '   ' }, PLAIN_TOKEN));
  eq('纯空白理由 → 40001', r.code, 40001);

  r = await H.call(H.req('PUT', '/admin/submit/1/reject', { reason: '音质太差' }, PLAIN_TOKEN));
  eq('驳回成功', r.code, 0);
  eq('review 置 REJECTED + 理由', [r.data.reviewStatus, r.data.rejectReason], [2, '音质太差']);
  eq('schedule 维度**保留原值**（回答「他当时排到哪一格」）', byId(1).scheduleStatus, S.SCHEDULE.APPROVED);
  eq('派生 status = 2（已驳回）', r.data.status, 2);

  // ★ 位子释放 → 候补原位递补（点播未截止，weekRow 默认 appEnd 在过去 → 允许跨时段；
  //   这里两个人都首选同一格，所以递补走的是原位）
  const promoted = (H.dump().request_status_log || []).filter((x) => x.requestId === 2 && x.dimension === 'schedule');
  ok('驳回释放位子后候补被递补（schedule 维度有变更日志）', promoted.length >= 1,
    JSON.stringify(promoted.map((x) => [x.fromStatus, x.toStatus])));

  r = await H.call(H.req('PUT', '/admin/submit/3/reject', { reason: '再驳回' }, PLAIN_TOKEN));
  eq('重复驳回 → 40001', [r.code, r.message], [40001, '这条已是驳回状态，无需重复操作']);

  r = await H.call(H.req('PUT', '/admin/submit/3/revoke', {}, SUPER_TOKEN));
  eq('撤销（超管）→ 回到待审', r.code, 0);
  eq('三维一起归零 + 审核痕迹清空',
    [byId(3).reviewStatus, byId(3).scheduleStatus, byId(3).playStatus, byId(3).rejectReason, byId(3).reviewerId, byId(3).reviewTime],
    [0, 0, 0, null, null, null]);
  eq('派生 status 回到 0', r.data.status, 0);

  r = await H.call(H.req('PUT', '/admin/submit/3/revoke', {}, SUPER_TOKEN));
  eq('待审态再撤销 → 40001', [r.code, r.message], [40001, '这条还是待审状态，无需撤销']);
  eq('普管调 revoke → 40301（仅超管）', (await H.call(H.req('PUT', '/admin/submit/4/revoke', {}, PLAIN_TOKEN))).code, 40301);
  eq('撤销前：4 号确实是已通过 + 已排期', [byId(4).reviewStatus, byId(4).scheduleStatus], [S.REVIEW.APPROVED, S.SCHEDULE.APPROVED]);
  eq('撤销前：还没有 RELEASED 记录', (H.dump().assignment_log || []).filter((x) => x.assignmentType === 'RELEASED').length, 0);
  r = await H.call(H.req('PUT', '/admin/submit/4/revoke', {}, SUPER_TOKEN));
  eq('撤销成功', r.code, 0);
  ok('写了 RELEASED 的 assignment_log',
    (H.dump().assignment_log || []).some((x) => x.requestId === 4 && x.assignmentType === 'RELEASED' && x.reason === 'SLOT_RELEASED'),
    JSON.stringify((H.dump().assignment_log || []).map((x) => [x.requestId, x.assignmentType, x.reason])));

  /* ══════════════════ E. batch ══════════════════ */
  section('E. POST /admin/submit/batch');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { want: `${DATE0} 早间 07:20` }),
      mkSubmit(3, { review: S.REVIEW.REJECTED }),
      mkSubmit(4, { want: `${DATE0} 午间 12:20` }),
    ],
  }));

  eq('空 ids → 40001', (await H.call(H.req('POST', '/admin/submit/batch', { ids: [] }, PLAIN_TOKEN))).code, 40001);
  eq('非法 action → 40001', (await H.call(H.req('POST', '/admin/submit/batch', { ids: [1], action: 'x' }, PLAIN_TOKEN))).code, 40001);
  eq('reject 缺 reason → 40001', (await H.call(H.req('POST', '/admin/submit/batch', { ids: [1], action: 'reject' }, PLAIN_TOKEN))).code, 40001);

  r = await H.call(H.req('POST', '/admin/submit/batch', { ids: [1, 2, 3, 999], action: 'approve' }, PLAIN_TOKEN));
  eq('批量通过：affected / skipped(不存在 + 已驳回)', [r.data.affected, r.data.skipped.sort()], [2, [3, 999].sort()]);
  eq('两条都已通过并通过排期落座', [byId(1).reviewStatus, byId(2).reviewStatus], [1, 1]);

  r = await H.call(H.req('POST', '/admin/submit/batch', { ids: [4], action: 'reject', reason: '批量驳回' }, PLAIN_TOKEN));
  eq('批量驳回', [r.data.affected, byId(4).rejectReason], [1, '批量驳回']);

  /* ══════════════════ F. schedule 矩阵 ══════════════════ */
  section('F. GET /admin/submit/schedule（排期矩阵）');
  reset(baseSeed({
    submit: [
      // DATE0 早间：1 已占 + 1 候补 + 1 待审
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: `${DATE0} 早间 07:20` }),
      mkSubmit(3, { review: S.REVIEW.PENDING, want: `${DATE0} 早间 07:20` }),
      // DATE0 午间：1 待审（**用来钉住「待审不该被 scheduleStatus 条件滤掉」**）
      mkSubmit(4, { review: S.REVIEW.PENDING, want: `${DATE0} 午间 12:20` }),
    ],
  }));

  r = await H.call(H.req('GET', '/admin/submit/schedule', {}, PLAIN_TOKEN));
  eq('矩阵 → code 0', r.code, 0);
  eq('5 天 × 3 时段', [r.data.days.length, r.data.days[0].slots.length], [5, 3]);
  eq('weekStart / weekEnd', [r.data.weekStart, r.data.weekEnd], [DATE0, bj.ymd(bj.shifted(WEEK_MS + 4 * bj.DAY_MS))]);
  eq('capacity = 0（未配置 = 不限）', r.data.capacity, 0);

  const d0 = r.data.days[0];
  const slot070 = d0.slots.find((s) => s.time === '07:20');
  const slot122 = d0.slots.find((s) => s.time === '12:20');
  eq('早间：已占 1 / 候补 1 / 待审 1', [slot070.seated, slot070.scheduled, slot070.waiting, slot070.pending], [1, 1, 1, 1]);
  eq('兼容旧字段名 approved = seated、promoted 恒 0', [slot070.approved, slot070.promoted], [1, 0]);
  eq('capacity=0 时 left 为 null、full 恒 false', [slot070.left, slot070.full], [null, false]);
  eq('★ 待审计数不受 scheduleStatus 影响（午间待审 1）', [slot122.pending, slot122.seated, slot122.waiting], [1, 0, 0]);
  eq('合计 totalPending / totalScheduled / totalWaiting', [r.data.totalPending, r.data.totalScheduled, r.data.totalWaiting], [2, 1, 1]);
  ok('week 视图与 lockAt/finalizeAt 同时下发',
    !!r.data.week && typeof r.data.lockAt === 'string' && r.data.lockAt === r.data.finalizeAt,
    `${r.data.lockAt}`);
  ok('window 视图随包下发', !!r.data.window && typeof r.data.queue === 'object');

  /* ══════════════════ G. week ══════════════════ */
  section('G. GET /admin/submit/week');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 午间 12:20` }),
    ],
  }));

  r = await H.call(H.req('GET', '/admin/submit/week', {}, PLAIN_TOKEN));
  eq('week → code 0', r.code, 0);
  eq('weekStartDate = 下周一', r.data.weekStartDate, DATE0);
  eq('槽位数 = 5 天 × 3 时段', r.data.slots, 15);
  eq('已占 2', r.data.seated, 2);
  eq('capacity=0 → total/left 为 0 / null', [r.data.total, r.data.left], [0, null]);
  ok('下发 reviewEndAt（前端别再用 lockAt − applicationEndAt 反算）', typeof r.data.reviewEndAt === 'string', r.data.reviewEndAt);
  ok('下发 lockText / secondsToLock / canApply / locked / lockPaused / unlockable',
    typeof r.data.lockText === 'string' && typeof r.data.secondsToLock === 'number'
    && r.data.canApply === false && r.data.locked === false && r.data.lockPaused === false && r.data.unlockable === false);

  r = await H.call(H.req('GET', '/admin/submit/week', { weekStart: DATE0 }, PLAIN_TOKEN));
  eq('显式 weekStart 走同一周', r.data.weekStartDate, DATE0);

  /* ══════════════════ H. previewSchedule（dryRun） ══════════════════ */
  section('H. POST /admin/submit/schedule/preview（只算不写库，仅超管）');
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.UNASSIGNED, want: `${DATE0} 早间 07:20`, createTime: new Date('2026-09-01T10:00:00+08:00') }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.UNASSIGNED, want: `${DATE0} 早间 07:20`, createTime: new Date('2026-09-02T10:00:00+08:00') }),
    ],
  }, { appEnd: Date.now() - 3600000 }));   // 点播已截止 → 允许跨时段

  const beforeSnap = JSON.stringify((H.dump().submit || []).map((x) => [x.id, x.scheduleStatus, x.scheduledSlot]));

  r = await H.call(H.req('POST', '/admin/submit/schedule/preview', {}, PLAIN_TOKEN));
  eq('普管调 preview → 40301（仅超管）', r.code, 40301);

  r = await H.call(H.req('POST', '/admin/submit/schedule/preview', {}, SUPER_TOKEN));
  eq('预览 → code 0', r.code, 0);
  eq('dryRun 标记', r.data.dryRun, true);
  eq('落座 1 / 候补 1（来自第一轮排期）',
    [r.data.summary.assigned, r.data.summary.waiting], [1, 1]);
  eq('plan.assign 里带歌名与目标格', [r.data.plan.assign.length, r.data.plan.assign[0].songName, r.data.plan.assign[0].to], [1, '晴天', `${DATE0} 早间 07:20`]);
  eq('plan.waiting 带期待格', [r.data.plan.waiting.length, r.data.plan.waiting[0].want], [1, `${DATE0} 早间 07:20`]);
  /**
   * ⚠️⚠️ 这一段是**陛下 2026-09-29 裁决修复的 dryRun 链式演练**的判据。
   *
   * 修之前：`reschedule(dryRun)` 的候选是「库里的 `scheduleStatus = WAITING`」，
   *   而 `initialAllocate(dryRun)` 不写库 → 刚被判「候补」的 2 号在库里仍是
   *   `UNASSIGNED` → 第二步一个候选都看不到 → `[0, 0, 0]`（源实现同款瑕疵）。
   * 修之后：第一步把「候补整行」+「落座后占用表」从内存交给第二步 →
   *   2 号被调剂到同一天的另一格（点播已截止 → 允许跨时段；成本表 10 档最近的一格）。
   */
  eq('★ 2 号被调剂到同一天的另一格（dryRun 也能算出调剂，不再是 0）',
    [r.data.plan.rescheduled.length, r.data.plan.rescheduled[0].to, r.data.plan.rescheduled[0].cost],
    [1, `${DATE0} 午间 12:20`, 10]);
  eq('★ summary：递补 0 / 调剂 1 / 仍候补 0',
    [r.data.summary.promoted, r.data.summary.rescheduled, r.data.summary.stillWaiting], [0, 1, 0]);
  /**
   * ⚠️ `autoRejectedIfLocked` 的语义（2026-09-29 与 dryRun 链式演练一起修正）：
   *    它按**锁定时刻的真实闸门**算 —— `lockWeek()` 是**显式 `crossSlot: true`**。
   *    所以即便本次预览的闸门是关的（点播未截止），这个数字仍然是「锁定那天会怎样」。
   *    这正是它在用途上必须与 `stillWaiting` 分开的原因：一个是**现在**，一个是**锁定时刻**。
   */
  eq('★ 「锁定后会被自动驳回」= 0（按锁定时刻的闸门算：2 号会被调剂到别处）',
    r.data.summary.autoRejectedIfLocked, 0);
  eq('★ 「模拟后各格占用」反映两步结果：早间 1 / 午间 1',
    [r.data.slots.find((s) => s.value === `${DATE0} 早间 07:20`).after,
      r.data.slots.find((s) => s.value === `${DATE0} 午间 12:20`).after], [1, 1]);
  eq('★ dryRun **不写库**', JSON.stringify((H.dump().submit || []).map((x) => [x.id, x.scheduleStatus, x.scheduledSlot])), beforeSnap);

  r = await H.call(H.req('POST', '/admin/submit/schedule/preview', { crossSlot: false }, SUPER_TOKEN));
  ok('crossSlot=false 时理由文案说「只做原位递补」', /只做原位递补/.test(r.data.crossSlotReason), r.data.crossSlotReason);
  eq('crossSlot=false 时 crossSlot 回流 false', r.data.crossSlot, false);
  // 首选格已被 1 号占满，且不许跨时段 → 2 号只能留在候补（闸门与链式演练互不干扰）
  eq('★ crossSlot=false：2 号留在候补（stillWaiting 1），不会被挪走',
    [r.data.summary.rescheduled, r.data.summary.stillWaiting, r.data.plan.rescheduled.length], [0, 1, 0]);
  eq('★ 但「锁定后会被自动驳回」仍是 0 —— 它看的是锁定时刻（闸门强制放开），不是现在',
    r.data.summary.autoRejectedIfLocked, 0);
  eq('★ dryRun **不写库**（crossSlot=false 这一轮同样）', JSON.stringify((H.dump().submit || []).map((x) => [x.id, x.scheduleStatus, x.scheduledSlot])), beforeSnap);

  /**
   * ★★ 「会被自动驳回」不能永远为 0 —— 否则上面两条断言是空过的。
   *    造一个**真的哪儿都去不了**的人：首选格被占满 + **本人拒绝调剂**
   *    （`allowReschedule = 0`）→ 跨时段放开了也没用，锁定时必然被驳回。
   */
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.UNASSIGNED, want: `${DATE0} 早间 07:20`, allow: 0 }),
    ],
  }, { appEnd: Date.now() - 3600000 }));   // 点播已截止 → 闸门放开，仍然无解
  r = await H.call(H.req('POST', '/admin/submit/schedule/preview', {}, SUPER_TOKEN));
  eq('★ 拒绝调剂 + 首选格满 → 锁定时会被自动驳回 1 条（这个数字不是恒 0）',
    [r.data.summary.autoRejectedIfLocked, r.data.summary.stillWaiting, r.data.plan.waiting.length], [1, 1, 1]);

  // 点播未截止 → 闸门自动关掉跨时段
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.UNASSIGNED, want: `${DATE1} 早间 07:20`, createTime: new Date('2026-09-01T10:00:00+08:00') }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE1} 早间 07:20` }),
    ],
  }, { appEnd: Date.now() + 3600000 }));   // 点播**未**截止
  r = await H.call(H.req('POST', '/admin/submit/schedule/preview', {}, SUPER_TOKEN));
  eq('★ 点播未截止 → canCrossSlot = false', r.data.crossSlot, false);
  eq('★ 且 1 号不会跨到 DATE0 的空位去（只做原位递补）', r.data.plan.rescheduled.length, 0);
  eq('1 号仍在候补', r.data.plan.waiting.length + r.data.plan.assign.length, 1);

  /* ══════════════════ I. runSchedule ══════════════════ */
  section('I. POST /admin/submit/schedule/run（执行排期，仅超管）');
  // 场景：容量 1；1 号占住 DATE0 早间；2 号是**库里真在候补**的人，首选也是这一格。
  // → initialAllocate 无位可给（首选格满），reschedule 在「显式放开跨时段」下把它调剂到
  //   DATE0 午间（同一天其他时段 = 成本表 10，最近的一格）。
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: `${DATE0} 早间 07:20` }),
    ],
  }, { appEnd: Date.now() + 3600000 }));    // 点播**未**截止

  eq('普管调 run → 40301', (await H.call(H.req('POST', '/admin/submit/schedule/run', {}, PLAIN_TOKEN))).code, 40301);

  r = await H.call(H.req('POST', '/admin/submit/schedule/run', {}, SUPER_TOKEN));
  eq('执行排期 → code 0', r.code, 0);
  eq('★ 手动执行**显式**放开跨时段（不受点播截止闸门限制）', r.data.crossSlot, true);
  eq('★ 2 号被跨时段调剂到同一天的另一格（成本表 10 档，最近）',
    [byId(2).scheduledSlot, byId(2).scheduleStatus], [`${DATE0} 午间 12:20`, S.SCHEDULE.APPROVED]);
  eq('1 号原位不动', [byId(1).scheduledSlot, byId(1).scheduleStatus], [`${DATE0} 早间 07:20`, S.SCHEDULE.APPROVED]);
  eq('返回值汇总：落座 0 / 候补 0 / 调剂 1 / 仍候补 0',
    [r.data.assigned, r.data.waiting, r.data.promoted + r.data.rescheduled, r.data.stillWaiting], [0, 0, 1, 0]);
  ok('写了 RESCHEDULED 的 assignment_log（fromSlot = 首选格，toSlot = 实排格）',
    (H.dump().assignment_log || []).some((x) => x.requestId === 2 && x.assignmentType === 'RESCHEDULED'
      && x.fromSlot === `${DATE0} 早间 07:20` && x.toSlot === `${DATE0} 午间 12:20`),
    JSON.stringify((H.dump().assignment_log || []).map((x) => [x.requestId, x.assignmentType, x.fromSlot, x.toSlot])));
  ok('周状态推到 SCHEDULING', (H.dump().weekly_schedule || [])[0].status === 'SCHEDULING');

  // ★★ 反过来：点播未截止时，**自动路径**（runAllocators，不带 crossSlot）只做原位递补
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: [
      // 1 号在别的天占了 2 号想去的格？不 —— 这里让 2 号的首选格被别人占满，
      // 而别处有大量空位；点播未截止 → 2 号**必须留在候补**，不许被挪走。
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: `${DATE0} 早间 07:20` }),
    ],
  }, { appEnd: Date.now() + 3600000 }));
  r = await H.call(H.req('POST', '/admin/submit/queue/sweep', {}, SUPER_TOKEN));
  eq('sweep → code 0', r.code, 0);
  eq('★ 点播未截止：sweep 的排期不会把候补跨时段挪走',
    [byId(2).scheduleStatus, byId(2).scheduledSlot], [S.SCHEDULE.WAITING, null]);

  /* ══════════════════ J. lock / unlock ══════════════════ */
  section('J. POST /admin/submit/schedule/lock · /unlock');
  // 场景：容量 1 且**15 个格子全被占满** → 第 16 条（首选某格但已满）真的无位可去，
  //      连 lockWeek 的最后一次调度也救不了它 → 必须 AUTO_REJECTED。
  //      （这条路径是「系统自动驳回」唯一的生产入口，值得用真数据把它跑通。）
  const slotValues = (await slotSvc.getSlots()).list.map((s) => s.value);
  eq('矩阵格子数 = 5 天 × 3 时段', slotValues.length, 15);
  const FULL_WEEK = slotValues.map((v, i) => mkSubmit(100 + i, {
    review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: v, want: v,
  }));
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: FULL_WEEK.concat([
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: slotValues[0] }),
    ]),
  }, { lockAt: Date.now() + 3600000 }));     // 还没到锁定时刻

  r = await H.call(H.req('POST', '/admin/submit/schedule/lock', {}, PLAIN_TOKEN));
  eq('普管调 lock → 40301', r.code, 40301);

  r = await H.call(H.req('POST', '/admin/submit/schedule/lock', {}, SUPER_TOKEN));
  eq('未到锁定时刻 → 40001 且带出锁定时刻', r.code, 40001);
  ok('文案含「还没到锁定时刻」', /还没到锁定时刻/.test(r.message), r.message);
  eq('被拦下时**没有**改任何数据', byId(2).scheduleStatus, S.SCHEDULE.WAITING);

  r = await H.call(H.req('POST', '/admin/submit/schedule/lock', { force: true }, SUPER_TOKEN));
  eq('force 可提前锁', r.code, 0);
  eq('★ 满周里无位可去的候补被自动驳回',
    [byId(2).reviewStatus, byId(2).scheduleStatus, byId(2).autoRejected], [S.REVIEW.APPROVED, S.SCHEDULE.AUTO_REJECTED, 1]);
  eq('自动驳回原因 = 排期已锁定没有可用位置', byId(2).rejectReason, S.SYSTEM_REASON.lockedNoSlot);
  eq('派生 status = 2（驳回）', byId(2).status, 2);
  eq('已占的 15 条一条没动', (H.dump().submit || []).filter((x) => x.scheduleStatus === S.SCHEDULE.APPROVED).length, 15);
  eq('返回值 rejected', r.data.rejected, 1);
  eq('周状态 → LOCKED', (H.dump().weekly_schedule || [])[0].status, 'LOCKED');
  ok('lockedAt 已写', (H.dump().weekly_schedule || [])[0].lockedAt instanceof Date);

  r = await H.call(H.req('POST', '/admin/submit/schedule/lock', {}, SUPER_TOKEN));
  eq('重复锁定 → already 分支不报错', r.code, 0);

  // 锁定后人工改动一律被拦
  const SEAT = 100;
  eq('锁定后 approve → 40001', (await H.call(H.req('PUT', `/admin/submit/${SEAT}/approve`, {}, PLAIN_TOKEN))).code, 40001);
  eq('锁定后 reject → 40001', (await H.call(H.req('PUT', `/admin/submit/${SEAT}/reject`, { reason: 'x' }, PLAIN_TOKEN))).code, 40001);
  eq('锁定后 remove → 40001', (await H.call(H.req('DELETE', `/admin/submit/${SEAT}`, {}, PLAIN_TOKEN))).code, 40001);
  eq('锁定后 played → 40001', (await H.call(H.req('PUT', `/admin/submit/${SEAT}/played`, {}, SUPER_TOKEN))).code, 40001);
  eq('锁定后 assign → 40001', (await H.call(H.req('POST', `/admin/submit/${SEAT}/assign`, { slot: slotValues[1] }, SUPER_TOKEN))).code, 40001);
  eq('锁定后 revoke → 40001', (await H.call(H.req('PUT', `/admin/submit/${SEAT}/revoke`, {}, SUPER_TOKEN))).code, 40001);
  r = await H.call(H.req('PUT', `/admin/submit/${SEAT}/approve`, {}, PLAIN_TOKEN));
  ok('拦截文案说明是「排期已锁定」', /排期已锁定/.test(r.message), r.message);

  // 文稿不参与排期 → 不受锁定约束
  reset(baseSeed({
    submit: [mkSubmit(1, { type: 2, articleTitle: '文稿' }), mkSubmit(2, { type: 1, want: `${DATE0} 早间 07:20` })],
  }, { status: 'LOCKED', lockedAt: new Date() }));
  eq('★ 文稿（type=2）不受锁定约束：可以照常审核',
    (await H.call(H.req('PUT', '/admin/submit/1/approve', {}, PLAIN_TOKEN))).code, 0);
  eq('点歌（type=1）仍被拦', (await H.call(H.req('PUT', '/admin/submit/2/approve', {}, PLAIN_TOKEN))).code, 40001);

  // ---- unlock
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: FULL_WEEK.concat([
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: slotValues[0] }),
    ]),
  }, { lockAt: Date.now() + 3600000 }));
  await H.call(H.req('POST', '/admin/submit/schedule/lock', { force: true }, SUPER_TOKEN));
  eq('前置：2 号已被自动驳回', byId(2).scheduleStatus, S.SCHEDULE.AUTO_REJECTED);

  r = await H.call(H.req('POST', '/admin/submit/schedule/unlock', {}, PLAIN_TOKEN));
  eq('普管调 unlock → 40301', r.code, 40301);

  r = await H.call(H.req('POST', '/admin/submit/schedule/unlock', {}, SUPER_TOKEN));
  eq('解锁 → code 0', r.code, 0);
  eq('★ 锁定时被自动驳回的候补退回 WAITING', [byId(2).scheduleStatus, byId(2).autoRejected, byId(2).rejectReason], [S.SCHEDULE.WAITING, 0, null]);
  eq('返回值 restored', r.data.restored, 1);
  eq('周退回 SCHEDULING 且 lockedAt 清空', [(H.dump().weekly_schedule || [])[0].status, (H.dump().weekly_schedule || [])[0].lockedAt], ['SCHEDULING', null]);
  eq('★ lockPaused 必须置 1（否则下一轮 sweep 立刻锁回去）', (H.dump().weekly_schedule || [])[0].lockPaused, 1);
  eq('weekView 里 lockPaused 暴露给前端', r.data.lockPaused, true);

  // ★ 解锁后 sweep 不许把它锁回去（lockPaused 的真正用途）
  await H.call(H.req('POST', '/admin/submit/queue/sweep', {}, SUPER_TOKEN));
  eq('★ 解锁后 sweep 不再自动锁定（lockPaused 生效）', (H.dump().weekly_schedule || [])[0].status, 'SCHEDULING');

  // restore:false → 不解冻
  reset(baseSeed({
    system_setting: [{ _id: 'setting:song_slot_capacity', id: 1, key: 'song_slot_capacity', value: '1', desc: '容量', updateTime: new Date() }],
    submit: FULL_WEEK.concat([
      mkSubmit(2, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.WAITING, want: slotValues[0] }),
    ]),
  }, { lockAt: Date.now() + 3600000 }));
  await H.call(H.req('POST', '/admin/submit/schedule/lock', { force: true }, SUPER_TOKEN));
  r = await H.call(H.req('POST', '/admin/submit/schedule/unlock', { restore: false }, SUPER_TOKEN));
  eq('restore:false → 被自动驳回的**不**解冻', [r.data.restored, byId(2).scheduleStatus], [0, S.SCHEDULE.AUTO_REJECTED]);

  // 未锁定的周再解锁：`unlockWeek` 抛的是**裸 Error + code 40001**，源控制器没有 catch
  // → 源后端同样落到全局兜底 = 500。这里保持同口径，不擅自"修好"线上既有行为。
  r = await H.call(H.req('POST', '/admin/submit/schedule/unlock', {}, SUPER_TOKEN));
  eq('未锁定状态再解锁 → 50001（与源后端同口径，见注释）', r.code, 50001);

  // 手动重新锁定要清 lockPaused
  reset(baseSeed({
    submit: [mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20` })],
  }, { lockAt: Date.now() - 3600000, lockPaused: 1 }));
  r = await H.call(H.req('POST', '/admin/submit/schedule/lock', { force: true }, SUPER_TOKEN));
  eq('手动重新锁定成功', r.code, 0);
  eq('★ lockPaused 被清 0（恢复自动锁定）', (H.dump().weekly_schedule || [])[0].lockPaused, 0);

  /* ══════════════════ K. assign / played / statusLogs ══════════════════ */
  section('K. assign · played · status-logs');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20`, want: `${DATE0} 早间 07:20` }),
      mkSubmit(2, { review: S.REVIEW.PENDING, type: 2 }),
    ],
  }));

  eq('普管调 assign → 40301', (await H.call(H.req('POST', '/admin/submit/1/assign', { slot: `${DATE0} 午间 12:20` }, PLAIN_TOKEN))).code, 40301);
  eq('缺 slot → 40001', (await H.call(H.req('POST', '/admin/submit/1/assign', {}, SUPER_TOKEN))).code, 40001);
  r = await H.call(H.req('POST', '/admin/submit/2/assign', { slot: `${DATE0} 午间 12:20` }, SUPER_TOKEN));
  eq('对文稿 assign → 40001', [r.code, r.message], [40001, '只能对点歌做排期调整']);
  r = await H.call(H.req('POST', '/admin/submit/1/assign', { slot: `${DATE0} 午间 12:20` }, SUPER_TOKEN));
  eq('人工指定时段 → code 0', r.code, 0);
  eq('已改到新格', [byId(1).scheduledSlot, byId(1).scheduleStatus], [`${DATE0} 午间 12:20`, S.SCHEDULE.APPROVED]);
  ok('写了 MANUAL 的 assignment_log',
    (H.dump().assignment_log || []).some((x) => x.requestId === 1 && x.assignmentType === 'MANUAL' && x.toSlot === `${DATE0} 午间 12:20`));

  // played
  eq('普管调 played → 40301', (await H.call(H.req('PUT', '/admin/submit/1/played', {}, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/1/played', {}, SUPER_TOKEN));
  eq('缺 body.played → 默认标记为已播放', [byId(1).playStatus, byId(1).status], [S.PLAY.PLAYED, 5]);
  ok('playedAt 已写', byId(1).playedAt instanceof Date);
  r = await H.call(H.req('PUT', '/admin/submit/1/played', { played: false }, SUPER_TOKEN));
  eq('取消播放标记', [byId(1).playStatus, byId(1).playedAt, byId(1).status], [S.PLAY.NOT_PLAYED, null, 1]);

  // statusLogs
  r = await H.call(H.req('GET', '/admin/submit/1/status-logs', {}, PLAIN_TOKEN));
  eq('轨迹接口 → code 0', r.code, 0);
  ok('有 play 维度的变更记录', r.data.some((x) => x.dimension === 'play'), JSON.stringify(r.data.map((x) => [x.dimension, x.fromStatus, x.toStatus])));
  ok('轨迹按 id 升序', r.data.every((x, i) => i === 0 || x.id > r.data[i - 1].id));
  eq('不存在的 id → 空数组（不报错）', (await H.call(H.req('GET', '/admin/submit/999/status-logs', {}, PLAIN_TOKEN))).data, []);

  /* ══════════════════ L. capacity / setQuota / sweepQueue ══════════════════ */
  section('L. capacity · setQuota · sweepQueue');
  reset(baseSeed({
    submit: [mkSubmit(1, { review: S.REVIEW.APPROVED, schedule: S.SCHEDULE.APPROVED, slot: `${DATE0} 早间 07:20` })],
  }));

  r = await H.call(H.req('GET', '/admin/submit/capacity', {}, PLAIN_TOKEN));
  eq('capacity → code 0', r.code, 0);
  ok('快照含 capacity / weekCapacity / queue / week / window',
    'capacity' in r.data && 'weekCapacity' in r.data && !!r.data.queue && !!r.data.week && !!r.data.window,
    Object.keys(r.data).join(','));
  eq('未配置容量 → 0（不限）', r.data.capacity, 0);

  r = await H.call(H.req('GET', '/admin/submit/quota', {}, PLAIN_TOKEN));
  eq('旧路径 /quota 与 /capacity 同一 handler', r.code, 0);
  ok('两者返回结构一致', 'capacity' in r.data && 'queue' in r.data);

  eq('普管调 setQuota → 40301', (await H.call(H.req('PUT', '/admin/submit/quota', { capacity: 2 }, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/quota', { capacity: 2, queueLimit: 99 }, SUPER_TOKEN));
  eq('setQuota → code 0', r.code, 0);
  eq('容量已写 KV', (H.dump().system_setting || []).find((d) => d.key === 'song_slot_capacity').value, '2');
  eq('读回 capacity=2', (await H.call(H.req('GET', '/admin/submit/capacity', {}, SUPER_TOKEN))).data.capacity, 2);
  eq('★ queueLimit 在协议版**不生效**（候补无人数上限）',
    (H.dump().system_setting || []).some((d) => d.key === 'song_queue_limit'), false);

  eq('普管调 sweep → 40301', (await H.call(H.req('POST', '/admin/submit/queue/sweep', {}, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('POST', '/admin/submit/queue/sweep', {}, SUPER_TOKEN));
  eq('sweep → code 0', r.code, 0);
  ok('返回 weeks / played', Array.isArray(r.data.weeks) && typeof r.data.played === 'number', JSON.stringify(Object.keys(r.data)));
  r = await H.call(H.req('POST', '/admin/submit/queue/sweep', {}, SUPER_TOKEN));
  eq('sweep 幂等（重跑不报错）', r.code, 0);
  eq('旧路径 /quota/sweep 同一 handler', (await H.call(H.req('POST', '/admin/submit/quota/sweep', {}, SUPER_TOKEN))).code, 0);

  /* ══════════════════ M. 点歌设置：notice / timeslots / window / rules ══════════════════ */
  section('M. 点歌设置四件套');
  reset(baseSeed());

  // ---- 注意事项（读 + 写都是普管）
  r = await H.call(H.req('GET', '/admin/submit/notice', {}, PLAIN_TOKEN));
  eq('notice → code 0', r.code, 0);
  eq('两份注意事项一次给全', Object.keys(r.data).sort(), ['article', 'song']);
  eq('初始未配置', [r.data.song.configured, r.data.song.version], [false, 0]);

  r = await H.call(H.req('PUT', '/admin/submit/notice', {}, PLAIN_TOKEN));
  eq('不传 content → 40001', [r.code, r.message], [40001, '请传 content（允许空字符串表示停用）']);

  r = await H.call(H.req('PUT', '/admin/submit/notice', { content: '每人每周最多 2 首', type: 'song' }, PLAIN_TOKEN));
  eq('内容变化 → 版本 +1', [r.code, r.data.bumped, r.data.version], [0, true, 1]);
  eq('普管即可保存注意事项', r.data.content, '每人每周最多 2 首');

  r = await H.call(H.req('PUT', '/admin/submit/notice', { content: '每人每周最多 2 首', type: 'song' }, PLAIN_TOKEN));
  eq('内容未变化 → 版本不变', [r.data.bumped, r.data.version], [false, 1]);
  r = await H.call(H.req('PUT', '/admin/submit/notice', { content: '每人每周最多 2 首  ', type: 'song' }, PLAIN_TOKEN));
  eq('仅尾部空白差异 → 不算变化（trim 后比较）', [r.data.bumped, r.data.version], [false, 1]);
  r = await H.call(H.req('PUT', '/admin/submit/notice', { content: '改了', type: 'song' }, PLAIN_TOKEN));
  eq('再次变化 → 版本 2', [r.data.bumped, r.data.version], [true, 2]);
  r = await H.call(H.req('PUT', '/admin/submit/notice', { content: 'x'.repeat(5001), type: 'song' }, PLAIN_TOKEN));
  eq('超过 5000 字 → 40001', [r.code, r.message], [40001, '点歌注意事项内容不能超过 5000 字']);

  // ---- 播出时段
  r = await H.call(H.req('GET', '/admin/submit/timeslots', {}, PLAIN_TOKEN));
  eq('timeslots → code 0', r.code, 0);
  eq('默认三档 + 来源 default', [r.data.times.map((t) => t.time), r.data.source], [['07:20', '12:20', '17:30'], 'default']);
  eq('maxSlots = 6', r.data.maxSlots, 6);

  eq('普管调 saveSlots → 40301', (await H.call(H.req('PUT', '/admin/submit/slots', { times: [{ time: '08:00' }] }, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/slots', {}, SUPER_TOKEN));
  eq('times 非数组 → 40001', [r.code, r.message], [40001, '请传 times 数组，如 [{time:"12:20",label:"午间"}]']);
  r = await H.call(H.req('PUT', '/admin/submit/slots', { times: [{ time: '25:00' }] }, SUPER_TOKEN));
  eq('全非法时段 → 40001（服务端兜住）', r.code, 40001);
  r = await H.call(H.req('PUT', '/admin/submit/slots', { times: [{ time: '12:20', label: '午间' }, { time: '08:00' }] }, SUPER_TOKEN));
  eq('保存成功', r.code, 0);
  eq('按时间升序归一 + label 缺省由小时推', r.data.times, [{ time: '08:00', label: '早间' }, { time: '12:20', label: '午间' }]);
  eq('来源变成 custom', r.data.source, 'custom');
  eq('时段数变了 → 周槽位跟着变', (await H.call(H.req('GET', '/admin/submit/week', {}, SUPER_TOKEN))).data.slots, 10);

  // ---- 下一播出周 · 关闭日期（2026-10-08：节日当天不接收点歌）
  r = await H.call(H.req('GET', '/admin/submit/timeslots', {}, PLAIN_TOKEN));
  eq('timeslots 下发 5 天日期框架', r.data.days.length, 5);
  eq('默认无关闭日期', r.data.closedDates, []);
  const allDays = r.data.days.map((d) => d.date);

  eq('普管调 slot-dates → 40301', (await H.call(H.req('PUT', '/admin/submit/slot-dates', { closedDates: [allDays[2]] }, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/slot-dates', {}, SUPER_TOKEN));
  eq('closedDates 非数组 → 40001', [r.code, r.message], [40001, '请传 closedDates 数组，如 ["2026-10-14"]']);

  r = await H.call(H.req('PUT', '/admin/submit/slot-dates', { closedDates: [allDays[2]] }, SUPER_TOKEN));
  eq('关闭一天 → code 0', [r.code, r.data.closedDates], [0, [allDays[2]]]);
  r = await H.call(H.req('GET', '/admin/submit/timeslots', {}, PLAIN_TOKEN));
  eq('读回：那天 closed=true', r.data.days.find((d) => d.date === allDays[2]).closed, true);
  eq('closedDates 一并下发', r.data.closedDates, [allDays[2]]);
  eq('其余四天仍开放', r.data.days.filter((d) => !d.closed).length, 4);
  // ⚠️ admin 接口下发的是 count（格子总数），不下发 list —— 前面 5 天 × 2 时段 = 10
  eq('可选格子少一天（10 → 4×2）', r.data.count, 8);
  ok('范围文案不受影响（仍是 5 天那一段）', typeof r.data.rangeText === 'string' && r.data.rangeText.indexOf('~') > 0, `rangeText=${r.data.rangeText}`);

  r = await H.call(H.req('PUT', '/admin/submit/slot-dates', { closedDates: [] }, SUPER_TOKEN));
  eq('传空数组 → 全部恢复', [r.code, r.data.closedDates], [0, []]);

  // ---- 时间窗口
  r = await H.call(H.req('GET', '/admin/submit/window', {}, PLAIN_TOKEN));
  eq('window → code 0', r.code, 0);
  eq('默认窗口 周六18:00 → 周日18:00', [r.data.config.startDay, r.data.config.startTime, r.data.config.endDay, r.data.config.endTime], [6, '18:00', 0, '18:00']);
  eq('审核截止默认未单独配置（跟随点播结束+偏移）', [r.data.config.reviewDay, r.data.reviewConfigured], [null, false]);
  eq('下发 followOffsetMinutes', r.data.followOffsetMinutes, 360);
  ok('下发 allowedDays / dayNames / maxSpanHours', Array.isArray(r.data.allowedDays) && r.data.maxSpanHours === 168, `maxSpan=${r.data.maxSpanHours}`);

  eq('普管调 saveWindow → 40301', (await H.call(H.req('PUT', '/admin/submit/window', { enabled: 0 }, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/window', { enabled: 0, startDay: 5, startTime: '09:00', endDay: 0, endTime: '20:00', reviewDay: 0, reviewTime: '22:00' }, SUPER_TOKEN));
  eq('保存窗口 → code 0', r.code, 0);
  eq('已生效', [r.data.config.enabled, r.data.config.startDay, r.data.config.startTime, r.data.config.endDay, r.data.config.endTime], [0, 5, '09:00', 0, '20:00']);
  eq('审核截止可独立配置', [r.data.config.reviewDay, r.data.config.reviewTime, r.data.reviewConfigured], [0, '22:00', true]);
  eq('窗口文案随包下发', typeof r.data.windowText, 'string');
  r = await H.call(H.req('PUT', '/admin/submit/window', { enabled: 1, startDay: 6, startTime: '18:00', endDay: 6, endTime: '18:00' }, SUPER_TOKEN));
  eq('起止同一天同一时刻（0 小时跨度）→ 40001', r.code, 40001);

  // ---- 规则
  r = await H.call(H.req('GET', '/admin/submit/rules', {}, PLAIN_TOKEN));
  eq('rules → code 0', r.code, 0);
  eq('默认每周 2 首 / 同曲拦截开', [r.data.weeklyUserLimit, r.data.dupBlock], [2, 1]);
  eq('defaultUserLimit 一并下发', r.data.defaultUserLimit, 2);
  eq('普管调 saveRules → 40301', (await H.call(H.req('PUT', '/admin/submit/rules', { weeklyUserLimit: 5 }, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('PUT', '/admin/submit/rules', { weeklyUserLimit: 5, dupBlock: 0 }, SUPER_TOKEN));
  eq('保存规则 → code 0', [r.code, r.data.weeklyUserLimit, r.data.dupBlock], [0, 5, 0]);
  eq('读回一致', (await H.call(H.req('GET', '/admin/submit/rules', {}, SUPER_TOKEN))).data.weeklyUserLimit, 5);

  /* ══════════════════ N. purgeSongs ══════════════════ */
  section('N. DELETE /admin/submit/songs（一键清空点歌）');
  reset(baseSeed({
    submit: [
      mkSubmit(1, { type: 1 }), mkSubmit(2, { type: 1 }),
      mkSubmit(3, { type: 2, articleTitle: '文稿' }),
    ],
    assignment_log: [{ _id: 'al1', id: 1, requestId: 1, type: 'INITIAL', createTime: new Date() }],
    request_status_log: [{ _id: 'rl1', id: 1, requestId: 2, dimension: 'review', createTime: new Date() }],
  }));

  eq('普管调 purge → 40301', (await H.call(H.req('DELETE', '/admin/submit/songs', {}, PLAIN_TOKEN))).code, 40301);
  r = await H.call(H.req('DELETE', '/admin/submit/songs', {}, SUPER_TOKEN));
  eq('未传 confirm → 40001', [r.code, r.message], [40001, '高危操作：请传 confirm: "DELETE" 明确确认']);
  r = await H.call(H.req('DELETE', '/admin/submit/songs', { confirm: 'delete' }, SUPER_TOKEN));
  eq('大小写不匹配 → 40001', r.code, 40001);

  r = await H.call(H.req('DELETE', '/admin/submit/songs', { confirm: 'DELETE' }, SUPER_TOKEN));
  eq('清空 → code 0', r.code, 0);
  eq('只删点歌（type=1）', r.data.deletedSongs, 2);
  eq('日志一并清（logsCleared 记的是被清点歌数）', r.data.logsCleared, 2);
  const left = H.dump().submit || [];
  eq('文稿不受影响', left.map((x) => x.id), [3]);
  eq('两张日志表清空', [left.length, (H.dump().assignment_log || []).length, (H.dump().request_status_log || []).length], [1, 0, 0]);
  eq('幂等：再清一次 0 条', (await H.call(H.req('DELETE', '/admin/submit/songs', { confirm: 'DELETE' }, SUPER_TOKEN))).data.deletedSongs, 0);

  /* ══════════════════ 输出 ══════════════════ */
  const checked = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  lines.push('');
  lines.push(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { require('fs').writeFileSync(path.join(__dirname, '..', '..', '_cloud_admin_submit_test.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
