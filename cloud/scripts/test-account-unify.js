'use strict';

/**
 * 账号密码统一 · 本地实测（2026-10-31）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-account-unify.js
 *
 * 覆盖这件事的全部主张：
 *   ① 一个学号只有一份密码 —— 站员用**学生密码**就能进伙伴端
 *   ② 改了学生密码，旧的 admin 密码立刻不认（不再读 admin.password）
 *   ③ 改密后**三端**旧 token 同时失效，而且是同一秒就失效（没有 30 秒缓存窗口）
 *   ④ 超管 / 社干 / 站员 **三档只能从学生名册建**（2026-10-31 第二版口径）：
 *      账号=学号、密码=学生自己那份；手打账号密码一律拒绝
 *   ⑤ 删后台账号**不删**学生档案（他首先还是学生，要用同一个学号登学生端）
 *   ⑥ 存量老师没有 userId 时，登录会就地补建并回填（惰性迁移）
 *   ⑦ 同一学号不能有两个后台身份（40901，要改角色请走编辑）
 *
 * ⚠️ 为什么这些必须单独立一条：改的是登录和改密这类「错了就全站进不去」的路径，
 *    靠人工点几下验不完，而且改密即失效这种时序行为肉眼看不出来。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const { pwdVersionOf } = require(path.join(API_DIR, 'services', 'studentAccount'));

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

const STUDENT_PWD = 'stu12345';
const STUDENT_HASH = bcrypt.hashSync(STUDENT_PWD, 4);
const WANG_PWD = 'wang55pass';
const WANG_HASH = bcrypt.hashSync(WANG_PWD, 4);
const OLD_ADMIN_HASH = bcrypt.hashSync('oldadmin1', 4);
const T = new Date('2026-10-01T10:00:00+08:00');

/* ── 种子 ── */
function seedBase() {
  return {
    admin: [
      // 超管老师：**刻意不给 userId**，用来验惰性补建
      { _id: 'ad1', id: 1, username: 'root', password: OLD_ADMIN_HASH, nickname: '超管', role: 0, status: 1,
        userId: null, lastLoginAt: null, createTime: T, updateTime: T },
      // 站员：挂在学生 user 上，密码事实源在 user
      { _id: 'ad2', id: 2, username: '20240101', password: OLD_ADMIN_HASH, nickname: '沈方', role: 2, status: 1,
        userId: 1, lastLoginAt: null, createTime: T, updateTime: T },
    ],
    user: [
      { _id: 'u1', id: 1, username: '20240101', password: STUDENT_HASH, kind: 'student',
        nickname: '沈方', grade: '2024', classNo: '01', seatNo: '01', status: 1,
        pwdChangedAt: null, loginCount: 0, createTime: T, updateTime: T },
      // 没有任何后台身份、且**从没设过密码** —— 验「建号时给他落初始密码」
      { _id: 'u2', id: 2, username: '20240202', password: null, kind: 'student',
        nickname: '李四', grade: '2024', classNo: '02', seatNo: '02', status: 1,
        pwdChangedAt: null, loginCount: 0, createTime: T, updateTime: T },
      // 有密码、没有后台身份 —— 验「密码就是他自己的学生密码」
      { _id: 'u3', id: 3, username: '20240303', password: WANG_HASH, kind: 'student',
        nickname: '王五', grade: '2024', classNo: '03', seatNo: '03', status: 1,
        pwdChangedAt: null, loginCount: 0, createTime: T, updateTime: T },
    ],
  };
}

function reset() {
  H.reset(seedBase());
}

/** 从 dump 里捞一条 user */
function userOf(username) {
  return (H.dump().user || []).find((u) => u.username === username) || null;
}
function adminOf(username) {
  return (H.dump().admin || []).find((a) => a.username === username) || null;
}

