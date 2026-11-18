'use strict';

/**
 * 栏目播出编排 + 日期投影 · 2026-11-19
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-program-slot.js
 *
 * 守的是陛下这一轮的三句话：
 *   ①「日期选择做成每周周几，不需要具体日期，除非是特别节目档」
 *   ②「一天的中午档可能会播 2-3 个，下午也是」→ 栏目必须落在「时段 + 第几档」
 *   ③「早间午间晚间的时间我没法设置，每个时段多少个档我也没办法增删，档的时间也没办法修改」
 *      → 时段名 / 起止 / 档数**全部走配置**，不许写死在代码或界面里
 *   最终定稿口径：站里只有午间 12:10-12:30、晚间 17:40-18:10，**每段 3 档**。
 *
 * 为什么必须单独测这一层（这轮改动的真正成本所在）：
 *   `broadcast_date` 是小程序节目单（/user/program/weekly、/schedule）与首页
 *   「今天 12:10 见」**唯一**的时间依据。库里改成「每周几」之后，那些按日期
 *   between 的查询会**一条都查不到 —— 不报错、列表静默变空**。
 *   所以真正要证明的不是「字段加上了」，而是：
 *     · 库里没存日期，下发时能投影出本周具体日期（小程序一行都不用改）
 *     · 改了档数 / 时长，已经排好的栏目时间**自动跟着走**（不用逐条重排）
 *     · 老数据（改造前录的、只有 broadcastDate 没有 weekdays）不会因为升级而消失
 *     · 编排写入只有超管能改（社干能看不能改）
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const S = require(path.join(API_DIR, 'services', 'programSlot'));

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
const CLUB_TOKEN = sign({ id: 2, username: 'editor', role: 1 });

/** 站里真实的编排（陛下口述，一字不差） */
const REAL = [
  { label: '午间', start: '12:10', end: '12:30', count: 3 },
  { label: '晚间', start: '17:40', end: '18:10', count: 3 },
];

/** 固定的一周：2026-11-16 是周一，2026-11-22 是周日 —— 用例永远不依赖「今天是周几」 */
const MON = '2026-11-16';
const WED = '2026-11-18';
const FRI = '2026-11-20';
const SUN = '2026-11-22';

/** 造一条栏目行（只给 expand 用，不进库） */
function row(o) {
  return Object.assign({
    id: 1,
    title: '校园早班车',
    host: '李述祥',
    broadcastTime: '',
    broadcastDate: null,
    weekdays: '1,3',
    slotLabel: '午间',
    slotIndex: 2,
    isSpecial: 0,
    isShow: 1,
    sort: 0,
  }, o);
}

