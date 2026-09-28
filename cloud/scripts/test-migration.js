'use strict';

/**
 * 阶段 8 · 数据迁移本地实测（harness，无需云环境/网络）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-migration.js
 *
 * 覆盖四层：
 *   A. 行 → 云文档（`_id` 规则 / 数字 id 归一 / 时间归一 / JSON 反序列化 / NULL 保持 / 各类错误）
 *   B. `unique_keys` 补登记（含「NULL 不登记」这条最容易错的口径）
 *   C. `sequence` 预置（防 id 撞号）
 *   D/E. 双向校验：干净数据必须全绿；**四类坏数据必须全部被抓到**
 *   F. 闭环：迁移产物灌进假库后，云函数真的能消费（登录 / 读配置 / 读开关 / 取号不撞历史）
 *
 * ⚠️ E 段是**反向用例**，不是可选项。
 *    依据：静默漂移 #23 的教训 —— 一个永远返回「无差异」的 `verify()` 在干净数据上也是全绿的。
 *    只有先证明它能抓到差异，D 段的「全绿」才是有意义的。
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const kv = require(path.join(API_DIR, 'services', 'kv'));
const schedSvc = require(path.join(API_DIR, 'services', 'scheduling'));

const { TABLES, byName } = require('../migration/tables');
const { transformTable } = require('../migration/transform');
const { buildUniqueKeys } = require('../migration/unique-keys');
const { buildSequence } = require('../migration/sequence');
const { verify, loadCloudDump } = require('../migration/verify');
const { toWire, fromWire, sameValue } = require('../migration/wire');

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

/* ══════════════════ 假源数据（模拟 Sequelize findAll({raw:true}) 的裸行） ══════════════════ */
const T1 = '2026-01-01T00:00:00.000Z';
const HASH = bcrypt.hashSync('password123', 4);

