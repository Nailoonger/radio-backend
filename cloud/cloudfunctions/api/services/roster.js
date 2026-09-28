'use strict';

/**
 * roster —— 学生名册：解析 / 归一化 / 校验 / 落库 / 批量维护
 * 从 src/services/studentRosterService.js 移植（阶段 7）
 *
 * ═══ 三段确定性规则（不猜） ═══════════════════════════════════════════════
 *   1. 认表头：扫前 3 行找关键词（年级/班级/序号/姓名），命中最多的一行当表头。
 *      一个都没命中 → 按列序取第 1/2/3 列，并拿第一行数据试解析，解析不出就报错。
 *   2. 逐格归一化：2024级 / 24 → 2024；1班 → 01；第5 → 05；全角数字、撇号、空格先清洗。
 *      也支持单列合并写法：20240101 / 2024-01-01 / 2024级1班1号。
 *   3. 逐行出结论：可导入 / 异常（带原因和真实行号）/ 库中已存在。
 *      **预览阶段一行都不写库**；commit 时服务端重新解析 + 重新校验（不信任前端回传）。
 *
 * ═══ 账号规则 ═════════════════════════════════════════════════════════════
 *   账号 = 入学年级(4) + 班级(2) + 序号(2)，如 2024 + 01 + 01 = 20240101
 *
 * ═══ 云化差异（逐条，都经过实测/推演） ═══════════════════════════════════
 * ① **没有跨文档事务**。原 `commit` / `removeGrade` / `updateStudent` 里的
 *    `sequelize.transaction` 全部拆成顺序执行。可接受的理由：这些操作都是「批量维护」，
 *    失败时最多留下「部分导入」的半成品 —— 而**每一行本身的写都是幂等的**
 *    （按 username 覆盖 / 固定 `_id` 占用），重跑一遍即可收敛。真正的原子性需求
 *    （抢座位）在 `songStatus` 的 `applyChange`，不在这里。
 * ② **没有 GROUP BY**：`statsByClass` / `listGrades` / `listStudents.summary`
 *    全部退化成「分页拉全量 + JS 聚合」。适用前提：学生数 ≤ 数千（本项目量级）。
 * ③ **没有 LIKE**：`keyword` 过滤改成 JS 子串匹配（大小写不敏感，对齐 MySQL ci 排序规则）。
 * ④ **唯一性**：MySQL 的 `uk_username` 改用 `reserveUnique('user_name', ...)`
 *    （见 docs/data-model-mapping.md §三）。删除账号时**必须** `releaseUnique`，
 *    否则孤儿键会挡住后续同名导入。
 * ⑤ **时间显示改北京时间**：原 `formatTime` / `stamp` 用的是**容器本地时间**
 *    （本项目容器是 UTC）→ 导出的「最近登录时间」比实际早 8 小时。这属于缺陷，不是语义，
 *    按全项目口径改用 `lib/bjTime`。（有意偏离，已在 stage7 方案里标注。）
 */

const { C, _, findOne, findAllPaged, findMany, insertOne, updateById, updateWhere, removeWhere, count, nextId, reserveUnique, releaseUnique } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');
const bj = require('../lib/bjTime');
const accountService = require('./studentAccount');

const CLASS_MAX = 99;
const SEAT_MAX = 99;
const GRADE_RE = /^(19|20)\d{2}$/;

/** 表头关键词：命中越多的行越可能是表头行 */
const HEADER_WORDS = {
  grade: ['入学年份', '入学', '年级', '届', '年份'],
  class: ['班级', '班'],
  seat: ['序号', '座号', '编号', '学号', '号'],
  name: ['姓名', '名字', '学生姓名'],
};

/**
 * `username IS NOT NULL` 的云端等价物。
 *
 * ⚠️ 不能只写 `_.neq(null)`：模型文档数据库里「字段缺失」与「字段为 null」是两回事，
 *    只判 neq 时缺失字段可能被算进来（不同 SDK 版本行为不一致）。
 *    显式加 `exists(true)` 后语义就与 SQL 的 IS NOT NULL 完全一致。
 */
const HAS_USERNAME = _.exists(true).and(_.neq(null));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 云端下推 `_.in([...])` 时数组不宜过大（受命令体大小限制）—— 统一按 100 切 */
const IN_CHUNK = 100;

/* ────────────────────────── 清洗与归一化 ────────────────────────── */

