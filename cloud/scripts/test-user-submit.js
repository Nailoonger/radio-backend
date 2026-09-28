'use strict';

/**
 * 用户端「投稿 / 点歌」接口本地实测（阶段 4 收尾）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-user-submit.js
 *
 * 覆盖 11 个接口：
 *   create · notice · ackNotice · timeslots · windowStatus · weekSchedule
 *   quota · myList · detail · cancel · leaveQueue
 *
 * ⚠️⚠️ 本脚本盯的是三类**容易静默错**的东西：
 *
 *  1. **拦截顺序**：`create` 的 5 个拦截码有严格先后（窗口 → 注意事项 → 时段/规则
 *     → 字段 → 防重 → 内容安全）。顺序错了不会报错，只会「换一个错误码/文案」，
 *     前端的分支判断（40303 弹注意事项、40907 拉倒计时）就会走错 ——
 *     所以下面**刻意用「同时满足两个错误条件」的入参**来钉死优先级。
 *
 *  2. **三维状态 + 派生镜像**：取消一条投稿必须同时改 `reviewStatus`(3) 与
 *     `status`(7)，只改一个前端就看不出来。日志是**可追溯性的真值**，
 *     `applyChange` 的乐观锁「影响 0 行 → 返回空 logs」更是不报错的静默分支。
 *
 *  3. **主键口径**：`weekly_schedule` 用业务键 `week:<date>` 当 `_id`，
 *     `submit` 用数字 `id`。混用不报错，只会查不到。
 *
 * 日期一律动态计算（bjTime），不写死 —— 否则测试会随时间失效。
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
const accountService = require(path.join(API_DIR, 'services', 'studentAccount'));
const songWindow = require(path.join(API_DIR, 'services', 'songWindow'));
const broadcastSlot = require(path.join(API_DIR, 'services', 'broadcastSlot'));
const submitRule = require(path.join(API_DIR, 'services', 'submitRule'));
const songNotice = require(path.join(API_DIR, 'services', 'songNotice'));
const S = require(path.join(API_DIR, 'services', 'songStatus'));
const sched = require(path.join(API_DIR, 'services', 'scheduling'));

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

const USER = '20240101';
const OTHER = '20240202';
const TOKEN = sign({ openid: USER, uid: 1, username: USER, pv: 0 });
const TOKEN_OTHER = sign({ openid: OTHER, uid: 2, username: OTHER, pv: 0 });

/** 登录态用例：token 里的 username 必须在库中真实存在，否则 assertTokenFresh 先给 40101 */
const ACCOUNT = { _id: 'u1', id: 1, openid: null, username: USER, status: 1, pwdChangedAt: null };
const ACCOUNT_OTHER = { _id: 'u2', id: 2, openid: null, username: OTHER, status: 1, pwdChangedAt: null };

/** KV 文档 helper（kv 走 `setting:<key>` 单文档直读） */
function kv(obj) {
  return Object.keys(obj).map((k) => ({ _id: `setting:${k}`, key: k, value: String(obj[k]) }));
}
function withKv(obj, extra) {
  return { system_setting: kv(obj), ...(extra || {}) };
}

/**
 * 窗口配置
 *  · OPEN   —— 点播周**整周**（周一 00:00 → 周日 23:59），窗口必然覆盖「现在」
 *  · CLOSED —— start === end（周一 00:00），`status()` 会落到「已过窗口」分支 → 恒关闭。
 *              用等长区间是为了在**任意运行时刻**都稳定关闭，不依赖今天是周几。
 */
const OPEN_WINDOW = { enabled: 1, startDay: 1, startTime: '00:00', endDay: 0, endTime: '23:59', reviewDay: null, reviewTime: null };
const CLOSED_WINDOW = { enabled: 1, startDay: 1, startTime: '00:00', endDay: 1, endTime: '00:00', reviewDay: null, reviewTime: null };

/** 系统下发的合法时段值（默认 07:20 / 12:20 / 17:30 × 下周一到周五） */
const nextMon = bj.ymd(bj.shifted(bj.nextWeekRange().start.getTime()));
const SLOT = `${nextMon} 早间 07:20`;
const SLOT2 = `${nextMon} 午间 12:20`;

/** 一条形状完整的 submit 文档（字段与 handlers/user/submit.newSubmitDoc 对齐） */
function submitDoc(o) {
  return {
    _id: o._id, id: o.id, openid: o.openid, type: o.type || 1,
    songName: o.songName || null, singer: o.singer || null, wishContent: o.wishContent || null,
    articleTitle: o.articleTitle || null, articleContent: o.articleContent || null,
    wantBroadcastTime: o.wantBroadcastTime || null,
    scheduledSlot: o.scheduledSlot || null, queueAt: null, promotedAt: null,
    reviewStatus: o.reviewStatus === undefined ? 0 : o.reviewStatus,
    scheduleStatus: o.scheduleStatus === undefined ? 0 : o.scheduleStatus,
    playStatus: o.playStatus === undefined ? 0 : o.playStatus,
    allowReschedule: o.allowReschedule === undefined ? 1 : o.allowReschedule,
    assignedAt: null, playedAt: null,
    status: o.status === undefined ? 0 : o.status,
    rejectReason: null, reviewerId: null, reviewTime: null, autoRejected: o.autoRejected || 0,
    createTime: o.createTime || new Date(),
    updateTime: o.updateTime || new Date(),
  };
}
const now = () => new Date();

