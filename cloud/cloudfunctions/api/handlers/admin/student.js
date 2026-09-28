'use strict';

/**
 * 管理端 · 学生账号（导入分发 / 列表 / 导出 / 重置）—— 全部仅超管
 * 迁移自 src/controllers/admin/studentController.js
 *
 * 路由层全部挂 `adminAuth + requireSuperAdmin` → 每个方法第一行 `asSuper(ctx)`。
 *
 * ═══════════════ ⚠️ 二进制文件的传输契约（与原 HTTP 版**有意不同**） ═══════════════
 * 原实现是 HTTP：`multipart(file)` 上传、`res.send(buffer)` 下载。
 * 云函数 `callFunction` 只走 JSON，没有 multipart，也没有二进制响应体。所以：
 *
 *   上传（import/preview）：body 传 `{ filename, fileBase64 }`
 *                          （前端 FileReader.readAsDataURL / arrayBuffer→base64）
 *   下载（template / export）：返回 `{ filename, base64, mime }`
 *                          （前端 atob → Blob → 触发下载）
 *
 * ⚠️ 大小上限：云函数单次请求/响应体约 **1MB**。xlsx 转 base64 后 +33%，
 *    所以「几千行的名册」够用，超大表需要改走云存储（见 stage7 方案「未定事项」）。
 *    超限时云函数会直接报 `-504002`，前端只会看到笼统的失败 —— 这是已知边界，已文档化。
 *
 * ⚠️ 时间显示：`stamp()` / 导出里的「导出时间」原用**容器本地时间**（= UTC），
 *    云端统一改成北京时间（`lib/bjTime`）。属缺陷修正，已在方案里标注。
 */

const { C, findMany, insertOne, nextId, parseId } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const bj = require('../../lib/bjTime');
const roster = require('../../services/roster');
const importer = require('../../services/sheet');
const accountService = require('../../services/studentAccount');
const { asSuper } = require('./_kit');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 北京时间 YYYYMMDD（源用容器本地时间 = UTC，见文件头） */
function stamp() {
  return bj.ymd(bj.shifted(Date.now())).replace(/-/g, '');
}

/** 北京时间显示串（导出说明页用） */
function nowText() {
  return roster.formatTime(Date.now());
}

/** xlsx 的统一响应壳（前端 atob → Blob → 下载） */
function xlsxPayload(buffer, filename) {
  return {
    filename,
    mime: XLSX_MIME,
    base64: Buffer.from(buffer).toString('base64'),
  };
}

/** 校验前端回传的 rows（二维数组） */
function assertRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new ApiError(Codes.PARAM_ERROR, '缺少 rows（应为白名单二维数组）');
  }
  if (rows.length > importer.MAX_ROWS) {
    throw new ApiError(Codes.PARAM_ERROR, `行数超过上限 ${importer.MAX_ROWS}`);
  }
  rows.forEach((r, i) => {
    if (!Array.isArray(r)) throw new ApiError(Codes.PARAM_ERROR, `rows[${i}] 不是数组`);
  });
  return rows;
}

/* ────────────────── 导入 ────────────────── */

/**
 * 上传并预览（不写库）
 * body: { filename, fileBase64 }    query: { force: '1' }
 */
