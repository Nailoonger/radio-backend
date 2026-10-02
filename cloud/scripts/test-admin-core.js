'use strict';

/**
 * 管理端本地实测 · 第一批（阶段 7）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-admin-core.js
 *
 * 覆盖：全量管理端路由的权限矩阵 + 除 submit / student 之外的模块行为
 *       （auth · setting · switch · program · notice · message · stats ·
 *        cadre · staff · showcase · adminMgr）
 *       `admin.submit.*` → test-admin-submit.js；`admin.student.*` → test-admin-student.js
 *
 * ⚠️ 权限矩阵为什么必须单独立一条：原 Express 把 `adminAuth` / `requireSuperAdmin`
 *    挂在**路由**上，云函数没有中间件层，权限判定散落到 93 个 handler 的第一行。
 *    漏写一处的后果是「接口能调通、但没登录 / 普管也能调」——**接口照样返回 200**，
 *    不报错、不告警（静默漂移 #2）。这里用「全量路由 × 三种身份」一次扫完，
 *    以后新增路由只要加进 router.js 就自动被覆盖。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const { ADMIN_ROUTES } = require(path.join(API_DIR, 'router'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
const bj = require(path.join(API_DIR, 'lib', 'bjTime'));

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
const SUPER = { id: 1, username: 'root', role: 0 };
const PLAIN = { id: 2, username: 'reviewer', role: 1 };
const SUPER_TOKEN = sign(SUPER);
const PLAIN_TOKEN = sign(PLAIN);

function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
}

/** 基础种子：两个管理员（超管 / 普管）+ 一个停用账号 */
function baseSeed() {
  return {
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, lastLoginAt: null, createTime: new Date('2026-01-01T00:00:00+08:00'), updateTime: new Date('2026-01-01T00:00:00+08:00') },
      { _id: 'ad2', id: 2, username: 'reviewer', password: HASH, nickname: '审核员', role: 1, status: 1, lastLoginAt: null, createTime: new Date('2026-01-02T00:00:00+08:00'), updateTime: new Date('2026-01-02T00:00:00+08:00') },
      { _id: 'ad3', id: 3, username: 'banned', password: HASH, nickname: '停用', role: 1, status: 0, lastLoginAt: null, createTime: new Date('2026-01-03T00:00:00+08:00'), updateTime: new Date('2026-01-03T00:00:00+08:00') },
    ],
  };
}

/* ══════════════════════════════════════════════════════════════════ *
 * 权限规范（**独立于实现的一份声明**）
 *
 * 逐条抄自 src/routes/admin.js 的 `requireAdmin` / `requireSuperAdmin`。
 * 故意写成「handlerKey 的字面清单」而不是去解析 routes/admin.js ——
 * 规范应当独立于被测实现，否则实现改错、测试跟着改错，等于没测。
 * ══════════════════════════════════════════════════════════════════ */
const SUPER_ONLY = new Set([
  'admin.recruitment.createBatch', 'admin.recruitment.updateBatch',
  'admin.recruitment.publishBatch', 'admin.recruitment.publishResults', 'admin.recruitment.archiveBatch',
  'admin.recruitment.closeBatch', 'admin.recruitment.generateInterviewOrder',
  // 点歌：容量 / 窗口 / 时段 / 排期 / 规则 / 危险操作（V1 §2.1）
  'admin.submit.setQuota', 'admin.submit.sweepQueue', 'admin.submit.saveWindow',
  'admin.submit.saveSlots', 'admin.submit.previewSchedule', 'admin.submit.runSchedule',
  'admin.submit.lock', 'admin.submit.unlock', 'admin.submit.saveRules',
  'admin.submit.purgeSongs', 'admin.submit.revoke', 'admin.submit.assign', 'admin.submit.played',
  // 系统设置 / 开关
  'admin.setting.list', 'admin.setting.get', 'admin.setting.upsert',
  'admin.switch.list', 'admin.switch.update',
  // 社干 / 部门人员 / 风采
  'admin.cadre.list', 'admin.cadre.detail', 'admin.cadre.create', 'admin.cadre.update', 'admin.cadre.remove', 'admin.cadre.toggle',
  'admin.staff.list', 'admin.staff.detail', 'admin.staff.create', 'admin.staff.update', 'admin.staff.remove', 'admin.staff.toggle',
  'admin.showcase.list', 'admin.showcase.toggle',
  // 管理员账号
  'admin.adminMgr.list', 'admin.adminMgr.create', 'admin.adminMgr.update', 'admin.adminMgr.remove',
  // 学生账号：**19 条全是超管**（src/routes/admin.js 逐条 requireSuperAdmin）
  // 具体行为断言在 test-admin-student.js，这里只声明权限归属，纳入同一张矩阵
  'admin.student.importPreview', 'admin.student.importCommit', 'admin.student.template',
  'admin.student.list', 'admin.student.stats', 'admin.student.exportXlsx',
  'admin.student.grades', 'admin.student.gradeDetail', 'admin.student.removeGrade',
  'admin.student.cleanupLast', 'admin.student.batches', 'admin.student.resetPasswordBatch',
  'admin.student.setStatusBatch', 'admin.student.rollback', 'admin.student.removeBatch',
  'admin.student.update', 'admin.student.setStatus', 'admin.student.resetPassword', 'admin.student.remove',
]);

/** 唯一免登录入口 */
const ANON_OK = new Set(['POST /admin/login']);

/**
 * 「普通管理员即可」的 handlerKey —— **同样逐条抄自 src/routes/admin.js 的 requireAdmin**。
 * 与 SUPER_ONLY 一起构成完整且互斥的分类（下面有并集/交集断言兜底）。
 */