/** 全角数字 → 半角、去零宽字符 */
function toHalfWidth(s) {
  return String(s)
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function clean(v) {
  if (v === null || v === undefined) return '';
  let s = toHalfWidth(v);
  s = s.replace(/^['"`]+|['"`]+$/g, ''); // Excel 文本撇号
  s = s.replace(/\u3000/g, ' ');         // 全角空格
  return s.replace(/\s+/g, '');
}

/**
 * 年级 → 4 位入学年份
 *   2024 / 2024级 / 2024届 / 24 / 24级 → 2024
 */
function normalizeGrade(raw) {
  const s = clean(raw).replace(/[级届年份入学报到]/g, '');
  const m = s.match(/\d+/);
  if (!m) throw new Error(`年级「${String(raw).trim()}」无法识别，应为 4 位入学年份（如 2024）`);
  let n = m[0];
  if (n.length === 2) n = `20${n}`; // 24 → 2024
  if (n.length !== 4 || !GRADE_RE.test(n)) {
    throw new Error(`年级「${String(raw).trim()}」不合法，应为 4 位入学年份（如 2024）`);
  }
  return n;
}

/**
 * 班级 / 序号 → 2 位
 *   1 / 01 / 1班 / 高一(1)班 / 5号 / 第5 → 01 / 05
 */
function normalizePart(raw, label, max = CLASS_MAX) {
  const s = clean(raw);
  const m = s.match(/\d+/);
  if (!m) throw new Error(`${label}「${String(raw).trim()}」无法识别，应为数字`);
  const n = parseInt(m[0], 10);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw new Error(`${label}「${String(raw).trim()}」超出范围（1~${max}）`);
  }
  return String(n).padStart(2, '0');
}

/**
 * 单列合并写法 → 三元组
 *   20240101 / 2024-01-01 / 2024 01 01 / 2024级1班1号
 */
function splitCombined(text) {
  const s = clean(text);
  if (!s) return null;
  if (/^\d{8}$/.test(s)) return [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  const nums = s.match(/\d+/g) || [];
  if (nums.length < 3) return null;
  return [nums[0], nums[1], nums[2]];
}

function buildUsername(grade, classNo, seatNo) {
  return `${grade}${classNo}${seatNo}`;
}

function gradeLabel(grade, classNo) {
  return `${grade} 级 ${String(classNo).replace(/^0/, '')} 班`;
}

/** 北京时间格式化（源实现用容器本地时间 = UTC，见文件头 ⑤） */
function formatTime(v) {
  const d = bj.shifted(new Date(v).getTime());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* ────────────────────────── 表头识别 ────────────────────────── */

function detectHeader(rows) {
  let best = null;
  const scan = Math.min(rows.length, 3);
  for (let i = 0; i < scan; i++) {
    const row = rows[i] || [];
    const map = {};
    let hits = 0;
    row.forEach((cell, ci) => {
      const s = clean(cell);
      if (!s || /^\d+$/.test(s)) return; // 纯数字单元格绝不可能是表头
      for (const field of Object.keys(HEADER_WORDS)) {
        if (map[field] !== undefined) continue;
        if (HEADER_WORDS[field].some((w) => s.includes(w))) {
          map[field] = ci;
          hits++;
          break;
        }
      }
    });
    if (hits >= 1 && (!best || hits > best.hits)) best = { rowIndex: i, map, hits };
  }
  return best;
}

/** 整行是否为空（全空 / 只有空白） */
function isBlankRow(row) {
  if (!row || !row.length) return true;
  return row.every((c) => clean(c) === '');
}

/* ────────────────────────── 解析（纯逻辑，不查库） ────────────────────────── */

function parseSheet(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new ApiError(Codes.PARAM_ERROR, '表格是空的，没有读到任何行');
  }

  const warnings = [];
  const header = detectHeader(rows);
  let mode = 'header';
  let headerRowIndex = -1;
  let columns = { grade: null, class: null, seat: null, name: null };

  if (header) {
    headerRowIndex = header.rowIndex;
    columns = { grade: null, class: null, seat: null, name: null, ...header.map };
  } else {
    mode = 'position';
    columns = { grade: 0, class: 1, seat: 2, name: 3 };
    warnings.push('未识别到表头，已按前 3 列的顺序当作「年级 / 班级 / 序号」解析');
  }
  if (columns.name === null || columns.name === undefined) {
    columns.name = null;
  }

  const start = headerRowIndex + 1;
  const dataRows = [];
  const seen = new Map(); // username -> 首次出现的行号

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    if (isBlankRow(row)) continue;

    const rowNo = i + 1; // 与用户在表格里看到的行号一致
    const item = {
      rowNo,
      raw: row.map((c) => clean(c)),
      grade: null,
      classNo: null,
      seatNo: null,
      username: null,
      name: '',
      valid: true,
      error: '',
      state: 'invalid',
    };

    try {
      let g = columns.grade !== null ? row[columns.grade] : '';
      let c = columns.class !== null ? row[columns.class] : '';
      let s = columns.seat !== null ? row[columns.seat] : '';

      // 单列合并写法兜底：三元组没凑齐时，拿第一个「能切出三段」的单元格再试一次。
      if ([g, c, s].filter((v) => clean(v) !== '').length < 3) {
        const candidates = [g, ...row.map((cell) => clean(cell))];
        for (const cand of candidates) {
          const parts = splitCombined(cand);
          if (parts) {
            [g, c, s] = parts;
            break;
          }
        }
      }

      item.grade = normalizeGrade(g);
      item.classNo = normalizePart(c, '班级');
      item.seatNo = normalizePart(s, '序号', SEAT_MAX);
      item.username = buildUsername(item.grade, item.classNo, item.seatNo);
      if (columns.name !== null && row[columns.name] !== undefined) {
        item.name = clean(row[columns.name]).slice(0, 64);
      }
    } catch (e) {
      item.valid = false;
      item.error = e.message;
    }

    // 本批次内重复：只留第一行，后面的判异常（避免「同一人两条账号」）
    if (item.valid && seen.has(item.username)) {
      item.valid = false;
      item.error = `本批次内账号 ${item.username} 重复（第 ${seen.get(item.username)} 行已出现）`;
    } else if (item.valid) {
      seen.set(item.username, rowNo);
    }

    dataRows.push(item);
  }

  if (!dataRows.length) {
    throw new ApiError(Codes.PARAM_ERROR, '没有读到任何数据行（表头下面全是空行？）');
  }
  if (dataRows.length > 0 && dataRows.every((r) => !r.valid)) {
    // 全部解析失败：把第一行的原因抛出去，比「一片红」更好定位
    const first = dataRows[0];
    if (mode === 'position') {
      throw new ApiError(
        Codes.PARAM_ERROR,
        `未识别到列：第一行数据解析失败（${first.error}）。请确认前 3 列是「年级 / 班级 / 序号」，或补一行表头`
      );
    }
  }

  return { mode, headerRowIndex, columns, dataRows, totalRows: dataRows.length, warnings };
}

/* ────────────────────────── 查库校验 ────────────────────────── */

async function fetchExistingMap(usernames) {
  const map = new Map();
  for (const part of chunk([...new Set(usernames)], IN_CHUNK)) {
    const found = await findAllPaged(C.USER, { username: _.in(part) });
    found.forEach((u) => {
      map.set(u.username, {
        id: u.id,
        username: u.username,
        status: Number(u.status),
        activated: !!u.pwdChangedAt,
        grade: u.grade,
        classNo: u.classNo,
        seatNo: u.seatNo,
        name: u.remark || '',
      });
    });
  }
  return map;
}

/**
 * 解析 + 查库校验（preview 与 commit 共用同一条链路）
 * @param {string[][]} rows
 * @param {{force?:boolean}} opts force=true 时「已激活」的账号也允许被覆盖更新
 */
async function analyze(rows, opts = {}) {
  const force = !!opts.force;
  const parsed = parseSheet(rows);
  const validUsernames = parsed.dataRows.filter((r) => r.valid).map((r) => r.username);
  const existing = await fetchExistingMap(validUsernames);

  const summary = { new: 0, update: 0, active: 0, invalid: 0 };

  for (const r of parsed.dataRows) {
    if (!r.valid) {
      r.state = 'invalid';
      summary.invalid++;
      continue;
    }
    const hit = existing.get(r.username);
    if (!hit) {
      r.state = 'new';
      summary.new++;
      continue;
    }
    r.existingId = hit.id;
    r.existingStatus = hit.status;
    if (hit.activated) {
      // 真人在用（改过密码）：默认跳过保护，不把学生正在用的密码打回初始密码
      r.state = force ? 'update' : 'active';
      r.protectedPwd = true;
      if (force) summary.update++;
      else summary.active++;
    } else {
      r.state = 'update';
      summary.update++;
    }
  }

  const errors = parsed.dataRows
    .filter((r) => r.state === 'invalid')
    .map((r) => ({ rowNo: r.rowNo, message: r.error, raw: r.raw }));

  return {
    mode: parsed.mode,
    headerRowIndex: parsed.headerRowIndex,
    columns: parsed.columns,
    totalRows: parsed.totalRows,
    warnings: parsed.warnings,
    summary,
    errors,
    rows: parsed.dataRows,
  };
}

/** 只读预览：一行都不写库 */
async function preview(rows, opts = {}) {
  const a = await analyze(rows, opts);
  return {
    mode: a.mode,
    headerRowIndex: a.headerRowIndex,
    columns: a.columns,
    totalRows: a.totalRows,
    warnings: a.warnings,
    summary: a.summary,
    errors: a.errors,
    rows: a.rows.map((r) => ({
      rowNo: r.rowNo,
      grade: r.grade,
      classNo: r.classNo,
      seatNo: r.seatNo,
      username: r.username,
      name: r.name,
      state: r.state,
      error: r.error,
      raw: r.raw,
    })),
  };
}

/* ────────────────────────── 落库 ────────────────────────── */

/**
 * 确认导入（服务端重新解析 + 重新校验，不信任前端回传的结论）
 *
 * ⚠️ 初始密码只 hash 一次整批复用 —— bcrypt 每行 60~100ms，逐行 hash 2000 人就是分钟级超时。
 *    （源注释原话；这里沿用：`hashInitPasswordFor` 内部已带 cost 8 的取舍。）
 * ⚠️ 「已激活」的账号即使 force 也不覆盖 password，只更新三元组 / 备注。
 * ⚠️ 源用 `bulkCreate + ignoreDuplicates`；云端等价物是
 *    **`reserveUnique('user_name', ...)` 抢唯一键**（抢不到=已存在=跳过）。
 */
async function commit(rows, opts = {}) {
  const { filename = '', operator = '', operatorId = null, force = false, strict = false } = opts;
  const a = await analyze(rows, { force });

  if (strict && a.summary.invalid > 0) {
    throw new ApiError(
      Codes.PARAM_ERROR,
      `有 ${a.summary.invalid} 行异常，严格模式下已拒绝整批导入。请先修正后再试`
    );
  }

  const toCreate = a.rows.filter((r) => r.state === 'new');
  const toUpdate = a.rows.filter((r) => r.state === 'update');
  const initHashOf = (r) => accountService.hashInitPasswordFor(r.username);

  const now = new Date();
  const batchId = await nextId(C.IMPORT_BATCH);
  /**
   * ⚠️⚠️ **必须接住 `insertOne` 返回的 `_id`**：云文档的 `_id` 是自动生成的字符串
   * （`auto_N`），而 `batchId` 是**数字业务主键**（等价 MySQL AUTO_INCREMENT）。
   * `updateById` 走的是 `doc(_id)`，拿数字 id 去更新会抛 `document does not exist`
   * → 批次统计永远回填不上（且只在「导入成功」路径炸，测试不覆盖就发现不了）。
   * 全项目约定：`insertOne` 之后要改这一行，一律用返回的 `_id`；
   * 只有「业务键当 _id」的 4 张表才用 `insertWithId` 后按业务键更新。
   */
  const batchDocId = await insertOne(C.IMPORT_BATCH, {
    id: batchId,
    filename: String(filename).slice(0, 255),
    total: a.totalRows,
    created: 0,
    updated: 0,
    skipped: a.summary.active,
    invalid: a.summary.invalid,
    operatorId,
    operator: String(operator).slice(0, 64),
    createTime: now,
    updateTime: now,
  });

  // 1) 新建
  let created = 0;
  for (const part of chunk(toCreate, IN_CHUNK)) {
    for (const r of part) {
      const id = await nextId(C.USER);
      const got = await reserveUnique('user_name', r.username, id);
      if (!got) continue; // 并发下已被别人抢先建号 → 跳过（等价 INSERT IGNORE）
      await insertOne(C.USER, {
        id,
        openid: null,
        username: r.username,
        password: await initHashOf(r),
        grade: r.grade,
        classNo: r.classNo,
        seatNo: r.seatNo,
        remark: r.name || null,
        nickname: r.name || null,
        status: 1,
        pwdChangedAt: null,
        loginCount: 0,
        importBatchId: batchId,
        createTime: now,
        updateTime: now,
      });
      created += 1;
    }
  }

  // 2) 覆盖更新（未激活的既有账号；force 时也含已激活账号，但不碰密码）
  let updated = 0;
  for (const r of toUpdate) {
    const patch = {
      grade: r.grade,
      classNo: r.classNo,
      seatNo: r.seatNo,
      importBatchId: batchId,
      status: 1,
      updateTime: new Date(),
    };
    if (r.name) {
      patch.remark = r.name;
      patch.nickname = r.name;
    }
    // 未激活账号：密码重设为「user + 新学号」的初始值保持一致
    if (!r.protectedPwd) patch.password = await initHashOf(r);
    updated += await updateWhere(C.USER, { username: r.username }, patch);
  }

  await updateById(C.IMPORT_BATCH, batchDocId, { created, updated, updateTime: new Date() });

  // 缓存里可能存着旧状态（例如刚被 force 覆盖的账号），清一遍
  toUpdate.forEach((r) => accountService.invalidate(r.username));

  // 落库后再数一次，作为「本批真实生效数」的权威值
  const total = await count(C.USER, { importBatchId: batchId });

  return {
    batchId,
    created,
    updated,
    skipped: a.summary.active,
    invalid: a.summary.invalid,
    total,
    totalRows: a.totalRows,
    warnings: a.warnings,
    errors: a.errors,
    preview: {
      mode: a.mode,
      summary: a.summary,
      rows: a.rows.map((r) => ({
        rowNo: r.rowNo,
        username: r.username,
        grade: r.grade,
        classNo: r.classNo,
        seatNo: r.seatNo,
        name: r.name,
        state: r.state,
        error: r.error,
      })),
    },
  };
}

/* ────────────────────────── 列表 / 统计 / 导出 ────────────────────────── */

/**
 * 列表条件。返回**云端可下推**的 where（关键字走 JS 过滤，见文件头 ③）。
 * 原实现把 keyword 也塞进 where（Op.like）；云端拆出来单独处理。
 */
function buildListWhere(q = {}) {
  const where = { username: HAS_USERNAME };
  if (q.grade) where.grade = String(q.grade);
  if (q.classNo) where.classNo = String(q.classNo);
  if (q.batchId) where.importBatchId = Number(q.batchId);
  if (q.status === 0 || q.status === '0') where.status = 0;
  if (q.status === 1 || q.status === '1') where.status = 1;
  if (q.activated === 1 || q.activated === '1') where.pwdChangedAt = _.exists(true).and(_.neq(null));
  if (q.activated === 0 || q.activated === '0') where.pwdChangedAt = null;
  return where;
}

/** 关键字过滤（对齐 MySQL LIKE '%kw%'：子串 + 大小写不敏感） */
function keywordHit(u, keyword) {
  if (!keyword) return true;
  const kw = String(keyword).toLowerCase();
  return String(u.username || '').toLowerCase().indexOf(kw) >= 0
    || String(u.remark || '').toLowerCase().indexOf(kw) >= 0;
}

function toDto(u) {
  return {
    id: u.id,
    username: u.username,
    grade: u.grade,
    classNo: u.classNo,
    seatNo: u.seatNo,
    name: u.remark || '',
    className: u.grade ? gradeLabel(u.grade, u.classNo) : '',
    status: Number(u.status),
    activated: !!u.pwdChangedAt,
    pwdChangedAt: u.pwdChangedAt === undefined ? null : u.pwdChangedAt,
    lastLoginAt: u.lastLoginAt === undefined ? null : u.lastLoginAt,
    loginCount: Number(u.loginCount || 0),
    importBatchId: u.importBatchId === undefined ? null : u.importBatchId,
    createTime: u.createTime,
  };
}

/**
 * 「有投稿记录」的用户名集合（= `username IN (SELECT openid FROM submit)`）。
 * ⚠️ 原实现用 SQL 子查询；云端改成「拉一遍 submit 的 openid 去重」。
 *    调用方在一次请求内复用同一个集合，避免重复扫描。
 */
async function fetchSubmitOpenids() {
  const rows = await findAllPaged(C.SUBMIT, {});
  const set = new Set();
  rows.forEach((r) => { if (r.openid) set.add(r.openid); });
  return set;
}

async function listStudents(q = {}) {
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 20, 1), 200);
  const where = buildListWhere(q);
  const kw = q.keyword ? String(q.keyword) : '';

  let scoped = null;
  let total = await count(C.USER, where);
  let pageRows;

  if (kw) {
    // 有关键字 → 只能全量拉 + JS 过滤（没有 LIKE），顺带把这份数据给摘要复用
    scoped = (await findAllPaged(C.USER, where)).filter((u) => keywordHit(u, kw));
    total = scoped.length;
    pageRows = scoped.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  } else {
    // 无关键字 → 排序与分页都能下推给数据库，不必全量拉
    pageRows = await findMany(C.USER, where, {
      orderBy: [['grade', 'asc'], ['classNo', 'asc'], ['seatNo', 'asc']],
      skip: (page - 1) * pageSize,
      limit: pageSize,
    });
  }

  // 摘要数字：与列表**同一个 where** 的全量聚合（不是当页），口径与 analyzeGrade 一致
  // （有投稿记录 = username 出现在 submit.openid）。聚合失败不挡列表。
  // ⚠️ 云端没有 GROUP BY / 子查询 → 这里必然要扫一遍 user（见文件头 ②）。
  let summary = null;
  try {
    const all = scoped || await findAllPaged(C.USER, where);
    const used = await fetchSubmitOpenids();
    summary = {
      total: all.length,
      activated: all.filter((u) => !!u.pwdChangedAt).length,
      disabled: all.filter((u) => Number(u.status) === 0).length,
      withSubmit: all.filter((u) => used.has(u.username)).length,
    };
  } catch (e) {
    summary = null;
  }

  return { list: pageRows.map(toDto), total, page, pageSize, summary };
}

