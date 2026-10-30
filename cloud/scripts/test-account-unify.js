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
 *   ④ 新建老师账号会自动建 user 行；删老师账号会把 user 行一起删
 *   ⑤ 删站员**不删** user 行（他首先还是学生）
 *   ⑥ 存量老师没有 userId 时，登录会就地补建并回填（惰性迁移）
 *   ⑦ 站员不接受手打建号（没有学生档案就拒绝）
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

  /* ══════════ 4. 新建老师账号自动建 user 行 ══════════ */
  section('4. 新建后台账号 → 自动建 user 行（kind=teacher）');
  reset();

  const rootTok = sign({ id: 1, username: 'root', role: 0, pv: pwdVersionOf(null) });
  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'T2024001', password: 'teach123', nickname: '王老师', role: 0 }, rootTok));
  eq('新建老师 → 成功', r.code, 0);

  const tUser = userOf('T2024001');
  ok('user 表里自动出现这条老师记录', Boolean(tUser));
  eq('kind = teacher', tUser && tUser.kind, 'teacher');
  eq('admin.userId 已回填', adminOf('T2024001').userId, tUser.id);

  r = await H.call(H.req('POST', '/admin/login', { username: 'T2024001', password: 'teach123' }));
  eq('新老师能登录', r.code, 0);

  // 删掉它 → user 行要跟着走，否则这个工号永久占着
  r = await H.call(H.req('DELETE', `/admin/admin/${adminOf('T2024001').id}`, {}, rootTok));
  eq('删除老师账号 → 成功', r.code, 0);
  ok('老师的 user 行被一起删掉', userOf('T2024001') === null);

  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'T2024001', password: 'teach123', role: 0 }, rootTok));
  eq('同名可以重建（没被孤儿记录挡住）', r.code, 0);

  /* ══════════ 5. 删站员不删 user ══════════ */
  section('5. 删站员 → user 行必须留着（他首先还是学生）');
  reset();

  r = await H.call(H.req('DELETE', '/admin/admin/2', {}, rootTok));
  eq('删除站员 → 成功', r.code, 0);
  ok('站员的 user 行还在（学生端还要用同一个学号）', userOf('20240101') !== null);
  eq('user 的 kind 仍然是 student', userOf('20240101').kind, 'student');

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
  section('7. 站员必须挂在学生档案上');
  reset();

  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'member9', password: 'abcdef', role: 2 }, rootTok));
  eq('role=2 但没有 userId → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'member9', password: 'abcdef', role: 2, userId: 1 }, rootTok));
  eq('role=2 且挂了真实学生档案 → 可以建', r.code, 0);
  eq('userId 落库正确', adminOf('member9').userId, 1);

  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: 'member9b', password: 'abcdef', role: 2, userId: 999 }, rootTok));
  eq('挂不存在的档案 → 40401', r.code, 40401);

  /* ══════════ 8. 用户名撞车要报错，不能静默复用 ══════════ */
  section('8. 老师工号撞学生学号 → 拒绝，不共用一条 user');
  reset();

  r = await H.call(H.req('POST', '/admin/admin/create',
    { username: '20240101', password: 'abcdef', role: 0 }, rootTok));
  eq('工号撞学生学号 → 40901', r.code, 40901);
  eq('学生那条 user 没被改动', userOf('20240101').password, STUDENT_HASH);

  /* ── 汇总 ── */
  lines.push('\n──────────────────────────');
  lines.push(`结论：断言 ${lines.filter((l) => l.startsWith('OK ') || l.startsWith('FAIL')).length} 项 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身出错：', (e && e.stack) || e);
  process.exit(2);
});
