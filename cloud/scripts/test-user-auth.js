'use strict';

/**
 * 用户端 登录 / 改密 / 当前用户 本地实测（阶段 4 第二批）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-user-auth.js
 *
 * 重点盯三条容易「静默错」的语义：
 *   1. 登录失败文案必须统一（不区分「账号不存在」与「密码错」）—— 否则可被用来探测有效学号
 *   2. 改密后**旧 token 必须立刻失效**（靠 JWT 里的 pv + 30s 状态缓存）
 *   3. dto 里**绝不能出现 password**（原模型靠 defaultScope 排除，文档库没有 scope，得自己保证）
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const bcrypt = require('bcryptjs');
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

/** reset + 清两个实例级缓存（开关 3s 缓存 / 账号状态 30s 缓存），否则用例之间串味 */
function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  accountService._clearCache();
}

const USERNAME = '20240101';
const PWD = 'user20240101';
const HASH = bcrypt.hashSync(PWD, 8);

function studentSeed(extra = {}) {
  return {
    user: [{
      _id: 'u1', id: 1, openid: null, username: USERNAME, password: HASH,
      nickname: '', remark: '张三', grade: '2024', classNo: '01', seatNo: '01',
      status: 1, loginCount: 0, pwdChangedAt: null, avatar: '', createTime: new Date(), updateTime: new Date(),
      ...extra,
    }],
  };
}

const OLD_TOKEN = sign({ openid: USERNAME, uid: 1, username: USERNAME, pv: 0 });