/** grade → classNo → seatNo 的升序（都是零填充字符串，字典序 == 数值序） */
function cmpSeat(a, b) {
  const ka = `${a.grade || ''}|${a.classNo || ''}|${a.seatNo || ''}`;
  const kb = `${b.grade || ''}|${b.classNo || ''}|${b.seatNo || ''}`;
  if (ka === kb) return 0;
  return ka < kb ? -1 : 1;
}

/** 按年级 + 班级汇总：总数 / 已激活 / 未激活 */
async function statsByClass() {
  const rows = await findAllPaged(C.USER, { username: HAS_USERNAME });

  const map = new Map();
  rows.forEach((u) => {
    const k = `${u.grade || ''}\u0001${u.classNo || ''}`;
    if (!map.has(k)) map.set(k, { grade: u.grade, classNo: u.classNo, total: 0, activated: 0 });
    const c = map.get(k);
    c.total += 1;
    if (u.pwdChangedAt) c.activated += 1;
  });

  const classes = [...map.values()]
    .sort((a, b) => cmpSeat(a, b))
    .map((c) => ({
      grade: c.grade,
      classNo: c.classNo,
      className: gradeLabel(c.grade, c.classNo),
      total: c.total,
      activated: c.activated,
      inactive: c.total - c.activated,
    }));

  const overall = classes.reduce(
    (acc, c) => ({
      total: acc.total + c.total,
      activated: acc.activated + c.activated,
      inactive: acc.inactive + c.inactive,
    }),
    { total: 0, activated: 0, inactive: 0 }
  );

  return { classes, overall };
}