async function importPreview(ctx) {
  asSuper(ctx);
  const body = ctx.body || {};
  const filename = String(body.filename || '');
  if (!body.fileBase64) {
    throw new ApiError(Codes.PARAM_ERROR, '缺少文件内容（fileBase64）');
  }

  let buffer;
  try {
    buffer = Buffer.from(String(body.fileBase64).replace(/^data:[^,]*,/, ''), 'base64');
  } catch (e) {
    throw new ApiError(Codes.PARAM_ERROR, '文件内容不是合法的 base64');
  }
  if (!buffer.length) throw new ApiError(Codes.PARAM_ERROR, '文件内容为空');

  const force = String((ctx.query || {}).force) === '1';
  try {
    const { rows, sheetName } = await importer.readSheet(buffer, filename);
    const result = await roster.preview(rows, { force });
    return {
      filename,
      sheetName,
      ...result,
      // 把原始行一并回给前端：确认导入时原样回传，服务端会重新解析校验（不信任前端结论）
      rawRows: rows,
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.warn('[student] importPreview 失败:', e && e.message);
    throw new ApiError(Codes.PARAM_ERROR, `表格解析失败：${e.message}`);
  }
}

/** 确认导入   body: { rows, filename, force?, strict? } */
async function importCommit(ctx) {
  const me = asSuper(ctx);
  const { rows, filename = '', force = false, strict = false } = ctx.body || {};
  assertRows(rows);

  const result = await roster.commit(rows, {
    filename,
    force: !!force,
    strict: !!strict,
    operator: (me && me.username) || '',
    operatorId: (me && me.id) || null,
  });

  console.log(
    `[student] 导入批次 ${result.batchId}：新建 ${result.created} 更新 ${result.updated} ` +
      `跳过 ${result.skipped} 异常 ${result.invalid}（操作人 ${me && me.username}）`
  );
  return result;
}

/** 下载导入模板（说明页写清规则，避免用户来回问格式） */
async function template(ctx) {
  asSuper(ctx);
  const buffer = await importer.buildWorkbook([
    {
      name: '学生名册',
      columns: [
        { header: '年级', width: 10 },
        { header: '班级', width: 10 },
        { header: '序号', width: 10 },
        { header: '姓名', width: 14 },
      ],
      rows: [
        ['2024', '01', '01', '张三'],
        ['2024', '01', '02', '李四'],
        ['2024', '02', '01', '王五'],
      ],
    },
    {
      name: '填写说明',
      columns: [{ header: '说明', width: 96 }],
      rows: [
        ['1. 列名认「年级 / 班级 / 序号」，第 4 列「姓名」可留空，多余的空列会被忽略。'],
        ['2. 年级填 4 位入学年份：2024 或 2024级（写 24 也能识别，自动补成 2024）。'],
        ['3. 班级、序号填 1~99，写 1 会当成 01；写成 1班、5号、第5 也能识别。'],
        ['4. 没有表头时按前 3 列顺序当作「年级 / 班级 / 序号」解析。'],
        ['5. 也支持把三段拼成一列写，例如 20240101 或 2024级1班1号。'],
        ['6. 账号 = 年级 + 班级 + 序号，例如 2024 + 01 + 01 = 20240101；初始密码为 user+学号（如 user20240101）。'],
        ['7. 同一行重复、缺序号、超范围的行会在预览里标红并给出原因，不会写进系统。'],
      ],
    },
  ]);
  return xlsxPayload(buffer, `学生账号导入模板_${stamp()}.xlsx`);
}

/* ────────────────── 列表 / 统计 ────────────────── */

async function list(ctx) {
  asSuper(ctx);
  return roster.listStudents(ctx.query || {});
}

async function stats(ctx) {
  asSuper(ctx);
  return roster.statsByClass();
}

/* ────────────────── 导出 ────────────────── */

async function exportXlsx(ctx) {
  const me = asSuper(ctx);
  const q = ctx.query || {};
  const { columns, rows, total } = await roster.exportData(q);
  if (!total) throw new ApiError(Codes.NOT_FOUND, '没有符合条件的账号可导出');

  const parts = [];
  if (q.grade) parts.push(`${q.grade}级`);
  if (q.classNo) parts.push(`${String(q.classNo).replace(/^0/, '')}班`);
  if (String(q.activated) === '0') parts.push('未激活');

  const buffer = await importer.buildWorkbook([
    { name: '学生账号', columns, rows },
    {
      name: '说明',
      columns: [{ header: '说明', width: 96 }],
      rows: [
        ['本表含登录初始密码，请只在站内分发，不要外发。'],
        ['「初始密码」列留空表示该学生已经改过密码（哈希不可逆，无法导出原密码）。'],
        ['学生忘记密码时，在管理后台「学生账号」里重置为初始密码（user+学号，如 user20240101）即可。'],
        ['导出时间：' + nowText()],
      ],
    },
  ]);

  console.log(`[student] 导出 ${total} 条账号（操作人 ${me && me.username}）`);
  return xlsxPayload(buffer, `学生账号${parts.length ? '_' + parts.join('') : ''}_${stamp()}.xlsx`);
}

/* ────────────────── 单个账号维护 ────────────────── */

async function update(ctx) {
  asSuper(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');
  return roster.updateStudent(id, ctx.body || {});
}

async function setStatus(ctx) {
  asSuper(ctx);
  const { status } = ctx.body || {};
  if (status === undefined) throw new ApiError(Codes.PARAM_ERROR, '缺少 status（1=启用 0=停用）');
  const id = parseId(ctx.params.id);
  if (id === null) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');
  return roster.setStatus(id, status);
}

/** POST /student/status/batch   body { ids:number[], status:0|1 } */
async function setStatusBatch(ctx) {
  const me = asSuper(ctx);
  const { ids, status } = ctx.body || {};
  if (status === undefined) throw new ApiError(Codes.PARAM_ERROR, '缺少 status（1=启用 0=停用）');
  const data = await roster.setStatusBatch(ids, status);
  const off = Number(status) === 0;
  console.log(`[student] 批量${off ? '停用' : '启用'} ${data.affected} 个（操作人 ${me && me.username}）`);
  return { affected: data.affected };
}

async function resetPassword(ctx) {
  const me = asSuper(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');
  const data = await roster.resetPasswords({ ids: [id] });
  console.log(`[student] 重置密码 ${data.usernames.join(',')}（操作人 ${me && me.username}）`);
  return { ...data, initPassword: accountService.initPasswordFor(data.usernames[0]) };
}

async function resetPasswordBatch(ctx) {
  const me = asSuper(ctx);
  const { ids, grade, classNo } = ctx.body || {};
  const data = await roster.resetPasswords({ ids, grade, classNo });
  console.log(`[student] 批量重置密码 ${data.affected} 个（操作人 ${me && me.username}）`);
  return { affected: data.affected, initPasswordRule: 'user + 学号' };
}

async function remove(ctx) {
  asSuper(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) throw new ApiError(Codes.NOT_FOUND, '学生账号不存在');
  return roster.removeStudent(id);
}

/**
 * 批量删除（仅超管 · 不可逆批量属于超管边界）
 * 逐条走与单条删除完全相同的规则：没有投稿记录的真删；有投稿记录的改为「停用」。
 */
async function removeBatch(ctx) {
  const me = asSuper(ctx);
  const raw = Array.isArray((ctx.body || {}).ids) ? ctx.body.ids : [];
  const ids = [...new Set(raw.filter((v) => v !== undefined && v !== null && v !== ''))];
  if (!ids.length) throw new ApiError(Codes.PARAM_ERROR, '请先勾选要删除的账号');
  if (ids.length > 200) throw new ApiError(Codes.PARAM_ERROR, '一次最多删除 200 个账号');

  let deleted = 0;
  let disabled = 0;
  const failed = [];
  for (const id of ids) {
    try {
      const r = await roster.removeStudent(Number(id));
      if (r.deleted) deleted += 1;
      else disabled += 1;
    } catch (e) {
      failed.push({ id, message: (e && e.message) || '处理失败' });
    }
  }
  console.log(
    `[student] 批量删除 ${ids.length} 个（真删 ${deleted} / 转停用 ${disabled} / 失败 ${failed.length}，操作人 ${me && me.username}）`
  );
  return { total: ids.length, deleted, disabled, failed };
}

/* ────────────────── 按年级（查询 / 整届清理） ────────────────── */

async function grades(ctx) {
  asSuper(ctx);
  return roster.listGrades();
}

async function gradeDetail(ctx) {
  asSuper(ctx);
  return roster.analyzeGrade(ctx.params.grade);
}

/** 整届清理   body: { mode?: 'safe'|'disable'|'purge', confirm?: string } */
async function removeGrade(ctx) {
  const me = asSuper(ctx);
  const { mode, confirm } = ctx.body || {};
  const gradeParam = ctx.params.grade;

  // 执行前先取「会被停用的账号清单 + 其余届未受影响数」，用于写清理回执（v8「清理完成」屏）
  let preview = null;
  try { preview = await roster.gradeCleanupPreview(gradeParam); } catch (e) { preview = null; }

  const startedAt = Date.now();
  const data = await roster.removeGrade(gradeParam, { mode, confirm });
  const costMs = Date.now() - startedAt;

  // ── 写清理回执（v8：清理完成屏要回答「删了几个 / 留了几个 / 怎么找回」）──
  const disabledAccounts = preview ? preview.willDisable : [];
  const now = new Date();
  let receipt = null;
  try {
    const logId = await nextId(C.CLEANUP_LOG);
    const doc = {
      id: logId,
      grade: data.grade,
      gradeName: data.name,
      mode: data.mode,
      total: data.total,
      deleted: data.deleted,
      disabled: data.disabled,
      classCount: preview ? new Set((preview.willDisable || []).map((x) => x.className)).size : 0,
      untouched: preview ? preview.untouched : 0,
      costMs,
      operatorId: (me && me.id) || null,
      operatorName: (me && (me.nickname || me.username)) || '',
      disabledAccounts: JSON.stringify(disabledAccounts),
      createTime: now,
      updateTime: now,
    };
    await insertOne(C.CLEANUP_LOG, doc);
    receipt = doc;
  } catch (e) {
    console.warn(`[student] 清理回执落库失败：${e.message}`);
  }

  console.log(
    `[student] 整届清理 ${data.grade}（${data.mode}）：删除 ${data.deleted} 停用 ${data.disabled}` +
      `，共 ${data.total} 个（操作人 ${me && me.username}，耗时 ${costMs}ms）`
  );

  const receiptDto = receipt
    ? { ...receipt, disabledAccounts, costText: `${(costMs / 1000).toFixed(1)}s` }
    : null;

  return { ...data, costMs, receipt: receiptDto };
}

/**
 * 最近一次清理回执（按年级）
 * GET /admin/student/cleanup/last?grade=2024
 * 不传 grade 就取全局最近一次 —— 「清理完成」屏刷新后靠它还原整屏内容
 */
async function cleanupLast(ctx) {
  asSuper(ctx);
  const q = ctx.query || {};
  const where = {};
  if (q.grade) where.grade = String(q.grade).trim();

  const rows = await findMany(C.CLEANUP_LOG, where, { orderBy: [['createTime', 'desc']], limit: 1 });
  const dto = rows[0];
  if (!dto) return null;

  let disabledAccounts = [];
  try { disabledAccounts = JSON.parse(dto.disabledAccounts || '[]'); } catch (e) { disabledAccounts = []; }
  return {
    ...dto,
    disabledAccounts,
    costText: `${((Number(dto.costMs) || 0) / 1000).toFixed(1)}s`,
  };
}

/* ────────────────── 批次 ────────────────── */

async function batches(ctx) {
  asSuper(ctx);
  const list = await roster.listBatches((ctx.query || {}).limit);
  return { list };
}

async function rollback(ctx) {
  const me = asSuper(ctx);
  const id = parseId(ctx.params.id);
  if (id === null) throw new ApiError(Codes.NOT_FOUND, '批次不存在');
  const data = await roster.rollbackBatch(id);
  const msg =
    `已撤销 ${data.removed} 个未激活账号` +
    (data.keptActivated ? `；保留 ${data.keptActivated} 个已激活账号` : '') +
    (data.keptWithSubmit ? `；${data.keptWithSubmit} 个有投稿记录已保留` : '');
  console.log(`[student] 撤销批次 ${data.batchId}：${msg}（操作人 ${me && me.username}）`);
  return data;
}

module.exports = {
  importPreview,
  importCommit,
  template,
  list,
  stats,
  exportXlsx,
  update,
  setStatus,
  setStatusBatch,
  resetPassword,
  resetPasswordBatch,
  remove,
  removeBatch,
  grades,
  gradeDetail,
  removeGrade,
  cleanupLast,
  batches,
  rollback,
};
