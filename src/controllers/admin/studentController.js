'use strict';

/**
 * 管理端 · 学生账号（导入分发 / 列表 / 导出 / 重置）
 *   全部接口都需要超管（路由层用 requireSuperAdmin 拦）
 *
 * 对外契约（前端拿这个写页面）：
 *   POST /api/admin/student/import/preview   multipart(file)         → 只解析不落库
 *   POST /api/admin/student/import/commit    json{rows,filename,...} → 重新校验后落库
 *   GET  /api/admin/student/template                                 → 模板 xlsx
 *   GET  /api/admin/student/list                                     → 账号列表
 *   GET  /api/admin/student/stats                                    → 按班级激活进度
 *   GET  /api/admin/student/grades                                   → 按年级汇总（年级卡片）
 *   GET  /api/admin/student/grade/:grade                             → 该年级明细 + 清理试算（只读）
 *   DELETE /api/admin/student/grade/:grade                           → 整届清理（一键删除该年级账号）
 *   GET  /api/admin/student/export                                   → 导出 xlsx
 *   PUT  /api/admin/student/:id                                      → 改备注 / 三元组 / 状态
 *   PUT  /api/admin/student/:id/status                               → 启用 / 停用
 *   PUT  /api/admin/student/:id/reset-password                       → 重置为初始密码
 *   POST /api/admin/student/reset-password/batch                     → 批量重置
 *   DELETE /api/admin/student/:id                                    → 删除（有投稿则改停用）
 *   GET  /api/admin/student/batches                                  → 批次列表
 *   POST /api/admin/student/batch/:id/rollback                       → 撤销批次
 */

const roster = require('../../services/studentRosterService');
const importer = require('../../services/studentImportService');
const accountService = require('../../services/studentAccountService');
const { CleanupLog } = require('../../models');
const { readSheet, buildWorkbook } = importer;
const { success, ApiError, Codes } = require('../../utils/response');
const logger = require('../../utils/logger');

/* ────────────────── 内部工具 ────────────────── */

