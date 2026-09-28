'use strict';

/**
 * 管理端本地实测 · 学生账号 19 条接口（阶段 7 最后一块）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-admin-student.js
 *
 * 覆盖范围：`handlers/admin/student.js`（19 条，全部 `asSuper`）
 *        + `services/roster.js`（名册解析 / 归一化 / 落库 / 批量维护 / 整届清理）
 *        + `services/sheet.js`（xlsx / csv 读写）
 *
 * 断言围绕几条**最容易悄悄错掉**的口径展开：
 *  · 19 条路由**全部**超管专属（漏挂 asSuper = 普管能导名册 / 能删整届）
 *  · 二进制契约改成 base64（上传 `fileBase64` / 下载回 `{filename,mime,base64}`），
 *    且**能在本地把下载的 base64 解回 xlsx 再读出来**（否则前端拿到一堆乱码才发现）
 *  · `preview` 一行都不写库；`commit` **重新解析重新校验**（不信任前端回传的结论）
 *  · 唯一键 `user_name:<学号>` 必须**建号时占、删号时放**（孤儿键会挡住同名再导入）
 *  · 改三元组 = 换账号 → `submit` / `message` / `notice_ack` 的 openid 必须跟着搬
 *  · 「有投稿记录」的账号永不硬删（只停用）—— 单条删除 / 批量删除 / 整届清理三处口径一致
 *  · 整届清理的**回执**（v8「清理完成」屏靠它还原）：disabledAccounts 落库是 JSON 串、
 *    读出来必须是数组；costText 由 costMs 现算
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const { ADMIN_ROUTES } = require(path.join(API_DIR, 'router'));
const roster = require(path.join(API_DIR, 'services', 'roster'));
const importer = require(path.join(API_DIR, 'services', 'sheet'));
const accountService = require(path.join(API_DIR, 'services', 'studentAccount'));
const switchSvc = require(path.join(API_DIR, 'services', 'switch'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (!okv) failed++;
  lines.push(`${okv ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

const HASH = bcrypt.hashSync('password123', 4);
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });          // role 0 = 超管
const PLAIN_TOKEN = sign({ id: 2, username: 'reviewer', role: 1 });      // role 1 = 普管

function reset(seed) {
  H.reset(seed || {});
  switchSvc.invalidate();
  accountService._clearCache();
}

/* ────────────────────────── 造数 ────────────────────────── */

function mkUser(id, o) {
  const opt = o || {};
  const grade = opt.grade === undefined ? '2024' : opt.grade;
  const classNo = opt.classNo === undefined ? '01' : opt.classNo;
  const seatNo = opt.seatNo === undefined ? String(id).padStart(2, '0') : opt.seatNo;
  return {
    _id: `u${id}`,
    id,
    openid: opt.openid === undefined ? null : opt.openid,
    // ⚠️ username 显式给 null 用来造「老微信用户」（HAS_USERNAME 会把它排除在名册外）
    username: opt.username === undefined ? `${grade}${classNo}${seatNo}` : opt.username,
    password: opt.password === undefined ? HASH : opt.password,
    grade,
    classNo,
    seatNo,
    remark: opt.remark === undefined ? null : opt.remark,
    nickname: opt.nickname === undefined ? (opt.remark === undefined ? null : opt.remark) : opt.nickname,
    status: opt.status === undefined ? 1 : opt.status,
    // ⚠️ 一律显式写 null：`activated=0` 的 where 是 `{pwdChangedAt: null}`，
    //    字段**缺失**与字段为 null 在自研假库里不等价（真云库等价），显式写才两边一致
    pwdChangedAt: opt.pwdChangedAt === undefined ? null : opt.pwdChangedAt,
    lastLoginAt: opt.lastLoginAt === undefined ? null : opt.lastLoginAt,
    loginCount: opt.loginCount || 0,
    importBatchId: opt.importBatchId === undefined ? null : opt.importBatchId,
    createTime: opt.createTime || new Date('2026-09-01T10:00:00+08:00'),
    updateTime: new Date(),
  };
}

function baseSeed(extra) {
  const s = {
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, createTime: new Date() },
      { _id: 'ad2', id: 2, username: 'reviewer', password: HASH, nickname: '审核员', role: 1, status: 1, createTime: new Date() },
    ],
  };
  return Object.assign(s, extra || {});
}

/** 五人造数（含一个老微信用户，用来验 HAS_USERNAME 排除） */
function rosterSeed(extra) {
  return baseSeed(Object.assign({
    user: [
      mkUser(1, { remark: '张三' }),                                              // 2024/01/01 未激活
      mkUser(2, { remark: '李四', status: 0, pwdChangedAt: new Date('2026-09-10T10:00:00+08:00'), lastLoginAt: new Date('2026-09-12T10:00:00+08:00'), loginCount: 2 }), // 已激活
      mkUser(3, { grade: '2024', classNo: '02', seatNo: '01', remark: '王五' }),  // 2024/02/01
      mkUser(4, { grade: '2023', classNo: '01', seatNo: '01', remark: null }),    // 2023/01/01
      mkUser(5, { username: null, remark: '老微信用户' }),                        // 排除在名册之外
      mkUser(6, { grade: '2024', classNo: '02', seatNo: '02', remark: 'Amy' }),   // 关键字大小写用
    ],
    submit: [
      { _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() },
    ],
  }, extra || {}));
}

/**
 * 导入用例专用种子：
 *  · 20240101 —— **已激活**且密码是自设的 `myOwnPwd`（用来验「默认跳过」「force 也不动密码」）
 *  · 20240102 —— 存在但**未激活**（用来验「覆盖三元组 + 密码重置回初始值」）
 *  ⚠️ 必须把 id2 也改回未激活：基础种子里它是已激活的（列表用例要用），
 *     否则导入预览里 20240102 会算成 active 而不是 update，整个 summary 就错位了。
 */
const commitSeed = () => rosterSeed({
  user: rosterSeed().user.map((u) => {
    if (u.id === 1) return mkUser(1, { remark: '张三', password: bcrypt.hashSync('myOwnPwd', 4), pwdChangedAt: new Date('2026-09-08T10:00:00+08:00'), status: 1 });
    if (u.id === 2) return mkUser(2, { remark: '李四', pwdChangedAt: null, status: 1 });
    return u;
  }),
});

const dump = () => H.dump();
const usersOf = () => dump().user || [];
const byId = (id) => usersOf().find((u) => Number(u.id) === Number(id)) || null;
const uniqIds = () => (dump().unique_keys || []).map((x) => x._id).sort();

const csvB64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const b64Buf = (s) => Buffer.from(String(s), 'base64');

