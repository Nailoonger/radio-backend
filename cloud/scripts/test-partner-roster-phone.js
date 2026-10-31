'use strict';

/**
 * 伙伴名册 · 手机号（2026-10-31）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-partner-roster-phone.js
 *
 * 覆盖：
 *   - 名册 GET /partner/people：三端都能看（超管 / 社干 / 站员），每项都带 phone 字段
 *   - `me`：自己那一行（前端置顶 + 判「要不要强制填」都靠它）
 *   - 自助改号码 PUT /partner/me/profile：只改自己、校验 11 位、去全角/空格/横线
 *   - needPhone：没填 = true，填完 = false（前端弹窗的唯一判据）
 *   - 脏数据：库里存了非法号，读接口给 '' 而不是把整张名册搞挂
 *
 * ⚠️ 为什么要单独守「站员也能调」：站员是 role=2，很多接口要求 asManager，
 *    名册一旦漏了这条，站员进名册就是 40301，而超管和社干测着全对。
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));

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

// 超管 id=1 / 社干 id=2 / 站员 id=5 / 停用 id=3
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });
const MGR_TOKEN = sign({ id: 2, username: '20231104', role: 1 });
const MEMBER_TOKEN = sign({ id: 5, username: '20240107', role: 2 });
const BANNED_TOKEN = sign({ id: 3, username: 'banned', role: 1 });

function baseSeed() {
  const t = new Date('2026-01-01T00:00:00+08:00');
  return {
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: 'x', nickname: '老师', role: 0, status: 1, department: '', dutyRoles: [], createTime: t, updateTime: t },
      { _id: 'ad2', id: 2, username: '20231104', password: 'x', nickname: '陈屿', role: 1, status: 1, department: '主持部', dutyRoles: ['主持'], createTime: t, updateTime: t },
      { _id: 'ad3', id: 3, username: 'banned', password: 'x', nickname: '停用', role: 1, status: 0, department: '', dutyRoles: [], createTime: t, updateTime: t },
      { _id: 'ad5', id: 5, username: '20240107', password: 'x', nickname: '周牧之', role: 2, status: 1, department: '播音部', dutyRoles: ['播音'], createTime: t, updateTime: t },
    ],
  };
}

const reset = () => H.reset(baseSeed());
const call = (method, p, body, token) => H.call(H.req(method, p, body || {}, token || ''));
const findRow = (list, id) => (list || []).filter((x) => x.personId === id)[0] || null;

(async () => {
  /* ══════════ 1. 名册读取 · 三端 ══════════ */
  section('1. GET /partner/people —— 三端都能看');

  reset();
  {
    const r = await call('GET', '/partner/people', {}, '');
    eq('未登录 → 40101', r.code, 40101);
  }
  {
    const r = await call('GET', '/partner/people', {}, BANNED_TOKEN);
    eq('停用账号 → 40301', r.code, 40301);
  }
  for (const [who, tok, name] of [['超管', SUPER_TOKEN, '老师'], ['社干', MGR_TOKEN, '陈屿'], ['站员', MEMBER_TOKEN, '周牧之']]) {
    const r = await call('GET', '/partner/people', {}, tok);
    eq(`${who}看名册成功`, r.code, 0);
    ok(`${who}拿到清单(${(r.data.list || []).length}人)`, (r.data.list || []).length === 3, `len=${(r.data.list || []).length}`);
    eq(`${who}自己是 me`, r.data.me && r.data.me.name, name);
    ok(`${who}没填过 ⇒ needPhone=true`, r.data.me && r.data.me.needPhone === true);
    eq(`${who}phone 空值是 '' 不是 null`, r.data.me && r.data.me.phone, '');
    const withPhone = (r.data.list || []).every((x) => typeof x.phone === 'string');
    ok(`${who}每个人都有 phone 字段（字符串）`, withPhone);
  }
  {
    const r = await call('GET', '/partner/people', {}, MEMBER_TOKEN);
    const me = r.data.me;
    eq('站员 me 带学号', me.username, '20240107');
    eq('站员 me 标出 isMember', me.isMember, true);
    const now = findRow(r.data.list, 2);
    eq('社干那行 isMember=false', now.isMember, false);
    eq('超管那行 isSuper=true', findRow(r.data.list, 1).isSuper, true);
  }

  /* ══════════ 2. 首次填写 · 校验 ══════════ */
  section('2. PUT /partner/me/profile —— 自助填号码');

  reset();
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '' }, MEMBER_TOKEN);
    eq('空号码 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '1380000' }, MEMBER_TOKEN);
    eq('不足 11 位 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '12800001104' }, MEMBER_TOKEN);
    eq('第二位不对 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/profile', {}, MEMBER_TOKEN);
    eq('不传 phone → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '13900002407' }, '');
    eq('未登录 → 40101', r.code, 40101);
  }
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '13900002407' }, MEMBER_TOKEN);
    eq('站员保存成功', r.code, 0);
    eq('回显号码', r.data.phone, '13900002407');
    eq('needPhone 转 false', r.data.needPhone, false);
    ok('记下修改时间', !!r.data.phoneUpdatedAt);
  }
  {
    const me = await call('GET', '/partner/me', {}, MEMBER_TOKEN);
    eq('/partner/me 读到号码', me.data.phone, '13900002407');
    eq('/partner/me needPhone=false', me.data.needPhone, false);
    const ppl = await call('GET', '/partner/people', {}, MEMBER_TOKEN);
    eq('名册里自己那行同步', (ppl.data.me || {}).phone, '13900002407');
    eq('名册 list 里也同步', findRow(ppl.data.list, 5).phone, '13900002407');
  }

  /* ══════════ 3. 清洗规则 ══════════ */
  section('3. 号码清洗 —— 空格 / 横线 / 括号 / 全角');

  reset();
  const CLEAN = [
    ['139 0000 2407', '带空格'],
    ['139-0000-2407', '带横线'],
    ['139（0000）2407', '带全角括号'],
    ['１３９００００２４０７', '全角数字'],
  ];
  for (const [raw, label] of CLEAN) {
    const r = await call('PUT', '/partner/me/profile', { phone: raw }, MEMBER_TOKEN);
    eq(`${label} → 规范化保存`, r.data && r.data.phone, '13900002407');
  }

  /* ══════════ 4. 只改自己 ══════════ */
  section('4. 只改自己 —— 不串号');

  reset();
  {
    await call('PUT', '/partner/me/profile', { phone: '13900002407' }, MEMBER_TOKEN);
    await call('PUT', '/partner/me/profile', { phone: '13800001104' }, MGR_TOKEN);
    const all = await call('GET', '/partner/people', {}, SUPER_TOKEN);
    eq('站员号还是自己的', findRow(all.data.list, 5).phone, '13900002407');
    eq('社干号是自己的', findRow(all.data.list, 2).phone, '13800001104');
    eq('超管没被顺带写', findRow(all.data.list, 1).phone, '');
    const sup = await call('GET', '/partner/me', {}, SUPER_TOKEN);
    eq('超管 needPhone 仍为 true', sup.data.needPhone, true);
  }
  {
    const r = await call('PUT', '/partner/me/profile', { phone: '13700001234', nickname: '改名试试' }, MEMBER_TOKEN);
    eq('夹带 nickname 不影响结果', r.code, 0);
    const me = await call('GET', '/partner/me', {}, MEMBER_TOKEN);
    eq('姓名没被改掉', me.data.name, '周牧之');
  }

  /* ══════════ 5. 脏数据不炸名册 ══════════ */
  section('5. 库里有脏号码 —— 读接口兜成空');

  {
    const seed = baseSeed();
    seed.admin[3].phone = '不是号码';       // 站员行（id=5）
    H.reset(seed);
    const r = await call('GET', '/partner/people', {}, SUPER_TOKEN);
    eq('脏号码不影响整张名册', r.code, 0);
    eq('脏号码读出来是空串', findRow(r.data.list, 5).phone, '');
    const me = await call('GET', '/partner/people', {}, MEMBER_TOKEN);
    eq('脏号码本人 needPhone=true（会让他重填）', me.data.me.needPhone, true);
  }

  /* ══════════ 6. 路由鉴权矩阵 ══════════ */
  section('6. 新接口的鉴权矩阵');

  reset();
  {
    const anon = await call('PUT', '/partner/me/profile', { phone: '13900002407' }, '');
    ok('未登录被拦', anon.code === 40101, `code=${anon.code}`);
    const banned = await call('PUT', '/partner/me/profile', { phone: '13900002407' }, BANNED_TOKEN);
    ok('停用账号被拦', banned.code === 40301, `code=${banned.code}`);
    const member = await call('PUT', '/partner/me/profile', { phone: '13900002407' }, MEMBER_TOKEN);
    ok('站员放行（自助类接口不设角色门槛）', member.code === 0, `code=${member.code}`);
  }

  /* ══════════ 输出 ══════════ */
  console.log(lines.join('\n'));
  const total = lines.filter((l) => l.startsWith('OK  ') || l.startsWith('FAIL')).length;
  // ⚠️ 这一行是 regression.js 的解析契约（正则要 `结论：… N 项 / 失败 M 项`），别改格式
  console.log(`\n结论：断言 ${total} 项 / 失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});