(async () => {
  /* ══════════════════ A. 注意事项 ══════════════════ */
  section('A. /user/submit/notice · ackNotice');

  // A1. 没配置内容 → 不拦人（否则功能没上线就把入口堵死）
  reset(withKv({}, { user: [ACCOUNT] }));
  let r = await H.call(H.req('GET', '/user/submit/notice', {}, TOKEN));
  eq('notice 未配置 code', r.code, 0);
  eq('notice 未配置 configured=false', r.data.configured, false);
  eq('notice 未配置 needAck=false', r.data.needAck, false);
  eq('notice 未配置 content 为空', r.data.content, '');
  eq('notice 默认 type=song', r.data.type, 'song');
  eq('notice 未登录 → 40101（源路由挂了 userAuth）',
    (await H.call(H.req('GET', '/user/submit/notice'))).code, 40101);
  eq('ackNotice 未登录 → 40101',
    (await H.call(H.req('POST', '/user/submit/notice/ack', { version: 1 }))).code, 40101);

  // A2. 配置了内容 → 需要确认
  reset(withKv({ song_notice: '规则正文', song_notice_version: '3' }, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/notice', {}, TOKEN));
  eq('notice 已配置 configured=true', r.data.configured, true);
  eq('notice 已配置 needAck=true', r.data.needAck, true);
  eq('notice 正文', r.data.content, '规则正文');
  eq('notice 版本', r.data.version, 3);
  eq('notice ackedVersion 缺省 0', r.data.ackedVersion, 0);

  // A3. ack 后不再需要确认
  r = await H.call(H.req('POST', '/user/submit/notice/ack', { version: 3 }, TOKEN));
  eq('ack code', r.code, 0);
  eq('ack 后 needAck=false', r.data.needAck, false);
  eq('ack 后 ackedVersion=3', r.data.ackedVersion, 3);

  const ackDocs = H.dump().notice_ack || [];
  eq('notice_ack 落了一行', ackDocs.length, 1);
  eq('notice_ack 用业务键当 _id', ackDocs[0]._id, `ack:${USER}:song_submit`);
  eq('notice_ack 同时写了数字 id（与 MySQL 迁移对齐）', ackDocs[0].id, 1);

  // A4. 版本只增不减 + 超版本被夹住
  r = await H.call(H.req('POST', '/user/submit/notice/ack', { version: 999 }, TOKEN));
  eq('ack 超大版本被夹到当前版本', r.data.ackedVersion, 3);
  r = await H.call(H.req('POST', '/user/submit/notice/ack', { version: 1 }, TOKEN));
  eq('ack 小版本不回退', r.data.ackedVersion, 3);
  eq('ack 幂等：仍只有一行', (H.dump().notice_ack || []).length, 1);

  // A5. article 与 song 互不影响（各自独立的 KV 与 ack 键）
  reset(withKv({ song_notice: '歌规则', song_notice_version: '2' }, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/notice?type=article', {}, TOKEN));
  eq('article 未配置 → 不拦', r.data.configured, false);
  eq('article type 正确', r.data.type, 'article');
  eq('article key 正确', r.data.key, 'article_submit');

  /* ══════════════════ B. 时间窗口 ══════════════════ */
  section('B. /user/submit/window');

  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/window', {}, TOKEN));
  eq('window code', r.code, 0);
  eq('OPEN → open=true', r.data.open, true);
  ok('OPEN → windowText 含「每周一 00:00」', /每周一 00:00/.test(r.data.windowText), r.data.windowText);
  ok('OPEN → 给了 opensAt/closesAt', !!r.data.opensAt && !!r.data.closesAt);
  ok('window 带 reviewAt（审核截止独立于点播截止）', !!r.data.reviewAt, r.data.reviewAt);
  ok('window 带 week（含 reviewEndAt，前端别再用 lockAt−end 反算）',
    !!(r.data.week && r.data.week.reviewEndAt), JSON.stringify(r.data.week && r.data.week.reviewEndAt));

  reset(withKv({ song_submit_window: JSON.stringify(CLOSED_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/window', {}, TOKEN));
  eq('CLOSED → open=false', r.data.open, false);
  ok('CLOSED → 带出 opensAt（前端做倒计时）', !!r.data.opensAt, r.data.opensAt);
  eq('CLOSED → secondsToClose 为空', r.data.secondsToClose, null);

  // 关闭窗口限制（enabled=0）= 一直开放
  reset(withKv({ song_submit_window: JSON.stringify({ ...OPEN_WINDOW, enabled: 0 }) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/window', {}, TOKEN));
  eq('enabled=0 → 恒开放', r.data.open, true);
  eq('enabled=0 → windowText=不限时间', r.data.windowText, '不限时间');
  // ⚠️ 「路由层中间件」契约：源路由 `/submit/window` 挂了 userAuth，
  //    漏了不报错、只会「未登录也能看」→ 必须钉住。
  eq('window 未登录 → 40101（源路由挂了 userAuth）',
    (await H.call(H.req('GET', '/user/submit/window'))).code, 40101);

  /* ══════════════════ C. 可选时段 ══════════════════ */
  section('C. /user/submit/timeslots');

  reset(withKv({}, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/timeslots', {}, TOKEN));
  eq('timeslots code', r.code, 0);
  eq('默认 5 天 × 3 时段 = 15 条', r.data.list.length, 15);
  eq('第一条的时段值', r.data.list[0].value, SLOT);
  ok('每条带 capacity/seated/left/full/canBuffer',
    ['capacity', 'seated', 'left', 'full', 'canBuffer'].every((k) => k in r.data.list[0]));
  eq('协议版候补无上限', r.data.queue.unlimited, true);
  eq('候补 limit=0', r.data.queue.limit, 0);
  ok('带 window 与 week', !!r.data.window && !!r.data.week);
  ok('带 lockAt', !!r.data.lockAt, r.data.lockAt);

  // 容量=1 且已占用 1 → full（协议版：full 只是提示，**不阻止提交**）
  reset(withKv({ song_slot_capacity: '1' }, {
    user: [ACCOUNT],
    submit: [submitDoc({
      _id: 's1', id: 1, openid: USER, songName: 'A', wantBroadcastTime: SLOT,
      scheduledSlot: SLOT, reviewStatus: 1, scheduleStatus: 1, status: 1,
    })],
  }));
  r = await H.call(H.req('GET', '/user/submit/timeslots', {}, TOKEN));
  const first = r.data.list.find((x) => x.value === SLOT);
  eq('occupied slot: seated=1', first.seated, 1);
  eq('capacity=1 时该格 full=true', first.full, true);
  eq('full 时 canBuffer 仍为 false（可提交但会进候补/调剂）', first.canBuffer, false);
  const free = r.data.list.find((x) => x.value === SLOT2);
  eq('空格的 seated=0', free.seated, 0);
  eq('空格的 left=1', free.left, 1);
  eq('timeslots 未登录 → 40101（源路由挂了 userAuth）',
    (await H.call(H.req('GET', '/user/submit/timeslots'))).code, 40101);

  /* ══════════════════ D. quota ══════════════════ */
  section('D. /user/submit/quota');

  reset(withKv({}, { user: [ACCOUNT] }));
  r = await H.call(H.req('GET', '/user/submit/quota', {}, TOKEN));
  eq('quota code', r.code, 0);
  ok('quota 带 window/week/song/userWeekly',
    !!r.data.window && !!r.data.song && !!r.data.userWeekly);
  eq('每格容量默认 0（不限）', r.data.song.capacity, 0);
  eq('周上限默认 2', r.data.userWeekly.limit, 2);
  eq('已用 0 次', r.data.userWeekly.used, 0);
  eq('剩余 2 次', r.data.userWeekly.remaining, 2);
  eq('quota 未登录 → 40101', (await H.call(H.req('GET', '/user/submit/quota'))).code, 40101);

  /* ══════════════════ E. 首页本周排期 ══════════════════ */
  section('E. /user/submit/week');

  reset(withKv({}, { system_switch: [{ _id: 'switch:home_song_schedule', key: 'home_song_schedule', value: 'off' }] }));
  r = await H.call(H.req('GET', '/user/submit/week'));
  eq('开关 off → visible=false', r.data.visible, false);
  eq('开关 off → days 为空', r.data.days.length, 0);
  // ⚠️ **有意的例外**：源路由 `router.get('/submit/week', submit.weekSchedule)` ——
  //    全组唯一**没有**挂 userAuth 的接口（首页要能未登录看到本周歌单）。
  eq('week 未登录 → code 0（源路由确实没挂 userAuth）', r.code, 0);

  reset(withKv({}, {
    system_switch: [{ _id: 'switch:home_song_schedule', key: 'home_song_schedule', value: 'on' }],
    submit: [submitDoc({
      _id: 'w1', id: 1, openid: USER, songName: '本周歌',
      scheduledSlot: `${bj.ymd(bj.shifted(bj.weekRange().start.getTime()))} 早间 07:20`,
      reviewStatus: 1, scheduleStatus: 1, status: 1,
    })],
  }));
  r = await H.call(H.req('GET', '/user/submit/week'));
  eq('开关 on → visible=true', r.data.visible, true);
  eq('本周 5 天', r.data.days.length, 5);
  const d0 = r.data.days[0];
  eq('周一的第一首歌', d0.songs[0] && d0.songs[0].title, '本周歌');
  eq('歌曲带时刻', d0.songs[0] && d0.songs[0].time, '07:20');
  eq('歌曲带时段名', d0.songs[0] && d0.songs[0].period, '早间');
  ok('第一天 isToday 字段存在', 'isToday' in d0);

  /* ══════════════════ F. 我的投稿 / 详情 ══════════════════ */
  section('F. /user/submit/my · detail');

  const MINE = [
    submitDoc({ _id: 'm1', id: 11, openid: USER, songName: '旧', createTime: new Date('2026-09-01T10:00:00Z') }),
    submitDoc({ _id: 'm2', id: 12, openid: USER, songName: '新', createTime: new Date('2026-09-10T10:00:00Z') }),
    submitDoc({ _id: 'm3', id: 13, openid: USER, songName: '候补', reviewStatus: 1, scheduleStatus: 2, status: 3, createTime: new Date('2026-09-05T10:00:00Z') }),
    submitDoc({ _id: 'm4', id: 14, openid: OTHER, songName: '别人的', createTime: new Date('2026-09-20T10:00:00Z') }),
  ];

  reset(withKv({}, { user: [ACCOUNT, ACCOUNT_OTHER], submit: MINE }));
  r = await H.call(H.req('GET', '/user/submit/my', {}, TOKEN));
  eq('my code', r.code, 0);
  eq('my 只含自己的（3 条，不含别人的）', r.data.total, 3);
  eq('my 时间倒序', r.data.list[0].songName, '新');
  eq('my 未登录 → 40101', (await H.call(H.req('GET', '/user/submit/my'))).code, 40101);

  r = await H.call(H.req('GET', '/user/submit/my?pageSize=2&page=2', {}, TOKEN));
  eq('my 分页 page=2 size=2 → 1 条', r.data.list.length, 1);
  eq('my 分页回显 page', r.data.page, 2);
  eq('my 分页 total 不受分页影响', r.data.total, 3);

  r = await H.call(H.req('GET', '/user/submit/my?status=3', {}, TOKEN));
  eq('my 按派生 status=3 筛出候补', r.data.list.length, 1);
  eq('my 候补那条的歌名', r.data.list[0].songName, '候补');

  // 状态卡：候补中的应带 queue 卡
  reset(withKv({}, { user: [ACCOUNT], submit: [MINE[2]] }));
  r = await H.call(H.req('GET', '/user/submit/my', {}, TOKEN));
  ok('候补行带 card', !!r.data.list[0].card, JSON.stringify(r.data.list[0].card));
  eq('card.type=queue', r.data.list[0].card.type, 'queue');
  eq('card 带 queuePos', r.data.list[0].card.queuePos, 1);
  eq('card 有「放弃候补」动作', r.data.list[0].card.actions[0].key, 'leave');
  eq('cards 汇总数组长度 1', r.data.cards.length, 1);

  // 待审行不该有 card（不特殊渲染）
  reset(withKv({}, { user: [ACCOUNT], submit: [MINE[0]] }));
  r = await H.call(H.req('GET', '/user/submit/my', {}, TOKEN));
  eq('待审行 card=null', r.data.list[0].card, null);

  // detail
  reset(withKv({}, { user: [ACCOUNT, ACCOUNT_OTHER], submit: MINE }));
  r = await H.call(H.req('GET', '/user/submit/12', {}, TOKEN));
  eq('detail 自己的 code', r.code, 0);
  eq('detail 三维下发 reviewStatus', r.data.reviewStatus, 0);
  eq('detail 三维下发 scheduleStatusName', r.data.scheduleStatusName, 'UNASSIGNED');
  eq('detail 镜像 status', r.data.status, 0);
  eq('detail 镜像 statusText', r.data.statusText, '待审核');

  eq('detail 别人的 → 40401', (await H.call(H.req('GET', '/user/submit/14', {}, TOKEN))).code, 40401);
  eq('detail 不存在 → 40401', (await H.call(H.req('GET', '/user/submit/999', {}, TOKEN))).code, 40401);
  eq('detail 非法 id → 40401（不抛异常）', (await H.call(H.req('GET', '/user/submit/abc', {}, TOKEN))).code, 40401);
  eq('detail 未登录 → 40101', (await H.call(H.req('GET', '/user/submit/12'))).code, 40101);

  // 状态历史
  reset(withKv({}, {
    user: [ACCOUNT],
    submit: [MINE[0]],
    request_status_log: [
      { _id: 'l1', id: 1, requestId: 11, operatorName: 'ADMIN', dimension: 'review', fromStatus: 'PENDING_REVIEW', toStatus: 'APPROVED' },
      { _id: 'l2', id: 2, requestId: 11, operatorName: 'SYSTEM', dimension: 'schedule', fromStatus: 'UNASSIGNED', toStatus: 'APPROVED' },
    ],
  }));
  r = await H.call(H.req('GET', '/user/submit/11', {}, TOKEN));
  eq('detail 带 statusHistory', r.data.statusHistory.length, 2);
  eq('statusHistory 按 id 升序', r.data.statusHistory[0].fromStatus, 'PENDING_REVIEW');

  /* ══════════════════ G. 提交投稿：拦截链 ══════════════════ */
  section('G. POST /user/submit —— 拦截链（顺序即契约）');

  const baseBody = { type: 1, songName: '晴天', singer: '周杰伦', wishContent: '生日快乐', wantBroadcastTime: SLOT };

  // G1. 未登录最先
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }));
  eq('create 未登录 → 40101', (await H.call(H.req('POST', '/user/submit', baseBody))).code, 40101);

  // G2. type 非法
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  eq('type=9 → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, type: 9 }, TOKEN))).code, 40001);

  // G3. 模块开关（**先于**窗口判断）
  reset(withKv({ song_submit_window: JSON.stringify(CLOSED_WINDOW) }, {
    user: [ACCOUNT],
    system_switch: [{ _id: 'switch:submit_song', key: 'submit_song', value: 'off' }],
  }));
  eq('模块关闭 → 40302（先于窗口）',
    (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 40302);

  // G4. 窗口关闭 → 40907，且 data 必须带 opensAt（前端拉倒计时用）
  reset(withKv({ song_submit_window: JSON.stringify(CLOSED_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('POST', '/user/submit', baseBody, TOKEN));
  eq('窗口外 → 40907', r.code, 40907);
  ok('40907 带 opensAt', !!(r.data && r.data.opensAt), JSON.stringify(r.data));
  ok('40907 带 windowText', !!(r.data && r.data.windowText));
  // 窗口优先于「缺时段」：即使 wantBroadcastTime 为空也应先报 40907
  eq('窗口优先于时段校验 → 仍 40907',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, wantBroadcastTime: '' }, TOKEN))).code, 40907);

  // G5. 注意事项未确认 → 40303（先于时段/规则）
  reset(withKv({
    song_submit_window: JSON.stringify(OPEN_WINDOW),
    song_notice: '规则正文', song_notice_version: '3',
  }, { user: [ACCOUNT] }));
  r = await H.call(H.req('POST', '/user/submit', { ...baseBody, wantBroadcastTime: '乱填的' }, TOKEN));
  eq('注意事项未确认 → 40303（先于时段合法性）', r.code, 40303);
  ok('40303 文案含「确认」', /确认/.test(r.message), r.message);

  // 确认后放行到下一层
  await H.call(H.req('POST', '/user/submit/notice/ack', { version: 3 }, TOKEN));
  eq('确认后：非法时段 → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, wantBroadcastTime: '乱填的' }, TOKEN))).code, 40001);

  // G6. 时段缺失 / 非法
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  eq('缺 wantBroadcastTime → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, wantBroadcastTime: '' }, TOKEN))).code, 40001);
  eq('非法时段（非系统下发）→ 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, wantBroadcastTime: '2026-09-21 午间 12:20' }, TOKEN))).code, 40001);

  // G7. 同曲一周去重 → 40903（先于字段校验）
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'd1', id: 1, openid: OTHER, songName: '晴天', wantBroadcastTime: SLOT, status: 0 })],
  }));
  r = await H.call(H.req('POST', '/user/submit', { ...baseBody, singer: '' }, TOKEN));
  eq('同曲重复 → 40903（先于「缺歌手」40001）', r.code, 40903);
  ok('40903 文案含歌名', /晴天/.test(r.message), r.message);

  // 归一化比较：全角 / 空格 / 大小写都算同一首
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'd2', id: 1, openid: OTHER, songName: 'qī晴天', status: 0 })],
  }));
  eq('归一化：全角/空格视为同曲 → 40903',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, songName: 'Ｑī 晴天' }, TOKEN))).code, 40903);

  // 被驳回的不占坑 → 可以再点
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'd3', id: 1, openid: OTHER, songName: '晴天', status: 2, reviewStatus: 2 })],
  }));
  eq('已被驳回的同名歌不算占用 → 放行', (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 0);

  // G8. 周次数上限 → 40903（默认每周 2 次）
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [
      submitDoc({ _id: 'q1', id: 1, openid: USER, songName: 'A', createTime: now() }),
      submitDoc({ _id: 'q2', id: 2, openid: USER, songName: 'B', createTime: now() }),
    ],
  }));
  r = await H.call(H.req('POST', '/user/submit', baseBody, TOKEN));
  eq('本周已用 2 次 → 40903', r.code, 40903);
  ok('40903 文案含次数', /次数/.test(r.message), r.message);

  // 系统自动驳回的不占学生次数
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [
      submitDoc({ _id: 'q3', id: 1, openid: USER, songName: 'A', autoRejected: 1 }),
      submitDoc({ _id: 'q4', id: 2, openid: USER, songName: 'B', autoRejected: 1 }),
    ],
  }));
  eq('系统自动驳回的不占次数 → 放行', (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 0);

  // 别人的点歌不占我的次数
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [
      submitDoc({ _id: 'q5', id: 1, openid: OTHER, songName: 'A' }),
      submitDoc({ _id: 'q6', id: 2, openid: OTHER, songName: 'B' }),
    ],
  }));
  eq('别人的点歌不占我的周次数 → 放行', (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 0);

  // G9. 字段校验
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  eq('缺歌名 → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, songName: '' }, TOKEN))).code, 40001);
  eq('缺歌手 → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, singer: '' }, TOKEN))).code, 40001);
  eq('祝福语 > 500 字 → 40001',
    (await H.call(H.req('POST', '/user/submit', { ...baseBody, wishContent: 'x'.repeat(501) }, TOKEN))).code, 40001);
  eq('文稿缺标题 → 40001',
    (await H.call(H.req('POST', '/user/submit', { type: 2, articleContent: '正文' }, TOKEN))).code, 40001);
  eq('文稿正文 > 5000 字 → 40001',
    (await H.call(H.req('POST', '/user/submit', { type: 2, articleTitle: 'T', articleContent: 'x'.repeat(5001) }, TOKEN))).code, 40001);

  // 文稿不受点歌窗口限制
  reset(withKv({ song_submit_window: JSON.stringify(CLOSED_WINDOW) }, { user: [ACCOUNT] }));
  eq('窗口关闭时文稿仍可提交',
    (await H.call(H.req('POST', '/user/submit', { type: 2, articleTitle: 'T', articleContent: '正文' }, TOKEN))).code, 0);

  // G10. 1 分钟防重复 → 40901
  //
  // ⚠️ 造这个用例要绕开「同曲去重」：checkSubmit 排在防重复**之前**，
  //    所以「1 分钟前投过同一首歌」会先命中 40903，根本走不到 40901。
  //    这里用一条**已被驳回**的同名记录 —— 驳回的不算占坑（同曲检查放过），
  //    但它照样算学生的周次数、也照样命中 1 分钟防重复窗口。
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({
      _id: 'r1', id: 1, openid: USER, songName: '晴天',
      reviewStatus: 2, status: 2, createTime: now(),
    })],
  }));
  eq('1 分钟内同曲重提 → 40901（不是 40903）',
    (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 40901);

  // 超过 1 分钟就不算重提（此处另一首歌，避开同曲规则）
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({
      _id: 'r2', id: 1, openid: USER, songName: '晴天',
      createTime: new Date(Date.now() - 2 * 60 * 1000),
    })],
  }));
  eq('超过 1 分钟 → 不算重提（但同曲仍在，故 40903）',
    (await H.call(H.req('POST', '/user/submit', baseBody, TOKEN))).code, 40903);

  /* ══════════════════ H. 提交成功：落库形状 ══════════════════ */
  section('H. POST /user/submit —— 成功路径与落库');

  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('POST', '/user/submit', baseBody, TOKEN));
  eq('create code', r.code, 0);
  eq('create outcome', r.data.outcome, 'submitted');
  eq('create 返回数字 id', r.data.id, 1);
  eq('create 三维：reviewStatus=PENDING', r.data.reviewStatus, 0);
  eq('create 三维：scheduleStatus=UNASSIGNED', r.data.scheduleStatus, 0);
  eq('create 默认允许调剂', r.data.allowReschedule, true);
  ok('create 带 week（周行已懒创建）', !!r.data.week && !!r.data.week.weekStartDate, JSON.stringify(r.data.week));
  // 周状态是**按时间派生**的：本例把窗口设成「点播周整周」，所以「现在」正落在点播期内
  // → APPLICATION。这里只断言「落在合法六态里」，不钉死具体值 ——
  // 否则一改窗口配置（比如以后默认窗口变成周六18:00）这条就会假失败。
  ok('create week.status 是六个周状态之一',
    ['DRAFT', 'APPLICATION', 'REVIEW', 'SCHEDULING', 'LOCKED', 'CANCELLED'].includes(r.data.week.status),
    r.data.week.status);
  ok('create weekText 含周起始日', new RegExp(r.data.week.weekStartDate).test(r.data.weekText), r.data.weekText);
  ok('create 带 lockAt', !!r.data.lockAt, r.data.lockAt);

  const submitRows = H.dump().submit || [];
  eq('落库 1 行', submitRows.length, 1);
  const sd = submitRows[0];
  eq('落库 status 镜像=0（待审核）', sd.status, 0);
  eq('落库 reviewStatus=0', sd.reviewStatus, 0);
  eq('落库 scheduleStatus=0', sd.scheduleStatus, 0);
  eq('落库 playStatus=0', sd.playStatus, 0);
  eq('落库 allowReschedule=1', sd.allowReschedule, 1);
  eq('落库 openid=学号', sd.openid, USER);
  eq('落库 wantBroadcastTime 原文', sd.wantBroadcastTime, SLOT);
  eq('落库 autoRejected=0', sd.autoRejected, 0);
  // null 字段必须**存在**（否则前端 JSON 里整个键消失）
  ok('落库字段写全（scheduledSlot 存在且为 null）', 'scheduledSlot' in sd && sd.scheduledSlot === null);
  ok('落库字段写全（rejectReason 存在且为 null）', 'rejectReason' in sd && sd.rejectReason === null);

  // 周行懒创建：_id 必须是业务键
  const weekRows = H.dump().weekly_schedule || [];
  eq('周行懒创建了 1 条', weekRows.length, 1);
  ok('周行 _id = week:<date>', /^week:\d{4}-\d{2}-\d{2}$/.test(weekRows[0]._id), weekRows[0]._id);
  eq('周行数字 id=1', weekRows[0].id, 1);
  eq('周行 lockPaused 初始为 0', weekRows[0].lockPaused, 0);
  ok('周行锚点齐全', ['applicationStartAt', 'applicationEndAt', 'scheduleLockAt', 'reviewEndAt']
    .every((k) => weekRows[0][k] instanceof Date), JSON.stringify(Object.keys(weekRows[0])));

  // 不接受调剂
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('POST', '/user/submit', { ...baseBody, allowReschedule: false }, TOKEN));
  eq('allowReschedule=false 回显 false', r.data.allowReschedule, false);
  eq('落库 allowReschedule=0', (H.dump().submit || [])[0].allowReschedule, 0);

  // 文稿落库
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, { user: [ACCOUNT] }));
  r = await H.call(H.req('POST', '/user/submit', { type: 2, articleTitle: '题目', articleContent: '正文' }, TOKEN));
  eq('文稿 create code', r.code, 0);
  eq('文稿 outcome', r.data.outcome, 'submitted');
  const art = (H.dump().submit || [])[0];
  eq('文稿 type=2', art.type, 2);
  eq('文稿 title 落库', art.articleTitle, '题目');
  eq('文稿不建周行（只有点歌才懒建）', (H.dump().weekly_schedule || []).length, 0);

  // id 单调递增（不与已有数据撞号）
  reset(withKv({ song_submit_window: JSON.stringify(OPEN_WINDOW) }, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'x1', id: 41, openid: OTHER, songName: '旧数据' })],
  }));
  r = await H.call(H.req('POST', '/user/submit', baseBody, TOKEN));
  eq('新 id 接在既有最大 id 之后（防撞号）', r.data.id, 42);

  /* ══════════════════ I. 取消 / 放弃候补 ══════════════════ */
  section('I. DELETE /user/submit/:id · leave-queue');

  // I1. 待审可撤销
  reset(withKv({}, { user: [ACCOUNT], submit: [submitDoc({ _id: 'c1', id: 1, openid: USER, songName: 'A' })] }));
  r = await H.call(H.req('DELETE', '/user/submit/1', {}, TOKEN));
  eq('撤销待审 code', r.code, 0);
  let row = (H.dump().submit || [])[0];
  eq('撤销后 reviewStatus=CANCELLED(3)', row.reviewStatus, 3);
  eq('撤销后镜像 status=CANCELLED(7)', row.status, 7);
  eq('撤销后 scheduleStatus 不变', row.scheduleStatus, 0);

  r = await H.call(H.req('DELETE', '/user/submit/1', {}, TOKEN));
  eq('重复撤销幂等 → code 0', r.code, 0);

  const logs = H.dump().request_status_log || [];
  eq('撤销落了一条状态日志', logs.length, 1);
  eq('日志维度=review', logs[0].dimension, 'review');
  eq('日志 toStatus=CANCELLED', logs[0].toStatus, 'CANCELLED');
  eq('日志 operatorName=USER', logs[0].operatorName, 'USER');
  eq('日志 reason=USER_CANCEL', logs[0].reason, 'USER_CANCEL');
  eq('日志 requestId 用数字 id', logs[0].requestId, 1);

  // I2. 候补中的**也允许**直接撤销
  //
  // ⚠️ 原 cancel() 里有一条 `schedule === WAITING ? '这是候补中的点歌，请用「放弃候补」'` 的文案，
  //    但它挂在 `!revocable` 分支下 —— 而 `APPROVED + WAITING` 恰好**是** revocable 的，
  //    所以那个分支**永远不可达**。这是原实现的死文案，已经如实移植（见 submit.cancel 注释），
  //    行为不变：候补中走 DELETE 与走 leave-queue 等价，都是 reviewStatus → CANCELLED。
  //    本用例就是在钉住这个「看起来该拦、实际放行」的既有行为，别在移植时"顺手修正"。
  reset(withKv({}, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'c2', id: 2, openid: USER, songName: 'B', reviewStatus: 1, scheduleStatus: 2, status: 3 })],
  }));
  r = await H.call(H.req('DELETE', '/user/submit/2', {}, TOKEN));
  eq('候补中撤销 → 允许（code 0，与原实现一致）', r.code, 0);
  eq('候补中撤销后 reviewStatus=3', (H.dump().submit || [])[0].reviewStatus, 3);

  // I3. 已排期不能撤
  reset(withKv({}, {
    user: [ACCOUNT],
    submit: [submitDoc({
      _id: 'c3', id: 3, openid: USER, songName: 'C',
      reviewStatus: 1, scheduleStatus: 1, status: 1, scheduledSlot: SLOT,
    })],
  }));
  eq('已排期撤销 → 40301',
    (await H.call(H.req('DELETE', '/user/submit/3', {}, TOKEN))).code, 40301);

  // I4. 放弃候补
  reset(withKv({}, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'c4', id: 4, openid: USER, songName: 'D', reviewStatus: 1, scheduleStatus: 2, status: 3 })],
  }));
  r = await H.call(H.req('POST', '/user/submit/4/leave-queue', {}, TOKEN));
  eq('放弃候补 code', r.code, 0);
  row = (H.dump().submit || [])[0];
  eq('放弃候补后 reviewStatus=3', row.reviewStatus, 3);
  eq('放弃候补后镜像 status=7', row.status, 7);
  const ll = (H.dump().request_status_log || [])[0];
  eq('放弃候补日志 reason', ll.reason, 'USER_LEAVE_QUEUE');

  // I5. 非候补的状态 → 40001
  reset(withKv({}, { user: [ACCOUNT], submit: [submitDoc({ _id: 'c5', id: 5, openid: USER, songName: 'E' })] }));
  eq('待审时放弃候补 → 40001',
    (await H.call(H.req('POST', '/user/submit/5/leave-queue', {}, TOKEN))).code, 40001);

  // I6. 别人的投稿动不了 / 未登录
  reset(withKv({}, {
    user: [ACCOUNT, ACCOUNT_OTHER],
    submit: [submitDoc({ _id: 'c6', id: 6, openid: OTHER, songName: 'F' })],
  }));
  eq('撤别人的 → 40401', (await H.call(H.req('DELETE', '/user/submit/6', {}, TOKEN))).code, 40401);
  eq('放弃别人的候补 → 40401',
    (await H.call(H.req('POST', '/user/submit/6/leave-queue', {}, TOKEN))).code, 40401);
  eq('撤销未登录 → 40101', (await H.call(H.req('DELETE', '/user/submit/6'))).code, 40101);
  eq('非法 id 撤销 → 40401', (await H.call(H.req('DELETE', '/user/submit/abc', {}, TOKEN))).code, 40401);

  // I7. 撤销一条**占位中**的（APPROVED+WAITING）→ 触发 afterRelease（阶段 5 未移植，应被兜住）
  reset(withKv({}, {
    user: [ACCOUNT],
    submit: [submitDoc({ _id: 'c7', id: 7, openid: USER, songName: 'G', reviewStatus: 1, scheduleStatus: 2, status: 3 })],
  }));
  r = await H.call(H.req('POST', '/user/submit/7/leave-queue', {}, TOKEN));
  eq('占位中放弃候补：afterRelease 未移植也不影响取消成功', r.code, 0);

  /* ══════════════════ J. 乐观锁（applyChange） ══════════════════ */
  section('J. applyChange 乐观锁 —— 静默分支');

  // J1. 冲突：读到的 scheduleStatus 与库里不一致 → 影响 0 行 → 空 logs
  reset({ submit: [submitDoc({
    _id: 'k1', id: 1, openid: USER, songName: 'K',
    reviewStatus: 1, scheduleStatus: 2, status: 3,
  })] });
  const stale = { id: 1, reviewStatus: 1, scheduleStatus: 0, playStatus: 0, status: 6 };
  const res = await S.applyChange(stale, { scheduleStatus: 1, scheduledSlot: SLOT }, { operatorName: 'SYSTEM' });
  eq('并发冲突 → logs 为空', res.logs.length, 0);
  eq('并发冲突 → conflict=true', res.conflict, true);
  const after = (H.dump().submit || [])[0];
  eq('并发冲突 → 库里未被改动', after.scheduleStatus, 2);
  eq('并发冲突 → 库里 scheduledSlot 未写', after.scheduledSlot, null);
  eq('并发冲突 → 无状态日志', (H.dump().request_status_log || []).length, 0);

  // J2. 正常：条件命中 → 写库 + 落日志 + 内存对象同步
  reset({ submit: [submitDoc({
    _id: 'k2', id: 2, openid: USER, songName: 'L',
    reviewStatus: 1, scheduleStatus: 0, status: 6,
  })] });
  const live = { id: 2, reviewStatus: 1, scheduleStatus: 0, playStatus: 0, status: 6 };
  const res2 = await S.applyChange(live, { scheduleStatus: 1, scheduledSlot: SLOT }, { operatorName: 'SYSTEM', reason: 'INITIAL_ALLOCATION' });
  eq('乐观锁命中 → logs 1 条', res2.logs.length, 1);
  eq('乐观锁命中 → status 派生为已排期(1)', res2.status, 1);
  eq('乐观锁命中 → 内存对象同步 scheduleStatus', live.scheduleStatus, 1);
  eq('乐观锁命中 → 内存对象同步 status', live.status, 1);
  const after2 = (H.dump().submit || [])[0];
  eq('乐观锁命中 → 库里 scheduleStatus=1', after2.scheduleStatus, 1);
  eq('乐观锁命中 → 库里 status=1', after2.status, 1);
  eq('乐观锁命中 → 库里写入了 scheduledSlot', after2.scheduledSlot, SLOT);
  const lg = (H.dump().request_status_log || [])[0];
  eq('日志 fromStatus', lg.fromStatus, 'UNASSIGNED');
  eq('日志 toStatus', lg.toStatus, 'APPROVED');
  eq('日志 reason', lg.reason, 'INITIAL_ALLOCATION');

  // J3. 白名单：非白名单字段被丢弃（防止手滑改到别处）
  reset({ submit: [submitDoc({ _id: 'k3', id: 3, openid: USER, songName: 'M' })] });
  const w = { id: 3, reviewStatus: 0, scheduleStatus: 0, playStatus: 0, status: 0 };
  await S.applyChange(w, { rejectedNote: 'hack', songName: '篡改' }, { operatorName: 'ADMIN' });
  const after3 = (H.dump().submit || [])[0];
  eq('白名单：songName 没被改', after3.songName, 'M');
  ok('白名单：未知字段没落库', after3.rejectedNote === undefined);
  eq('白名单：无维度变化 → 不落日志', (H.dump().request_status_log || []).length, 0);

  // J4. 派生镜像函数本身
  eq('deriveStatus 播放优先', S.deriveStatus(1, 1, 1), 5);
  eq('deriveStatus 取消 > 驳回', S.deriveStatus(3, 0, 0), 7);
  eq('deriveStatus 自动驳回 → 镜像 2', S.deriveStatus(1, 3, 0), 2);
  eq('deriveStatus 候补 → 镜像 3', S.deriveStatus(1, 2, 0), 3);
  eq('deriveStatus 已通过待排期 → 镜像 6', S.deriveStatus(1, 0, 0), 6);
  eq('statusView 名称', S.statusView({ reviewStatus: 2, scheduleStatus: 0, playStatus: 0 }).reviewStatusName, 'REJECTED');
  eq('statusView statusText', S.statusView({ reviewStatus: 2, scheduleStatus: 0, playStatus: 0 }).statusText, '已驳回');

  /* ══════════════════ K. 阶段 5 排期算法导出面 ══════════════════ */
  section('K. 阶段 5 排期算法：12 个函数必须全部导出且可调用');

  // ⚠️ 阶段 5 收尾后，原先的「占位抛错」机制（NOT_PORTED_YET）已**整体拆除** ——
  //    现在这条断言反向守住：**排期算法的导出面一个都不能少**。
  //    （导出面被误删的表现是 `sched.xxx is not a function`，只在真调到的分支才炸。）
  const SCHED_EXPORTS = [
    'logAssignment', 'initialAllocate', 'reschedule', 'runAllocators', 'afterRelease',
    'lockWeek', 'unlockWeek', 'cancelWeek',
    'markPlayed', 'setPlayed', 'manualAssign', 'sweep',
  ];
  const missing = SCHED_EXPORTS.filter((n) => typeof sched[n] !== 'function');
  eq('阶段 5 排期算法 12 个函数全部导出', JSON.stringify(missing), JSON.stringify([]));
  ok('占位机制已拆除（不再有 NOT_PORTED_YET）', sched.NOT_PORTED_YET === undefined);
  // 读路径也必须还在（阶段 4 的成果不能被阶段 5 的改动挤掉）
  eq('阶段 4 读路径仍在（canCrossSlot / waitingSnapshot / weekView）',
    JSON.stringify(['canCrossSlot', 'waitingSnapshot', 'weekView'].filter((n) => typeof sched[n] !== 'function')),
    JSON.stringify([]));

  /* ══════════════════ 汇总 ══════════════════ */
  console.log(lines.join('\n'));
  const total = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  console.log(`\n结论：${total} 行 / 失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 2);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