/** 下载 xlsx（中文文件名走 RFC 5987，避免各家浏览器乱码） */
function sendXlsx(res, buffer, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="student-account.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(buffer);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
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
 * form-data: file=<xlsx|csv>&force=0|1
 */
exports.importPreview = async (req, res, next) => {
  try {
    const { rows, sheetName } = await readSheet(req.file.buffer, req.file.originalname);
    const result = await roster.preview(rows, { force: String(req.query.force) === '1' });
    return success(res, {
      filename: req.file.originalname,
      sheetName,
      ...result,
      // 把原始行一并回给前端：确认导入时原样回传，服务端会重新解析校验（不信任前端结论）
      rawRows: rows,
    }, '解析完成，尚未写入');
  } catch (e) {
    if (e instanceof ApiError) return next(e);
    logger.error('[student] importPreview 失败:', e.message);
    return next(new ApiError(Codes.PARAM_ERROR, `表格解析失败：${e.message}`));
  }
};

/**
 * 确认导入
 * body: { rows: [[...]], filename, force?, strict? }
 */
exports.importCommit = async (req, res, next) => {
  try {
    const { rows, filename = '', force = false, strict = false } = req.body || {};
    assertRows(rows);

    const result = await roster.commit(rows, {
      filename,
      force: !!force,
      strict: !!strict,
      operator: req.admin?.username || '',
      operatorId: req.admin?.id || null,
    });

    logger.info(
      `[student] 导入批次 ${result.batchId}：新建 ${result.created} 更新 ${result.updated} ` +
        `跳过 ${result.skipped} 异常 ${result.invalid}（操作人 ${req.admin?.username}）`
    );
    return success(res, result, '导入完成');
  } catch (e) {
    return next(e);
  }
};

/**
 * 下载导入模板
 * 说明页写清规则，避免用户来回问格式
 */
exports.template = async (req, res, next) => {
  try {
    const buffer = await buildWorkbook([
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
    return sendXlsx(res, buffer, `学生账号导入模板_${stamp()}.xlsx`);
  } catch (e) {
    return next(e);
  }
};

/* ────────────────── 列表 / 统计 ────────────────── */

exports.list = async (req, res, next) => {
  try {
    const result = await roster.listStudents(req.query || {});
    return success(res, result);
  } catch (e) {
    return next(e);
  }
};

exports.stats = async (req, res, next) => {
  try {
    const data = await roster.statsByClass();
    return success(res, data);
  } catch (e) {
    return next(e);
  }
};

/* ────────────────── 导出 ────────────────── */

exports.exportXlsx = async (req, res, next) => {
  try {
    const { columns, rows, total } = await roster.exportData(req.query || {});
    if (!total) throw new ApiError(Codes.NOT_FOUND, '没有符合条件的账号可导出');

    const parts = [];
    if (req.query.grade) parts.push(`${req.query.grade}级`);
    if (req.query.classNo) parts.push(`${String(req.query.classNo).replace(/^0/, '')}班`);
    if (String(req.query.activated) === '0') parts.push('未激活');

    const buffer = await buildWorkbook([
      { name: '学生账号', columns, rows },
      {
        name: '说明',
        columns: [{ header: '说明', width: 96 }],
        rows: [
          ['本表含登录初始密码，请只在站内分发，不要外发。'],
          ['「初始密码」列留空表示该学生已经改过密码（哈希不可逆，无法导出原密码）。'],
          ['学生忘记密码时，在管理后台「学生账号」里重置为初始密码（user+学号，如 user20240101）即可。'],
          ['导出时间：' + new Date().toLocaleString('zh-CN')],
        ],
      },
    ]);

    logger.info(`[student] 导出 ${total} 条账号（操作人 ${req.admin?.username}）`);
    return sendXlsx(res, buffer, `学生账号${parts.length ? '_' + parts.join('') : ''}_${stamp()}.xlsx`);
  } catch (e) {
    return next(e);
  }
};

/* ────────────────── 单个账号维护 ────────────────── */

exports.update = async (req, res, next) => {
  try {
    const data = await roster.updateStudent(req.params.id, req.body || {});
    return success(res, data, data.renamed ? `已改为新账号 ${data.username}` : '已保存');
  } catch (e) {
    return next(e);
  }
};

exports.setStatus = async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (status === undefined) throw new ApiError(Codes.PARAM_ERROR, '缺少 status（1=启用 0=停用）');
    const data = await roster.setStatus(req.params.id, status);
    return success(res, data, Number(status) === 0 ? '已停用' : '已启用');
  } catch (e) {
    return next(e);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const data = await roster.resetPasswords({ ids: [Number(req.params.id)] });
    logger.info(`[student] 重置密码 ${data.usernames.join(',')}（操作人 ${req.admin?.username}）`);
    return success(res, { ...data, initPassword: accountService.initPasswordFor(data.usernames[0]) }, '已重置为初始密码');
  } catch (e) {
    return next(e);
  }
};

exports.resetPasswordBatch = async (req, res, next) => {
  try {
    const { ids, grade, classNo } = req.body || {};
    const data = await roster.resetPasswords({ ids, grade, classNo });
    logger.info(
      `[student] 批量重置密码 ${data.affected} 个（操作人 ${req.admin?.username}）`
    );
    return success(
      res,
      { affected: data.affected, initPasswordRule: 'user + 学号' },
      `已重置 ${data.affected} 个账号为初始密码（各自的 user + 学号）`
    );
  } catch (e) {
    return next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const data = await roster.removeStudent(req.params.id);
    return success(res, data, data.deleted ? '已删除' : data.message);
  } catch (e) {
    return next(e);
  }
};

/**
 * 批量删除（仅超管 · 不可逆批量属于超管边界）
 * 逐条走与单条删除完全相同的规则：没有投稿记录的真删；有投稿记录的改为「停用」。
 * 逐条独立处理，单条失败不影响其它条，最后汇总数量与失败明细。
 */
exports.removeBatch = async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.filter((v) => v !== undefined && v !== null && v !== ''))];
    if (!ids.length) throw new ApiError(Codes.PARAM_ERROR, '请先勾选要删除的账号');
    if (ids.length > 200) throw new ApiError(Codes.PARAM_ERROR, '一次最多删除 200 个账号');

    let deleted = 0;
    let disabled = 0;
    const failed = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      try {
        const r = await roster.removeStudent(id);
        if (r.deleted) deleted += 1;
        else disabled += 1;
      } catch (e) {
        failed.push({ id, message: e?.message || '处理失败' });
      }
    }
    logger.info(
      `[student] 批量删除 ${ids.length} 个（真删 ${deleted} / 转停用 ${disabled} / 失败 ${failed.length}，操作人 ${req.admin?.username}）`
    );
    return success(
      res,
      { total: ids.length, deleted, disabled, failed },
      `已处理 ${deleted + disabled} 个：删除 ${deleted} 个、转为停用 ${disabled} 个`
        + (failed.length ? `，${failed.length} 个失败` : '')
    );
  } catch (e) {
    return next(e);
  }
};

/* ────────────────── 按年级（查询 / 整届清理） ────────────────── */

/**
 * 年级汇总：给「按年级分类查询」的年级卡片用
 * 每个年级带 账号总数 / 已激活 / 未激活 / 停用 / 班级数
 */
exports.grades = async (req, res, next) => {
  try {
    const data = await roster.listGrades();
    return success(res, data);
  } catch (e) {
    return next(e);
  }
};

/**
 * 单个年级的明细 + 清理试算（只读，不改任何数据）
 * 管理员点「毕业清理」时先用它弹出确认框：将删除 N 个、将停用 M 个
 */