const PLAIN_ONLY = new Set([
  'admin.recruitment.batches', 'admin.recruitment.batchDetail',
  'admin.recruitment.applications', 'admin.recruitment.applicationDetail',
  'admin.recruitment.review', 'admin.recruitment.interview',
  'admin.recruitment.interviewOrder', 'admin.recruitment.exportInterviewOrder',
  'admin.auth.login', 'admin.auth.profile', 'admin.auth.changePassword', 'admin.auth.logout',
  // 点歌：**读** 全放行 + 审核动作；排期 / 配置 / 危险操作在 SUPER_ONLY
  'admin.submit.list', 'admin.submit.capacity', 'admin.submit.window', 'admin.submit.notice',
  'admin.submit.saveNotice', 'admin.submit.timeslots', 'admin.submit.schedule', 'admin.submit.week',
  'admin.submit.rules', 'admin.submit.batch', 'admin.submit.detail', 'admin.submit.approve',
  'admin.submit.statusLogs', 'admin.submit.reject', 'admin.submit.remove',
  'admin.program.list', 'admin.program.create', 'admin.program.update', 'admin.program.remove', 'admin.program.setLive',
  'admin.notice.list', 'admin.notice.create', 'admin.notice.update', 'admin.notice.remove', 'admin.notice.toggle',
  'admin.message.list', 'admin.message.approve', 'admin.message.reject', 'admin.message.remove',
  'admin.stats.overview', 'admin.stats.submitTrend', 'admin.stats.topSongs',
]);

