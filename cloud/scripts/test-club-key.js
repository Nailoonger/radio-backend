'use strict';

/**
 * 社团密钥（生成 / 校验 / 作废 / 票据 / 换头像）—— 真路由 + 真 handler + 内存云库
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-club-key.js
 *
 * ═══════════ 这个套件守什么 ═══════════
 * 密钥这条线只有三种错法，而且**全都不报错**：
 *   ① 明文漏进返回体（列表/详情带出 `key_hash` 或明文）⇒ 钥匙等于公开，界面看着完全正常
 *   ② 作废不彻底（只改 status 不清哈希）⇒ 列表显示「已作废」，旧钥匙照样能进
 *   ③ 票据形同虚设（过期还能用 / 换个社团的票据能改别家头像）⇒ 越权且无痕
 * 所以这里不测 UI，只钉死：
 *   · 明文只出现在 `POST /partner/club-keys/:id/reset` 的返回里，别的地方一处都没有
 *   · 重置 ⇒ 旧密钥立刻失效，旧票据仍有效到过期（重置不是为了踢在校生）
 *   · 作废 ⇒ 哈希被清空，谁都进不来
 *   · 权限：超管恒过 / 社干看 clubkey 位 / 站员 40301
 *   · 试错闸：同一来源一分钟 8 次
 *   · 头像：只能换自己票据那一家（不接受前端传 clubId）
 */

const assert = require('assert');
const path = require('path');
const H = require('./harness');

const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib', 'auth'));
const clubKeySvc = require(path.join(API, 'services', 'clubKey'));

let checks = 0;
const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const ok = (name, cond, extra) => { assert.ok(cond, `${name}${extra ? ' :: ' + extra : ''}`); checks++; };
const section = (t) => console.log(`\n---- ${t} ----`);

/* ───────── 种子 ───────── */
const STU = '20240101';
const STU2 = '20240202';
const T_STU = sign({ openid: STU, uid: 1, username: STU, pv: 0 });
const T_STU2 = sign({ openid: STU2, uid: 2, username: STU2, pv: 0 });

/** 1 超管 / 2 社干甲 / 3 站员 */
const T_SUPER = sign({ id: 1, username: 'p1', role: 0 });
const T_MGR = sign({ id: 2, username: 'p2', role: 1 });
const T_MEMBER = sign({ id: 3, username: 'p3', role: 2 });

function seed(permDocs) {
  const out = {
    user: [
      { _id: 'u1', id: 1, openid: null, username: STU, status: 1, pwdChangedAt: null },
      { _id: 'u2', id: 2, openid: null, username: STU2, status: 1, pwdChangedAt: null },
    ],
    admin: [
      { _id: 'a1', id: 1, username: 'p1', nickname: '老师', role: 0, status: 1, dutyRoles: ['播音'], department: '播音部' },
      { _id: 'a2', id: 2, username: 'p2', nickname: '社干甲', role: 1, status: 1, dutyRoles: ['播音'], department: '播音部' },
      { _id: 'a3', id: 3, username: 'p3', nickname: '站员丙', role: 2, status: 1, dutyRoles: ['播音'], department: '播音部' },
    ],
  };
  if (permDocs) out.partner_permissions = permDocs;
  return out;
}

const reset = (permDocs) => H.reset(seed(permDocs));
const call = (method, url, body, token) => H.call(H.req(method, url, body || {}, token || ''));

const list = (token) => call('GET', '/partner/club-keys', {}, token);
const detail = (id, token) => call('GET', `/partner/club-keys/${id}`, {}, token);
const doReset = (id, token) => call('POST', `/partner/club-keys/${id}/reset`, {}, token);
const setStatus = (id, status, token) => call('PUT', `/partner/club-keys/${id}/status`, { status }, token);
const verifyKey = (key, token) => call('POST', '/user/club-key/verify', { key }, token);
const meOf = (ticket, token) => call('GET', '/user/club-key/me', { ticket }, token);