/* ────────────────────────── 按年级查询 / 整届清理 ────────────────────────── */

/** 年级展示名：2024 → 2024 级 */
function gradeName(grade) {
  return `${grade} 级`;
}

/** 年级汇总列表（只查 user 一张表，不做跨表 join，避免 ONLY_FULL_GROUP_BY 之类的方言坑） */
async function listGrades() {
  const rows = await findAllPaged(C.USER, { username: HAS_USERNAME });

  const map = new Map();
  rows.forEach((u) => {
    const g = u.grade;
    if (g === undefined || g === null || g === '') return;
    if (!map.has(g)) map.set(g, { grade: g, total: 0, activated: 0, disabled: 0, classes: new Set(), lastImportAt: null });
    const a = map.get(g);
    a.total += 1;
    if (u.pwdChangedAt) a.activated += 1;
    if (Number(u.status) === 0) a.disabled += 1;
    if (u.classNo !== undefined && u.classNo !== null) a.classes.add(u.classNo);
    const t = u.createTime ? new Date(u.createTime).getTime() : null;
    if (t !== null && (a.lastImportAt === null || t > a.lastImportAt)) a.lastImportAt = t;
  });

  const list = [...map.values()]
    .sort((a, b) => (String(a.grade) < String(b.grade) ? -1 : String(a.grade) > String(b.grade) ? 1 : 0))
    .map((a) => ({
      grade: a.grade,
      name: gradeName(a.grade),
      classCount: a.classes.size,
      total: a.total,
      activated: a.activated,
      inactive: a.total - a.activated,
      disabled: a.disabled,
      lastImportAt: a.lastImportAt === null ? null : new Date(a.lastImportAt),
    }));

  const overall = list.reduce(
    (acc, g) => ({
      gradeCount: acc.gradeCount + 1,
      total: acc.total + g.total,
      activated: acc.activated + g.activated,
      disabled: acc.disabled + g.disabled,
    }),
    { gradeCount: 0, total: 0, activated: 0, disabled: 0 }
  );

  return { list, overall };
}