async function main() {
  /* ══════════════ A. 档位切分（机器算，不写死） ══════════════ */
  section('A. slotTicks —— 时段怎么切成档');

  eq('午间 12:10-12:30 分 3 档', S.slotTicks(REAL[0]).map((t) => t.text),
    ['12:10-12:17', '12:17-12:24', '12:24-12:30']);
  eq('晚间 17:40-18:10 分 3 档', S.slotTicks(REAL[1]).map((t) => t.text),
    ['17:40-17:50', '17:50-18:00', '18:00-18:10']);
  ok('末档强制收在 end（20 分钟除不尽也不会溢出）',
    S.slotTicks({ start: '12:10', end: '12:30', count: 3 }).slice(-1)[0].end === '12:30');
  ok('首档起点就是时段起点',
    S.slotTicks({ start: '17:40', end: '18:10', count: 3 })[0].start === '17:40');
  eq('分 1 档 = 整段', S.slotTicks({ start: '12:10', end: '12:30', count: 1 }).map((t) => t.text),
    ['12:10-12:30']);
  ok('index 从 1 开始（界面上是「第 3 档」不是「第 2 档」）',
    S.slotTicks(REAL[0]).map((t) => t.index).join(',') === '1,2,3');
  ok('档数改了，切分跟着改（20 分钟分 4 档 = 每档 5 分钟）',
    S.slotTicks({ start: '12:10', end: '12:30', count: 4 }).map((t) => t.text).join('|')
      === '12:10-12:15|12:15-12:20|12:20-12:25|12:25-12:30');
  eq('起止非法（end <= start）→ 不给档，不抛错', S.slotTicks({ start: '12:30', end: '12:10', count: 3 }), []);
  eq('空参数 → []', S.slotTicks(null), []);

  /* ══════════════ B. 编排归一化（配坏了也不许让功能挂掉） ══════════════ */
  section('B. normalizeSlots —— 配坏了往回收，不报错');

  eq('按起点升序（用户可能倒着加）',
    S.normalizeSlots([
      { label: '晚间', start: '17:40', end: '18:10', count: 3 },
      { label: '午间', start: '12:10', end: '12:30', count: 3 },
    ]).map((s) => s.label), ['午间', '晚间']);

  ok('丢掉没名字的 / 时间格式不对的 / end<=start 的',
    S.normalizeSlots([
      { label: '', start: '08:00', end: '09:00', count: 2 },
      { label: '早间', start: '8:00', end: '09:00', count: 2 },
      { label: '午间', start: '12:30', end: '12:10', count: 2 },
      { label: '晚间', start: '17:40', end: '18:10', count: 3 },
    ]).map((s) => s.label).join(',') === '晚间');

  ok('重名只留第一个（同一时段不能出现两次）',
    S.normalizeSlots([
      { label: '午间', start: '12:10', end: '12:30', count: 3 },
      { label: '午间', start: '13:10', end: '13:30', count: 2 },
    ]).length === 1);

  eq('档数夹到 1..6（0 或 99 都不会把界面搞崩）',
    S.normalizeSlots([
      { label: '午间', start: '12:10', end: '12:30', count: 0 },
      { label: '晚间', start: '17:40', end: '18:10', count: 99 },
    ]).map((s) => s.count), [1, 6]);

  ok('最多 6 个时段', S.normalizeSlots(Array.from({ length: 9 }, (_, i) => ({
    label: 'T' + i, start: `0${i}:00`, end: `0${i}:30`, count: 1,
  }))).length === 6);

  /* ══════════════ C. 默认值 = 站里真实配置；落库能读回来 ══════════════ */
  section('C. getSlots / setSlots');

  H.reset({});
  S.clearCache();
  eq('没配过 = 午间 12:10-12:30 · 3 档 + 晚间 17:40-18:10 · 3 档',
    (await S.getSlots()).map((s) => `${s.label} ${s.start}-${s.end} x${s.count}`),
    ['午间 12:10-12:30 x3', '晚间 17:40-18:10 x3']);

  const withTicks = await S.getSlotsWithTicks();
  ok('对外输出自带每档推算（前端不用重算一遍）',
    withTicks.length === 2 && withTicks[0].ticks.length === 3 && withTicks[0].minutes === 20,
    JSON.stringify(withTicks.map((s) => ({ l: s.label, m: s.minutes, t: s.ticks.length }))));

  await S.setSlots([
    { label: '晚间', start: '17:40', end: '18:10', count: 3 },
    { label: '午间', start: '12:10', end: '12:30', count: 3 },
    { label: '午间', start: '12:40', end: '12:50', count: 1 },   // 重名 → 丢掉
  ]);
  S.clearCache();   // 模拟另一台实例读到最新值
  eq('存进去之后读回来（重名被丢掉，顺序被扶正）',
    (await S.getSlots()).map((s) => s.label), ['午间', '晚间']);

  const empty = await S.setSlots([]);
  eq('全部非法 → 返回 null，不写空配置（哪怕前端传了个空数组）', empty, null);
  S.clearCache();
  eq('而且原配置没被清掉', (await S.getSlots()).map((s) => s.label), ['午间', '晚间']);

  /* ══════════════ D. 投影：周几 → 本周具体日期 ══════════════ */
  section('D. expand —— 库里没日期，下发时有日期');

  let out = await S.expand([row({ weekdays: '1,3', slotIndex: 2 })], MON, SUN, REAL);
  eq('每周一、三 → 本周正好 2 条', out.length, 2);
  eq('具体日期是投影出来的', out.map((x) => x.broadcastDate), [MON, WED]);
  eq('时间按「午间第 2 档」算', out.map((x) => x.broadcastTime), ['12:17-12:24', '12:17-12:24']);
  ok('标了 cyclic（周期栏目），occurKey 唯一', out.every((x) => x.cyclic === 1 && x.occKey === `1-${x.broadcastDate}`));

  out = await S.expand([row({ weekdays: '7', slotLabel: '晚间', slotIndex: 1 })], MON, SUN, REAL);
  eq('只排周日 → 1 条，落在 11-22', out.map((x) => `${x.broadcastDate} ${x.broadcastTime}`), [`${SUN} 17:40-17:50`]);

  // 改了编排，已排栏目自动跟着变 —— 这是「改档数不用重新排一遍」的关键
  const WIDE = [{ label: '午间', start: '12:10', end: '12:30', count: 4 }, { label: '晚间', start: '17:40', end: '18:10', count: 3 }];
  out = await S.expand([row({ weekdays: '1', slotIndex: 2 })], MON, SUN, WIDE);
  eq('午间改成 4 档后，第 2 档自动变 12:15-12:20', out[0] && out[0].broadcastTime, '12:15-12:20');

  // 档位不存在（比如从 3 档改成 2 档，原来第 3 档的栏目）→ 不许崩，保留原时间
  out = await S.expand([row({ weekdays: '1', slotIndex: 3, broadcastTime: '12:24-12:30' })], MON, SUN,
    [{ label: '午间', start: '12:10', end: '12:30', count: 2 }]);
  ok('档位被删掉了 → 沿用原 broadcastTime，不吞掉这条栏目',
    out.length === 1 && out[0].broadcastTime === '12:24-12:30', JSON.stringify(out.map((x) => x.broadcastTime)));

  // 老数据（本次改造前录入）：只有 broadcastDate，没有 weekdays
  out = await S.expand([row({ weekdays: null, broadcastDate: WED, broadcastTime: '12:20' })], MON, SUN, REAL);
  eq('老数据退回按自己的日期显示，升级不丢内容（cyclic=0）',
    out.map((x) => `${x.occurDate} ${x.broadcastTime} ${x.cyclic}`), [`${WED} 12:20 0`]);

  out = await S.expand([row({ weekdays: null, broadcastDate: '2026-12-01' })], MON, SUN, REAL);
  eq('老数据日期不在区间内 → 不出现（不是错）', out.length, 0);

  // 特别节目档：只认自己的日期，不参与周期投影
  out = await S.expand([row({ isSpecial: 1, weekdays: null, broadcastDate: FRI, broadcastTime: '19:30-20:30', slotLabel: null, slotIndex: null })], MON, SUN, REAL);
  eq('特别节目档在本周 → 出现 1 次，时间是手填的',
    out.map((x) => `${x.occurDate} ${x.broadcastTime} ${x.cyclic}`), [`${FRI} 19:30-20:30 0`]);

  out = await S.expand([row({ isSpecial: 1, weekdays: '1,2,3,4,5', broadcastDate: '2026-12-01' })], MON, SUN, REAL);
  eq('特别节目档哪怕误填了 weekdays 也不许被投影成 5 条', out.length, 0);

  // 同一天两个时段的排序：按日期 → 时间
  out = await S.expand([
    row({ id: 2, weekdays: '1', slotLabel: '晚间', slotIndex: 1 }),
    row({ id: 1, weekdays: '1', slotLabel: '午间', slotIndex: 3 }),
  ], MON, MON, REAL);
  eq('同一天：午间排在晚间前面', out.map((x) => x.broadcastTime), ['12:24-12:30', '17:40-17:50']);

  eq('parseWeekdays 去重 + 只留 1..7', S.parseWeekdays('3,1,3,9,0'), [1, 3]);
  eq('weekdayOf：2026-11-16 是周一', S.weekdayOf(MON), 1);
  eq('weekdayOf：2026-11-22 是周日', S.weekdayOf(SUN), 7);
  eq('datesBetween 闭区间（周一~周三 = 3 天）', S.datesBetween(MON, WED).length, 3);

  /* ══════════════ E. 真接口 ══════════════ */
  section('E. 真接口（/admin/program/* · /user/program/*）');

  // 用当前这一周算特别档日期，避免依赖「今天是周几」
  const wk = bj.weekRange();
  const thisMon = bj.ymd(bj.shifted(wk.start.getTime()));
  const thisThu = bj.ymd(bj.shifted(wk.start.getTime() + 3 * bj.DAY_MS));

  H.reset({
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '王慕之', role: 0, status: 1, createTime: new Date(), updateTime: new Date() },
      { _id: 'ad2', id: 2, username: 'editor', password: HASH, nickname: '李思远', role: 1, status: 1, createTime: new Date(), updateTime: new Date() },
    ],
    program: [
      {
        _id: 'pg1', id: 1, title: '校园早班车', host: '李述祥',
        broadcastTime: '12:17-12:24', broadcastDate: null,
        weekdays: '1,3', slotLabel: '午间', slotIndex: 2, isSpecial: 0,
        desc: null, cover: null, isShow: 1, isLive: 0, sort: 0,
        createTime: new Date(), updateTime: new Date(),
      },
      {
        _id: 'pg2', id: 2, title: '月考特别节目', host: '编辑部',
        broadcastTime: '19:30-20:30', broadcastDate: thisThu,
        weekdays: null, slotLabel: null, slotIndex: null, isSpecial: 1,
        desc: null, cover: null, isShow: 1, isLive: 0, sort: 1,
        createTime: new Date(), updateTime: new Date(),
      },
    ],
  });
  S.clearCache();
  await S.setSlots(REAL);

  // E1 路由顺序：/program/slots 不能被 /program/:id 抢走
  let r = await H.call(H.req('GET', '/admin/program/slots', {}, CLUB_TOKEN));
  eq('GET /admin/program/slots → code 0（没被 :id 抢走）', r.code, 0);
  ok('回了 list + 上限；社干也能看（能看不能改）',
    Array.isArray(r.data && r.data.list) && r.data.list.length === 2
    && r.data.maxSlots === 6 && r.data.maxCount === 6,
    JSON.stringify(r.data && r.data.list && r.data.list.map((s) => s.label)));
  ok('每档时间后端算好一起下发',
    r.data && r.data.list[0].ticks.map((t) => t.text).join('|') === '12:10-12:17|12:17-12:24|12:24-12:30',
    JSON.stringify(r.data && r.data.list[0] && r.data.list[0].ticks));

  // E2 编排写入只有超管
  r = await H.call(H.req('PUT', '/admin/program/slots', { list: REAL }, CLUB_TOKEN));
  eq('社干改编排 → 40301', r.code, 40301);

  r = await H.call(H.req('PUT', '/admin/program/slots', { list: [] }, SUPER_TOKEN));
  eq('超管传空编排 → 40001（不许把站里配置清空）', r.code, 40001);

  r = await H.call(H.req('PUT', '/admin/program/slots', {
    list: [
      { label: '午间', start: '12:10', end: '12:30', count: 4 },
      { label: '晚间', start: '17:40', end: '18:10', count: 3 },
    ],
  }, SUPER_TOKEN));
  eq('超管改档数 → code 0', r.code, 0);

  r = await H.call(H.req('GET', '/admin/program/slots', {}, SUPER_TOKEN));
  ok('改完立刻读回来是 4 档，第 4 档 12:25-12:30',
    r.data.list[0].count === 4 && r.data.list[0].ticks[3].text === '12:25-12:30',
    JSON.stringify(r.data.list[0].ticks));

  r = await H.call(H.req('GET', '/admin/program/list', {}, CLUB_TOKEN));
  const pg1 = (r.data.list || []).find((x) => x.id === 1) || {};
  ok('列表里每条都带「周几 + 时段 + 第几档」（界面靠这三个字段渲染「周一 · 午间 ②」）',
    pg1.weekdays === '1,3' && pg1.slotLabel === '午间' && pg1.slotIndex === 2,
    JSON.stringify({ w: pg1.weekdays, s: pg1.slotLabel, i: pg1.slotIndex }));

  // E3 新建栏目
  r = await H.call(H.req('POST', '/admin/program/create', {
    title: '午后书场', host: '陈晓', weekdays: [1, 5], slotLabel: '午间', slotIndex: 3,
  }, CLUB_TOKEN));
  eq('新建常规栏目 → code 0', r.code, 0);
  ok('时间由后端按编排算（不信任前端传的值）',
    r.data.broadcastTime === '12:20-12:25', String(r.data.broadcastTime));
  ok('常规栏目不存具体日期，weekdays 归一成 "1,5"',
    r.data.broadcastDate === null && r.data.weekdays === '1,5' && r.data.isSpecial === 0,
    JSON.stringify({ d: r.data.broadcastDate, w: r.data.weekdays, sp: r.data.isSpecial }));

  r = await H.call(H.req('POST', '/admin/program/create', { title: '没排期的', slotLabel: '午间', slotIndex: 1 }, CLUB_TOKEN));
  eq('没选周几 → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/program/create', { title: '档位越界', weekdays: [2], slotLabel: '午间', slotIndex: 9 }, CLUB_TOKEN));
  eq('档位在编排里不存在 → 40001（提示刷新重选）', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/program/create', { title: '特别节目', isSpecial: 1, weekdays: [2], slotLabel: '午间', slotIndex: 1 }, CLUB_TOKEN));
  eq('特别节目档没给日期 → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/program/create', {
    title: '元旦特别节目', isSpecial: 1, broadcastDate: '2027-01-01', broadcastTime: '09:00-10:00',
  }, CLUB_TOKEN));
  ok('特别节目档：只存日期，把周几 / 时段 / 档位清空（两套模型不许混）',
    r.code === 0 && r.data.broadcastDate === '2027-01-01'
    && r.data.weekdays === null && r.data.slotLabel === null && r.data.slotIndex === null,
    JSON.stringify({ c: r.code, d: r.data && r.data.broadcastDate, w: r.data && r.data.weekdays }));

  // E4 用户端：小程序节目单拿到的是「投影后」的具体日期
  r = await H.call(H.req('GET', '/user/program/weekly', {}, ''));
  eq('GET /user/program/weekly → code 0', r.code, 0);
  const weekly = (r.data && r.data.list) || [];
  const cycle = weekly.filter((x) => x.title === '校园早班车');
  eq('周一 + 周三 = 本周 2 条（库里存的是 "1,3"，没存日期）', cycle.length, 2);
  ok('两条的日期不同，且周几确实落在 1/3',
    cycle.length === 2 && cycle[0].broadcastDate !== cycle[1].broadcastDate
    && cycle.every((x) => [1, 3].indexOf(S.weekdayOf(x.broadcastDate)) >= 0),
    JSON.stringify(cycle.map((x) => `${x.broadcastDate}(${S.weekdayOf(x.broadcastDate)})`)));
  ok('时间已按当前编排（4 档）算好 → 第 2 档 12:15-12:20',
    cycle.every((x) => x.broadcastTime === '12:15-12:20'),
    JSON.stringify(cycle.map((x) => x.broadcastTime)));
  eq('本周的特别节目档也在里面', weekly.filter((x) => x.title === '月考特别节目').length, 1);
  ok('节目单区间 = 本周一~周日',
    r.data.weekRange.from === thisMon && r.data.weekRange.to >= thisMon,
    JSON.stringify(r.data.weekRange));

  r = await H.call(H.req('GET', `/user/program/schedule?from=${MON}&to=${SUN}`, {}, ''));
  const sched = (r.data && r.data.list) || [];
  eq('schedule 带 from/to → 按同样规则投影', sched.filter((x) => x.title === '校园早班车').length, 2);
  ok('指定区间内不带别的周', sched.every((x) => x.broadcastDate >= MON && x.broadcastDate <= SUN),
    JSON.stringify(sched.map((x) => x.broadcastDate)));

  r = await H.call(H.req('GET', '/user/program/1', {}, ''));
  ok('详情：常规栏目仍能按数字 id 打开', r.code === 0 && r.data.program.id === 1);

  console.log(lines.join('\n'));
  console.log(failed ? `\n结论：断言 ${lines.filter((l) => /^(OK|FAIL)/.test(l)).length} 项 / 失败 ${failed} 项`
    : `\n结论：断言 ${lines.filter((l) => /^(OK|FAIL)/.test(l)).length} 项 / 失败 0 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
