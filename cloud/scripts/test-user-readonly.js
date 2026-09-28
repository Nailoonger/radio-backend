'use strict';

/**
 * 用户端只读接口本地实测（阶段 4 第一批）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-user-readonly.js
 *
 * 覆盖：notice(list/detail) · cadre/staff detail · showcase · program(current/schedule/weekly/detail)
 *      · profile · message(create/myList) · station 三件套
 *
 * ⚠️ 本脚本重点盯两条「静默错」的口径（错了不报错、只是查不到）：
 *    1. 主键口径：URL 的 :id 是字符串，业务查询必须用**数字 `id`**（见 lib/db.js 的 parseId）
 *    2. GET 参数收敛：cloud 模式下前端传的 query 落在 body 里，由网关折进 ctx.query
 *    （这两条若有回归，页面表现为「详情打不开 / 分页永远是第一页」，极难定位）
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
const accountService = require(path.join(API_DIR, 'services', 'studentAccount'));

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

/**
 * reset + 清两个实例级缓存
 *  · switch 的 3s 开关缓存
 *  · studentAccount 的 30s 账号状态缓存（requireUser 现在会查它做 token 新鲜度校验）
 * 不清就会让用例之间串味。
 */
function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  accountService._clearCache();
}

const USER = '20240101';
const TOKEN = sign({ openid: USER, uid: 1, username: USER, pv: 0 });

/**
 * 登录态用例必须让 token 里的 username 在库中**真实存在**，
 * 否则 requireUser 的 assertTokenFresh 会先返回 40101（账号不存在），
 * 用例就测不到自己的目标分支了。
 */
const ACCOUNT = { _id: 'u1', id: 1, openid: null, username: USER, status: 1, pwdChangedAt: null };

// 动态日期（避免写死日期导致测试随时间失效）
const today = bj.dayKey();
const wr = bj.weekRange();
const monday = bj.ymd(bj.shifted(wr.start.getTime()));
const sunday = bj.ymd(bj.shifted(wr.end.getTime() - 1));

function datePlus(str, days) {
  const p = String(str).split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]) + days * bj.DAY_MS);
  return `${t.getUTCFullYear()}-${bj.pad2(t.getUTCMonth() + 1)}-${bj.pad2(t.getUTCDate())}`;
}