/**
 * 取一个年级的全部账号 + 这些账号里「已经发过投稿」的集合
 * @returns {{grade:string, users:object[], usedSet:Set<string>}}
 */
async function collectGrade(gradeRaw) {
  const grade = normalizeGrade(gradeRaw);
  const users = await findAllPaged(C.USER, { grade, username: HAS_USERNAME });
  users.sort(cmpSeat);
  if (!users.length) throw new ApiError(Codes.NOT_FOUND, `${gradeName(grade)}下没有任何学生账号`);

  const usedSet = new Set();
  for (const part of chunk(users.map((u) => u.username), IN_CHUNK)) {
    const rows = await findAllPaged(C.SUBMIT, { openid: _.in(part) });
    rows.forEach((r) => { if (r.openid) usedSet.add(r.openid); });
  }

  return { grade, users, usedSet };
}

/**
 * 整届清理 · 试算（只读，一行都不改）
 *
 * 判定与单个删除保持一致：有投稿记录的账号**不硬删**，改为停用
 */
async function analyzeGrade(gradeRaw) {
  const { grade, users, usedSet } = await collectGrade(gradeRaw);

  const classMap = new Map();
  users.forEach((u) => {
    const k = u.classNo || '';
    if (!classMap.has(k)) classMap.set(k, { classNo: k, className: gradeLabel(grade, k), total: 0, activated: 0, withSubmit: 0 });
    const c = classMap.get(k);
    c.total++;
    if (u.pwdChangedAt) c.activated++;
    if (usedSet.has(u.username)) c.withSubmit++;
  });

  const withSubmit = users.filter((u) => usedSet.has(u.username)).length;

  return {
    grade,
    name: gradeName(grade),
    total: users.length,
    classCount: classMap.size,
    activated: users.filter((u) => u.pwdChangedAt).length,
    disabled: users.filter((u) => Number(u.status) === 0).length,
    withSubmit,
    canDelete: users.length - withSubmit,
    classes: [...classMap.values()],
    // 给前端弹窗看的样例（最多 20 个，避免一次塞几千条）
    samples: users.slice(0, 20).map((u) => toDto(u)),
  };
}