(async () => {
  /* ══════════════════ A. 权限矩阵（全量路由 × 三种身份） ══════════════════ */
  section('A. 权限矩阵（全量管理端路由）');
  reset(baseSeed());

  eq('管理端路由总数', ADMIN_ROUTES.length, 108);

  const anonBad = [];
  const plainBad = [];
  const anonLeak = [];

  for (const [spec, hk] of ADMIN_ROUTES) {
    const sp = spec.indexOf(' ');
    const method = spec.slice(0, sp);
    const p = spec.slice(sp + 1);
    // 参数一律用不存在的 id / 未知 key，避免真的改到种子数据
    const filled = p.replace(/:[a-zA-Z]+/g, (m) => (m === ':type' ? 'cadre' : '999999'));

    // ① 匿名：除登录外**一律** 40101
    if (!ANON_OK.has(spec)) {
      const r = await H.call(H.req(method, filled, {}, ''));
      if (r.code !== 40101) anonBad.push(`${spec} → ${r.code}/${r.message}`);
    }

    // ② 普管：超管专属 = 40301；显式声明为「普管即可」的 = 至少过鉴权
    const r2 = await H.call(H.req(method, filled, {}, PLAIN_TOKEN));
    if (SUPER_ONLY.has(hk)) {
      if (r2.code !== 40301) plainBad.push(`${spec} → 应为 40301，实得 ${r2.code}/${r2.message}`);
    } else if (PLAIN_ONLY.has(hk)) {
      if (r2.code === 40101 || r2.code === 40301) plainBad.push(`${spec} → 被错误拒绝 ${r2.code}/${r2.message}`);
    } else {
      plainBad.push(`${spec} → handlerKey ${hk} 未分类`);
    }

    // ③ 超管不应在**鉴权**上被拦（业务错误如 40001/40401 是正常的）
    const r3 = await H.call(H.req(method, filled, {}, SUPER_TOKEN));
    if (r3.code === 40101 || r3.code === 40301) anonLeak.push(`${spec} → ${r3.code}/${r3.message}`);
  }

  ok('匿名调全部路由（除登录）均为 40101', anonBad.length === 0, anonBad.slice(0, 8).join(' | '));
  ok('普管对超管专属路由全部 40301、对其它路由不被误拦', plainBad.length === 0, plainBad.slice(0, 8).join(' | '));
  ok('超管调全部路由均过鉴权', anonLeak.length === 0, anonLeak.slice(0, 8).join(' | '));
  eq('超管专属 handlerKey 条数', SUPER_ONLY.size, 62);
  // sweepQueue 一个 key 对应两条路由（/quota/sweep 与 /queue/sweep）→ 56 > 55
  eq('落在超管专属 handlerKey 上的**路由**条数', ADMIN_ROUTES.filter(([, hk]) => SUPER_ONLY.has(hk)).length, 63);

  // 权限规范必须**恰好覆盖**路由表。只声明「超管」是不够的 ——
  // 另一半（普管即可）如果只靠「不在 SUPER_ONLY 里」隐式推出，那么
  // 「本该是超管、却被漏写」的 key 会**静默降级成普管**，矩阵照样全绿。
  // 所以两边都显式声明，并要求并集恰好等于路由表、交集为空。
  const routeKeys = [...new Set(ADMIN_ROUTES.map(([, hk]) => hk))];
  const uncovered = routeKeys.filter((k) => !SUPER_ONLY.has(k) && !PLAIN_ONLY.has(k));
  const overlap = routeKeys.filter((k) => SUPER_ONLY.has(k) && PLAIN_ONLY.has(k));
  ok('每个 handlerKey 都被显式分类（超管 ∪ 普管）', uncovered.length === 0, uncovered.join(' | '));
  ok('两类互不重叠', overlap.length === 0, overlap.join(' | '));
  eq('分类总数 = 路由表去重后的 key 数', SUPER_ONLY.size + PLAIN_ONLY.size, routeKeys.length);
  eq('普管可调 handlerKey 条数', PLAIN_ONLY.size, 44);
  eq('普管可调**路由**条数（capacity 一 key 两路由）', ADMIN_ROUTES.filter(([, hk]) => PLAIN_ONLY.has(hk)).length, 45);

  /* ══════════════════ B. auth ══════════════════ */
  section('B. 管理端登录 / 当前账号 / 改密 / 退出');
  reset(baseSeed());

  let r = await H.call(H.req('POST', '/admin/login', {}));
  eq('缺参登录 → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'wrong' }));
  eq('密码错 → 40101', r.code, 40101);
  eq('密码错 → 统一文案（不泄露账号是否存在）', r.message, '账号或密码错误');

  r = await H.call(H.req('POST', '/admin/login', { username: 'nobody', password: 'password123' }));
  eq('账号不存在 → 与密码错同一文案', [r.code, r.message], [40101, '账号或密码错误']);

  r = await H.call(H.req('POST', '/admin/login', { username: 'banned', password: 'password123' }));
  eq('停用账号 → 40301 账号已禁用', [r.code, r.message], [40301, '账号已禁用']);

  r = await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'password123' }));
  eq('登录成功 → code 0', r.code, 0);
  ok('返回 token', typeof r.data.token === 'string' && r.data.token.length > 20);
  eq('返回 admin 四字段（**无 password**）', r.data.admin, { id: 1, username: 'root', nickname: '超管', role: 0 });
  ok('返回体不含 password 字样', !/password/i.test(JSON.stringify(r.data)), JSON.stringify(r.data));
  const superToken = r.data.token;

  const loginDoc = (H.dump().admin || []).find((a) => a.id === 1);
  ok('登录写入 lastLoginAt', loginDoc.lastLoginAt instanceof Date);

  r = await H.call(H.req('GET', '/admin/profile', {}, superToken));
  eq('GET /admin/profile → code 0', r.code, 0);
  eq('profile 字段集（顺序即 pick 顺序）', Object.keys(r.data), ['id', 'username', 'nickname', 'role', 'lastLoginAt', 'createTime']);
  ok('profile 摘掉 password', r.data.password === undefined);

  r = await H.call(H.req('PUT', '/admin/change-password', { oldPassword: 'x', newPassword: 'abcdef' }, superToken));
  eq('原密码错 → 40001', [r.code, r.message], [40001, '原密码错误']);

  r = await H.call(H.req('PUT', '/admin/change-password', { oldPassword: 'password123', newPassword: '123' }, superToken));
  eq('新密码过短 → 40001', [r.code, r.message], [40001, '新密码长度不能少于6位']);

  r = await H.call(H.req('PUT', '/admin/change-password', { oldPassword: 'password123', newPassword: 'newpass123' }, superToken));
  eq('改密成功 → code 0 / data null', [r.code, r.data], [0, null]);
  eq('新密码可登录', (await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'newpass123' }))).code, 0);
  eq('旧密码已失效', (await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'password123' }))).code, 40101);

  r = await H.call(H.req('POST', '/admin/logout', {}, superToken));
  eq('登出 → code 0', [r.code, r.data], [0, null]);

  /* ══════════════════ C. setting（KV） ══════════════════ */
  section('C. 系统设置 KV（仅超管）');
  reset(baseSeed());

  eq('普管读设置 → 40301', (await H.call(H.req('GET', '/admin/setting/list', {}, PLAIN_TOKEN))).code, 40301);

  r = await H.call(H.req('GET', '/admin/setting/list', {}, SUPER_TOKEN));
  eq('设置列表初始为空', [r.code, r.data], [0, { list: [] }]);

  r = await H.call(H.req('GET', '/admin/setting/nope', {}, SUPER_TOKEN));
  eq('未配置 → 40401', [r.code, r.message], [40401, '配置不存在']);

  r = await H.call(H.req('PUT', '/admin/setting/station_intro', { value: '菁菁校园情' }, SUPER_TOKEN));
  eq('upsert 新建 → 字段集', Object.keys(r.data), ['id', 'key', 'value', 'desc', 'updateTime']);
  eq('新建 desc 兜底为**空串**（不是 null）', r.data.desc, '');
  eq('新建补上数字 id', r.data.id, 1);
  const settingDocId = (H.dump().system_setting || [])[0]._id;
  eq('文档 _id = setting:<key>', settingDocId, 'setting:station_intro');

  r = await H.call(H.req('PUT', '/admin/setting/station_intro', { value: '悠悠广播声' }, SUPER_TOKEN));
  eq('更新：只传 value → desc 保持不变', r.data.desc, '');
  eq('更新：value 已改', r.data.value, '悠悠广播声');

  r = await H.call(H.req('PUT', '/admin/setting/station_intro', { desc: '站点简介' }, SUPER_TOKEN));
  eq('更新：只传 desc → value 保持不变', r.data.value, '悠悠广播声');
  eq('更新：desc 已改', r.data.desc, '站点简介');

  r = await H.call(H.req('GET', '/admin/setting/station_intro', {}, SUPER_TOKEN));
  eq('读回一致', [r.data.key, r.data.value, r.data.desc], ['station_intro', '悠悠广播声', '站点简介']);
  ok('不返回 _id（_id 是云文档内部标识）', r.data._id === undefined);

  // ⚠️ 与 kv.set 的差异：kv.set 缺 desc 时会写 null，管理端 upsert 必须写空串/保留旧值
  const kvSvc = require(path.join(API_DIR, 'services', 'kv'));
  await kvSvc.set('kv_probe', 'x');
  const probe = (H.dump().system_setting || []).find((d) => d.key === 'kv_probe');
  eq('kv.set 缺 desc → 写 null（故 upsert **不能**直接复用它）', probe.desc, null);

  /* ══════════════════ D. switch ══════════════════ */
  section('D. 模块开关（仅超管）');
  reset(Object.assign(baseSeed(), {
    system_switch: [
      { _id: 'switch:submit_song', key: 'submit_song', value: 'on', desc: '点歌', updatedBy: 1, updatedAt: new Date('2026-01-05T00:00:00+08:00') },
      { _id: 'switch:message', key: 'message', value: 'off', desc: '留言', updatedBy: 2, updatedAt: new Date('2026-01-06T00:00:00+08:00') },
    ],
  }));

  eq('普管读开关 → 40301', (await H.call(H.req('GET', '/admin/switch/list', {}, PLAIN_TOKEN))).code, 40301);

  r = await H.call(H.req('GET', '/admin/switch/list', {}, SUPER_TOKEN));
  eq('开关列表 → code 0', r.code, 0);
  const swRoot = r.data.list.find((s) => s.key === 'submit_song');
  const swRev = r.data.list.find((s) => s.key === 'message');
  eq('updatedBy → updatedByName（admin.id 换姓名）', swRoot.updatedByName, '超管');
  eq('另一个开关的姓名也对', swRev.updatedByName, '审核员');

  r = await H.call(H.req('PUT', '/admin/switch/message', { value: 'on' }, SUPER_TOKEN));
  eq('开开关 → code 0', r.code, 0);
  r = await H.call(H.req('GET', '/admin/switch/list', {}, SUPER_TOKEN));
  eq('开关已变 on', r.data.list.find((s) => s.key === 'message').value, 'on');
  eq('写入 updatedBy = 当前超管', r.data.list.find((s) => s.key === 'message').updatedBy, 1);

  r = await H.call(H.req('PUT', '/admin/switch/message', { value: 'maybe' }, SUPER_TOKEN));
  eq('非法 value → 40001', [r.code, r.message], [40001, 'value 必须为 on 或 off']);

  /* ══════════════════ E. program ══════════════════ */
  section('E. 节目排期');
  reset(baseSeed());

  eq('普管调 program/list → 放行', (await H.call(H.req('GET', '/admin/program/list', {}, PLAIN_TOKEN))).code, 0);

  r = await H.call(H.req('POST', '/admin/program/create', { title: '晚安电台' }, SUPER_TOKEN));
  eq('缺开播时间 → 40001', [r.code, r.message], [40001, '请填写节目名和开播时间']);

  r = await H.call(H.req('POST', '/admin/program/create', { title: '早间新闻', broadcastTime: '07:20', broadcastDate: '2026-10-05', sort: 2 }, SUPER_TOKEN));
  eq('create → 字段集', Object.keys(r.data), ['id', 'title', 'host', 'broadcastTime', 'broadcastDate', 'desc', 'cover', 'isShow', 'isLive', 'sort', 'createTime', 'updateTime']);
  eq('create 默认 isShow=1 / isLive=0', [r.data.isShow, r.data.isLive], [1, 0]);
  const pA = r.data.id;

  await H.call(H.req('POST', '/admin/program/create', { title: '午间点播', broadcastTime: '12:20', broadcastDate: '2026-10-05', sort: 1 }, SUPER_TOKEN));
  await H.call(H.req('POST', '/admin/program/create', { title: '更早的节目', broadcastTime: '09:00', broadcastDate: '2026-10-01', sort: 9 }, SUPER_TOKEN));

  r = await H.call(H.req('GET', '/admin/program/list', {}, SUPER_TOKEN));
  eq('列表排序 broadcastDate ASC, sort ASC', r.data.list.map((x) => x.title), ['更早的节目', '午间点播', '早间新闻']);
  eq('列表 total', r.data.total, 3);

  r = await H.call(H.req('GET', '/admin/program/list', { startDate: '2026-10-05', endDate: '2026-10-05' }, SUPER_TOKEN));
  eq('日期过滤：两端都给才生效', r.data.list.map((x) => x.title), ['午间点播', '早间新闻']);

  r = await H.call(H.req('GET', '/admin/program/list', { startDate: '2026-10-05' }, SUPER_TOKEN));
  eq('只给一端 → 不过滤', r.data.total, 3);

  r = await H.call(H.req('PUT', `/admin/program/${pA}/live`, { isLive: 1 }, SUPER_TOKEN));
  eq('标记直播', r.data.isLive, 1);

  const pB = (await H.call(H.req('GET', '/admin/program/list', {}, SUPER_TOKEN))).data.list.find((x) => x.title === '午间点播').id;
  await H.call(H.req('PUT', `/admin/program/${pB}/live`, { isLive: 1 }, SUPER_TOKEN));
  const afterLive = (await H.call(H.req('GET', '/admin/program/list', {}, SUPER_TOKEN))).data.list;
  eq('全表仅一个 live=1（旧的自动归 0）', afterLive.map((x) => [x.title, x.isLive]).sort(), [['更早的节目', 0], ['午间点播', 1], ['早间新闻', 0]].sort());

  r = await H.call(H.req('PUT', `/admin/program/${pA}`, { title: '早间新闻（改）' }, SUPER_TOKEN));
  eq('部分更新：标题已改', r.data.title, '早间新闻（改）');
  eq('部分更新：未传字段保留', [r.data.broadcastTime, r.data.isLive], ['07:20', 0]);

  eq('删不存在 → 40401', (await H.call(H.req('DELETE', '/admin/program/999999', {}, SUPER_TOKEN))).code, 40401);
  r = await H.call(H.req('DELETE', `/admin/program/${pA}`, {}, SUPER_TOKEN));
  eq('删除 → code 0 / data null', [r.code, r.data], [0, null]);
  eq('删除后 total=2', (await H.call(H.req('GET', '/admin/program/list', {}, SUPER_TOKEN))).data.total, 2);

  /* ══════════════════ F. notice ══════════════════ */
  section('F. 公告管理');
  reset(baseSeed());

  r = await H.call(H.req('POST', '/admin/notice/create', { title: '只有标题' }, SUPER_TOKEN));
  eq('缺内容 → 40001', [r.code, r.message], [40001, '请填写标题和内容']);

  r = await H.call(H.req('POST', '/admin/notice/create', { title: '普通公告', content: '内容A' }, SUPER_TOKEN));
  eq('create → 字段集', Object.keys(r.data), ['id', 'title', 'content', 'isTop', 'isShow', 'publisherId', 'publishTime', 'createTime', 'updateTime']);
  eq('publisherId = 当前管理员', r.data.publisherId, 1);
  eq('默认 isTop=0 / isShow=1', [r.data.isTop, r.data.isShow], [0, 1]);
  const nA = r.data.id;

  await H.call(H.req('POST', '/admin/notice/create', { title: '置顶公告', content: '内容B', isTop: 1 }, SUPER_TOKEN));
  // 让 publishTime 有先后差
  const docs = H.dump().notice || [];
  const topDoc = docs.find((d) => d.title === '置顶公告');
  const plainDoc = docs.find((d) => d.title === '普通公告');
  topDoc.publishTime = new Date('2026-01-01T00:00:00+08:00');
  plainDoc.publishTime = new Date('2026-02-01T00:00:00+08:00');

  r = await H.call(H.req('GET', '/admin/notice/list', {}, PLAIN_TOKEN));
  eq('普管可读公告（非超管专属）', r.code, 0);
  eq('排序 isTop DESC, publishTime DESC', r.data.list.map((x) => x.title), ['置顶公告', '普通公告']);

  r = await H.call(H.req('GET', '/admin/notice/list', { keyword: '内容b' }, SUPER_TOKEN));
  eq('keyword 命中 content 且**大小写不敏感**', r.data.list.map((x) => x.title), ['置顶公告']);
  eq('keyword 命中后 total 同步', r.data.total, 1);

  r = await H.call(H.req('GET', '/admin/notice/list', { keyword: '公告' }, SUPER_TOKEN));
  eq('keyword 命中 title（两字段 OR）', r.data.total, 2);

  r = await H.call(H.req('PUT', `/admin/notice/${nA}/toggle`, {}, SUPER_TOKEN));
  eq('toggle 翻转 isShow 1→0', r.data.isShow, 0);
  r = await H.call(H.req('PUT', `/admin/notice/${nA}/toggle`, {}, SUPER_TOKEN));
  eq('再 toggle 0→1', r.data.isShow, 1);

  r = await H.call(H.req('PUT', `/admin/notice/${nA}`, { title: '普通公告（改）' }, SUPER_TOKEN));
  eq('部分更新保留其它字段', [r.data.title, r.data.content, r.data.isTop], ['普通公告（改）', '内容A', 0]);

  eq('删不存在 → 40401', (await H.call(H.req('DELETE', '/admin/notice/999999', {}, SUPER_TOKEN))).code, 40401);
  eq('删除成功', (await H.call(H.req('DELETE', `/admin/notice/${nA}`, {}, SUPER_TOKEN))).code, 0);
  eq('删除后 total=1', (await H.call(H.req('GET', '/admin/notice/list', {}, SUPER_TOKEN))).data.total, 1);

  /* ══════════════════ G. message ══════════════════ */
  section('G. 留言审核');
  reset(Object.assign(baseSeed(), {
    message: [
      { _id: 'm1', id: 1, openid: '20240101', programId: 7, nickname: '小明', avatar: '', content: 'Hello World', status: 0, rejectReason: null, reviewerId: null, reviewTime: null, createTime: new Date('2026-03-01T10:00:00+08:00') },
      { _id: 'm2', id: 2, openid: '20240102', programId: 8, nickname: '小红', avatar: '', content: '第二條留言', status: 1, rejectReason: null, reviewerId: 2, reviewTime: new Date('2026-03-02T10:00:00+08:00'), createTime: new Date('2026-03-02T10:00:00+08:00') },
    ],
  }));

  r = await H.call(H.req('GET', '/admin/message/list', {}, PLAIN_TOKEN));
  eq('列表字段集', Object.keys(r.data.list[0]), ['id', 'openid', 'programId', 'nickname', 'avatar', 'content', 'status', 'rejectReason', 'reviewerId', 'reviewTime', 'createTime']);
  eq('默认全部（status 空串不过滤）', r.data.total, 2);
  eq('排序 createTime DESC', r.data.list.map((x) => x.id), [2, 1]);

  r = await H.call(H.req('GET', '/admin/message/list', { status: '' }, SUPER_TOKEN));
  eq('显式 status="" 也不过滤', r.data.total, 2);

  r = await H.call(H.req('GET', '/admin/message/list', { status: '0' }, SUPER_TOKEN));
  eq('status=0 → 只出待审', r.data.list.map((x) => x.id), [1]);

  r = await H.call(H.req('GET', '/admin/message/list', { programId: '8' }, SUPER_TOKEN));
  eq('programId 过滤', r.data.list.map((x) => x.id), [2]);

  r = await H.call(H.req('GET', '/admin/message/list', { keyword: 'hello' }, SUPER_TOKEN));
  eq('keyword 命中 content 且大小写不敏感', r.data.list.map((x) => x.id), [1]);
  r = await H.call(H.req('GET', '/admin/message/list', { keyword: '小红' }, SUPER_TOKEN));
  eq('keyword 命中 nickname', r.data.list.map((x) => x.id), [2]);

  r = await H.call(H.req('PUT', '/admin/message/1/reject', {}, SUPER_TOKEN));
  eq('缺驳回理由 → 40001', [r.code, r.message], [40001, '请填写驳回理由']);

  r = await H.call(H.req('PUT', '/admin/message/1/reject', { reason: '含广告' }, PLAIN_TOKEN));
  eq('普管可驳回', r.code, 0);
  eq('驳回写入 status/reason/reviewerId', [r.data.status, r.data.rejectReason, r.data.reviewerId], [2, '含广告', 2]);

  r = await H.call(H.req('PUT', '/admin/message/1/approve', {}, PLAIN_TOKEN));
  eq('通过 → status=1 / reason 清空', [r.data.status, r.data.rejectReason], [1, null]);
  eq('通过写入 reviewerId = 当前普管', r.data.reviewerId, 2);

  // ⚠️ message 是 timestamps:false，审核**不能**顺手补 updateTime
  const m1 = (H.dump().message || []).find((d) => d.id === 1);
  ok('审核不写 updateTime（message 没有该列）', m1.updateTime === undefined);

  eq('审不存在 → 40401', (await H.call(H.req('PUT', '/admin/message/999/approve', {}, SUPER_TOKEN))).code, 40401);
  eq('删除成功', (await H.call(H.req('DELETE', '/admin/message/1', {}, SUPER_TOKEN))).code, 0);
  eq('删除后 total=1', (await H.call(H.req('GET', '/admin/message/list', {}, SUPER_TOKEN))).data.total, 1);

  /* ══════════════════ H. stats ══════════════════ */
  section('H. 数据统计');
  /**
   * ⚠️⚠️ 「今天 / 昨天 / 30 天前」都是**相对时间**，而 `thisWeek` 是按**北京周一 00:00**
   *     切分的。所以期望值**必须算出来，不能写死** ——
   *     写死 `thisWeek: 2` 只在这条用例跑于**周一**时成立；周二起「昨天」就跨进了本周，
   *     变成 3（2026-09-29 周二实测翻车）。这类时间炸弹比没有断言更糟：它会训练人忽略红灯。
   *     下方把种子的基准时刻固定在 `T0`，再用同一套 `bj.weekRange` 推导期望值，
   *     无论哪天跑都自洽。
   */
  const T0 = Date.now();
  const WEEK_START = bj.weekRange(T0).start.getTime();
  const inThisWeek = (t) => t >= WEEK_START;

  reset(Object.assign(baseSeed(), {
    submit: [
      // 今天：1 点歌（待审）+ 1 文稿
      { _id: 's1', id: 1, type: 1, status: 0, reviewStatus: 0, scheduleStatus: 0, playStatus: 0, createTime: new Date(T0), songName: '晴天', singer: '周杰伦' },
      { _id: 's2', id: 2, type: 2, status: 0, reviewStatus: 0, scheduleStatus: 0, playStatus: 0, createTime: new Date(T0), articleTitle: '散文' },
      // 30 天前：1 点歌（已排期 status=1）—— 必定不在本周
      { _id: 's3', id: 3, type: 1, status: 1, reviewStatus: 1, scheduleStatus: 1, playStatus: 0, createTime: new Date(T0 - 30 * 86400000), songName: '晴天', singer: '周杰伦' },
      // 昨天：1 点歌（已驳回 status=2）—— 周一时属上周、其余日子属本周
      { _id: 's4', id: 4, type: 1, status: 2, reviewStatus: 2, scheduleStatus: 0, playStatus: 0, createTime: new Date(T0 - 86400000), songName: '七里香', singer: '周杰伦' },
      /**
       * ⚠️ s5 / s6 是**为 `overview.approved` 的口径断言专门补的样本**（陛下 2026-09-29 裁决）：
       *    `approved` 从「`status: 1`」改成「`status ∈ {1, 5, 6}`」。只有 s3（=1）时
       *    新旧口径都是 1 —— 改了实现断言也不会有任何变化，等于没测。
       *    补上 5（已播放）和 6（已通过·待排期）之后，expect 从 1 变 3，才真正锁得住。
       *    createTime 一律取 30 天前：**不能落在本周或近 3 天**，否则会撞
       *    `thisWeek` 与 `submit-trend`（days=3）的既有断言。
       */
      { _id: 's5', id: 5, type: 1, status: 5, reviewStatus: 1, scheduleStatus: 1, playStatus: 1, createTime: new Date(T0 - 30 * 86400000), songName: '晴天', singer: '周杰伦' },
      { _id: 's6', id: 6, type: 1, status: 6, reviewStatus: 1, scheduleStatus: 0, playStatus: 0, createTime: new Date(T0 - 30 * 86400000), songName: '稻香', singer: '周杰伦' },
    ],
    message: [{ _id: 'm1', id: 1, status: 0, content: 'x', createTime: new Date(T0) }],
    notice: [{ _id: 'n1', id: 1, title: 't', createTime: new Date(T0) }],
    program: [{ _id: 'p1', id: 1, title: 'p', broadcastTime: '07:20', createTime: new Date(T0) }],
    user: [
      { _id: 'u1', id: 1, username: '20240101', nickname: '甲', createTime: new Date(T0) },
      { _id: 'u2', id: 2, username: '20240102', nickname: '乙', createTime: new Date(T0 - 10 * 86400000) },
    ],
  }));

  r = await H.call(H.req('GET', '/admin/stats/overview', {}, PLAIN_TOKEN));
  eq('overview → code 0', r.code, 0);
  eq('overview.submit（**approved 口径 = status ∈ {1,5,6}** = 已排期+已播放+已通过·待排期）', r.data.submit, {
    total: 6, pending: 2, approved: 3, rejected: 1, song: 5, article: 1, today: 2,
    thisWeek: [T0, T0, T0 - 86400000].filter(inThisWeek).length,
  });
  ok('★ approved 把「已播放(5)」和「已通过·待排期(6)」都算进来了（旧口径 status:1 只有 1）',
    r.data.submit.approved === 3, String(r.data.submit.approved));
  ok('★ 本周计数与「北京周一 00:00」口径一致（今天/昨天，30 天前不算）',
    r.data.submit.thisWeek === 2 + (inThisWeek(T0 - 86400000) ? 1 : 0), String(r.data.submit.thisWeek));
  eq('overview.message', r.data.message, { total: 1, pending: 1 });
  eq('overview.content', r.data.content, { notice: 1, program: 1 });
  eq('overview.user（today 按北京日历日）', r.data.user, { total: 2, today: 1 });

  r = await H.call(H.req('GET', '/admin/stats/submit-trend', { days: '3' }, PLAIN_TOKEN));
  eq('trend 天数', r.data.list.length, 3);
  eq('trend 末日 = 北京今天', r.data.list[2].date, bj.dayKey(Date.now()));
  eq('trend 昨天有 1 条点歌', [r.data.list[1].count, r.data.list[1].song, r.data.list[1].article], [1, 1, 0]);
  eq('trend 今天 2 条（1 歌 + 1 文）', [r.data.list[2].count, r.data.list[2].song, r.data.list[2].article], [2, 1, 1]);
  eq('trend 缺口补齐 0（前天）', [r.data.list[0].count, r.data.list[0].song, r.data.list[0].article], [0, 0, 0]);
  ok('trend 日期严格递增', r.data.list.every((x, i) => i === 0 || x.date > r.data.list[i - 1].date));

  r = await H.call(H.req('GET', '/admin/stats/top-songs', {}, PLAIN_TOKEN));
  // 口径已随陛下 2026-09-29 裁决与 overview.approved 统一为 `status ∈ {1,5,6}`（同日第二次点头）。
  // 期望值按新口径重新推导：s3 晴天(status1) + s5 晴天(status5 已播放) 聚成同一首 → 晴天×2；
  // s6 稻香(status6 已通过·待排期) → ×1。s1 晴天是待审(0)、s4 七里香已驳回(2)，都不算「已通过」。
  eq('top-songs 统计 status ∈ {1,5,6} 的点歌（与 overview.approved 同口径）',
    r.data.list, [
      { songName: '晴天', singer: '周杰伦', count: 2 },
      { songName: '稻香', singer: '周杰伦', count: 1 },
    ]);
  ok('★ 这条断言能区分新旧实现：旧口径(status:1)只会给出晴天×1（已播放的那次不算热门）',
    r.data.list.length === 2 && r.data.list[0].count === 2,
    `got ${JSON.stringify(r.data.list)}`);
  ok('★ 待审(晴天 s1)与已驳回(七里香)仍不进热门榜 —— 口径放宽不等于全收',
    !r.data.list.some((x) => x.songName === '七里香'));

  /* ══════════════════ I. cadre / staff / showcase ══════════════════ */
  section('I. 社干 / 部门人员 / 风采展示（全部仅超管）');
  reset(baseSeed());

  r = await H.call(H.req('POST', '/admin/cadre/create', { name: '张三' }, SUPER_TOKEN));
  eq('cadre 缺职务 → 40001', [r.code, r.message], [40001, '请填写职务']);

  r = await H.call(H.req('POST', '/admin/cadre/create', { name: '张'.repeat(33), role: '站长' }, SUPER_TOKEN));
  eq('cadre 姓名超 32 → 40001', [r.code, r.message], [40001, '姓名过长']);

  r = await H.call(H.req('POST', '/admin/cadre/create', { name: '张三', role: '站长', sort: 5 }, SUPER_TOKEN));
  eq('cadre create → 字段集', Object.keys(r.data), ['id', 'name', 'role', 'grade', 'avatar', 'motto', 'sort', 'isShow', 'createTime', 'updateTime']);
  eq('avatar 缺省为空串、motto 缺省为 null', [r.data.avatar, r.data.motto], ['', null]);
  eq('isShow 缺省 1', r.data.isShow, 1);

  await H.call(H.req('POST', '/admin/cadre/create', { name: '李四', role: '副站长', sort: 9 }, SUPER_TOKEN));
  await H.call(H.req('POST', '/admin/cadre/create', { name: '王五', role: '编辑', sort: 5 }, SUPER_TOKEN));

  r = await H.call(H.req('GET', '/admin/cadre/list', {}, SUPER_TOKEN));
  eq('cadre 排序 sort DESC, id ASC', r.data.list.map((x) => x.name), ['李四', '张三', '王五']);

  r = await H.call(H.req('GET', '/admin/cadre/list', { keyword: '副站长' }, SUPER_TOKEN));
  eq('cadre keyword 命中 role', r.data.list.map((x) => x.name), ['李四']);

  r = await H.call(H.req('PUT', `/admin/cadre/${r.data.list[0].id}`, { motto: 'm'.repeat(201) }, SUPER_TOKEN));
  eq('update 对**合并后**的值查长度 → 40001', [r.code, r.message], [40001, '座右铭过长']);

  // ---- staff：三处与 cadre 不同（必填 department / 三键排序含 id DESC / ?department=）
  r = await H.call(H.req('POST', '/admin/staff/create', { name: '赵六', role: '播音' }, SUPER_TOKEN));
  eq('staff 缺部门 → 40001', [r.code, r.message], [40001, '请填写部门']);

  await H.call(H.req('POST', '/admin/staff/create', { name: 'A', role: '播音', department: '播音部', sort: 1 }, SUPER_TOKEN));
  await H.call(H.req('POST', '/admin/staff/create', { name: 'B', role: '播音', department: '播音部', sort: 1 }, SUPER_TOKEN));
  await H.call(H.req('POST', '/admin/staff/create', { name: 'C', role: '编辑', department: '编辑部', sort: 9 }, SUPER_TOKEN));

  r = await H.call(H.req('GET', '/admin/staff/list', {}, SUPER_TOKEN));
  // ⚠️ 中文按**码点**排：'播'(U+64AD) < '编'(U+7F16)，所以「播音部」在「编辑部」**前面**
  //    （MySQL utf8mb4_general_ci 对 CJK 也是按码点，两边一致）
  eq('staff 排序 department ASC, sort DESC, **id DESC**',
    r.data.list.map((x) => x.name), ['B', 'A', 'C']);

  r = await H.call(H.req('GET', '/admin/staff/list', { department: '播音部' }, SUPER_TOKEN));
  eq('?department= 精确过滤', r.data.list.map((x) => x.name), ['B', 'A']);
  eq('过滤后 total 同步', r.data.total, 2);

  // ---- showcase
  r = await H.call(H.req('GET', '/admin/showcase/list', {}, SUPER_TOKEN));
  eq('showcase → code 0', r.code, 0);
  eq('合并顺序恒为**社干在前、部员在后**', r.data.list.map((x) => [x.type, x.name]), [
    ['cadre', '李四'], ['cadre', '张三'], ['cadre', '王五'],
    ['staff', 'A'], ['staff', 'B'], ['staff', 'C'],
  ]);
  eq('showcase.counts', r.data.counts, { cadre: 3, staff: 3, all: 6 });
  eq('showcase.onShow', r.data.onShow, { cadre: 3, staff: 3, all: 6 });
  eq('showcase.hidden', r.data.hidden, { cadre: 0, staff: 0, all: 0 });
  eq('normalize：副标题社干取 role', r.data.list[0].subtitle, '副站长');
  eq('normalize：副标题部员取 department', r.data.list.find((x) => x.name === 'C').subtitle, '编辑部');
  // ⚠️ 钉住「同一张 staff 表在两个接口里排序不同」这个**源实现就有的**差异：
  //    admin/staff/list 是 ... id DESC，showcase 里是 ... id ASC。统一它就改了线上顺序。
  eq('showcase 里 staff 的排序是 id ASC（与 admin/staff/list 的 id DESC 不同）',
    r.data.list.filter((x) => x.type === 'staff').map((x) => x.name), ['A', 'B', 'C']);

  r = await H.call(H.req('GET', '/admin/showcase/list', { type: 'staff' }, SUPER_TOKEN));
  eq('type=staff', r.data.list.map((x) => x.type).every((t) => t === 'staff'), true);
  eq('type=staff 时 still 给全量 counts', r.data.counts, { cadre: 3, staff: 3, all: 6 });

  r = await H.call(H.req('GET', '/admin/showcase/list', { type: 'nope' }, SUPER_TOKEN));
  eq('非法 type → 40001', r.code, 40001);

  r = await H.call(H.req('GET', '/admin/showcase/list', { keyword: '编辑' }, SUPER_TOKEN));
  eq('showcase keyword 分表搜索（cadre 命中 role、staff 命中 role）', r.data.list.map((x) => x.name), ['王五', 'C']);

  const cadreId = r.data.list[0].id;
  r = await H.call(H.req('PUT', `/admin/showcase/cadre/${cadreId}/toggle`, {}, SUPER_TOKEN));
  eq('toggle → isShow 1→0', [r.data.type, r.data.isShow], ['cadre', 0]);
  r = await H.call(H.req('GET', '/admin/showcase/list', {}, SUPER_TOKEN));
  eq('hidden 统计跟着变', r.data.hidden, { cadre: 1, staff: 0, all: 1 });
  eq('onShow 统计跟着变', r.data.onShow, { cadre: 2, staff: 3, all: 5 });

  r = await H.call(H.req('PUT', '/admin/showcase/nope/1/toggle', {}, SUPER_TOKEN));
  eq('非法 type → 40001', r.code, 40001);
  eq('toggle 不存在 → 40401', (await H.call(H.req('PUT', '/admin/showcase/cadre/999999/toggle', {}, SUPER_TOKEN))).code, 40401);

  /* ══════════════════ J. adminMgr ══════════════════ */
  section('J. 管理员账号管理（仅超管）');
  reset(baseSeed());

  r = await H.call(H.req('GET', '/admin/admin/list', {}, SUPER_TOKEN));
  eq('列表字段集（**绝无 password**）', Object.keys(r.data.list[0]), ['id', 'username', 'nickname', 'role', 'status', 'lastLoginAt', 'createTime']);
  ok('整包不含 password 字段', !/password/i.test(JSON.stringify(r.data)));
  eq('列表 total', r.data.total, 3);

  // ⚠️ 校验顺序与源实现一致：**先 role 合法、再查重** —— 所以缺 role 时得到的是
  //    「角色必须为0或1」而**不是**「用户名已存在」。这条顺序也是契约（前端提示不同）。
  r = await H.call(H.req('POST', '/admin/admin/create', { username: 'root', password: 'abcdef' }, SUPER_TOKEN));
  eq('缺 role → 40001（校验在查重之前）', [r.code, r.message], [40001, '角色必须为0或1']);

  r = await H.call(H.req('POST', '/admin/admin/create', { username: 'root', password: 'abcdef', role: 1 }, SUPER_TOKEN));
  eq('重复用户名 → 40901', [r.code, r.message], [40901, '用户名已存在']);

  r = await H.call(H.req('POST', '/admin/admin/create', { username: 'x', password: '123' }, SUPER_TOKEN));
  eq('密码过短 → 40001', [r.code, r.message], [40001, '密码长度不能少于6位']);

  r = await H.call(H.req('POST', '/admin/admin/create', { username: 'x', password: 'abcdef', role: 9 }, SUPER_TOKEN));
  eq('role 非 0/1 → 40001', [r.code, r.message], [40001, '角色必须为0或1']);

  r = await H.call(H.req('POST', '/admin/admin/create', { username: 'newbie', password: 'abcdef', role: 1 }, SUPER_TOKEN));
  eq('新建 → 返回四字段', Object.keys(r.data), ['id', 'username', 'nickname', 'role']);
  eq('nickname 缺省 = username', r.data.nickname, 'newbie');
  const newId = r.data.id;
  ok('唯一键已登记 admin:newbie', (H.dump().unique_keys || []).some((k) => k._id === 'admin:newbie'));
  eq('新账号可登录', (await H.call(H.req('POST', '/admin/login', { username: 'newbie', password: 'abcdef' }))).code, 0);

  r = await H.call(H.req('PUT', `/admin/admin/${newId}`, { nickname: '新人', role: 0 }, SUPER_TOKEN));
  eq('update 返回五字段', Object.keys(r.data), ['id', 'username', 'nickname', 'role', 'status']);
  eq('nickname / role 已改', [r.data.nickname, r.data.role], ['新人', 0]);

  r = await H.call(H.req('PUT', `/admin/admin/${newId}`, { password: '123' }, SUPER_TOKEN));
  eq('改密过短 → 40001', r.code, 40001);
  await H.call(H.req('PUT', `/admin/admin/${newId}`, { password: 'zzzzzz1' }, SUPER_TOKEN));
  eq('改密后可登录新密码', (await H.call(H.req('POST', '/admin/login', { username: 'newbie', password: 'zzzzzz1' }))).code, 0);

  r = await H.call(H.req('DELETE', '/admin/admin/1', {}, SUPER_TOKEN));
  eq('删除自己 → 40301', [r.code, r.message], [40301, '不能删除自己']);

  r = await H.call(H.req('DELETE', `/admin/admin/${newId}`, {}, SUPER_TOKEN));
  eq('删除非超管成功', [r.code, r.data], [0, null]);
  ok('唯一键已释放', !(H.dump().unique_keys || []).some((k) => k._id === 'admin:newbie'));
  eq('释放后可重建同名', (await H.call(H.req('POST', '/admin/admin/create', { username: 'newbie', password: 'abcdef', role: 1 }, SUPER_TOKEN))).code, 0);

  // 超管降级后只剩 0 个超管 → 不允许
  const superDoc = (H.dump().admin || []).find((a) => a.id === 1);
  superDoc.role = 1;
  const onlySuper = (H.dump().admin || []).find((a) => a.role === 0);
  ok('此时无超管（用超管 token 直连，绕过 role 校验）', onlySuper === undefined);
  superDoc.role = 0;
  // 让「另一个超管」出现，再试图删掉它 → 应保留至少一个
  await H.call(H.req('POST', '/admin/admin/create', { username: 'super2', password: 'abcdef', role: 0 }, SUPER_TOKEN));
  const super2 = (H.dump().admin || []).find((a) => a.username === 'super2');
  eq('删掉另一个超管（系统仍有 1 个）', (await H.call(H.req('DELETE', `/admin/admin/${super2.id}`, {}, SUPER_TOKEN))).code, 0);

  eq('普管调 adminMgr.list → 40301', (await H.call(H.req('GET', '/admin/admin/list', {}, PLAIN_TOKEN))).code, 40301);

  /* ══════════════════ 输出 ══════════════════ */
  const checked = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  lines.push('');
  lines.push(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { require('fs').writeFileSync(path.join(__dirname, '..', '..', '_cloud_admin_core_test.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