exports.gradeDetail = async (req, res, next) => {
  try {
    const data = await roster.analyzeGrade(req.params.grade);
    return success(res, data);
  } catch (e) {
    return next(e);
  }
};

/**
 * 整届清理 —— 一键删除该年级所有账号
 * body: { mode?: 'safe' | 'disable' | 'purge', confirm?: string }
 *   safe（默认）：无投稿记录硬删，有投稿记录改停用（与单个删除同规则）
 *   disable      ：只停用，一个不删
 *   purge        ：全删（危险，confirm 必须原样等于年级）
 */
exports.removeGrade = async (req, res, next) => {
  try {
    const { mode, confirm } = req.body || {};
    // 执行前先取「会被停用的账号清单 + 其余届未受影响数」，用于写清理回执（v8「清理完成」屏）
    let preview = null;
    try { preview = await roster.gradeCleanupPreview(req.params.grade); } catch (e) { preview = null; }

    const startedAt = Date.now();
    const data = await roster.removeGrade(req.params.grade, { mode, confirm });
    const costMs = Date.now() - startedAt;

    const msg =
      data.mode === 'disable'
        ? `已停用 ${data.name} 的 ${data.disabled} 个账号`
        : `已清除 ${data.name} 的 ${data.deleted} 个账号` +
          (data.disabled ? `；另有 ${data.disabled} 个有投稿记录已改为停用` : '');

    // ── 写清理回执（v8：清理完成屏要回答「删了几个 / 留了几个 / 怎么找回」）──
    const disabledAccounts = (data.mode === 'purge' || data.mode === 'disable')
      ? (preview ? preview.willDisable : [])
      : (preview ? preview.willDisable : []);   // safe 模式下列出的正是「改为停用」的那批
    let receipt = null;
    try {
      receipt = await CleanupLog.create({
        grade: data.grade,
        gradeName: data.name,
        mode: data.mode,
        total: data.total,
        deleted: data.deleted,
        disabled: data.disabled,
        classCount: preview ? new Set((preview.willDisable || []).map((x) => x.className)).size : 0,
        untouched: preview ? preview.untouched : 0,
        costMs,
        operatorId: req.admin?.id || null,
        operatorName: req.admin?.nickname || req.admin?.username || '',
        disabledAccounts: JSON.stringify(disabledAccounts),
      });
    } catch (e) {
      logger.warn(`[student] 清理回执落库失败：${e.message}`);
    }

    logger.warn(
      `[student] 整届清理 ${data.grade}（${data.mode}）：删除 ${data.deleted} 停用 ${data.disabled}` +
        `，共 ${data.total} 个（操作人 ${req.admin?.username}，耗时 ${costMs}ms）`
    );

    const receiptDto = receipt
      ? {
          ...receipt.toJSON(),
          disabledAccounts,
          costText: `${(costMs / 1000).toFixed(1)}s`,
        }
      : null;

    return success(res, { ...data, costMs, receipt: receiptDto }, msg);
  } catch (e) {
    return next(e);
  }
};

/**
 * 最近一次清理回执（按年级）
 * GET /api/admin/student/cleanup/last?grade=2024
 * 不传 grade 就取全局最近一次 —— 「清理完成」屏刷新后靠它还原整屏内容
 */
exports.cleanupLast = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.grade) where.grade = String(req.query.grade).trim();
    const row = await CleanupLog.findOne({ where, order: [['create_time', 'DESC']] });
    if (!row) return success(res, null);
    const dto = row.toJSON();
    let disabledAccounts = [];
    try { disabledAccounts = JSON.parse(dto.disabledAccounts || '[]'); } catch (e) { disabledAccounts = []; }
    return success(res, {
      ...dto,
      disabledAccounts,
      costText: `${((Number(dto.costMs) || 0) / 1000).toFixed(1)}s`,
    });
  } catch (e) {
    return next(e);
  }
};

/* ────────────────── 批次 ────────────────── */

exports.batches = async (req, res, next) => {
  try {
    const list = await roster.listBatches(req.query.limit);
    return success(res, { list });
  } catch (e) {
    return next(e);
  }
};

exports.rollback = async (req, res, next) => {
  try {
    const data = await roster.rollbackBatch(Number(req.params.id));
    const msg =
      `已撤销 ${data.removed} 个未激活账号` +
      (data.keptActivated ? `；保留 ${data.keptActivated} 个已激活账号` : '') +
      (data.keptWithSubmit ? `；${data.keptWithSubmit} 个有投稿记录已保留` : '');
    logger.info(`[student] 撤销批次 ${data.batchId}：${msg}（操作人 ${req.admin?.username}）`);
    return success(res, data, msg);
  } catch (e) {
    return next(e);
  }
};