/**
 * 该届里「会被改为停用」的账号清单（有投稿记录的）+ 其余届未受影响的账号数
 * —— v8「清理完成」回执要用
 */
async function gradeCleanupPreview(gradeRaw) {
  const { grade, users, usedSet } = await collectGrade(gradeRaw);
  const willDisable = users
    .filter((u) => usedSet.has(u.username))
    .map((u) => ({ username: u.username, name: u.remark || '', className: gradeLabel(grade, u.classNo) }));

  // `[:where]` 等价物：username IS NOT NULL AND (grade IS NULL OR grade <> :grade)
  const untouched = await count(C.USER, _.and([
    { username: HAS_USERNAME },
    _.or([{ grade: null }, { grade: _.neq(grade) }]),
  ]));

  return { grade, gradeName: gradeName(grade), total: users.length, willDisable, untouched };
}

/**
 * 整届清理 · 执行（管理员一键删除该年级所有账号）
 *
 * @param {string} gradeRaw 年级（2024 / 2024级 / 24 都能识别）
 * @param {{mode?:'safe'|'disable'|'purge', confirm?:string}} opts
 */
async function removeGrade(gradeRaw, opts = {}) {
  const mode = ['disable', 'purge'].includes(opts.mode) ? opts.mode : 'safe';
  const { grade, users, usedSet } = await collectGrade(gradeRaw);

  if (mode === 'purge' && clean(opts.confirm) !== grade) {
    throw new ApiError(
      Codes.PARAM_ERROR,
      `危险操作：要把投稿记录里的账号一并删掉，请在确认框里原样输入年级「${grade}」`
    );
  }

  const ids = users.map((u) => u.id);

  // 1) 只停用
  if (mode === 'disable') {
    let n = 0;
    for (const part of chunk(ids, IN_CHUNK)) {
      n += await updateWhere(C.USER, { id: _.in(part) }, { status: 0 });
    }
    users.forEach((u) => accountService.invalidate(u.username));
    return {
      grade,
      name: gradeName(grade),
      mode,
      total: users.length,
      deleted: 0,
      disabled: n || users.length,
    };
  }

  // 2) 纯清除 / 安全清除
  let deleteUsers;
  let disableUsers;
  if (mode === 'purge') {
    deleteUsers = users;
    disableUsers = [];
  } else {
    deleteUsers = users.filter((u) => !usedSet.has(u.username));
    disableUsers = users.filter((u) => usedSet.has(u.username));
  }

  // ⚠️ 云端没有跨文档事务（见文件头 ①）→ 顺序执行；每步按 100 一批
  let deleted = 0;
  for (const part of chunk(deleteUsers, IN_CHUNK)) {
    deleted += await removeWhere(C.USER, { id: _.in(part.map((u) => u.id)) });
    // 删主记录必须同步释放唯一键，否则孤儿键会挡住后续同名导入
    for (const u of part) await releaseUnique('user_name', u.username);
  }

  let disabled = 0;
  for (const part of chunk(disableUsers.map((u) => u.id), IN_CHUNK)) {
    disabled += await updateWhere(C.USER, { id: _.in(part) }, { status: 0 });
  }

  // 3) 被删 / 被停用的账号，缓存里的旧状态必须立刻作废
  users.forEach((u) => accountService.invalidate(u.username));

  return {
    grade,
    name: gradeName(grade),
    mode,
    total: users.length,
    deleted,
    disabled,
  };
}

/**
 * 导出用的数据结构（列定义 + 行）
 * ⚠️ 初始密码列只在「仍是初始密码」时有值；已改密的行留空（bcrypt 不可逆）
 */