(async () => {
  // ================= A. 公告 =================
  section('A. /user/notice');
  const NOTICES = [
    { _id: 'n1', id: 1, title: '置顶', isShow: 1, isTop: 1, publishTime: '2026-09-01 10:00:00' },
    { _id: 'n2', id: 2, title: '普通新', isShow: 1, isTop: 0, publishTime: '2026-09-20 10:00:00' },
    { _id: 'n3', id: 3, title: '普通旧', isShow: 1, isTop: 0, publishTime: '2026-09-10 10:00:00' },
    { _id: 'n4', id: 4, title: '隐藏', isShow: 0, isTop: 1, publishTime: '2026-09-25 10:00:00' },
  ];

  reset({ notice: NOTICES });
  const nl = await H.call(H.req('GET', '/user/notice/list'));
  eq('notice.list code', nl.code, 0);
  eq('notice.list 只含 isShow=1', nl.data.total, 3);
  eq('notice.list 置顶优先', nl.data.list[0].title, '置顶');
  eq('notice.list 其余按发布时间倒序', JSON.stringify(nl.data.list.slice(1).map((x) => x.title)), JSON.stringify(['普通新', '普通旧']));

  // 分页（GET 参数经网关折进 ctx.query）
  const np1 = await H.call(H.req('GET', '/user/notice/list', { page: 1, pageSize: 2 }));
  eq('notice.list 分页 page1 条数', np1.data.list.length, 2);
  eq('notice.list 分页 total 不变', np1.data.total, 3);
  const np2 = await H.call(H.req('GET', '/user/notice/list', { page: 2, pageSize: 2 }));
  eq('notice.list 分页 page2 条数', np2.data.list.length, 1);
  eq('notice.list page2 内容', np2.data.list[0].title, '普通旧');
  eq('notice.list 回显 pageSize', np2.data.pageSize, 2);

  const nd = await H.call(H.req('GET', '/user/notice/2'));
  eq('notice.detail 命中（数字 id 口径）', nd.data.title, '普通新');
  eq('notice.detail isShow=0 → 40401', (await H.call(H.req('GET', '/user/notice/4'))).code, 40401);
  eq('notice.detail 不存在 → 40401', (await H.call(H.req('GET', '/user/notice/999'))).code, 40401);
  eq('notice.detail 非法 id → 40401（不抛异常）', (await H.call(H.req('GET', '/user/notice/abc'))).code, 40401);

  // ================= B. 社干 / 部员 / 风采 =================
  section('B. /user/cadre, /user/staff, /user/showcase');
  reset({
    cadre: [
      { _id: 'c1', id: 1, name: '张三', sort: 2, isShow: 1 },
      { _id: 'c2', id: 2, name: '李四', sort: 5, isShow: 1 },
      { _id: 'c3', id: 3, name: '隐藏', sort: 9, isShow: 0 },
    ],
    staff: [
      { _id: 's1', id: 11, name: 'A', department: '播音部', sort: 1, isShow: 1 },
      { _id: 's2', id: 12, name: 'B', department: '播音部', sort: 3, isShow: 1 },
      { _id: 's3', id: 13, name: 'C', department: '', sort: 0, isShow: 1 },
      { _id: 's4', id: 14, name: 'D', department: '播音部', sort: 9, isShow: 0 },
    ],
  });

  eq('cadre.detail 命中', (await H.call(H.req('GET', '/user/cadre/1'))).data.name, '张三');
  eq('cadre.detail isShow=0 → 40401', (await H.call(H.req('GET', '/user/cadre/3'))).code, 40401);
  eq('cadre.detail 非法 id → 40401', (await H.call(H.req('GET', '/user/cadre/abc'))).code, 40401);
  eq('staff.detail 命中', (await H.call(H.req('GET', '/user/staff/11'))).data.name, 'A');

  const sc = await H.call(H.req('GET', '/user/showcase'));
  eq('showcase code', sc.code, 0);
  eq('showcase cadre 仅 isShow=1', sc.data.cadreTotal, 2);
  eq('showcase cadre 按 sort 倒序', JSON.stringify(sc.data.cadre.map((x) => x.name)), JSON.stringify(['李四', '张三']));
  eq('showcase staffTotal 仅 isShow=1', sc.data.staffTotal, 3);
  ok('showcase 部门分组存在「播音部」', !!sc.data.staff['播音部']);
  eq('showcase 播音部按 sort 倒序', JSON.stringify(sc.data.staff['播音部'].map((x) => x.name)), JSON.stringify(['B', 'A']));
  eq('showcase 空部门兜底为「未分部门」', JSON.stringify((sc.data.staff['未分部门'] || []).map((x) => x.name)), JSON.stringify(['C']));

  // ================= C. 节目 =================
  section('C. /user/program');
  reset({
    program: [
      { _id: 'p1', id: 1, title: '本周一节目', isShow: 1, isLive: 0, sort: 1, broadcastDate: monday },
      { _id: 'p2', id: 2, title: '本周日节目', isShow: 1, isLive: 0, sort: 2, broadcastDate: sunday },
      { _id: 'p3', id: 3, title: '今天节目', isShow: 1, isLive: 0, sort: 3, broadcastDate: today },
      { _id: 'p4', id: 4, title: '很久以后', isShow: 1, isLive: 0, sort: 4, broadcastDate: datePlus(today, 30) },
      { _id: 'p5', id: 5, title: '隐藏节目', isShow: 0, isLive: 0, sort: 5, broadcastDate: today },
      { _id: 'p6', id: 6, title: '正在直播', isShow: 1, isLive: 1, sort: 0, broadcastDate: today },
    ],
    message: [
      { _id: 'pm1', id: 91, programId: 1, content: '已通过', status: 1, createTime: '2026-09-02T01:00:00.000Z' },
      { _id: 'pm2', id: 92, programId: 1, content: '待审核', status: 0, createTime: '2026-09-03T01:00:00.000Z' },
      { _id: 'pm3', id: 93, programId: 2, content: '别的节目', status: 1, createTime: '2026-09-04T01:00:00.000Z' },
    ],
  });

  const cur = await H.call(H.req('GET', '/user/program/current'));
  eq('program.current 命中 isLive=1', cur.data.title, '正在直播');

  const wkl = await H.call(H.req('GET', '/user/program/weekly'));
  eq('program.weekly weekRange.from = 本周一（北京时间）', wkl.data.weekRange.from, monday);
  eq('program.weekly weekRange.to = 本周日', wkl.data.weekRange.to, sunday);
  const wkTitles = wkl.data.list.map((x) => x.title).sort();
  ok('program.weekly 含本周一/周日/今天', ['本周一节目', '本周日节目', '今天节目'].every((t) => wkTitles.includes(t)), wkTitles.join(','));
  ok('program.weekly 排除隐藏/远期节目', !wkTitles.includes('隐藏节目') && !wkTitles.includes('很久以后'), wkTitles.join(','));

  const schDefault = await H.call(H.req('GET', '/user/program/schedule'));
  const schTitles = schDefault.data.list.map((x) => x.title);
  ok('program.schedule 默认区间含今天', schTitles.includes('今天节目'), schTitles.join(','));
  ok('program.schedule 默认区间不含 30 天后', !schTitles.includes('很久以后'), schTitles.join(','));
  ok('program.schedule 默认区间不含隐藏', !schTitles.includes('隐藏节目'), schTitles.join(','));

  const schRange = await H.call(H.req('GET', '/user/program/schedule', { from: monday, to: sunday }));
  ok(
    'program.schedule 显式区间结果全落在 [monday, sunday]',
    schRange.data.list.every((x) => x.broadcastDate >= monday && x.broadcastDate <= sunday),
    schRange.data.list.map((x) => `${x.title}@${x.broadcastDate}`).join(',')
  );
  ok('program.schedule 显式区间含本周日', schRange.data.list.map((x) => x.title).includes('本周日节目'));
  ok('program.schedule 显式区间排除远期/隐藏', !schRange.data.list.some((x) => ['很久以后', '隐藏节目'].includes(x.title)));

  const pd = await H.call(H.req('GET', '/user/program/1'));
  eq('program.detail 命中', pd.data.program.title, '本周一节目');
  eq('program.detail 只带已通过留言', JSON.stringify(pd.data.messages.map((m) => m.content)), JSON.stringify(['已通过']));
  eq('program.detail 不存在 → 40401', (await H.call(H.req('GET', '/user/program/999'))).code, 40401);

  // current 无直播时返回 null（不是 404）
  reset({ program: [{ _id: 'x', id: 1, title: '没在播', isShow: 1, isLive: 0 }] });
  const curNone = await H.call(H.req('GET', '/user/program/current'));
  eq('program.current 无直播 code=0', curNone.code, 0);
  eq('program.current 无直播 data=null', curNone.data, null);

  // ================= D. 个人中心 =================
  section('D. /user/profile');
  reset({
    user: [ACCOUNT],
    submit: [
      { _id: 'su1', id: 1, openid: USER, status: 0, songName: 'A', createTime: '2026-09-01T01:00:00.000Z' },
      { _id: 'su2', id: 2, openid: USER, status: 1, songName: 'B', createTime: '2026-09-02T01:00:00.000Z' },
      { _id: 'su3', id: 3, openid: USER, status: 5, songName: 'C', createTime: '2026-09-03T01:00:00.000Z' },
      { _id: 'su4', id: 4, openid: 'OTHER', status: 1, songName: 'D', createTime: '2026-09-04T01:00:00.000Z' },
    ],
    message: [
      { _id: 'm1', id: 1, openid: USER, content: 'x', status: 1, createTime: '2026-09-01T01:00:00.000Z' },
      { _id: 'm2', id: 2, openid: USER, content: 'y', status: 0, createTime: '2026-09-02T01:00:00.000Z' },
    ],
  });

  eq('profile 未登录 → 40101', (await H.call(H.req('GET', '/user/profile'))).code, 40101);
  const pf = await H.call(H.req('GET', '/user/profile', {}, TOKEN));
  eq('profile code', pf.code, 0);
  eq('profile submitTotal（只数自己）', pf.data.stats.submitTotal, 3);
  eq('profile submitPending', pf.data.stats.submitPending, 1);
  eq('profile submitApproved', pf.data.stats.submitApproved, 1);
  eq('profile messageTotal', pf.data.stats.messageTotal, 2);
  eq('profile recentSubmits 条数', pf.data.recentSubmits.length, 3);
  eq('profile recentSubmits 时间倒序', pf.data.recentSubmits[0].songName, 'C');

  // ================= E. 留言 =================
  section('E. /user/message');
  reset({
    user: [ACCOUNT],
    message: [
      { _id: 'm1', id: 1, openid: USER, content: '第一条', status: 1, createTime: '2026-09-01T01:00:00.000Z' },
      { _id: 'm2', id: 2, openid: USER, content: '第二条', status: 0, createTime: '2026-09-02T01:00:00.000Z' },
      { _id: 'm3', id: 3, openid: 'OTHER', content: '别人的', status: 0, createTime: '2026-09-03T01:00:00.000Z' },
    ],
  });

  eq('message.my 未登录 → 40101', (await H.call(H.req('GET', '/user/message/my'))).code, 40101);
  const ml = await H.call(H.req('GET', '/user/message/my', {}, TOKEN));
  eq('message.my 只数自己', ml.data.total, 2);
  eq('message.my 时间倒序', ml.data.list[0].content, '第二条');
  const ml1 = await H.call(H.req('GET', '/user/message/my', { page: 1, pageSize: 1 }, TOKEN));
  eq('message.my 分页生效', ml1.data.list.length, 1);

  eq('message.create 空内容 → 40001', (await H.call(H.req('POST', '/user/message', { content: '   ' }, TOKEN))).code, 40001);
  eq('message.create 超 500 字 → 40001', (await H.call(H.req('POST', '/user/message', { content: 'x'.repeat(501) }, TOKEN))).code, 40001);

  const mc = await H.call(H.req('POST', '/user/message', { content: '你好广播站' }, TOKEN));
  eq('message.create code', mc.code, 0);
  ok('message.create 返回自增 id', Number.isInteger(mc.data.id) && mc.data.id > 0, `id=${mc.data.id}`);
  const created = H.dump().message.find((x) => x.id === mc.data.id);
  eq('message.create 落库 status=0（待审核）', created.status, 0);
  // ⚠️ 账号用户的 token.openid 是「学号」，而 user 文档的 openid 为空 → 按原实现取不到昵称，
  //    兜底为「同学」。这是账号体系改造遗留的已知行为，此处如实断言（不擅自改业务语义）。
  eq('message.create 账号用户昵称走兜底（原实现行为）', created.nickname, '同学');
  eq('message.create 头像走兜底空串', created.avatar, '');
  eq('message.create programId 缺省为 null', created.programId, null);

  // 老微信用户（token.openid 就是真实 openid）→ 能取到真实冗余昵称头像
  reset({ user: [ACCOUNT, { _id: 'w1', id: 5, openid: 'wx_abc', username: null, nickname: '老同学', avatar: 'w.png' }] });
  const wxToken = sign({ openid: 'wx_abc' });
  const mcWx = await H.call(H.req('POST', '/user/message', { content: '微信用户留言' }, wxToken));
  eq('老微信用户留言 code', mcWx.code, 0);
  const createdWx = H.dump().message.find((x) => x.id === mcWx.data.id);
  eq('老微信用户留言取到真实昵称', createdWx.nickname, '老同学');
  eq('老微信用户留言取到真实头像', createdWx.avatar, 'w.png');
  eq('老微信用户留言 openid 归属正确', createdWx.openid, 'wx_abc');

  // 防刷：库里已有「刚刚」的一条 → 再发必须被拦
  // ⚠️ 必须用 new Date()（真·当前时刻）；写死的历史时间不会命中原实现的「1 分钟内」条件
  reset({ user: [ACCOUNT], message: [{ _id: 'm1', id: 1, openid: USER, content: '早', status: 0, createTime: new Date() }] });
  const mc2 = await H.call(H.req('POST', '/user/message', { content: '再发一条' }, TOKEN));
  eq('message.create 1 分钟内防刷 → 40901', mc2.code, 40901);

  // 模块开关关闭 → 40302（验证「云函数里开关真的生效」，这正是原同步实现会漏掉的场景）
  reset({ user: [ACCOUNT], system_switch: [{ _id: 'switch:message', key: 'message', value: 'off' }] });
  eq('message.create 模块关闭 → 40302', (await H.call(H.req('POST', '/user/message', { content: 'hi' }, TOKEN))).code, 40302);

  // ================= F. 广播站信息 =================
  section('F. /user/station/*');
  reset({});
  eq('station.intro 未配置 → 40401', (await H.call(H.req('GET', '/user/station/intro'))).code, 40401);

  reset({
    system_setting: [{ _id: 'setting:station_intro', key: 'station_intro', value: '我们是菁悠广播站' }],
  });
  const si = await H.call(H.req('GET', '/user/station/intro'));
  eq('station.intro 命中', si.data.value, '我们是菁悠广播站');
  eq('station.schedule 仍未配置 → 40401', (await H.call(H.req('GET', '/user/station/schedule'))).code, 40401);

  lines.push('');
  lines.push(`结论：${lines.length} 行 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})();
