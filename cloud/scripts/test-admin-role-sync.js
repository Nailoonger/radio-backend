'use strict';

// 管理端「切角色实时同步」—— 真路由 + 真 handler + 内存云库
//
// 用法（仓库根目录）：
//   node cloud/scripts/test-admin-role-sync.js
//
// ═══════════ 这个套件守什么（2026-11-02 陛下报的 bug）═══════════
// 「管理端 web 在账号管理那里切换账号角色的时候，无法做到实时同步，导致权限错乱」
//
// 病根是两层，两层都不报错：
//   ① JWT 里的 role 是**签发那一刻的快照**，`requireAdmin` 直接信它 ⇒
//      把人从超管改成社干，他手里的旧 token 还能调 asSuper（降权不生效）；
//      把社干升成超管，他那边永远按 role=1 跑（升权不生效，要等 7 天 token 过期）。
//   ② 直连后端的 update 只认 `[0, 1]` 两档 ⇒ 改成「站员」被**静默丢弃**，
//      界面提示保存成功、刷新还是原角色。
//
// 所以这里钉四件事：
//   · 角色**以库为准**：库里降权后，旧 token 立刻 40301；库里升权后，旧 token 立刻放行
//   · 停用即失效：库里 status=0，旧 token 立刻 40101
//   · update 接口三档都能写进去（含站员），非法值报错而不是静默忽略
//   · 最后一位超管不许被降级（否则整站锁死在系统管理之外）

const assert = require('assert');
const path = require('path');
const H = require('./harness');
const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib/auth'));

let checks = 0;
const equal = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const yes = (name, cond) => { assert.ok(cond, name); checks++; };

/** 角色号在库里是什么，token 里**故意**写成另一个 —— 正是要测的错位 */
const token = (id, role, username) => sign({ id, username: username || `u${id}`, role });

function seed(extraAdmins) {
  const admin = [
    { id: 1, username: 'teacher', role: 0, status: 1, nickname: '老师' },
    { id: 2, username: 'cadre1', role: 1, status: 1, nickname: '社干甲', userId: 21 },
    { id: 3, username: 'staff1', role: 2, status: 1, nickname: '站员丙', userId: 31 },
    { id: 4, username: 'off', role: 1, status: 0, nickname: '已停用的人', userId: 41 },
  ].concat(extraAdmins || []);
  return { admin: admin.map((a) => ({ _id: `a${a.id}`, ...a })) };
}

const reset = (extra) => H.reset(seed(extra));
const call = (method, url, body, tk) => H.call(H.req(method, url, body || {}, tk || ''));

/** 超管 token（库里 id=1 确实是 role 0） */
const SUPER = () => token(1, 0, 'teacher');

(async () => {
  /* ───────── ① 降权：库里改成社干，旧 token 里还写着超管 ───────── */
  reset();
  let r = await call('GET', '/admin/admin/list', {}, SUPER());
  equal('超管 token + 库里是超管：能看账号列表', r.code, 0);

  // id=2 在库里是社干，token 却写着 role=0（改角色之前的旧 token）
  r = await call('GET', '/admin/admin/list', {}, token(2, 0, 'cadre1'));
  equal('降权后旧 token 立刻失去超管权限（以库为准）', r.code, 40301);

  r = await call('PUT', '/admin/admin/3', { role: 1 }, token(2, 0, 'cadre1'));
  equal('降权后旧 token 也改不了别人角色', r.code, 40301);

  /* ───────── ② 升权：库里改成超管，旧 token 里还写着社干 ───────── */
  reset([{ id: 5, username: 'newsuper', role: 0, status: 1, nickname: '新超管' }]);
  // 让 id=2 在库里就是超管（升权已经发生），但客户端 token 还是 role=1
  H.reset({ admin: [
    { _id: 'a1', id: 1, username: 'teacher', role: 0, status: 1, nickname: '老师' },
    { _id: 'a2', id: 2, username: 'cadre1', role: 0, status: 1, nickname: '刚升上来的超管', userId: 21 },
  ] });
  r = await call('GET', '/admin/admin/list', {}, token(2, 1, 'cadre1'));
  equal('升权后旧 token 立刻按新角色放行（不用重新登录）', r.code, 0);

  /* ───────── ③ 停用：不在入口拦（拦截仍在业务层，保持既有 40301 口径）───────── */
  reset();
  r = await call('GET', '/admin/profile', {}, token(4, 1, 'off'));
  equal('停用账号的入口不受影响（没把「不让干」改成「登录失效」）', r.code, 0);
  equal('读到的角色仍是库里的值', Number(r.data.role), 1);

  r = await call('GET', '/admin/profile', {}, SUPER());
  equal('超管自己不受影响', r.code, 0);
  equal('profile 里的角色是库里的值', Number(r.data.role), 0);

  /* ───────── ④ update：三档都能写进去 ───────── */
  reset();
  r = await call('PUT', '/admin/admin/2', { role: 1 }, SUPER());
  equal('改成社干：接口回的是新角色', Number(r.data.role), 1);

  r = await call('PUT', '/admin/admin/2', { role: 2 }, SUPER());
  equal('改成站员：接口回的是新角色（不是静默丢弃）', Number(r.data.role), 2);

  r = await call('GET', '/admin/admin/list', {}, SUPER());
  const row2 = (r.data.list || []).find((x) => Number(x.id) === 2);
  equal('列表里也跟着变成站员', Number(row2 && row2.role), 2);

  r = await call('PUT', '/admin/admin/2', { role: '0' }, SUPER());
  equal('字符串角色也认（Number 之后入库）', Number(r.data.role), 0);

  r = await call('PUT', '/admin/admin/2', { role: 9 }, SUPER());
  equal('非法角色报参数错，不静默忽略', r.code, 40001);

  /* ───────── ⑤ 最后一位超管不许被降级 ───────── */
  reset();
  r = await call('PUT', '/admin/admin/1', { role: 1 }, SUPER());
  equal('唯一超管把自己改成社干：拒绝', r.code, 40301);
  yes('拒绝时给出的是人话', /至少保留一个超级管理员/.test(r.message || ''));

  // 还有第二个超管时，就可以降
  reset([{ id: 6, username: 'teacher2', role: 0, status: 1, nickname: '另一个超管' }]);
  r = await call('PUT', '/admin/admin/1', { role: 1 }, SUPER());
  equal('另有超管时允许降级', r.code, 0);
  equal('降级后角色真的是社干', Number(r.data.role), 1);

  /* ───────── ⑥ 站员必须挂学生档案（与直连同口径）───────── */
  reset([{ id: 7, username: 'noguy', role: 1, status: 1, nickname: '没有学生档案的账号' }]);
  r = await call('PUT', '/admin/admin/7', { role: 2 }, SUPER());
  equal('没有 userId 的账号不能改成站员', r.code, 40001);
  yes('文案说清了原因', /学生档案/.test(r.message || ''));

  /* ───────── ⑦ 没这条 admin 行的 token：保持既有行为（不因加校验把人挡在门外）───────── */
  r = await call('GET', '/admin/profile', {}, token(99, 0, 'ghost'));
  equal('库里没有这个人：仍按原逻辑报「账号不存在」', r.code, 40101);

  console.log(`\n结论：断言 ${checks} 项 / 失败 0 项`);
})().catch((err) => {
  console.error(err);
  // ⚠️ 失败也要有「结论」行：regression.js 靠这一行判定这个脚本跑没跑起来
  console.log('\n结论：断言 0 项 / 失败 1 项');
  process.exitCode = 1;
});