/** ⚠️ 注意几个"刻意不干净"的样本，它们各自对应一条断言 */
function srcRows() {
  return {
    admin: [
      { id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, lastLoginAt: null, createTime: new Date(T1), updateTime: new Date(T1) },
      { id: 2, username: 'reviewer', password: HASH, nickname: '普管', role: 1, status: 1, lastLoginAt: null, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    user: [
      // 学生账号：openid 为 NULL
      { id: 1, openid: null, username: '20240101', password: HASH, grade: '2024', classNo: '01', seatNo: '01', remark: '张三', nickname: '张三', status: 1, pwdChangedAt: null, lastLoginAt: null, loginCount: 0, importBatchId: 1, unionid: null, avatar: null, createTime: new Date(T1), updateTime: new Date(T1) },
      { id: 2, openid: null, username: '20240102', password: HASH, grade: '2024', classNo: '01', seatNo: '02', remark: '李四', nickname: '李四', status: 1, pwdChangedAt: null, lastLoginAt: null, loginCount: 0, importBatchId: 1, unionid: null, avatar: null, createTime: new Date(T1), updateTime: new Date(T1) },
      // 老微信用户：username / grade 全 NULL（MySQL UNIQUE 允许多行 NULL）
      { id: 3, openid: 'oWX3', username: null, password: null, grade: null, classNo: null, seatNo: null, remark: null, nickname: '微信用户', status: 1, pwdChangedAt: null, lastLoginAt: null, loginCount: 0, importBatchId: null, unionid: null, avatar: null, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    submit: [],
    program: [
      // ⚠️ broadcastDate 为 NULL 有业务含义（weekly 接口据此不显示），迁移必须原样保留
      { id: 1, title: '午间音乐', host: '张三', broadcastTime: '12:20', broadcastDate: null, desc: '', cover: '', isShow: 1, isLive: 0, sort: 1, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    notice: [],
    message: [],
    system_setting: [
      { id: 1, key: 'song_slot_capacity', value: '3', desc: '每格容量', updateTime: new Date(T1) },
    ],
    system_switch: [
      { id: 1, key: 'home_song_schedule', value: 'on', desc: '', updatedBy: 1, updatedAt: new Date(T1), createTime: new Date(T1) },
    ],
    cadre: [
      { id: 7, name: '王五', role: '站长', grade: '2024', avatar: '/uploads/a.png', motto: '', sort: 1, isShow: 1, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    staff: [],
    notice_ack: [
      // ⭐ id 刻意用**字符串** —— MySQL BIGINT UNSIGNED 经 mysql2 返回的就是字符串
      { id: '1', openid: 'oWX3', noticeKey: 'song_notice', version: 1, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    import_batch: [],
    cleanup_log: [
      { id: '1', grade: '2024', gradeName: '2024级', mode: 'safe', total: 2, deleted: 0, disabled: 2, classCount: 1, untouched: 0, costMs: 12, operatorId: 1, operatorName: '超管', disabledAccounts: '["20240101","20240102"]', createTime: new Date(T1), updateTime: new Date(T1) },
      // 坏 JSON：必须**保留原串 + 告警**，绝不静默置空
      { id: '2', grade: '2024', gradeName: '2024级', mode: 'safe', total: 0, deleted: 0, disabled: 0, classCount: 0, untouched: 0, costMs: 3, operatorId: 1, operatorName: '超管', disabledAccounts: '[{bad json', createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    weekly_schedule: [
      { id: 1, weekStartDate: '2026-10-05', applicationStartAt: new Date(T1), applicationEndAt: new Date(T1), reviewStartAt: new Date(T1), reviewEndAt: new Date(T1), scheduleLockAt: new Date(T1), status: 'SCHEDULING', lockedAt: null, lockPaused: 0, createdBy: 1, createTime: new Date(T1), updateTime: new Date(T1) },
    ],
    assignment_log: [],
    request_status_log: [],
  };
}

/** 表规则：补上 dateFields（真实导出时由 export.js 从模型 rawAttributes 推导） */
function specOf(name, extra) {
  const base = byName[name];
  return Object.assign({ dateFields: [] }, base, extra || {});
}

/** 跑一遍全表 transform */
function runAll(rows) {
  const results = TABLES.map((t) => transformTable(specOf(t.name), rows[t.name] || []));
  const byColl = {};
  results.forEach((r) => { byColl[r.collection] = r.docs; });
  return { results, byColl };
}

const has = (arr, v) => arr.indexOf(v) >= 0;
const ukIds = (uk) => uk.docs.map((d) => d._id);

(async () => {
  /* ══════════════ A. 行 → 云文档 ══════════════ */
  section('A. transform：行 → 云文档');
  const rows = srcRows();
  const { results, byColl } = runAll(rows);
  const R = {};
  results.forEach((r) => { R[r.collection] = r; });

  eq('A01 迁移表总数（17 张源表 - song_quota）', TABLES.length, 16);
  eq('A02 全部表 0 error', results.reduce((a, r) => a + r.errors.length, 0), 0);
  eq('A03 admin 2 行全出、不生成 _id',
    [R.admin.stats.out, '_id' in R.admin.docs[0]], [2, false]);
  eq('A04 admin 的密码哈希必须跟着走（丢了存量账号就全登不上）',
    R.admin.docs[0].password, HASH);
  eq('A05 system_setting 的 _id = setting:<key>',
    R.system_setting.docs[0]._id, 'setting:song_slot_capacity');
  ok('A06 ★ 且与运行时 kv.docId() 逐字一致（否则线上按 _id 读不到）',
    R.system_setting.docs[0]._id === kv.docId('song_slot_capacity'),
    `${R.system_setting.docs[0]._id} vs ${kv.docId('song_slot_capacity')}`);
  eq('A07 system_switch 的 _id = switch:<key>', R.system_switch.docs[0]._id, 'switch:home_song_schedule');
  eq('A08 notice_ack 的 _id = ack:<openid>:<noticeKey>', R.notice_ack.docs[0]._id, 'ack:oWX3:song_notice');
  eq('A09 weekly_schedule 的 _id = week:<weekStartDate>', R.weekly_schedule.docs[0]._id, 'week:2026-10-05');
  ok('A10 ★ 且与运行时 scheduling.weekDocId() 逐字一致',
    R.weekly_schedule.docs[0]._id === schedSvc.weekDocId('2026-10-05'));

  // ⭐ BIGINT 字符串 id 归一
  eq('A11 notice_ack 的 id：字符串 "1"（BIGINT UNSIGNED 经 mysql2 的返回形态）', typeof rows.notice_ack[0].id, 'string');
  eq('A12 ★ 迁移后 id 被归一成数字', [R.notice_ack.docs[0].id, typeof R.notice_ack.docs[0].id], [1, 'number']);
  eq('A13 cleanup_log 的 id 同样归一', typeof R.cleanup_log.docs[0].id, 'number');

  // ⭐ DATEONLY 不能被转成 Date
  eq('A14 ★ weekStartDate 仍是字符串（DATEONLY；转成 Date 会让 _id 拼成 week:Mon Oct 05 2026…）',
    [R.weekly_schedule.docs[0].weekStartDate, typeof R.weekly_schedule.docs[0].weekStartDate], ['2026-10-05', 'string']);

  // JSON 文本字段
  eq('A15 cleanup_log.disabledAccounts 反序列化成数组',
    R.cleanup_log.docs[0].disabledAccounts, ['20240101', '20240102']);
  eq('A16 ★ 坏 JSON 保留原串 + 记 1 条 warning（绝不静默置空）',
    [R.cleanup_log.docs[1].disabledAccounts, R.cleanup_log.warnings.length], ['[{bad json', 1]);

  // NULL 保持
  ok('A17 program.broadcastDate 的 NULL 原样保留（有业务含义）', R.program.docs[0].broadcastDate === null);
  ok('A18 admin.lastLoginAt 的 NULL 原样保留', R.admin.docs[0].lastLoginAt === null);

  // maxId
  eq('A19 maxId 统计：cadre 只有 id=7 一行', R.cadre.stats.maxId, 7);

  section('A2. transform：错误必须被拦下并跳过（不静默丢行）');
  // ① 业务键字段为空 → 拼出来会塌成 setting:null
  const bad1 = transformTable(specOf('system_setting'), [
    { id: 1, key: 'a', value: '1' },
    { id: 2, key: null, value: '2' },
    { id: 3, key: '', value: '3' },
  ]);
  eq('A20 ★ 业务键为 NULL/空 → 记 error 并跳过（避免塌成同一条）',
    [bad1.errors.length, bad1.stats.out], [2, 1]);
  ok('A21 错误信息里点明了是哪个字段', /业务键字段/.test(bad1.errors[0].message), bad1.errors[0].message);

  // ② id 重复
  const bad2 = transformTable(specOf('program'), [{ id: 1, title: 'a' }, { id: 1, title: 'b' }]);
  eq('A22 id 重复 → 记 error 并跳过第二条', [bad2.errors.length, bad2.stats.out], [1, 1]);

  // ③ 业务 _id 重复（源库数据本身违反 UNIQUE）
  const bad3 = transformTable(specOf('system_switch'), [
    { id: 1, key: 'dup', value: 'on' },
    { id: 2, key: 'dup', value: 'off' },
  ]);
  eq('A23 业务 _id 重复 → 记 error 并跳过', [bad3.errors.length, bad3.stats.out], [1, 1]);

  // ④ id 非正整数
  const bad4 = transformTable(specOf('program'), [{ id: 'abc', title: 'x' }, { id: null, title: 'y' }]);
  eq('A24 id 非法 → 记 error 并跳过', [bad4.errors.length, bad4.stats.out], [2, 0]);

  // ⑤ 时间字段归一（string → Date）
  const d5 = transformTable(specOf('notice', { dateFields: ['publishTime', 'createTime'] }), [
    { id: 1, title: 'n', publishTime: T1, createTime: T1 },
  ]);
  ok('A25 ★ 时间字符串归一成 Date 实例', d5.docs[0].publishTime instanceof Date);
  eq('A26 归一化后的时刻正确', d5.docs[0].publishTime.toISOString(), T1);
  const d6 = transformTable(specOf('notice', { dateFields: ['publishTime'] }), [
    { id: 1, title: 'n', publishTime: 'not-a-date' },
  ]);
  eq('A27 时间无法解析 → 保留原值 + 1 条 warning', [d6.docs[0].publishTime, d6.warnings.length], ['not-a-date', 1]);

  // ⑥ ⭐ 真机实测发现的坑：`findAll({raw:true})` 会把 `create_time AS createTime`
  //     和**裸的 `create_time`** 两份一起选出来（模型既有显式属性、又开了 timestamps）
  const dupSpec = specOf('admin', { snakeDupes: [['create_time', 'createTime'], ['update_time', 'updateTime']] });
  const d7 = transformTable(dupSpec, [{
    id: 1, username: 'a',
    createTime: new Date(T1), create_time: new Date(T1),
    updateTime: new Date(T1), update_time: new Date(T1),
  }]);
  eq('A28 ★ 裸下划线列名被去掉（否则云库里会出现 create_time，违反"字段名一律驼峰"）',
    Object.keys(d7.docs[0]).filter((k) => k.indexOf('_') >= 0), []);
  eq('A29 驼峰版本仍在、值正确', d7.docs[0].createTime.toISOString(), T1);
  const d8 = transformTable(specOf('admin', { snakeDupes: [['create_time', 'createTime']] }), [
    { id: 1, username: 'a', create_time: new Date(T1) },   // 只有裸列名、没有驼峰版本
  ]);
  ok('A30 ★ 只有裸列名、没有对应驼峰时**不删**（宁可脏，也不能误删真字段）',
    d8.docs[0].create_time instanceof Date);

  /* ══════════════ B. unique_keys 补登记 ══════════════ */
  section('B. unique_keys 补登记（迁移后这个集合是空的，不补 = 能建重名账号且不报错）');
  const uk = buildUniqueKeys(byColl, new Date(T1));
  const ids = ukIds(uk);
  eq('B01 0 error', uk.errors.length, 0);
  ok('B02 admin:root / admin:reviewer 都登记了', has(ids, 'admin:root') && has(ids, 'admin:reviewer'));
  ok('B03 user_name 登记了两条学号', has(ids, 'user_name:20240101') && has(ids, 'user_name:20240102'));
  ok('B04 ★ 老微信用户 username 为 NULL → **不登记** user_name:null', !has(ids, 'user_name:null'));
  ok('B05 user_openid 登记了唯一一条有 openid 的', has(ids, 'user_openid:oWX3'));
  ok('B06 ★ 两条学生 openid 为 NULL → **不登记** user_openid:null', !has(ids, 'user_openid:null'));
  ok('B07 user_seat 登记了座号', has(ids, 'user_seat:2024:01:01') && has(ids, 'user_seat:2024:01:02'));
  ok('B08 ★ grade/classNo/seatNo 有空 → 不登记 user_seat', !ids.some((x) => /^user_seat:null/.test(x)));
  ok('B09 4 张业务键表的键也登记了', has(ids, 'setting:song_slot_capacity') && has(ids, 'switch:home_song_schedule')
    && has(ids, 'ack:oWX3:song_notice') && has(ids, 'week:2026-10-05'));
  eq('B10 登记总数（2 admin + 2 user_name + 1 user_openid + 2 user_seat + 4 业务键）', uk.stats.total, 11);
  eq('B11 ★ 字段名是 snake_case（与 reserveUnique 实际写入的形状一致，别"顺手改整齐"）',
    Object.keys(uk.docs[0]).sort(), ['_id', 'create_time', 'key', 'owner_id', 'scope']);
  eq('B12 owner_id 指向数字业务 id', uk.docs.find((d) => d._id === 'admin:root').owner_id, 1);

  const ukBad = buildUniqueKeys({
    admin: [{ id: 1, username: 'same' }, { id: 2, username: 'same' }],
  }, new Date(T1));
  eq('B13 ★ 源库数据本身违反 UNIQUE → 记 error（不静默生成两份）',
    [ukBad.errors.length, ukBad.stats.total], [1, 1]);

  /* ══════════════ C. sequence 预置 ══════════════ */
  section('C. sequence 预置（防新建记录与历史 id 撞号）');
  const seq = buildSequence(results);
  eq('C01 每张迁移表都有一条', seq.length, TABLES.length);
  eq('C02 ★ 预置值 = max(id)，不是 max(id)+1（nextId 是「先 inc 再返回」）',
    seq.find((s) => s._id === 'cadre').value, 7);
  eq('C03 空表预置 0（第一次取号得到 1）', seq.find((s) => s._id === 'submit').value, 0);
  eq('C04 notice_ack 的 maxId 也按数字算', seq.find((s) => s._id === 'notice_ack').value, 1);

  /* ══════════════ D. 双向校验：干净数据必须全绿 ══════════════ */
  section('D. 双向校验：干净数据');
  /**
   * ⚠️ 快照必须**真的走一遍「落盘 → 读回」**（toWire → JSON → fromWire）再去比。
   *    直接拿内存里的原生对象比会漏掉一整类问题：真实链路中间必经 JSON，
   *    若编码/解码不对称（例如 Date 变成裸 ISO 串），两侧口径就不一致 ——
   *    这正是 `verify.js` CLI 里先 `parseDocs(JSON.stringify(rows))` 的原因。
   */
  const roundTripWire = (v) => fromWire(JSON.parse(JSON.stringify(toWire(v))));
  const snapshot = {
    generatedAt: T1,
    tables: results.map((r) => ({ name: r.collection, count: r.stats.in, rows: roundTripWire(r.docs) })),
    uniqueKeys: roundTripWire(uk.docs),
    sequence: roundTripWire(seq),
  };
  // 模拟「云库导出」：把文档原样搬过去（自增表补一个云端生成的 _id），同样走一次落盘往返
  const cloudByName = {};
  results.forEach((r) => {
    cloudByName[r.collection] = roundTripWire(r.docs)
      .map((d, i) => (d._id ? { ...d } : { _id: `cloud_${r.collection}_${i}`, ...d }));
  });
  cloudByName.unique_keys = roundTripWire(uk.docs).map((d) => ({ ...d }));
  cloudByName.sequence = roundTripWire(seq).map((d) => ({ ...d }));

  const clean = verify(snapshot, cloudByName);
  eq('D01 干净数据 → ok', clean.ok, true);
  eq('D02 检查了全部 16 张表', clean.summary.tablesChecked, 16);
  eq('D03 无缺失 / 无孤儿 / 无字段差 / 无结构问题',
    [clean.summary.missing, clean.summary.orphan, clean.summary.diffs, clean.summary.structural], [0, 0, 0, 0]);
  eq('D04 源侧行数合计', clean.summary.rowsSrc, results.reduce((a, r) => a + r.stats.out, 0));
  eq('D05 云侧行数与源侧一致', clean.summary.rowsCloud, clean.summary.rowsSrc);

  // ⭐ 容错：真实踩过一次 —— 快照写了 `$date` 而云库导出是 Date，直接比冒出几十条假差异
  const rawSnap = Object.assign({}, snapshot, {
    tables: results.map((r) => ({ name: r.collection, count: r.stats.in, rows: toWire(r.docs) })),
  });
  eq('D06 ★ 快照未还原 $date 时也不误报（容错做在 sameValue 里，不靠调用方自觉）',
    verify(rawSnap, cloudByName).summary.diffs, 0);

  /* ══════════════ E. 反向用例：四类坏数据必须全部被抓到 ══════════════ */
  section('E. ★ 反向用例： verify() 必须真的能抓到差异（否则 D 段全绿毫无意义）');

  // ① 源有云无（漏导入一行）
  const c1 = JSON.parse(JSON.stringify(cloudByName));
  c1.admin = c1.admin.slice(0, 1);
  const v1 = verify(snapshot, c1);
  eq('E01 云库少一行 → 报 missing', [v1.ok, v1.summary.missing], [false, 1]);

  // ② 云有源无（多导入一行 = 孤儿）
  const c2 = JSON.parse(JSON.stringify(cloudByName));
  c2.admin = c2.admin.concat([{ _id: 'cloud_extra', id: 99, username: 'ghost' }]);
  const v2 = verify(snapshot, c2);
  eq('E02 云库多一行 → 报 orphan', [v2.ok, v2.summary.orphan], [false, 1]);

  // ③ 同 id 字段被改（Upsert 覆盖错）
  const c3 = JSON.parse(JSON.stringify(cloudByName));
  c3.admin = c3.admin.map((d) => (d.id === 1 ? { ...d, role: 1 } : d));
  const v3 = verify(snapshot, c3);
  eq('E03 字段被改 → 报 diff', [v3.ok, v3.summary.diffs >= 1], [false, true]);
  eq('E04 且指名了字段与两侧的值', v3.tables.find((t) => t.name === 'admin').diffs[0].field, 'role');

  // ③b NULL 被写成缺失，也必须报出来（NULL 与「没这个字段」不是一回事）
  const c3b = JSON.parse(JSON.stringify(cloudByName));
  c3b.program = c3b.program.map((d) => { const o = { ...d }; delete o.broadcastDate; return o; });
  const v3b = verify(snapshot, c3b);
  eq('E05 ★ NULL 被写成"字段缺失" → 也算差异', [v3b.ok, v3b.summary.diffs >= 1], [false, true]);

  // ④ sequence 预置错（少 1 → 新建记录与历史 id 撞号）
  const c4 = JSON.parse(JSON.stringify(cloudByName));
  c4.sequence = c4.sequence.map((s) => (s._id === 'cadre' ? { ...s, value: 6 } : s));
  const v4 = verify(snapshot, c4);
  eq('E06 sequence 值错 → 报结构问题', [v4.ok, v4.summary.structural], [false, 1]);
  eq('E07 且指名是哪张表、应为/实为', v4.structural[0].bad[0]._id, 'cadre');

  // ⑤ unique_keys 没导入 / 少登记
  const c5 = JSON.parse(JSON.stringify(cloudByName));
  c5.unique_keys = c5.unique_keys.filter((d) => d._id !== 'admin:root');
  const v5 = verify(snapshot, c5);
  eq('E08 unique_keys 少登记 → 报结构问题', [v5.ok, v5.summary.structural], [false, 1]);

  /* ══════════════ F. 闭环：迁移产物真的能被云函数消费 ══════════════ */
  section('F. 闭环：把迁移产物灌进假库，云函数必须能正常读');

  // ⚠️ 走一遍 wire 编解码 —— 真实链路是「导出落盘 → 控制台导入」，中间必经 JSON
  const roundTrip = {};
  Object.keys(cloudByName).forEach((k) => { roundTrip[k] = fromWire(JSON.parse(JSON.stringify(toWire(cloudByName[k])))); });

  H.reset(roundTrip);
  const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });

  // ① 存量管理员用**原 bcrypt 哈希**登录
  const lg = await H.call(H.req('POST', '/admin/login', { username: 'root', password: 'password123' }));
  eq('F01 ★ 存量管理员用迁移过来的密码哈希能登录（密码丢了就全登不上）', lg.code, 0);
  eq('F02 登录返回的数字 id 与迁移数据一致', lg.data && lg.data.admin && lg.data.admin.id, 1);

  // ② setting:<key> 规则 → 线上能按 _id 读到
  const st = await H.call(H.req('GET', '/admin/setting/song_slot_capacity', {}, SUPER_TOKEN));
  eq('F03 ★ 按 setting:<key> 能读到迁移过来的配置', [st.code, st.data && st.data.value], [0, '3']);

  // ③ switch:<key> 规则
  const sw = await H.call(H.req('GET', '/user/switch/home_song_schedule'));
  eq('F04 ★ 按 switch:<key> 能读到迁移过来的开关', [sw.code, sw.data && sw.data.value], [0, 'on']);

  // ④ sequence 预置 → 新建记录不会与历史 id 撞号
  const cr = await H.call(H.req('POST', '/admin/cadre/create',
    { name: '新社干', role: '编辑', grade: '2025', sort: 2 }, SUPER_TOKEN));
  eq('F05 新建社干成功', cr.code, 0);
  ok('F06 ★ 新 id = 历史 maxId + 1（撞号防护真的生效）', cr.data && cr.data.id === 8, `got=${cr.data && cr.data.id}`);

  // ⑤ wire 编解码往返：Date 必须还原成 Date（不是字符串）
  ok('F07 ★ 落盘再读回，Date 仍是 Date 实例（写成裸 ISO 串会让时间条件静默失效）',
    roundTrip.admin[0].createTime instanceof Date);
  ok('F08 sameValue 对两个"不同实例但同一时刻"的 Date 判等',
    sameValue(new Date(T1), new Date(T1)));
  ok('F09 sameValue 对 Date 与裸 ISO 字符串**也判等**（云库导出格式可能不一致）',
    sameValue(new Date(T1), T1));
  ok('F10 sameValue 对真正的差异判不等', !sameValue(new Date(T1), new Date(T1).getTime() + 1));

  // ⑥ 云库导出目录加载器：数组与 JSON Lines 两种格式都要能读
  const fs2 = require('fs');
  const os2 = require('os');
  const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'mig-loadertest-'));
  try {
    fs2.writeFileSync(path.join(tmp, 'admin.json'), JSON.stringify(toWire(roundTrip.admin)));
    fs2.writeFileSync(path.join(tmp, 'program.jsonl'), roundTrip.program.map((d) => JSON.stringify(toWire(d))).join('\n'));
    fs2.writeFileSync(path.join(tmp, '无关文件.txt'), '不该被读进来');
    const loaded = loadCloudDump(tmp);
    eq('F11 数组格式能读', (loaded.admin || []).length, 2);
    eq('F12 JSON Lines 格式也能读', (loaded.program || []).length, 1);
    eq('F13 无关文件被忽略（按文件名认集合）', Object.keys(loaded).sort(), ['admin', 'program']);
    ok('F14 读回来的 Date 已还原', loaded.admin && loaded.admin[0].createTime instanceof Date);
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
  }

  lines.push('');
  lines.push(`结论：断言 ${lines.filter((l) => l.startsWith('OK  ') || l.startsWith('FAIL')).length} 项 / 失败 ${failed} 项`);
  console.log(lines.join('\n'));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(lines.join('\n'));
  console.log(`\n异常：${e && e.stack || e}`);
  process.exit(1);
});