(async () => {
  // ================= A. 账号密码登录 =================
  section('A. POST /user/login/account');
  reset(studentSeed());

  eq('缺参数 → 40001', (await H.call(H.req('POST', '/user/login/account', { username: USERNAME }))).code, 40001);

  const noUser = await H.call(H.req('POST', '/user/login/account', { username: '20999999', password: 'x1234567' }));
  eq('账号不存在 → 40101', noUser.code, 40101);
  const badPwd = await H.call(H.req('POST', '/user/login/account', { username: USERNAME, password: 'wrong1234' }));
  eq('密码错 → 40101', badPwd.code, 40101);
  eq('两种失败的文案完全一致（防学号探测）', noUser.message, badPwd.message);

  const okLogin = await H.call(H.req('POST', '/user/login/account', { username: `  ${USERNAME}  `, password: PWD }));
  eq('登录成功 code', okLogin.code, 0);
  ok('登录返回 token', typeof okLogin.data.token === 'string' && okLogin.data.token.length > 20);
  eq('dto.username', okLogin.data.user.username, USERNAME);
  eq('dto.name 取 remark', okLogin.data.user.name, '张三');
  eq('dto.className 由年级班级拼出', okLogin.data.user.className, '2024 级 1 班');
  eq('dto.isDefaultPwd（未改过密）', okLogin.data.user.isDefaultPwd, true);
  eq('dto.loginCount 已 +1', okLogin.data.user.loginCount, 1);
  ok('dto 里没有 password', okLogin.data.user.password === undefined, JSON.stringify(Object.keys(okLogin.data.user)));

  const dbUser = H.dump().user[0];
  eq('落库 lastLoginAt 已写', dbUser.lastLoginAt !== undefined && dbUser.lastLoginAt !== null, true);
  eq('落库 loginCount 已 +1', dbUser.loginCount, 1);

  // token 可用且能过 assertTokenFresh
  const meAfterLogin = await H.call(H.req('GET', '/user/me', {}, okLogin.data.token));
  eq('登录拿到的 token 可用', meAfterLogin.code, 0);

  reset(studentSeed({ status: 0 }));
  eq('账号已停用 → 40301', (await H.call(H.req('POST', '/user/login/account', { username: USERNAME, password: PWD }))).code, 40301);

  reset(studentSeed({ password: null }));
  eq('没设过密码 → 40101（同一句文案）', (await H.call(H.req('POST', '/user/login/account', { username: USERNAME, password: PWD }))).message, '账号或密码错误');

  // ================= B. 改密 =================
  section('B. PUT /user/change-password');

  reset(studentSeed());
  eq('未登录 → 40101', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: 'abc12345' }))).code, 40101);

  // 老微信用户（token 无 username）不允许改密
  const wxToken = sign({ openid: 'wx_openid_only' });
  eq('微信用户 token → 40101', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: 'a', newPassword: 'abc12345' }, wxToken))).code, 40101);

  eq('缺参数 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD }, OLD_TOKEN))).code, 40001);
  eq('新密码太短 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: 'abc123' }, OLD_TOKEN))).code, 40001);
  eq('新密码全字母 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: 'abcdefgh' }, OLD_TOKEN))).code, 40001);
  eq('新密码全数字 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: '12345678' }, OLD_TOKEN))).code, 40001);
  eq('新旧相同 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: PWD }, OLD_TOKEN))).code, 40001);
  eq('原密码错 → 40001', (await H.call(H.req('PUT', '/user/change-password', { oldPassword: 'wrong1234', newPassword: 'abc12345' }, OLD_TOKEN))).code, 40001);

  const chg = await H.call(H.req('PUT', '/user/change-password', { oldPassword: PWD, newPassword: 'abc12345' }, OLD_TOKEN));
  eq('改密成功 code', chg.code, 0);
  ok('改密返回新 token', typeof chg.data.token === 'string' && chg.data.token !== OLD_TOKEN);
  eq('dto.isDefaultPwd 已变 false', chg.data.user.isDefaultPwd, false);

  const afterChg = H.dump().user[0];
  eq('落库 pwdChangedAt 已写', !!afterChg.pwdChangedAt, true);
  eq('落库新密码可校验', bcrypt.compareSync('abc12345', afterChg.password), true);
  eq('落库旧密码已失效', bcrypt.compareSync(PWD, afterChg.password), false);

  // ★ 关键：旧 token 必须立刻作废（pv 不匹配）
  eq('改密后旧 token → 40101', (await H.call(H.req('GET', '/user/me', {}, OLD_TOKEN))).code, 40101);
  eq('改密后新 token 可用', (await H.call(H.req('GET', '/user/me', {}, chg.data.token))).code, 0);
  eq('改密后可用新密码登录', (await H.call(H.req('POST', '/user/login/account', { username: USERNAME, password: 'abc12345' }))).code, 0);
  eq('改密后旧密码登录失败', (await H.call(H.req('POST', '/user/login/account', { username: USERNAME, password: PWD }))).code, 40101);

  // 管理员停用账号后，已登录用户的 token 也应失效
  reset(studentSeed());
  const liveToken = sign({ openid: USERNAME, uid: 1, username: USERNAME, pv: 0 });
  eq('停用前 token 可用', (await H.call(H.req('GET', '/user/me', {}, liveToken))).code, 0);
  const dbUser2 = H.dump().user[0];
  H.store.get('user').set(dbUser2._id, { ...dbUser2, status: 0 });
  accountService._clearCache();
  eq('停用后 token → 40101', (await H.call(H.req('GET', '/user/me', {}, liveToken))).code, 40101);

  // ================= C. 微信登录（老通道） =================
  section('C. POST /user/login（微信通道）');

  reset({});
  const blocked = await H.call(H.req('POST', '/user/login', { code: 'mockcode' }));
  eq('默认（开关 on）→ 40302 强制账号登录', blocked.code, 40302);

  reset({ system_switch: [{ _id: 'switch:account_login_required', key: 'account_login_required', value: 'off' }] });
  process.env.MOCK_WECHAT = '1';
  const wx1 = await H.call(H.req('POST', '/user/login', { code: 'mockcode', nickname: '小明', avatar: 'evil.png' }));
  eq('开关 off → 微信登录放行', wx1.code, 0);
  ok('返回 token', typeof wx1.data.token === 'string');
  eq('首登昵称落库', wx1.data.user.nickname, '小明');
  eq('头像一律丢弃（不落库）', wx1.data.user.avatar, '');
  const wxRow = H.dump().user[0];
  eq('新用户 id 自增', wxRow.id, 1);
  eq('新用户 status=1', wxRow.status, 1);
  eq('新用户 username 为空（非账号用户）', wxRow.username, null);

  const wx2 = await H.call(H.req('POST', '/user/login', { code: 'mockcode' }));
  eq('二次登录同一 openid 不重复建号', H.dump().user.length, 1);
  eq('二次登录 code', wx2.code, 0);
  delete process.env.MOCK_WECHAT;

  // ================= D. 当前用户 =================
  section('D. GET /user/me');

  reset(studentSeed());
  eq('未登录 → 40101', (await H.call(H.req('GET', '/user/me'))).code, 40101);

  const me1 = await H.call(H.req('GET', '/user/me', {}, OLD_TOKEN));
  eq('me code', me1.code, 0);
  eq('me 返回年级班级（账号用户）', me1.data.className, '2024 级 1 班');
  eq('me 返回 name', me1.data.name, '张三');
  ok('me 里没有 password', me1.data.password === undefined);
  eq('账号用户 openid 为 null（库里就没存微信 openid）', me1.data.openid, null);

  reset({ user: [{ _id: 'w1', id: 7, openid: 'wx_openid_only', username: null, nickname: '老同学', avatar: '' }] });
  const me2 = await H.call(H.req('GET', '/user/me', {}, wxToken));
  eq('老微信用户 me code', me2.code, 0);
  eq('老微信用户只返回 base', JSON.stringify(Object.keys(me2.data).sort()), JSON.stringify(['avatar', 'nickname', 'openid']));

  reset(studentSeed());
  // ⚠️ 注意可达性：账号用户的 token 会先过 assertTokenFresh（库里查不到 → 40101），
  //    所以 /user/me 里那个 40401「用户不存在」分支**只对老微信用户 token 可达**。
  //    这与原实现一致（中间件先于 controller 执行），不要「顺手修成 40401」。
  eq(
    '账号用户在库中不存在 → 40101（中间件先拦）',
    (await H.call(H.req('GET', '/user/me', {}, sign({ openid: 'ghost', uid: 99, username: 'ghost', pv: 0 })))).code,
    40101
  );
  eq(
    '老微信用户 token 且库里查不到 → 40401',
    (await H.call(H.req('GET', '/user/me', {}, sign({ openid: 'ghost' })))).code,
    40401
  );

  lines.push('');
  lines.push(`结论：${lines.length} 行 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})();