async function exportData(q = {}) {
  const where = buildListWhere(q);
  let rows = await findAllPaged(C.USER, where);
  if (q.keyword) rows = rows.filter((u) => keywordHit(u, q.keyword));
  rows.sort(cmpSeat);

  const columns = [
    { header: '年级', width: 8 },
    { header: '班级', width: 8 },
    { header: '序号', width: 8 },
    { header: '姓名', width: 12 },
    { header: '账号', width: 14 },
    { header: '初始密码', width: 14 },
    { header: '状态', width: 8 },
    { header: '是否已激活', width: 12 },
    { header: '最近登录时间', width: 20 },
  ];

  const data = rows.map((u) => [
    u.grade,
    u.classNo,
    u.seatNo,
    u.remark || '',
    u.username,
    u.pwdChangedAt ? '' : accountService.initPasswordFor(u.username),
    Number(u.status) === 1 ? '启用' : '停用',
    u.pwdChangedAt ? '已激活' : '未激活',
    u.lastLoginAt ? formatTime(u.lastLoginAt) : '',
  ]);

  return { columns, rows: data, total: rows.length };
}

/* ────────────────────────── 单个账号维护 ────────────────────────── */

async function updateStudent(id, payload = {}) {
  const uid = Number(id);
  const user = Number.isInteger(uid) ? await findOne(C.USER, { id: uid }) : null;
  if (!user || !user.username) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');

  const oldUsername = user.username;
  const grade = payload.grade !== undefined ? normalizeGrade(payload.grade) : user.grade;
  const classNo = payload.classNo !== undefined ? normalizePart(payload.classNo, '班级') : user.classNo;
  const seatNo = payload.seatNo !== undefined ? normalizePart(payload.seatNo, '序号', SEAT_MAX) : user.seatNo;
  const newUsername = buildUsername(grade, classNo, seatNo);

  if (newUsername !== oldUsername) {
    const dup = await findOne(C.USER, { username: newUsername });
    if (dup) throw new ApiError(Codes.CONFLICT, `账号 ${newUsername} 已存在，无法改到该班级 / 序号`);
  }

  const patch = { grade, classNo, seatNo, updateTime: new Date() };

  // 姓名。对外字段名是 name，库里对应 remark + nickname 两列 —— 三个 key 都接受
  const nameInput = payload.name !== undefined
    ? payload.name
    : (payload.remark !== undefined ? payload.remark : payload.nickname);
  if (nameInput !== undefined) {
    const name = String(nameInput == null ? '' : nameInput).trim();
    if (!name) throw new ApiError(Codes.PARAM_ERROR, '姓名不能为空');
    if (name.length > 64) throw new ApiError(Codes.PARAM_ERROR, '姓名最长 64 个字符');
    // ⚠️ 必须两列一起写：管理端列表读 remark，投稿审核 / 留言审核 / 小程序「我的」读 nickname
    patch.remark = name;
    patch.nickname = name;
  }

  if (payload.status !== undefined) patch.status = Number(payload.status) === 0 ? 0 : 1;

  await updateById(C.USER, user._id, patch);

  // 改了三元组 = 账号变了：他的投稿 / 留言 / 已确认记录必须跟着迁
  if (newUsername !== oldUsername) {
    await updateById(C.USER, user._id, { username: newUsername });
    // 唯一键跟着搬：先占新键（抢不到说明已被占，前面已查过重，这里只做兜底），再放旧键
    const got = await reserveUnique('user_name', newUsername, user.id);
    if (!got) throw new ApiError(Codes.CONFLICT, `账号 ${newUsername} 已存在，无法改到该班级 / 序号`);
    await releaseUnique('user_name', oldUsername);

    await updateWhere(C.SUBMIT, { openid: oldUsername }, { openid: newUsername });
    await updateWhere(C.MESSAGE, { openid: oldUsername }, { openid: newUsername });
    await updateWhere(C.NOTICE_ACK, { openid: oldUsername }, { openid: newUsername });
  }

  accountService.invalidate(oldUsername);
  accountService.invalidate(newUsername);

  const fresh = await findOne(C.USER, { id: uid });
  return { ...toDto(fresh), renamed: newUsername !== oldUsername, oldUsername };
}

async function setStatus(id, status) {
  const uid = Number(id);
  const user = Number.isInteger(uid) ? await findOne(C.USER, { id: uid }) : null;
  if (!user || !user.username) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');
  const next = Number(status) === 0 ? 0 : 1;
  await updateById(C.USER, user._id, { status: next, updateTime: new Date() });
  await accountService.invalidate(user.username);
  return toDto({ ...user, status: next });
}

/**
 * 重置密码为初始密码（单个 / 批量）
 * 重置后 pwdChangedAt 归零 → 学生那边的旧 token 会因为「密码版本不匹配」被踢下线
 * @param {{ids?:number[], grade?:string, classNo?:string}} scope
 */
async function resetPasswords(scope = {}) {
  const ids = Array.isArray(scope.ids) ? scope.ids.map(Number).filter(Boolean) : [];
  let where;
  if (ids.length) {
    where = { id: _.in(ids), username: HAS_USERNAME };
  } else if (scope.grade || scope.classNo) {
    where = { username: HAS_USERNAME };
    if (scope.grade) where.grade = String(scope.grade);
    if (scope.classNo) where.classNo = String(scope.classNo);
  } else {
    // 不给范围就不给重置，避免手滑把全校密码全重置
    throw new ApiError(Codes.PARAM_ERROR, '请指定要重置的账号（勾选列表或指定年级 / 班级）');
  }

  const targets = await findAllPaged(C.USER, where);
  if (!targets.length) throw new ApiError(Codes.NOT_FOUND, '没有匹配到要重置的账号');

  // 每个账号的初始密码都不同（user + 学号），逐行哈希
  let affected = 0;
  for (const u of targets) {
    const hash = await accountService.hashInitPasswordFor(u.username);
    affected += await updateWhere(C.USER, { id: u.id }, { password: hash, pwdChangedAt: null, updateTime: new Date() });
    accountService.invalidate(u.username);
  }

  return { affected: affected || targets.length, usernames: targets.map((u) => u.username) };
}