(async () => {
  /* ══════════════ A. 权限：19 条全部超管专属 ══════════════ */
  section('A. 权限矩阵（19 条 × 匿名 / 普管 / 超管）');

  /**
   * ⚠️ 用**路由形状**（含 `:id` / `:grade` 占位符）跟路由表比对，
   *    实际调用再用具体值 —— 否则「清单少一条」或「路径写错一个字母」都发现不了。
   * 每条：[method, pattern, concretePath, body]
   */
  const STUDENT_ROUTES = [
    ['POST', '/admin/student/import/preview', '/admin/student/import/preview', { filename: 'a.csv', fileBase64: csvB64('年级,班级,序号\n2024,01,01\n') }],
    ['POST', '/admin/student/import/commit', '/admin/student/import/commit', { rows: [['2024', '01', '01']] }],
    ['GET', '/admin/student/template', '/admin/student/template', {}],
    ['GET', '/admin/student/list', '/admin/student/list', {}],
    ['GET', '/admin/student/stats', '/admin/student/stats', {}],
    ['GET', '/admin/student/export', '/admin/student/export', {}],
    ['GET', '/admin/student/grades', '/admin/student/grades', {}],
    ['GET', '/admin/student/grade/:grade', '/admin/student/grade/2024', {}],
    ['DELETE', '/admin/student/grade/:grade', '/admin/student/grade/2024', { mode: 'safe' }],
    ['GET', '/admin/student/cleanup/last', '/admin/student/cleanup/last', {}],
    ['GET', '/admin/student/batches', '/admin/student/batches', {}],
    ['POST', '/admin/student/reset-password/batch', '/admin/student/reset-password/batch', { ids: [1] }],
    ['POST', '/admin/student/status/batch', '/admin/student/status/batch', { ids: [1], status: 0 }],
    ['POST', '/admin/student/batch/:id/rollback', '/admin/student/batch/1/rollback', {}],
    ['POST', '/admin/student/delete/batch', '/admin/student/delete/batch', { ids: [1] }],
    ['PUT', '/admin/student/:id', '/admin/student/1', {}],
    ['PUT', '/admin/student/:id/status', '/admin/student/1/status', { status: 0 }],
    ['PUT', '/admin/student/:id/reset-password', '/admin/student/1/reset-password', {}],
    ['DELETE', '/admin/student/:id', '/admin/student/1', {}],
  ];

  // 路由表里的 admin.student.* 必须与上面这份清单**逐一对应**（防止漏测新加的路由）
  const fromTable = ADMIN_ROUTES
    .filter(([, hk]) => hk.indexOf('admin.student.') === 0)
    .map(([k]) => k)
    .sort();
  eq('路由表里的 admin.student.* 条数', fromTable.length, 19);
  eq('清单与路由表逐条一致（形状比对，含 :id / :grade）',
    STUDENT_ROUTES.map(([m, pattern]) => `${m} ${pattern}`).sort(), fromTable);
  // ⚠️ 去重键必须含 method：`GET /admin/student/grade/:grade` 与 `DELETE ...` 同路径，
  //    `PUT /admin/student/:id` 与 `DELETE ...` 同路径 —— 只比 path 会误报 17/19。
  eq('★ 清单里没有重复（method + path）', new Set(STUDENT_ROUTES.map(([m, pattern]) => `${m} ${pattern}`)).size, 19);

  reset(rosterSeed());
  let anonymous = 0;
  let plain = 0;
  let superOk = 0;
  const plainNot40301 = [];
  const superBlocked = [];
  for (const [m, , path, body] of STUDENT_ROUTES) {
    const a = await H.call(H.req(m, path, body, ''));
    if (a.code === 40101) anonymous++;
    const b = await H.call(H.req(m, path, body, PLAIN_TOKEN));
    if (b.code === 40301) plain++;
    else plainNot40301.push(`${m} ${path} → ${b.code} ${b.message}`);
    const c = await H.call(H.req(m, path, body, SUPER_TOKEN));
    // 超管不得被鉴权拦（业务错 40001/40401/40901 都算通过）
    if (c.code === 40101 || c.code === 40301) superBlocked.push(`${m} ${path} → ${c.code}`);
    else superOk++;
  }
  eq('匿名调用 → 40101（19/19）', anonymous, 19);
  eq('普管调用 → 40301（19/19）', plain, 19);
  ok('普管没有任何一条漏成通', plainNot40301.length === 0, plainNot40301.join(' | '));
  eq('超管调用全部通过鉴权（19/19）', superOk, 19);
  ok('超管没有被误拦', superBlocked.length === 0, superBlocked.join(' | '));

  /* ══════════════ B. importPreview ══════════════ */
  section('B. POST /admin/student/import/preview（上传解析，不写库）');

  reset(commitSeed());

  // ⚠️ 目标账号 20240301 必须**不在种子库里**（种子里是 20240101/20240102/20240201/20240202/20230101），
  //    否则「新建」会静默变成「覆盖」，created/updated 全错位。
  const CSV = [
    '年级,班级,序号,姓名',
    '2024,01,01,张三',   // 第 2 行：库中已存在且已激活 → active
    '2024,01,02,李四',   // 第 3 行：库中已存在未激活 → update
    '2024,03,01,钱七',   // 第 4 行：新建 → new
    '2024,,,赵六',       // 第 5 行：班级缺 → invalid
    '2024,01,01,重复',   // 第 6 行：本批次内重复 → invalid
  ].join('\n') + '\n';

  let r = await H.call(H.req('POST', '/admin/student/import/preview', { filename: 'r.csv' }, SUPER_TOKEN));
  eq('缺 fileBase64 → 40001', [r.code, r.message], [40001, '缺少文件内容（fileBase64）']);

  r = await H.call(H.req('POST', '/admin/student/import/preview', { filename: 'r.csv', fileBase64: '!!!' }, SUPER_TOKEN));
  eq('base64 解出 0 字节 → 40001「文件内容为空」', [r.code, r.message], [40001, '文件内容为空']);

  r = await H.call(H.req('POST', '/admin/student/import/preview', { filename: 'r.xlsx', fileBase64: Buffer.from('not an xlsx at all').toString('base64') }, SUPER_TOKEN));
  eq('内容不是 xlsx → 40001 且文案以「表格解析失败」开头',
    [r.code, String(r.message).slice(0, 6)], [40001, '表格解析失败']);

  const before = usersOf().length;
  r = await H.call(H.req('POST', '/admin/student/import/preview', { filename: 'r.csv', fileBase64: csvB64(CSV) }, SUPER_TOKEN));
  eq('正常预览 → code 0', r.code, 0);
  eq('回显 filename / sheetName', [r.data.filename, r.data.sheetName], ['r.csv', 'CSV']);
  eq('识别到表头在第 1 行（下标 0）', [r.data.mode, r.data.headerRowIndex], ['header', 0]);
  eq('列映射（年级/班级/序号/姓名）', r.data.columns, { grade: 0, class: 1, seat: 2, name: 3 });
  eq('数据行数 = 5（表头不算）', r.data.totalRows, 5);
  eq('summary：新建 1 / 覆盖 1 / 跳过(已激活) 1 / 异常 2',
    r.data.summary, { new: 1, update: 1, active: 1, invalid: 2 });
  eq('★ 一行都没写库', usersOf().length, before);
  eq('★ 也没写导入批次', (dump().import_batch || []).length, 0);
  eq('rawRows 原样回给前端（供确认导入时回传）', r.data.rawRows, [
    ['年级', '班级', '序号', '姓名'], ['2024', '01', '01', '张三'], ['2024', '01', '02', '李四'],
    ['2024', '03', '01', '钱七'], ['2024', '', '', '赵六'], ['2024', '01', '01', '重复'],
  ]);

  const pvRows = r.data.rows;
  eq('行 2 → active（本人已改密，默认保护）',
    [pvRows[0].rowNo, pvRows[0].username, pvRows[0].state, pvRows[0].name], [2, '20240101', 'active', '张三']);
  eq('行 3 → update', [pvRows[1].rowNo, pvRows[1].state], [3, 'update']);
  eq('行 4 → new', [pvRows[2].rowNo, pvRows[2].username, pvRows[2].state], [4, '20240301', 'new']);
  eq('行 5 → invalid（班级缺）', [pvRows[3].rowNo, pvRows[3].state], [5, 'invalid']);
  eq('行 6 → invalid（批次内重复）', [pvRows[4].rowNo, pvRows[4].state], [6, 'invalid']);
  eq('errors 带真实行号（与用户在 Excel 里看到的行号一致）',
    r.data.errors.map((e) => e.rowNo), [5, 6]);
  ok('重复行的原因点名了「第 N 行已出现」', /本批次内账号 20240101 重复（第 2 行已出现）/.test(r.data.errors[1].message), r.data.errors[1].message);

  // force=1：已激活也允许覆盖（POST 的 query 只能走 inline querystring）
  r = await H.call(H.req('POST', '/admin/student/import/preview?force=1', { filename: 'r.csv', fileBase64: csvB64(CSV) }, SUPER_TOKEN));
  eq('force=1：已激活的也归入 update / active 归零',
    [r.data.summary.new, r.data.summary.update, r.data.summary.active, r.data.summary.invalid], [1, 2, 0, 2]);

  // 真 xlsx 走一遍（证明 exceljs 在云函数里可用 + 能把上传的二进制读出来）
  const xbuf = await importer.buildWorkbook([{
    name: '名册',
    columns: [{ header: '年级', width: 10 }, { header: '班级', width: 10 }, { header: '序号', width: 10 }, { header: '姓名', width: 14 }],
    rows: [['2024', '03', '01', '钱七']],
  }]);
  r = await H.call(H.req('POST', '/admin/student/import/preview', { filename: '真表.xlsx', fileBase64: Buffer.from(xbuf).toString('base64') }, SUPER_TOKEN));
  eq('xlsx 上传解析 ok', [r.code, r.data.sheetName, r.data.summary.new], [0, '名册', 1]);
  eq('xlsx 里的行也能读出来', [r.data.rows[0].username, r.data.rows[0].name], ['20240301', '钱七']);

  /* ══════════════ C. importCommit ══════════════ */
  section('C. POST /admin/student/import/commit（重新解析 + 落库）');

  reset(commitSeed());

  const rowsArr = [
    ['年级', '班级', '序号', '姓名'],
    ['2024', '01', '01', '张三'],
    ['2024', '01', '02', '李四'],
    ['2024', '03', '01', '钱七'],
    ['2024', '', '', '赵六'],
  ];

  r = await H.call(H.req('POST', '/admin/student/import/commit', {}, SUPER_TOKEN));
  eq('缺 rows → 40001', [r.code, r.message], [40001, '缺少 rows（应为白名单二维数组）']);

  r = await H.call(H.req('POST', '/admin/student/import/commit', { rows: [] }, SUPER_TOKEN));
  eq('rows 为空数组 → 40001', r.code, 40001);

  r = await H.call(H.req('POST', '/admin/student/import/commit', { rows: [['2024', '01', '01'], 'oops'] }, SUPER_TOKEN));
  eq('rows[1] 不是数组 → 40001 且点名下标', [r.code, r.message], [40001, 'rows[1] 不是数组']);

  const tooMany = new Array(importer.MAX_ROWS + 1).fill(0).map(() => ['2024', '01', '01']);
  r = await H.call(H.req('POST', '/admin/student/import/commit', { rows: tooMany }, SUPER_TOKEN));
  eq('超过 MAX_ROWS → 40001', [r.code, r.message], [40001, `行数超过上限 ${importer.MAX_ROWS}`]);
  eq('MAX_ROWS = 5000（与 sheet 服务同一常量）', importer.MAX_ROWS, 5000);

  // 严格模式：有异常行就整批拒
  r = await H.call(H.req('POST', '/admin/student/import/commit', { rows: rowsArr, strict: true }, SUPER_TOKEN));
  eq('strict 且有异常行 → 40001 整批拒绝', [r.code, String(r.message).indexOf('严格模式') >= 0], [40001, true]);
  eq('★ strict 拒绝时一行都没写', (dump().import_batch || []).length, 0);

  r = await H.call(H.req('POST', '/admin/student/import/commit', { rows: rowsArr, filename: 'r.csv' }, SUPER_TOKEN));
  eq('正常导入 → code 0', r.code, 0);
  eq('created / updated / skipped / invalid', [r.data.created, r.data.updated, r.data.skipped, r.data.invalid], [1, 1, 1, 1]);
  eq('total = 本批真实生效数（created + updated）', r.data.total, 2);
  eq('totalRows 含异常行', r.data.totalRows, 4);
  ok('回执里带 preview 明细（前端拿它渲染结果）', !!r.data.preview && r.data.preview.summary.new === 1);

  const batchId = r.data.batchId;
  const batchDoc = (dump().import_batch || []).find((b) => Number(b.id) === Number(batchId));
  ok('import_batch 落了库', !!batchDoc);
  eq('批次统计已回填', [batchDoc.total, batchDoc.created, batchDoc.updated, batchDoc.skipped, batchDoc.invalid], [4, 1, 1, 1, 1]);
  eq('批次记了操作人', [batchDoc.operator, batchDoc.operatorId, batchDoc.filename], ['root', 1, 'r.csv']);

  const created = usersOf().find((u) => u.username === '20240301');
  ok('新建账号存在', !!created);
  eq('新建账号字段：三元组 / 姓名双写 / 状态 / 未改密 / 批次',
    [created.grade, created.classNo, created.seatNo, created.remark, created.nickname, created.status, created.pwdChangedAt, Number(created.importBatchId), created.openid],
    ['2024', '03', '01', '钱七', '钱七', 1, null, Number(batchId), null]);
  ok('新建账号的密码 = user + 学号 的哈希', bcrypt.compareSync('user20240301', created.password));

  const refreshed = usersOf().find((u) => u.username === '20240102');
  ok('未激活的既有账号：密码被重置为初始密码', bcrypt.compareSync('user20240102', refreshed.password));
  eq('未激活账号也挂上新批次号', Number(refreshed.importBatchId), Number(batchId));

  const active = usersOf().find((u) => u.username === '20240101');
  ok('★ 已激活账号默认被跳过：密码一个字节都没动', bcrypt.compareSync('myOwnPwd', active.password));
  ok('★ 也没把它的批次号改掉', active.importBatchId === null);

  ok('唯一键 user_name:20240301 已占', uniqIds().indexOf('user_name:20240301') >= 0);

  // force：已激活的也覆盖三元组 / 备注，但**密码不动**
  reset(commitSeed());
  r = await H.call(H.req('POST', '/admin/student/import/commit', {
    rows: [['2024', '01', '01', '张三改名']], force: true, filename: 'f.csv',
  }, SUPER_TOKEN));
  eq('force：created 0 / updated 1', [r.data.created, r.data.updated, r.data.skipped], [0, 1, 0]);
  const forced = usersOf().find((u) => u.username === '20240101');
  eq('force：姓名双列都被覆盖', [forced.remark, forced.nickname], ['张三改名', '张三改名']);
  ok('★ force 也不覆盖已激活账号的密码', bcrypt.compareSync('myOwnPwd', forced.password));

  /* ══════════════ D. template（下载模板） ══════════════ */
  section('D. GET /admin/student/template（xlsx 下载契约）');

  reset(rosterSeed());
  r = await H.call(H.req('GET', '/admin/student/template', {}, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('mime 是 xlsx', r.data.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ok('文件名 = 学生账号导入模板_YYYYMMDD.xlsx', /^学生账号导入模板_\d{8}\.xlsx$/.test(r.data.filename), r.data.filename);
  ok('base64 非空', typeof r.data.base64 === 'string' && r.data.base64.length > 100);

  const tplBuf = b64Buf(r.data.base64);
  eq('★ 解回二进制是合法 xlsx（PK 魔数）', tplBuf.slice(0, 4).toString('hex'), '504b0304');
  const tplBack = await importer.readSheet(tplBuf, 't.xlsx');
  eq('第一个工作表名', tplBack.sheetName, '学生名册');
  eq('模板表头', tplBack.rows[0], ['年级', '班级', '序号', '姓名']);
  eq('模板示例行', tplBack.rows.slice(1, 4), [['2024', '01', '01', '张三'], ['2024', '01', '02', '李四'], ['2024', '02', '01', '王五']]);

  /* ══════════════ E. list ══════════════ */
  section('E. GET /admin/student/list');

  reset(rosterSeed());

  r = await H.call(H.req('GET', '/admin/student/list', {}, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('总数 = 5（种子里 6 人，username=null 的老微信用户被排除）', r.data.total, 5);
  eq('默认 page / pageSize', [r.data.page, r.data.pageSize], [1, 20]);
  eq('★ 排序 grade ASC, classNo ASC, seatNo ASC', r.data.list.map((x) => x.username),
    ['20230101', '20240101', '20240102', '20240201', '20240202']);
  eq('老微信用户不在名册里', r.data.list.some((x) => x.username === null), false);
  eq('DTO 字段齐（含 className / activated / loginCount）',
    [r.data.list[1].id, r.data.list[1].username, r.data.list[1].name, r.data.list[1].className, r.data.list[1].status, r.data.list[1].activated, r.data.list[1].loginCount],
    [1, '20240101', '张三', '2024 级 1 班', 1, false, 0]);
  eq('已激活账号 DTO', [r.data.list[2].activated, r.data.list[2].status, r.data.list[2].loginCount], [true, 0, 2]);
  eq('summary：total / activated / disabled / withSubmit',
    [r.data.summary.total, r.data.summary.activated, r.data.summary.disabled, r.data.summary.withSubmit], [5, 1, 1, 1]);

  r = await H.call(H.req('GET', '/admin/student/list', { grade: '2024' }, SUPER_TOKEN));
  eq('按年级过滤', [r.data.total, r.data.summary.total], [4, 4]);

  r = await H.call(H.req('GET', '/admin/student/list', { grade: 2024, classNo: '01' }, SUPER_TOKEN));
  eq('按年级 + 班级过滤（年级传数字也认）', r.data.total, 2);

  r = await H.call(H.req('GET', '/admin/student/list', { status: 0 }, SUPER_TOKEN));
  eq('status=0 过滤', r.data.total, 1);

  r = await H.call(H.req('GET', '/admin/student/list', { activated: 1 }, SUPER_TOKEN));
  eq('activated=1 过滤', r.data.total, 1);

  r = await H.call(H.req('GET', '/admin/student/list', { activated: '0' }, SUPER_TOKEN));
  eq('activated=0 过滤（字符串 0 也认）', r.data.total, 4);

  r = await H.call(H.req('GET', '/admin/student/list', { keyword: 'AMY' }, SUPER_TOKEN));
  eq('★ 关键字大小写不敏感（AMY 命中 Amy）', [r.data.total, r.data.list[0].username], [1, '20240202']);
  r = await H.call(H.req('GET', '/admin/student/list', { keyword: 'amy' }, SUPER_TOKEN));
  eq('小写同样命中', r.data.total, 1);
  eq('★ 关键字过滤后 summary.total 跟着变（与列表同一口径）', r.data.summary.total, 1);

  r = await H.call(H.req('GET', '/admin/student/list', { keyword: '202401' }, SUPER_TOKEN));
  eq('关键字命中用户名子串', r.data.list.map((x) => x.username).sort(), ['20240101', '20240102']);

  r = await H.call(H.req('GET', '/admin/student/list', { keyword: '李' }, SUPER_TOKEN));
  eq('关键字命中姓名', [r.data.total, r.data.list[0].username], [1, '20240102']);

  r = await H.call(H.req('GET', '/admin/student/list', { page: 2, pageSize: 2 }, SUPER_TOKEN));
  eq('分页切片正确', [r.data.page, r.data.pageSize, r.data.list.map((x) => x.username)], [2, 2, ['20240102', '20240201']]);

  r = await H.call(H.req('GET', '/admin/student/list', { page: 0, pageSize: 999 }, SUPER_TOKEN));
  eq('page 收敛到 1 / pageSize 收敛到上限 200', [r.data.page, r.data.pageSize], [1, 200]);
  r = await H.call(H.req('GET', '/admin/student/list', { pageSize: 'abc' }, SUPER_TOKEN));
  eq('pageSize 非法 → 退回默认 20', r.data.pageSize, 20);

  // 只统计时聚合失败不挡列表：这里退化为「全量拉 + JS 聚合」，正常应给到 summary
  ok('summary 不是 null（云端没有 GROUP BY，走 JS 聚合）', r.data.summary !== null);

  /* ══════════════ F. stats ══════════════ */
  section('F. GET /admin/student/stats（按年级班级汇总）');

  reset(rosterSeed());
  r = await H.call(H.req('GET', '/admin/student/stats', {}, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('班级聚合（按 grade/classNo 升序）',
    r.data.classes.map((c) => [c.classNo, c.className, c.total, c.activated, c.inactive]),
    [['01', '2023 级 1 班', 1, 0, 1], ['01', '2024 级 1 班', 2, 1, 1], ['02', '2024 级 2 班', 2, 0, 2]]);
  eq('overall', r.data.overall, { total: 5, activated: 1, inactive: 4 });

  /* ══════════════ G. export ══════════════ */
  section('G. GET /admin/student/export');

  reset(rosterSeed());
  r = await H.call(H.req('GET', '/admin/student/export', { grade: '2099' }, SUPER_TOKEN));
  eq('没有匹配 → 40401', [r.code, r.message], [40401, '没有符合条件的账号可导出']);

  // 说明顺序：grade + classNo + activated=0
  r = await H.call(H.req('GET', '/admin/student/export', { grade: '2024', classNo: '01', activated: 0 }, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  ok('文件名 = 学生账号_2024级1班未激活_YYYYMMDD.xlsx',
    /^学生账号_2024级1班未激活_\d{8}\.xlsx$/.test(r.data.filename), r.data.filename);

  const expBuf = b64Buf(r.data.base64);
  eq('导出的是合法 xlsx', expBuf.slice(0, 4).toString('hex'), '504b0304');
  const expBack = await importer.readSheet(expBuf, 'e.xlsx');
  eq('导出工作表名', expBack.sheetName, '学生账号');
  eq('导出列头',
    expBack.rows[0].slice(0, 9),
    ['年级', '班级', '序号', '姓名', '账号', '初始密码', '状态', '是否已激活', '最近登录时间']);

  // 数据本身直接问服务（handler 只是套了层 xlsx 壳）
  const exp = await roster.exportData({ grade: '2024' });
  eq('导出条数（2024 全届 4 人）', exp.total, 4);
  eq('导出列定义条数', exp.columns.length, 9);
  const rowOf = (u) => exp.rows.find((x) => x[4] === u);
  eq('未改密的账号：初始密码列有值', rowOf('20240101').slice(0, 9),
    ['2024', '01', '01', '张三', '20240101', 'user20240101', '启用', '未激活', '']);
  eq('★ 已改密的账号：初始密码列**留空**（bcrypt 不可逆）', rowOf('20240102').slice(0, 9),
    ['2024', '01', '02', '李四', '20240102', '', '停用', '已激活', '2026-09-12 10:00']);
  eq('导出按年级班级序号升序', exp.rows.map((x) => x[4]), ['20240101', '20240102', '20240201', '20240202']);
  ok('★ 最近登录时间是北京时间（源用容器 UTC，云端已修正）',
    rowOf('20240102')[8] === '2026-09-12 10:00', rowOf('20240102')[8]);

  /* ══════════════ H. update ══════════════ */
  section('H. PUT /admin/student/:id（改三元组 / 姓名 / 状态）');

  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240101', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
    message: [{ _id: 'ms1', id: 1, openid: '20240101', content: '留言', createTime: new Date(), updateTime: new Date() }],
    notice_ack: [{ _id: 'ack:20240101:n1', id: 1, openid: '20240101', noticeKey: 'n1', createTime: new Date(), updateTime: new Date() }],
    unique_keys: [{ _id: 'user_name:20240101', scope: 'user_name', key: '20240101', owner_id: 1, create_time: new Date() }],
  }));

  r = await H.call(H.req('PUT', '/admin/student/1', { classNo: 2, seatNo: 5, name: '张三丰' }, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('账号已改：20240101 → 20240205', [r.data.username, r.data.renamed, r.data.oldUsername], ['20240205', true, '20240101']);
  eq('姓名 / 班级展示名跟着变', [r.data.name, r.data.className], ['张三丰', '2024 级 2 班']);

  const renamed = byId(1);
  eq('★ 库中姓名双列同写（列表读 remark、小程序读 nickname）',
    [renamed.remark, renamed.nickname], ['张三丰', '张三丰']);
  eq('三元组落库', [renamed.grade, renamed.classNo, renamed.seatNo, renamed.username], ['2024', '02', '05', '20240205']);
  eq('★ 投稿的 openid 跟着搬', ((dump().submit || [])[0] || {}).openid, '20240205');
  eq('★ 留言的 openid 跟着搬', ((dump().message || [])[0] || {}).openid, '20240205');
  eq('★ 已确认记录的 openid 跟着搬', ((dump().notice_ack || [])[0] || {}).openid, '20240205');
  eq('★ 唯一键同步搬迁（旧放新占）', uniqIds(), ['user_name:20240205']);

  r = await H.call(H.req('PUT', '/admin/student/2', { classNo: 2, seatNo: 5 }, SUPER_TOKEN));
  eq('改到已存在的账号 → 40901', [r.code, r.message], [40901, '账号 20240205 已存在，无法改到该班级 / 序号']);

  r = await H.call(H.req('PUT', '/admin/student/3', { name: '   ' }, SUPER_TOKEN));
  eq('姓名为空 → 40001', [r.code, r.message], [40001, '姓名不能为空']);

  r = await H.call(H.req('PUT', '/admin/student/3', { name: 'x'.repeat(65) }, SUPER_TOKEN));
  eq('姓名超 64 字 → 40001', [r.code, r.message], [40001, '姓名最长 64 个字符']);

  r = await H.call(H.req('PUT', '/admin/student/3', { name: 'x'.repeat(64) }, SUPER_TOKEN));
  eq('恰好 64 字 → 通过', r.code, 0);

  // 别名：管理端改名发的是 { remark, nickname }，三个 key 都得认
  r = await H.call(H.req('PUT', '/admin/student/4', { nickname: '王五五' }, SUPER_TOKEN));
  eq('nickname 别名也认', [r.code, r.data.name], [0, '王五五']);
  r = await H.call(H.req('PUT', '/admin/student/4', { remark: '王五五五' }, SUPER_TOKEN));
  eq('remark 别名也认', [r.code, r.data.name], [0, '王五五五']);

  r = await H.call(H.req('PUT', '/admin/student/999', { name: 'x' }, SUPER_TOKEN));
  eq('不存在的 id → 40401', [r.code, r.message], [40401, '学生账号不存在']);

  r = await H.call(H.req('PUT', '/admin/student/abc', { name: 'x' }, SUPER_TOKEN));
  eq('id 非数字 → 40401（parseId 拦在查库之前）', r.code, 40401);

  r = await H.call(H.req('PUT', '/admin/student/3', { status: 0 }, SUPER_TOKEN));
  eq('payload.status 走同一条更新路径', [r.code, r.data.status], [0, 0]);

  reset(rosterSeed());
  r = await H.call(H.req('PUT', '/admin/student/1', { grade: '24级' }, SUPER_TOKEN));
  eq('年级写「24级」也归一化成 2024（未改账号 → renamed false）',
    [r.code, r.data.grade, r.data.username, r.data.renamed], [0, '2024', '20240101', false]);

  /* ══════════════ I. setStatus / setStatusBatch ══════════════ */
  section('I. PUT /:id/status 与 POST /status/batch');

  reset(rosterSeed());
  r = await H.call(H.req('PUT', '/admin/student/1/status', { status: 0 }, SUPER_TOKEN));
  eq('停用单个 → code 0 / status 0', [r.code, r.data.status, byId(1).status], [0, 0, 0]);
  r = await H.call(H.req('PUT', '/admin/student/1/status', { status: 1 }, SUPER_TOKEN));
  eq('启用单个', [r.code, r.data.status], [0, 1]);

  r = await H.call(H.req('PUT', '/admin/student/1/status', {}, SUPER_TOKEN));
  eq('缺 status → 40001', [r.code, r.message], [40001, '缺少 status（1=启用 0=停用）']);
  r = await H.call(H.req('PUT', '/admin/student/999/status', { status: 0 }, SUPER_TOKEN));
  eq('不存在的账号 → 40401', r.code, 40401);

  r = await H.call(H.req('POST', '/admin/student/status/batch', { ids: [1, 1, 2], status: 0 }, SUPER_TOKEN));
  eq('批量停用（重复 id 去重）→ affected 2', [r.code, r.data], [0, { affected: 2 }]);
  eq('库中两人都被停用', [byId(1).status, byId(2).status], [0, 0]);

  r = await H.call(H.req('POST', '/admin/student/status/batch', { ids: [1], status: 1 }, SUPER_TOKEN));
  eq('批量启用', r.data.affected, 1);

  r = await H.call(H.req('POST', '/admin/student/status/batch', {}, SUPER_TOKEN));
  eq('缺 status → 40001', [r.code, r.message], [40001, '缺少 status（1=启用 0=停用）']);
  r = await H.call(H.req('POST', '/admin/student/status/batch', { ids: [], status: 0 }, SUPER_TOKEN));
  eq('空 ids → 40001', [r.code, r.message], [40001, '请先勾选要操作的账号']);
  r = await H.call(H.req('POST', '/admin/student/status/batch', { ids: Array.from({ length: 501 }, (_, i) => i + 1), status: 0 }, SUPER_TOKEN));
  eq('>500 → 40001', [r.code, r.message], [40001, '一次最多操作 500 个账号']);
  r = await H.call(H.req('POST', '/admin/student/status/batch', { ids: [999], status: 0 }, SUPER_TOKEN));
  eq('全部不存在 → 40401', [r.code, r.message], [40401, '没有匹配到学生账号']);

  /* ══════════════ J. resetPassword / resetPasswordBatch ══════════════ */
  section('J. PUT /:id/reset-password 与 POST /reset-password/batch');

  reset(rosterSeed());
  r = await H.call(H.req('PUT', '/admin/student/2/reset-password', {}, SUPER_TOKEN));
  eq('单个重置 → code 0', r.code, 0);
  eq('回执：affected / usernames / initPassword',
    [r.data.affected, r.data.usernames, r.data.initPassword], [1, ['20240102'], 'user20240102']);
  ok('★ 库中密码已被重置为初始密码', bcrypt.compareSync('user20240102', byId(2).password));
  eq('★ pwdChangedAt 归零（旧 token 立刻失效）', byId(2).pwdChangedAt, null);

  r = await H.call(H.req('PUT', '/admin/student/999/reset-password', {}, SUPER_TOKEN));
  eq('不存在的 id → 40401', r.code, 40401);
  r = await H.call(H.req('PUT', '/admin/student/abc/reset-password', {}, SUPER_TOKEN));
  eq('id 非数字 → 40401', r.code, 40401);

  r = await H.call(H.req('POST', '/admin/student/reset-password/batch', {}, SUPER_TOKEN));
  eq('不给范围 → 40001（防手滑重置全校）',
    [r.code, r.message], [40001, '请指定要重置的账号（勾选列表或指定年级 / 班级）']);

  r = await H.call(H.req('POST', '/admin/student/reset-password/batch', { grade: '2099' }, SUPER_TOKEN));
  eq('范围没匹配到人 → 40401', [r.code, r.message], [40401, '没有匹配到要重置的账号']);

  r = await H.call(H.req('POST', '/admin/student/reset-password/batch', { grade: '2024', classNo: '02' }, SUPER_TOKEN));
  eq('按年级 + 班级批量重置', [r.code, r.data.affected, r.data.initPasswordRule], [0, 2, 'user + 学号']);

  r = await H.call(H.req('POST', '/admin/student/reset-password/batch', { ids: [1, 3] }, SUPER_TOKEN));
  eq('按 ids 批量重置', [r.code, r.data.affected], [0, 2]);
  ok('两人密码都是各自的初始密码',
    bcrypt.compareSync('user20240101', byId(1).password) && bcrypt.compareSync('user20240201', byId(3).password));

  /* ══════════════ K. remove / removeBatch ══════════════ */
  section('K. DELETE /:id 与 POST /delete/batch');

  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
    unique_keys: [
      { _id: 'user_name:20240101', scope: 'user_name', key: '20240101', owner_id: 1, create_time: new Date() },
      { _id: 'user_name:20240102', scope: 'user_name', key: '20240102', owner_id: 2, create_time: new Date() },
    ],
  }));

  r = await H.call(H.req('DELETE', '/admin/student/1', {}, SUPER_TOKEN));
  eq('无投稿记录 → 真删', [r.code, r.data], [0, { deleted: true, disabled: false, submitCount: 0 }]);
  eq('库中确实没了', byId(1), null);
  eq('★ 唯一键同步释放（孤儿键会挡住同名再导入）', uniqIds(), ['user_name:20240102']);

  r = await H.call(H.req('DELETE', '/admin/student/2', {}, SUPER_TOKEN));
  eq('★ 有投稿记录 → 不删，改停用',
    [r.code, r.data.deleted, r.data.disabled, r.data.submitCount], [0, false, true, 1]);
  ok('并且给了人话解释', /有 1 条投稿记录，已改为停用（不删除）/.test(r.data.message), r.data.message);
  eq('账号还在、状态变 0', [!!byId(2), byId(2).status], [true, 0]);
  eq('★ 有投稿的账号唯一键**不释放**（账号还在）', uniqIds(), ['user_name:20240102']);

  r = await H.call(H.req('DELETE', '/admin/student/999', {}, SUPER_TOKEN));
  eq('不存在的 id → 40401', r.code, 40401);
  r = await H.call(H.req('DELETE', '/admin/student/abc', {}, SUPER_TOKEN));
  eq('id 非数字 → 40401', r.code, 40401);

  // 批量删除：逐条走与单条完全相同的规则
  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
  }));
  r = await H.call(H.req('POST', '/admin/student/delete/batch', {}, SUPER_TOKEN));
  eq('空 ids → 40001', [r.code, r.message], [40001, '请先勾选要删除的账号']);
  r = await H.call(H.req('POST', '/admin/student/delete/batch', { ids: Array.from({ length: 201 }, (_, i) => i + 1) }, SUPER_TOKEN));
  eq('>200 → 40001', [r.code, r.message], [40001, '一次最多删除 200 个账号']);

  r = await H.call(H.req('POST', '/admin/student/delete/batch', { ids: [1, 2, 999, 2] }, SUPER_TOKEN));
  eq('批量：total 去重后 3 条', r.data.total, 3);
  eq('★ 无投稿真删 1（id=1）/ 有投稿转停用 1（id=2）/ 不存在记失败 1（999）',
    [r.data.deleted, r.data.disabled, r.data.failed.length], [1, 1, 1]);
  eq('失败项带 id 与原因', [r.data.failed[0].id, r.data.failed[0].message], [999, '学生账号不存在']);
  eq('库里只剩有投稿的那个、且已停用', usersOf().filter((u) => u.id <= 2).map((u) => [u.id, u.status]), [[2, 0]]);

  r = await H.call(H.req('POST', '/admin/student/delete/batch', { ids: ['', null, undefined] }, SUPER_TOKEN));
  eq('ids 全是空值 → 40001', [r.code, r.message], [40001, '请先勾选要删除的账号']);

  /* ══════════════ L. grades / gradeDetail ══════════════ */
  section('L. GET /grades 与 GET /grade/:grade');

  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
  }));

  r = await H.call(H.req('GET', '/admin/student/grades', {}, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('年级列表（升序）', r.data.list.map((g) => [g.grade, g.name, g.classCount, g.total, g.activated, g.inactive, g.disabled]),
    [['2023', '2023 级', 1, 1, 0, 1, 0], ['2024', '2024 级', 2, 4, 1, 3, 1]]);
  eq('overall', r.data.overall, { gradeCount: 2, total: 5, activated: 1, disabled: 1 });
  // ⚠️ 本 harness 直接把返回值交给断言（不过 JSON），所以这里是 Date 实例而不是 ISO 串
  ok('lastImportAt 是 Date（线上经 JSON 序列化后为字符串）',
    r.data.list[1].lastImportAt instanceof Date, String(r.data.list[1].lastImportAt));

  r = await H.call(H.req('GET', '/admin/student/grade/2024', {}, SUPER_TOKEN));
  eq('届概况', [r.code, r.data.grade, r.data.name, r.data.total, r.data.classCount], [0, '2024', '2024 级', 4, 2]);
  eq('激活 / 停用 / 有投稿 / 可删',
    [r.data.activated, r.data.disabled, r.data.withSubmit, r.data.canDelete], [1, 1, 1, 3]);
  eq('按班拆分', r.data.classes.map((c) => [c.classNo, c.className, c.total, c.activated, c.withSubmit]),
    [['01', '2024 级 1 班', 2, 1, 1], ['02', '2024 级 2 班', 2, 0, 0]]);
  eq('samples 最多 20 条', r.data.samples.length, 4);

  r = await H.call(H.req('GET', '/admin/student/grade/24', {}, SUPER_TOKEN));
  eq('届参数写「24」也能识别', [r.code, r.data.grade], [0, '2024']);
  r = await H.call(H.req('GET', '/admin/student/grade/2099', {}, SUPER_TOKEN));
  eq('没有该届账号 → 40401', [r.code, r.message], [40401, '2099 级下没有任何学生账号']);
  r = await H.call(H.req('GET', '/admin/student/grade/abc', {}, SUPER_TOKEN));
  eq('届参数无法识别 → 50001（裸 Error，与源后端同口径）', r.code, 50001);

  /* ══════════════ M. removeGrade ══════════════ */
  section('M. DELETE /grade/:grade（整届清理）+ 清理回执');

  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
    unique_keys: rosterSeed().user.filter((u) => u.username).map((u) => ({
      _id: `user_name:${u.username}`, scope: 'user_name', key: u.username, owner_id: u.id, create_time: new Date(),
    })),
  }));

  // 先看不安全模式：必须原样输入年级
  r = await H.call(H.req('DELETE', '/admin/student/grade/2024', { mode: 'purge' }, SUPER_TOKEN));
  eq('purge 不带 confirm → 40001 且点名要原样输入年级',
    [r.code, r.message], [40001, '危险操作：要把投稿记录里的账号一并删掉，请在确认框里原样输入年级「2024」']);
  r = await H.call(H.req('DELETE', '/admin/student/grade/2024', { mode: 'purge', confirm: '2024级' }, SUPER_TOKEN));
  eq('confirm 不原样（多写了「级」）→ 40001', r.code, 40001);
  eq('★ 两次失败都没动人', usersOf().length, 6);

  // safe（默认）：无投稿真删、有投稿停用
  r = await H.call(H.req('DELETE', '/admin/student/grade/2024', {}, SUPER_TOKEN));
  eq('safe：2024 届共 4 人，删 3 / 停 1', [r.code, r.data.total, r.data.deleted, r.data.disabled, r.data.mode], [0, 4, 3, 1, 'safe']);
  eq('2024 届只剩那个有投稿的、且已停用',
    usersOf().filter((u) => u.grade === '2024' && u.username).map((u) => [u.id, u.status]), [[2, 0]]);
  eq('2023 届完全没动', usersOf().filter((u) => u.grade === '2023' && u.username).map((u) => [u.id, u.status]), [[4, 1]]);
  eq('★ 无投稿的账号唯一键被释放、有投稿的保留',
    uniqIds(), ['user_name:20230101', 'user_name:20240102']);

  // 回执（v8「清理完成」屏靠它还原）
  ok('返回了清理回执', !!r.data.receipt);
  eq('回执：年级 / 名称 / 模式 / 计数',
    [r.data.receipt.grade, r.data.receipt.gradeName, r.data.receipt.mode, r.data.receipt.total, r.data.receipt.deleted, r.data.receipt.disabled],
    ['2024', '2024 级', 'safe', 4, 3, 1]);
  eq('★ 回执里 disabledAccounts 是**数组**（落库是 JSON 串，出口还原）',
    Array.isArray(r.data.receipt.disabledAccounts), true);
  eq('被判停用的那个就是有投稿的人',
    r.data.receipt.disabledAccounts.map((x) => [x.username, x.name, x.className]), [['20240102', '李四', '2024 级 1 班']]);
  eq('★ 未受影响的其它届人数', r.data.receipt.untouched, 1);
  eq('回执带 operatorId / operatorName', [r.data.receipt.operatorId, r.data.receipt.operatorName], [1, 'root']);
  eq('回执带 classCount（这些账号跨几个班）', r.data.receipt.classCount, 1);
  ok('costMs 是非负数字', typeof r.data.costMs === 'number' && r.data.costMs >= 0, String(r.data.costMs));
  eq('costText = costMs / 1000 保留 1 位', r.data.receipt.costText, `${(r.data.costMs / 1000).toFixed(1)}s`);

  const clRows = dump().cleanup_log || [];
  eq('回执落库一笔', clRows.length, 1);
  ok('★ 落库的 disabledAccounts 是 JSON 字符串（不是对象数组）',
    typeof clRows[0].disabledAccounts === 'string', typeof clRows[0].disabledAccounts);
  eq('落库内容可还原', JSON.parse(clRows[0].disabledAccounts).map((x) => x.username), ['20240102']);

  // disable 模式：只停用不删
  reset(rosterSeed());
  r = await H.call(H.req('DELETE', '/admin/student/grade/2024', { mode: 'disable' }, SUPER_TOKEN));
  eq('disable：删 0 / 停 4', [r.data.deleted, r.data.disabled, r.data.total], [0, 4, 4]);
  eq('账号都还在、都停用',
    usersOf().filter((u) => u.grade === '2024' && u.username).map((u) => u.status), [0, 0, 0, 0]);
  ok('disable 也写回执', (dump().cleanup_log || []).length === 1);

  // purge 模式：confirm 正确 → 全删
  reset(rosterSeed({
    submit: [{ _id: 'sb1', id: 1, openid: '20240102', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
  }));
  r = await H.call(H.req('DELETE', '/admin/student/grade/2024', { mode: 'purge', confirm: '2024' }, SUPER_TOKEN));
  eq('purge：4 人全删', [r.data.deleted, r.data.disabled, r.data.mode], [4, 0, 'purge']);
  eq('★ 连有投稿的一起删了；2023 届与老微信用户还在', usersOf().map((u) => u.id), [4, 5]);

  // 收尾：届不存在
  r = await H.call(H.req('DELETE', '/admin/student/grade/2099', { mode: 'safe' }, SUPER_TOKEN));
  eq('届下无账号 → 40401', r.code, 40401);

  /* ══════════════ N. cleanupLast ══════════════ */
  section('N. GET /cleanup/last（刷新后还原「清理完成」屏）');

  reset(rosterSeed({
    cleanup_log: [
      { _id: 'cl1', id: 1, grade: '2024', gradeName: '2024 级', mode: 'safe', total: 5, deleted: 4, disabled: 1, classCount: 1, untouched: 1, costMs: 1234, operatorId: 1, operatorName: 'root', disabledAccounts: JSON.stringify([{ username: '20240102', name: '李四', className: '2024 级 1 班' }]), createTime: new Date('2026-09-01T10:00:00+08:00'), updateTime: new Date('2026-09-01T10:00:00+08:00') },
      { _id: 'cl2', id: 2, grade: '2023', gradeName: '2023 级', mode: 'disable', total: 1, deleted: 0, disabled: 1, classCount: 1, untouched: 5, costMs: 88, operatorId: 1, operatorName: 'root', disabledAccounts: JSON.stringify([{ username: '20230101', name: '', className: '2023 级 1 班' }]), createTime: new Date('2026-09-03T10:00:00+08:00'), updateTime: new Date('2026-09-03T10:00:00+08:00') },
      { _id: 'cl3', id: 3, grade: '2024', gradeName: '2024 级', mode: 'purge', total: 5, deleted: 5, disabled: 0, classCount: 2, untouched: 1, costMs: 2500, operatorId: 1, operatorName: 'root', disabledAccounts: JSON.stringify([]), createTime: new Date('2026-09-05T10:00:00+08:00'), updateTime: new Date('2026-09-05T10:00:00+08:00') },
    ],
  }));

  r = await H.call(H.req('GET', '/admin/student/cleanup/last', {}, SUPER_TOKEN));
  eq('不传 grade → 取全局最近一次', [r.code, r.data.id, r.data.mode], [0, 3, 'purge']);

  r = await H.call(H.req('GET', '/admin/student/cleanup/last', { grade: '2024' }, SUPER_TOKEN));
  eq('按年级取最近一次', [r.data.id, r.data.grade], [3, '2024']);

  r = await H.call(H.req('GET', '/admin/student/cleanup/last', { grade: '2023' }, SUPER_TOKEN));
  eq('另一个年级', [r.data.id, r.data.disabledAccounts.map((x) => x.username)], [2, ['20230101']]);
  eq('costText 由 costMs 现算', r.data.costText, '0.1s');

  r = await H.call(H.req('GET', '/admin/student/cleanup/last', { grade: '2099' }, SUPER_TOKEN));
  eq('没有回执 → 返回 null（不是 {}）', [r.code, r.data], [0, null]);

  // disabledAccounts 脏数据兜底
  reset(rosterBaseWithBadReceipt());
  r = await H.call(H.req('GET', '/admin/student/cleanup/last', {}, SUPER_TOKEN));
  eq('★ 回执里的 disabledAccounts 是坏 JSON → 兜底成空数组（不 500）',
    [r.code, r.data.disabledAccounts], [0, []]);
  eq('costMs 缺失 → costText 退化成 0.0s', r.data.costText, '0.0s');

  function rosterBaseWithBadReceipt() {
    return baseSeed({
      cleanup_log: [{ _id: 'bad1', id: 1, grade: '2024', mode: 'safe', disabledAccounts: '{不是 JSON', createTime: new Date('2026-09-01T10:00:00+08:00') }],
    });
  }

  /* ══════════════ O. batches / rollback ══════════════ */
  section('O. GET /batches 与 POST /batch/:id/rollback');

  reset(baseSeed({
    import_batch: [
      { _id: 'b1', id: 1, filename: 'a.csv', total: 3, created: 3, updated: 0, skipped: 0, invalid: 0, operator: 'root', operatorId: 1, createTime: new Date('2026-09-01T10:00:00+08:00'), updateTime: new Date('2026-09-01T10:00:00+08:00') },
      { _id: 'b2', id: 2, filename: 'b.csv', total: 5, created: 2, updated: 3, skipped: 0, invalid: 0, operator: 'root', operatorId: 1, createTime: new Date('2026-09-02T10:00:00+08:00'), updateTime: new Date('2026-09-02T10:00:00+08:00') },
      { _id: 'b3', id: 3, filename: 'c.csv', total: 1, created: 1, updated: 0, skipped: 0, invalid: 0, operator: 'reviewer', operatorId: 2, createTime: new Date('2026-09-03T10:00:00+08:00'), updateTime: new Date('2026-09-03T10:00:00+08:00') },
    ],
    user: [
      mkUser(11, { importBatchId: 1, username: '20240101', seatNo: '01' }),                                  // 未激活、无投稿 → 可撤
      mkUser(12, { importBatchId: 1, username: '20240102', seatNo: '02', pwdChangedAt: new Date('2026-09-10T10:00:00+08:00') }), // 已激活 → 保留
      mkUser(13, { importBatchId: 1, username: '20240103', seatNo: '03' }),                                  // 有投稿 → 保留
    ],
    submit: [{ _id: 'sb1', id: 1, openid: '20240103', type: 1, songName: '晴天', createTime: new Date(), updateTime: new Date() }],
  }));

  r = await H.call(H.req('GET', '/admin/student/batches', {}, SUPER_TOKEN));
  eq('code 0 / 返回 { list }', [r.code, Array.isArray(r.data.list)], [0, true]);
  eq('★ 批次按 id 倒序（最近的在前）', r.data.list.map((b) => b.id), [3, 2, 1]);
  eq('批次 DTO 字段', Object.keys(r.data.list[0]).sort(),
    ['createTime', 'created', 'filename', 'id', 'invalid', 'operator', 'skipped', 'total', 'updated']);
  eq('明细透传', [r.data.list[1].filename, r.data.list[1].total, r.data.list[1].created, r.data.list[1].updated], ['b.csv', 5, 2, 3]);

  r = await H.call(H.req('GET', '/admin/student/batches', { limit: 'abc' }, SUPER_TOKEN));
  eq('limit 非法 → 退回默认 20（不报错）', [r.code, r.data.list.length], [0, 3]);
  r = await H.call(H.req('GET', '/admin/student/batches', { limit: 500 }, SUPER_TOKEN));
  eq('limit 上限 100（单次 get 上限内）', r.data.list.length, 3);
  r = await H.call(H.req('GET', '/admin/student/batches', { limit: 1 }, SUPER_TOKEN));
  eq('limit=1 只取最近一条', r.data.list.map((b) => b.id), [3]);

  r = await H.call(H.req('POST', '/admin/student/batch/1/rollback', {}, SUPER_TOKEN));
  eq('code 0', r.code, 0);
  eq('★ 只删「未激活且无投稿」的：撤 1 / 保留已激活 1 / 保留有投稿 1',
    [r.data.batchId, r.data.removed, r.data.keptActivated, r.data.keptWithSubmit], [1, 1, 1, 1]);
  eq('被撤的账号没了、另外两个还在', byId(11), null);
  eq('留下的两人', usersOf().map((u) => u.id).sort(), [12, 13]);

  r = await H.call(H.req('POST', '/admin/student/batch/999/rollback', {}, SUPER_TOKEN));
  eq('批次不存在 → 40401', [r.code, r.message], [40401, '批次不存在']);
  r = await H.call(H.req('POST', '/admin/student/batch/abc/rollback', {}, SUPER_TOKEN));
  eq('id 非数字 → 40401', r.code, 40401);

  /* ══════════════ P. services/roster：归一化与解析（纯逻辑） ══════════════ */
  section('P. services/roster 归一化 / 表头识别 / 解析');

  eq('全角数字 → 半角', roster.toHalfWidth('２０２４'), '2024');
  eq('零宽字符被清掉', roster.toHalfWidth('2\u200B024'), '2024');
  eq('clean：去 Excel 文本撇号 + 全角空格 + 所有空白', roster.clean("' 2 0 2 4 '"), '2024');
  eq('clean：null → 空串', roster.clean(null), '');

  eq('normalizeGrade：2024 / "2024" / "24" / "2024级" / "2024届"',
    [roster.normalizeGrade(2024), roster.normalizeGrade('2024'), roster.normalizeGrade('24'), roster.normalizeGrade('2024级'), roster.normalizeGrade('2024届')],
    ['2024', '2024', '2024', '2024', '2024']);
  ok('normalizeGrade：非 19xx/20xx 的 4 位数被拒', (() => { try { roster.normalizeGrade('1800'); return false; } catch (e) { return /不合法/.test(e.message); } })());
  ok('normalizeGrade：空值被拒', (() => { try { roster.normalizeGrade(''); return false; } catch (e) { return /无法识别/.test(e.message); } })());
  ok('normalizeGrade：三位数被拒', (() => { try { roster.normalizeGrade('202'); return false; } catch (e) { return true; } })());

  eq('normalizePart：1 / "01" / "1班" / "高一(1)班" / "第5" / 5',
    [roster.normalizePart(1, '班级'), roster.normalizePart('01', '班级'), roster.normalizePart('1班', '班级'), roster.normalizePart('高一(1)班', '班级'), roster.normalizePart('第5', '序号', 99), roster.normalizePart(5, '序号', 99)],
    ['01', '01', '01', '01', '05', '05']);
  ok('normalizePart：0 越界被拒', (() => { try { roster.normalizePart('0', '班级'); return false; } catch (e) { return /超出范围/.test(e.message); } })());
  ok('normalizePart：100 超过 max 被拒', (() => { try { roster.normalizePart('100', '班级'); return false; } catch (e) { return /超出范围/.test(e.message); } })());
  ok('normalizePart：无数字被拒', (() => { try { roster.normalizePart('一班', '班级'); return false; } catch (e) { return /无法识别/.test(e.message); } })());

  eq('splitCombined：8 位拼写 / 带分隔符 / 中文拼写',
    [roster.splitCombined('20240101'), roster.splitCombined('2024-01-01'), roster.splitCombined('2024 01 01'), roster.splitCombined('2024级1班1号')],
    [['2024', '01', '01'], ['2024', '01', '01'], ['2024', '01', '01'], ['2024', '1', '1']]);
  eq('splitCombined：凑不齐三段 → null', [roster.splitCombined('2024'), roster.splitCombined('')], [null, null]);

  eq('buildUsername = 年级 + 班级 + 序号', roster.buildUsername('2024', '01', '01'), '20240101');
  eq('gradeLabel 去掉班级前导零', [roster.gradeLabel('2024', '01'), roster.gradeLabel('2024', '12')], ['2024 级 1 班', '2024 级 12 班']);
  eq('formatTime 用北京时间（UTC 02:30 → 10:30）', roster.formatTime(Date.UTC(2026, 8, 1, 2, 30)), '2026-09-01 10:30');
  eq('initPasswordFor 唯一出口', roster.initPasswordFor('20240101'), 'user20240101');

  eq('detectHeader：数字单元格不会被当成表头', roster.detectHeader([['2024', '01', '01']]), null);
  eq('detectHeader：命中最多的一行当选',
    roster.detectHeader([['说明', '', ''], ['年级', '班级', '序号']]).rowIndex, 1);

  const pos = roster.parseSheet([['2024', '01', '01'], ['2024', '01', '02']]);
  eq('无表头 → 按列序解析（position 模式）', [pos.mode, pos.headerRowIndex, pos.columns.grade, pos.columns.class, pos.columns.seat], ['position', -1, 0, 1, 2]);
  eq('无表头会给出 warning', pos.warnings.length, 1);
  eq('★ parseSheet 的 state 字段恒为默认 invalid（只对 analyze/preview 结果有意义，源实现同款）',
    pos.dataRows.map((x) => [x.valid, x.state]), [[true, 'invalid'], [true, 'invalid']]);

  ok('parseSheet：空表 → 40001', (() => { try { roster.parseSheet([]); return false; } catch (e) { return e.code === 40001; } })());
  ok('parseSheet：表头下全空 → 40001', (() => {
    try { roster.parseSheet([['年级', '班级', '序号'], ['', '', '']]); return false; } catch (e) { return /没有读到任何数据行/.test(e.message); }
  })());
  ok('parseSheet：position 模式下首行解析失败 → 提示补表头', (() => {
    try { roster.parseSheet([['甲', '乙', '丙'], ['丁', '戊', '己']]); return false; } catch (e) { return /请确认前 3 列/.test(e.message); }
  })());

  // analyzer 层
  // ⚠️ 20240301 同样必须不在库里；id1 要显式激活，否则「已激活 → active」这条路走不到
  const analyzeSeed = () => rosterSeed({
    user: rosterSeed().user.map((u) => (u.id === 1 ? mkUser(1, { remark: '张三', pwdChangedAt: new Date('2026-09-08T10:00:00+08:00'), status: 1 }) : u)),
  });
  reset(analyzeSeed());
  const analyzed = await roster.analyze([
    ['年级', '班级', '序号', '姓名'],
    ['2024', '01', '01', '张三'],   // 已激活 → active
    ['2024', '03', '01', '钱七'],   // 库里没有 → new
    ['2024', 'x', '01', '错'],      // 班级非法 → invalid
  ]);
  eq('analyze.summary', analyzed.summary, { new: 1, update: 0, active: 1, invalid: 1 });
  eq('analyze 会给 valid 行正确的 state', analyzed.rows.filter((x) => x.valid).map((x) => x.state), ['active', 'new']);
  ok('analyze 会对已激活行打 protectedPwd', analyzed.rows[0].protectedPwd === true);
  eq('analyze.errors 只含异常行', analyzed.errors.map((e) => e.rowNo), [4]);

  reset(analyzeSeed());
  const analyzedF = await roster.analyze([
    ['年级', '班级', '序号', '姓名'],
    ['2024', '01', '01', '张三'],
  ], { force: true });
  eq('force 下已激活归入 update', analyzedF.summary, { new: 0, update: 1, active: 0, invalid: 0 });
  ok('force 下仍标记 protectedPwd（调用方据此不覆盖密码）', analyzedF.rows[0].protectedPwd === true);

  /* ══════════════ Q. services/sheet：xlsx / csv 读写 ══════════════ */
  section('Q. services/sheet（xlsx / csv 读写）');

  eq('parseCsv：基本切分', importer.parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  eq('parseCsv：双引号内的逗号不被切', importer.parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
  eq('parseCsv：引号内换行不断行', importer.parseCsv('a,"x\ny"\n'), [['a', 'x\ny']]);
  eq('parseCsv：双写引号转义', importer.parseCsv('a,"说""引号"""\n'), [['a', '说"引号"']]);
  eq('parseCsv：CRLF 不断行', importer.parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  eq('parseCsv：BOM 被剥掉', importer.parseCsv('\uFEFFa,b\n'), [['a', 'b']]);
  eq('parseCsv：末尾空行被去掉', importer.parseCsv('a,b\n1,2\n\n\n'), [['a', 'b'], ['1', '2']]);
  eq('parseCsv：最后一行无换行也收尾', importer.parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);

  eq('cellToText：null / 数字 / 布尔 / 富文本 / 公式结果',
    [importer.cellToText(null), importer.cellToText(2024), importer.cellToText(true), importer.cellToText({ richText: [{ text: '甲' }, { text: '乙' }] }), importer.cellToText({ result: 2024 })],
    ['', '2024', 'true', '甲乙', '2024']);
  eq('cellToText：Date 折成 YYYYMMDD（用户把年份输成日期时还能救）',
    importer.cellToText(new Date(2024, 0, 5, 12, 0, 0)), '20240105');

  const multi = await importer.buildWorkbook([
    { name: 'S1', columns: [{ header: 'A', width: 8 }, { header: 'B', width: 8 }], rows: [['1', '2'], ['3', '']] },
    { name: 'S2', columns: [{ header: 'X', width: 8 }], rows: [['9']] },
  ]);
  eq('buildWorkbook 产出合法 xlsx', Buffer.from(multi).slice(0, 4).toString('hex'), '504b0304');
  const back1 = await importer.readSheet(Buffer.from(multi), 'm.xlsx');
  eq('readSheet 只读第一个工作表', back1.sheetName, 'S1');
  eq('表头 + 数据行（行号 = 下标 + 1）', back1.rows, [['A', 'B'], ['1', '2'], ['3', '']]);

  const blank = await importer.buildWorkbook([{ name: 'S', columns: [{ header: 'A', width: 8 }], rows: [['1'], [''], ['3']] }]);
  const backBlank = await importer.readSheet(Buffer.from(blank), 'b.xlsx');
  eq('★ 空行被保留（报错行号才能与用户在 Excel 里看到的对齐）',
    [backBlank.rows.length, backBlank.rows[2][0]], [4, '']);

  eq('csv 走 CSV 分支', (await importer.readSheet(Buffer.from('年级,班级\n2024,01\n'), 'a.csv')).sheetName, 'CSV');
  eq('.txt 也按 csv 解析', (await importer.readSheet(Buffer.from('a,b\n1,2\n'), 'a.txt')).sheetName, 'CSV');

  ok('readSheet：不是 xlsx 的二进制 → 抛错（由 handler 翻成 40001）', await (async () => {
    try { await importer.readSheet(Buffer.from('hello world'), 'x.xlsx'); return false; } catch (e) { return true; }
  })());

  /* ══════════════ 输出 ══════════════ */
  const checked = lines.filter((l) => /^(OK|FAIL) /.test(l)).length;
  lines.push('');
  lines.push(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { require('fs').writeFileSync(path.join(__dirname, '..', '..', '_cloud_admin_student_test.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