(async () => {
  lines.push('══ 账号密码统一 · 本地实测 ══');

  /* ══════════ 1. 站员用学生密码登伙伴端 ══════════ */
  section('1. 一个学号一份密码：站员用学生密码就能进');
  reset();

  let r = await H.call(H.req('POST', '/admin/login', { username: '20240101', password: STUDENT_PWD }));
  eq('用学生密码登伙伴端 → 成功', r.code, 0);

  r = await H.call(H.req('POST', '/admin/login', { username: '20240101', password: 'oldadmin1' }));
  eq('用旧的 admin 密码 → 40101（不再读 admin.password）', r.code, 40101);

  /* ══════════ 2. 学生改密后，伙伴端立刻同密码 ══════════ */
  section('2. 学生端改密 → 伙伴端立刻用新密码');
  reset();

  const studentToken = sign({ openid: '20240101', uid: 1, username: '20240101', pv: 0 });
  r = await H.call(H.req('PUT', '/user/change-password', { oldPassword: STUDENT_PWD, newPassword: 'newpw123' }, studentToken));
  eq('学生端改密 → 成功', r.code, 0);

  r = await H.call(H.req('POST', '/admin/login', { username: '20240101', password: 'newpw123' }));
  eq('伙伴端用学生的新密码 → 成功', r.code, 0);

  r = await H.call(H.req('POST', '/admin/login', { username: '20240101', password: STUDENT_PWD }));
  eq('学生旧密码登伙伴端 → 40101', r.code, 40101);

  /* ══════════ 3. 改密 = 三端旧 token 同一秒全废 ══════════ */
  section('3. 改密后三端旧 token 立刻失效（没有 30 秒窗口）');
  reset();

  // 三条 token 指向同一个人：后台 / 伙伴端 / 学生端
  const adminTok = (await H.call(H.req('POST', '/admin/login', { username: '20240101', password: STUDENT_PWD }))).data.token;
  const stuTok = sign({ openid: '20240101', uid: 1, username: '20240101', pv: 0 });

  eq('改密前：后台 token 可用', (await H.call(H.req('GET', '/admin/profile', {}, adminTok))).code, 0);
  eq('改密前：学生 token 可用', (await H.call(H.req('GET', '/user/me', {}, stuTok))).code, 0);

  // 通过后台改密（写的是 user.password）
  r = await H.call(H.req('PUT', '/admin/change-password',
    { oldPassword: STUDENT_PWD, newPassword: 'brandnew1' }, adminTok));
  eq('后台改密 → 成功且返回新 token', [r.code, typeof r.data.token], [0, 'string']);
  const freshTok = r.data.token;

  // ⚠️ 紧接着同一秒验：如果走了 30 秒缓存，这两条会误判为「还能用」
  eq('改密后：后台旧 token 立刻 40101', (await H.call(H.req('GET', '/admin/profile', {}, adminTok))).code, 40101);
  eq('改密后：学生端旧 token 立刻 40101', (await H.call(H.req('GET', '/user/me', {}, stuTok))).code, 40101);
  eq('改密后：新 token 可以继续用', (await H.call(H.req('GET', '/admin/profile', {}, freshTok))).code, 0);

  /* ══════════ 4. 三档都只能从学生名册建 ══════════ */
  section('4. 超管 / 社干 也必须从学生名册建（账号=学号、密码=学生自己那份）');
  reset();

  const rootTok = sign({ id: 1, username: 'root', role: 0, pv: pwdVersionOf(null) });

  // 老形态（手打账号密码）必须**明确拒绝**，不能静默忽略
  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'T2024001', password: 'teach123', nickname: '王老师', role: 0 }, rootTok));
  eq('手打账号密码（没传 userId）→ 40001', r.code, 40001);
  ok('没有偷偷建出一条叫 T2024001 的野账号', adminOf('T2024001') === null);

  r = await H.call(H.req('POST', '/admin/admin/create', { userId: 2, role: 9 }, rootTok));
  eq('角色非法 → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/admin/create', { userId: 999, role: 0 }, rootTok));
  eq('挂不存在的学生档案 → 40401', r.code, 40401);

  // 超管建在一个**从没设过密码**的学生身上 → 必须顺手落初始密码，否则建出来登不进去
  r = await H.call(H.req('POST', '/admin/admin/create', { userId: 2, role: 0 }, rootTok));
  eq('超管从名册建 → 成功', r.code, 0);
  eq('账号自动取学号（不接受手打）', adminOf('20240202').username, '20240202');
  eq('admin.userId 回指学生档案', adminOf('20240202').userId, 2);
  eq('role = 0 超管', adminOf('20240202').role, 0);
  ok('学生档案仍是他自己那条（没被改 kind）', userOf('20240202').kind === 'student');
  ok('学生原本没密码 → 界面能拿到初始密码', Boolean(r.data && r.data.initPassword));

  r = await H.call(H.req('POST', '/admin/login', { username: '20240202', password: 'user20240202' }));
  eq('这个新超管能用「user+学号」登录', r.code, 0);

  // 社干建在一个**已经有密码**的学生身上 → 密码就该是他自己那份
  r = await H.call(H.req('POST', '/admin/admin/create', { userId: 3, role: 1 }, rootTok));
  eq('社干从名册建 → 成功', r.code, 0);
  eq('已有的学生密码原样沿用（不重置）', userOf('20240303').password, WANG_HASH);
  ok('这种情况不返回初始密码（密码是他自己的）', !(r.data && r.data.initPassword));
  eq('能用他自己的学生密码登录', (await H.call(H.req('POST', '/admin/login',
    { username: '20240303', password: WANG_PWD }))).code, 0);

  // 同一学号不能有两个后台身份
  r = await H.call(H.req('POST', '/admin/admin/create', { userId: 3, role: 2 }, rootTok));
  eq('这个学号已经是后台账号 → 40901', r.code, 40901);

  // 删超管：admin 行没了，但**学生的档案必须留着**
  r = await H.call(H.req('DELETE', `/admin/admin/${adminOf('20240202').id}`, {}, rootTok));
  eq('删除这个超管 → 成功', r.code, 0);
  ok('学生档案没被删（他还要用同一个学号登学生端）', userOf('20240202') !== null);
  eq('删掉后可以重新建（没被唯一键挡住）',
    (await H.call(H.req('POST', '/admin/admin/create', { userId: 2, role: 2 }, rootTok))).code, 0);

  /* ══════════ 5. 删后台身份不删学生档案 ══════════ */
  section('5. 删后台身份 → 学生档案必须留着（他首先还是学生）');
  reset();

  r = await H.call(H.req('DELETE', '/admin/admin/2', {}, rootTok));
  eq('删除站员 → 成功', r.code, 0);
  ok('站员的 user 行还在（学生端还要用同一个学号）', userOf('20240101') !== null);
  eq('user 的 kind 仍然是 student', userOf('20240101').kind, 'student');
  eq('学生密码没被动过', userOf('20240101').password, STUDENT_HASH);

  /* ══════════ 6. 存量老师惰性补建 ══════════ */
  section('6. 存量 admin 没有 userId → 登录时就地补建');
  reset();
  ok('补建前：没有 root 的 user 记录', userOf('root') === null);

  r = await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'oldadmin1' }));
  eq('老老师用原密码登录 → 成功（哈希原样搬，不用重设密码）', r.code, 0);
  const rootUser = userOf('root');
  ok('user 表补出了 root 这条', Boolean(rootUser));
  eq('kind = teacher', rootUser && rootUser.kind, 'teacher');
  eq('admin.userId 已回填', adminOf('root').userId, rootUser.id);
  // ⚠️ pwdChangedAt 必须是 null：否则 pv 非 0，老师手上那些没有 pv 的老 token 会被全场踢掉
  ok('pwdChangedAt 保持 null（老 token 不会被误踢）', rootUser.pwdChangedAt == null);

  r = await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'wrongpass' }));
  eq('错密码 → 40101', r.code, 40101);
  ok('错密码不会往 user 表写垃圾数据', (H.dump().user || []).filter((u) => u.username === 'root').length === 1);

  /* ══════════ 7. 站员不接受手打建号 ══════════ */
  section('7. 任意一档缺 userId 都建不出号（没有野账号这条路）');
  reset();

  for (const role of [0, 1, 2]) {
    r = await H.call(H.req('POST', '/admin/admin/create',
      { username: `hand${role}`, password: 'abcdef', role }, rootTok));
    eq(`role=${role} 没传 userId → 40001`, r.code, 40001);
  }
  ok('一条手打账号都没落库', ['hand0', 'hand1', 'hand2'].every((n) => adminOf(n) === null));

  /* ══════════ 8. 批量拉人：三档同一套，重复的跳过不整体失败 ══════════ */
  section('8. 批量从名册建号（超管 / 社干 / 站员 都走这一条）');
  reset();

  r = await H.call(H.req('POST', '/partner/accounts/import',
    { userIds: [2, 3], role: 2 }, rootTok));
  eq('批量建站员 → 成功', r.code, 0);
  eq('建了 2 个', r.data && r.data.createdCount, 2);
  eq('账号都是学号', (H.dump().admin || []).filter((a) => Number(a.role) === 2)
    .map((a) => a.username).sort(), ['20240101', '20240202', '20240303']);

  r = await H.call(H.req('POST', '/partner/accounts/import',
    { userIds: [2, 3], role: 1 }, rootTok));
  eq('重复导入 → 不整体失败', r.code, 0);
  eq('两个都被跳过', r.data && r.data.skipped.length, 2);
  eq('角色没被偷偷改掉', adminOf('20240202').role, 2);

  r = await H.call(H.req('POST', '/partner/accounts/import',
    { userIds: [1], role: 0 }, rootTok));
  eq('把已有学生提成超管 → 40901 被跳过', r.data && r.data.skipped.length, 1);
  ok('跳过理由说明白了', /已经是后台账号/.test((r.data && r.data.skipped[0] && r.data.skipped[0].reason) || ''));

  /* ══════════ 9. 批量重置密码必须真改到 user.password ══════════ */
  section('9. 批量重置密码要落到密码事实源（只改 admin.password = 空转）');
  reset();

  const before = userOf('20240101').password;
  r = await H.call(H.req('POST', '/admin/admin/reset-password/batch', { range: 'all' }, rootTok));
  eq('批量重置 → 成功', r.code, 0);

  ok('user.password 真的变了（不是只改了 admin 那份镜像）', userOf('20240101').password !== before);
  ok('同时升了 pwdChangedAt（旧 token 会被踢）', userOf('20240101').pwdChangedAt != null);
  eq('重置后能用「user+学号」登录',
    (await H.call(H.req('POST', '/admin/login', { username: '20240101', password: 'user20240101' }))).code, 0);
  eq('旧的学生密码已经失效',
    (await H.call(H.req('POST', '/admin/login', { username: '20240101', password: STUDENT_PWD }))).code, 40101);

  /* ── 汇总 ── */
  lines.push('\n──────────────────────────');
  lines.push(`结论：断言 ${lines.filter((l) => l.startsWith('OK ') || l.startsWith('FAIL')).length} 项 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身出错：', (e && e.stack) || e);
  process.exit(2);
});