/**
 * 批量改状态（启用 / 停用）
 *
 * 走一条 UPDATE ... WHERE id IN (...)，再统一作废登录态。
 */
async function setStatusBatch(ids, status) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!list.length) throw new ApiError(Codes.PARAM_ERROR, '请先勾选要操作的账号');
  if (list.length > 500) throw new ApiError(Codes.PARAM_ERROR, '一次最多操作 500 个账号');

  const next = Number(status) === 0 ? 0 : 1;
  const rows = [];
  for (const part of chunk(list, IN_CHUNK)) {
    const found = await findAllPaged(C.USER, { id: _.in(part), username: HAS_USERNAME });
    rows.push(...found);
  }
  if (!rows.length) throw new ApiError(Codes.NOT_FOUND, '没有匹配到学生账号');

  for (const part of chunk(rows.map((r) => r.id), IN_CHUNK)) {
    await updateWhere(C.USER, { id: _.in(part) }, { status: next });
  }
  // 登录态作废：改停用后学生手里的 token 下一次请求就被踢，不用等 30 秒缓存
  await Promise.all(rows.map((r) => accountService.invalidate(r.username)));

  return { affected: rows.length, status: next, usernames: rows.map((r) => r.username) };
}

async function removeStudent(id) {
  const uid = Number(id);
  const user = Number.isInteger(uid) ? await findOne(C.USER, { id: uid }) : null;
  if (!user || !user.username) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');

  // 有投稿记录的不硬删：他只会在「我的投稿」里凭空少一条，且后台审核记录会指向不存在的账号
  const used = await count(C.SUBMIT, { openid: user.username });
  if (used > 0) {
    await updateById(C.USER, user._id, { status: 0, updateTime: new Date() });
    await accountService.invalidate(user.username);
    return { deleted: false, disabled: true, submitCount: used, message: `该账号有 ${used} 条投稿记录，已改为停用（不删除）` };
  }

  await removeWhere(C.USER, { id: uid });
  await releaseUnique('user_name', user.username);
  await accountService.invalidate(user.username);
  return { deleted: true, disabled: false, submitCount: 0 };
}

/* ────────────────────────── 批次 ────────────────────────── */

async function listBatches(limit = 20) {
  const n = Math.min(Number(limit) || 20, 100);
  // ⚠️ 单次 get 上限 100 条；n 已被限制在 100 以内，直接 findMany 即可
  const rows = await findMany(C.IMPORT_BATCH, {}, { orderBy: [['id', 'desc']], limit: n });
  return rows.map((b) => ({
    id: b.id,
    filename: b.filename,
    total: b.total,
    created: b.created,
    updated: b.updated,
    skipped: b.skipped,
    invalid: b.invalid,
    operator: b.operator,
    createTime: b.createTime,
  }));
}

/**
 * 撤销一个批次：只删本批次里「仍未激活」且「没有投稿记录」的账号
 * （已激活的账号学生可能正在用，动了就是事故）
 */
async function rollbackBatch(id) {
  const bid = Number(id);
  const batch = Number.isInteger(bid) ? await findOne(C.IMPORT_BATCH, { id: bid }) : null;
  if (!batch) throw new ApiError(Codes.NOT_FOUND, '批次不存在');

  const candidates = await findAllPaged(C.USER, { importBatchId: bid, username: HAS_USERNAME, pwdChangedAt: null });
  const activated = await count(C.USER, {
    importBatchId: bid,
    username: HAS_USERNAME,
    pwdChangedAt: _.exists(true).and(_.neq(null)),
  });

  let removable = candidates;
  if (candidates.length) {
    const usedSet = new Set();
    for (const part of chunk(candidates.map((u) => u.username), IN_CHUNK)) {
      const rows = await findAllPaged(C.SUBMIT, { openid: _.in(part) });
      rows.forEach((r) => { if (r.openid) usedSet.add(r.openid); });
    }
    removable = candidates.filter((u) => !usedSet.has(u.username));
  }

  if (removable.length) {
    for (const part of chunk(removable, IN_CHUNK)) {
      await removeWhere(C.USER, { id: _.in(part.map((u) => u.id)) });
      for (const u of part) await releaseUnique('user_name', u.username);
    }
    removable.forEach((u) => accountService.invalidate(u.username));
  }

  return {
    batchId: bid,
    removed: removable.length,
    keptActivated: activated,
    keptWithSubmit: candidates.length - removable.length,
  };
}

module.exports = {
  initPasswordFor: accountService.initPasswordFor,
  // 归一化（导出给验证脚本 / 测试直接断言）
  toHalfWidth,
  clean,
  normalizeGrade,
  normalizePart,
  splitCombined,
  buildUsername,
  gradeLabel,
  formatTime,
  detectHeader,
  parseSheet,
  analyze,
  preview,
  commit,
  listStudents,
  statsByClass,
  listGrades,
  analyzeGrade,
  gradeCleanupPreview,
  removeGrade,
  exportData,
  updateStudent,
  setStatus,
  setStatusBatch,
  resetPasswords,
  removeStudent,
  listBatches,
  rollbackBatch,
  fetchSubmitOpenids,
  HAS_USERNAME,
};