/** 1×1 PNG —— 只需要文件头能过 sniffMime */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  /* ═══════════ ① 免登录的社团清单 ═══════════ */
  section('① GET /user/club-key/clubs（免登录）');
  reset();
  let r = await call('GET', '/user/club-key/clubs');
  eq('免登录可读', r.code, 0);
  eq('种子恰好 5 家', r.data.list.length, 5);
  eq('顺序固定（按 id）', r.data.list.map((c) => c.name),
    ['摄影协会', '电视台', '青年志愿者协会', '学生会', '无与伦比吉他协会']);
  eq('露出的字段只有三个', Object.keys(r.data.list[0]).sort(), ['avatar', 'id', 'name']);
  ok('列表体里不含掩码/状态', !/key_mask|key_hash|status/.test(JSON.stringify(r.data.list)));

  /* ═══════════ ② 权限三道门 ═══════════ */
  section('② 谁能管密钥');
  eq('超管能看列表', (await list(T_SUPER)).code, 0);
  eq('社干默认也能看（缺行 = 全开）', (await list(T_MGR)).code, 0);
  eq('站员不能看', (await list(T_MEMBER)).code, 40301);
  eq('没登录不能看', (await list('')).code, 40101);

  reset([{ _id: 'global', schedule: true, review: true, proxy: true, clubkey: false }]);
  eq('超管关掉总闸也不影响自己', (await list(T_SUPER)).code, 0);
  r = await list(T_MGR);
  eq('社干被关掉 clubkey（统一四字文案）', r.code, 40301);
  eq('拒绝文案', r.message, '暂无权限');

  reset([{ _id: 'global', schedule: false, review: false, proxy: false, clubkey: true }]);
  eq('只开 clubkey 的社干可以管密钥', (await list(T_MGR)).code, 0);
  eq('但改社团信息仍要 clubkey 位（不是超管专属）',
    (await call('PUT', '/partner/club-keys/1', { ownerName: '林溪' }, T_MGR)).code, 0);

  /* ═══════════ ③ 初始状态：都没发钥匙 ═══════════ */
  section('③ 初始状态');
  reset();
  r = await list(T_SUPER);
  eq('5 家全部 status=0', r.data.list.every((x) => x.status === 0), true);
  eq('全部没有掩码', r.data.list.every((x) => x.mask === ''), true);
  eq('计数', r.data.count, { total: 5, active: 0, blank: 5 });
  ok('列表里没有 key_hash', !/key_hash/.test(JSON.stringify(r.data)));
  ok('列表里没有明文六位码', !/S9K3M7/.test(JSON.stringify(r.data)));

  const first = r.data.list[0];
  eq('详情能取到', (await detail(first.id, T_SUPER)).code, 0);

  /* ═══════════ ④ 重置：唯一一次明文 ═══════════ */
  section('④ 重置密钥');
  r = await doReset(first.id, T_SUPER);
  eq('重置成功', r.code, 0);
  const plain = r.data.plain;
  eq('明文 6 位', plain.length, clubKeySvc.KEY_LEN);
  ok('每一位都在字符集里（去掉了 0/O/1/I/L）',
    plain.split('').every((ch) => clubKeySvc.ALPHABET.indexOf(ch) >= 0), plain);
  ok('不含易认错的五个字符', !/[0O1IL]/.test(plain), plain);
  eq('掩码是后两位', r.data.mask, `····${plain.slice(-2)}`);
  eq('分享文案带社团名与明文', r.data.shareText.indexOf(plain) > 0 && r.data.shareText.indexOf('摄影协会') > 0, true);
  eq('reset 之后 status=1', r.data.record.status, 1);
  ok('返回体里没有 key_hash', !/key_hash/.test(JSON.stringify(r.data)));

  // 库里必须是哈希、不能是明文
  const doc = H.dump().club_keys.find((x) => x.id === first.id);
  eq('库里存的是 sha256（64 位十六进制）', /^[0-9a-f]{64}$/.test(doc.key_hash), true);
  ok('库里没有明文', JSON.stringify(doc).indexOf(plain) < 0);
  eq('库里只存掩码', doc.key_mask, `····${plain.slice(-2)}`);

  // 列表/详情永远不给明文
  r = await list(T_SUPER);
  ok('列表不含明文', JSON.stringify(r.data).indexOf(plain) < 0);
  r = await detail(first.id, T_SUPER);
  ok('详情不含明文', JSON.stringify(r.data).indexOf(plain) < 0);
  ok('详情也不含 key_hash', !/key_hash/.test(JSON.stringify(r.data)));

  /* ═══════════ ⑤ 学生输密钥 ═══════════ */
  section('⑤ POST /user/club-key/verify');
  eq('没登录不能验', (await verifyKey(plain, '')).code, 40101);
  eq('空密钥', (await verifyKey('', T_STU)).code, 40001);
  eq('位数不对', (await verifyKey(plain.slice(0, 3), T_STU)).code, 40001);
  eq('不存在的码', (await verifyKey('ZZZZZZ', T_STU)).code, 40401);

  // 小写 + 空格/横线都要能过（学生手抄常见）
  r = await verifyKey(` ${plain.toLowerCase().slice(0, 3)}-${plain.toLowerCase().slice(3)} `, T_STU);
  eq('小写+空格+横线也能过', r.code, 0);
  eq('票据是 48 位十六进制', /^[0-9a-f]{48}$/.test(r.data.ticket), true);
  eq('票据带回社团', r.data.club.name, '摄影协会');
  ok('票据有效期约 2 小时', Math.abs(r.data.expireAt - Date.now() - clubKeySvc.SESSION_TTL_MS) < 5000);
  const ticket = r.data.ticket;

  // 库里只存票据哈希
  const sess = H.dump().club_sessions[0];
  ok('库里不存票据明文', JSON.stringify(sess).indexOf(ticket) < 0);
  eq('票据绑定社团 id', sess.club_id, first.id);

  /* ═══════════ ⑥ 凭票据换社团 ═══════════ */
  section('⑥ GET /user/club-key/me');
  r = await meOf(ticket, T_STU);
  eq('票据有效', r.data.club.name, '摄影协会');
  eq('带掩码（学生确认进对了社团）', r.data.club.mask, `····${plain.slice(-2)}`);
  ok('但仍然没有密钥哈希', !/key_hash/.test(JSON.stringify(r.data)));
  eq('假票据 → null（不报错，前端据此回输密钥页）', (await meOf('deadbeef', T_STU)).data.club, null);
  eq('不带票据 → null', (await meOf('', T_STU)).data.club, null);
  eq('没登录 → 40101', (await meOf(ticket, '')).code, 40101);

  /* ═══════════ ⑦ 换社团头像 ═══════════ */
  section('⑦ PUT /user/club-key/avatar');
  r = await call('PUT', '/user/club-key/avatar', { ticket, fileBase64: PNG }, T_STU);
  eq('上传成功', r.code, 0);
  ok('头像是 fileID（cloud:// 开头）', /^cloud:\/\//.test(r.data.club.avatar), r.data.club.avatar);
  eq('换的是自己那一家', r.data.club.id, first.id);
  ok('学生换头像不需要 clubkey 位（社干被关掉也能换）',
    (await call('PUT', '/user/club-key/avatar', { ticket, fileBase64: PNG }, T_STU)).code === 0);

  eq('假票据 → 40101', (await call('PUT', '/user/club-key/avatar', { ticket: 'x', fileBase64: PNG }, T_STU)).code, 40101);
  eq('非图片 → 40001', (await call('PUT', '/user/club-key/avatar', { ticket, fileBase64: Buffer.from('hello world, not an image').toString('base64') }, T_STU)).code, 40001);
  eq('没带图 → 40001', (await call('PUT', '/user/club-key/avatar', { ticket }, T_STU)).code, 40001);

  // ⚠️ 传别家的 clubId 也没用：接口压根不读它
  const other = (await list(T_SUPER)).data.list[1];
  const beforeOther = (await detail(other.id, T_SUPER)).data.record.avatar;
  await call('PUT', '/user/club-key/avatar', { ticket, clubId: other.id, fileBase64: PNG }, T_STU);
  eq('前端塞 clubId 也改不到别家', (await detail(other.id, T_SUPER)).data.record.avatar, beforeOther);

  /* ═══════════ ⑧ 重置 ⇒ 旧密钥失效、旧票据仍有效 ═══════════ */
  section('⑧ 重置之后');
  r = await doReset(first.id, T_SUPER);
  const plain2 = r.data.plain;
  ok('新密钥与旧的不同', plain2 !== plain, `${plain} → ${plain2}`);
  eq('旧密钥失效', (await verifyKey(plain, T_STU2)).code, 40401);
  eq('新密钥可用', (await verifyKey(plain2, T_STU2)).code, 0);
  eq('旧票据仍有效（重置不踢在校生）', (await meOf(ticket, T_STU)).data.club.name, '摄影协会');

  /* ═══════════ ⑨ 作废 ═══════════ */
  section('⑨ 作废');
  r = await setStatus(first.id, 0, T_SUPER);
  eq('作废后 status=0', r.data.record.status, 0);
  const dead = H.dump().club_keys.find((x) => x.id === first.id);
  eq('作废把哈希清空（否则是假作废）', dead.key_hash, '');
  eq('作废把掩码清空', dead.key_mask, '');
  eq('作废后密钥进不来', (await verifyKey(plain2, T_STU2)).code, 40401);

  r = await list(T_SUPER);
  eq('计数跟着变', r.data.count.active, 0);
  eq('清单里那一家 status=0', r.data.list.find((x) => x.id === first.id).status, 0);

  // 作废再重置 ⇒ 又能用
  r = await doReset(first.id, T_SUPER);
  eq('作废后可以重新发密钥', (await verifyKey(r.data.plain, T_STU2)).code, 0);

  /* ═══════════ ⑩ 试错闸 ═══════════ */
  section('⑩ 试错闸');
  reset();
  await doReset(first.id, T_SUPER);   // 给一家发钥匙，确保「错」是错在码上而不是没钥匙
  let last = null;
  for (let i = 0; i < clubKeySvc.MAX_TRIES_PER_MIN; i += 1) {
    last = await verifyKey('ZZZZZZ', T_STU2);
    eq(`第 ${i + 1} 次仍按「密钥不对」处理`, last.code, 40401);
  }
  last = await verifyKey('ZZZZZZ', T_STU2);
  eq(`第 ${clubKeySvc.MAX_TRIES_PER_MIN + 1} 次被闸住`, last.code, 40301);
  ok('闸的文案说实话（不是「密钥错误」）', /频繁/.test(last.message), last.message);
  eq('换一个学生不受影响（按来源限速）', (await verifyKey('ZZZZZZ', T_STU)).code, 40401);

  // ⚠️ 这行格式必须与其它套件一致（regression.js 靠它认「结论」行），别改成「通过 N 项断言」
  console.log(`\n结论：断言 ${checks} 项 / 失败 0 项`);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.message);
  console.error((e && e.stack || '').split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
