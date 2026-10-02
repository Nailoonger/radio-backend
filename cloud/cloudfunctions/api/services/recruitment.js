'use strict';

const { ApiError, Codes } = require('../lib/response');
const R = require('./recruitmentCodes');
const S = require('./recruitmentStore');
const F = require('./recruitmentForm');
const Code = require('./recruitmentCode');
const crypto = require('crypto');
const bj = require('../lib/bjTime');
const { C, _ } = S;
const FORM_FIELDS = ['name', 'qqNumber', 'grade', 'className', 'answers'];
const BATCH_FIELDS = ['title', 'intro', 'opensAt', 'closesAt', 'questions', 'fixedFields'];

function fail(code, message) { throw new ApiError(code, message); }
function state(message) { fail(R.INVALID_STATE, message); }
function iso(n) { return n === null || n === undefined ? null : new Date(n).toISOString(); }
// 面试安排：批次级「统一安排」与个人「单独配置」同构。
function arrangement(row) { return row ? { at: iso(row.at), location: row.location, note: row.note } : null; }
function fixedOf(row) { return (row && row.fixedFields) || F.DEFAULT_FIXED_FIELDS; }
function manuallyClosed(row) { return row.closedAt !== null && row.closedAt !== undefined; }
function windowState(batch, now = Date.now()) {
  if (batch.publishedAt === null) return 'draft';
  if (manuallyClosed(batch)) return 'closed';
  if (now < batch.opensAt) return 'upcoming';
  return now < batch.closesAt ? 'open' : 'closed';
}
function batchDTO(row, admin = false) {
  const out = {
    id: row._id, title: row.title, intro: row.intro, opensAt: iso(row.opensAt), closesAt: iso(row.closesAt),
    publishedAt: iso(row.publishedAt), closedAt: iso(row.closedAt), resultPublishedAt: iso(row.resultPublishedAt), archivedAt: iso(row.archivedAt),
    questions: row.questions, fixedFields: fixedOf(row), interview: arrangement(row.interview),
    version: row.version, windowState: windowState(row),
  };
  if (admin) Object.assign(out, { unresolvedCount: row.unresolvedCount, orderGeneratedAt: iso(row.orderGeneratedAt),
    interviewOrderCount: Array.isArray(row.interviewOrderIds) ? row.interviewOrderIds.length : 0,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  return out;
}
// 是否有生效的面试安排：个人「单独配置」优先，否则跟随批次「统一安排」。
function arranged(row, batch) { return !!(row.interview || (batch && batch.interview)); }
// 面试改成批次级统一安排后，「待面试」由「有没有生效安排」派生，不再依赖逐条写 progress：
// 批次有统一安排、或本人有单独配置、或本行本就处于待面试，三者之一即为待面试。
function status(row, batch) {
  if (row.progress === 'withdrawn') return 'withdrawn';
  if (row.decision) return row.decision;
  if (row.progress === 'interview' || arranged(row, batch)) return 'interview';
  return 'submitted';
}
function applicationDTO(row, batch, admin = false) {
  const published = batch.resultPublishedAt !== null && row.progress !== 'withdrawn';
  // 公开侧绝不泄露未发布的录取决定；但「已安排面试」对本人可见。
  const publicProgress = row.progress === 'submitted' && arranged(row, batch) ? 'interview' : row.progress;
  const out = {
    id: row._id, batchId: row.batchId, batch: batchDTO(batch, admin),
    name: row.name, qqNumber: row.qqNumber || '', grade: row.grade, className: row.className,
    answers: row.answers, progress: admin ? status(row, batch) : (published ? row.decision : publicProgress),
    // 生效的面试安排 = 个人单独配置优先，否则跟随批次统一安排。
    interview: arrangement(row.interview || batch.interview),
    canEdit: windowState(batch) === 'open', version: row.version,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  };
  if (admin) Object.assign(out, { decision: row.decision, internalNote: row.internalNote, publicNote: row.publicNote, status: status(row, batch),
    interviewCustom: !!row.interview,
    legacyStudentNo: row.studentNo || '',
    interviewSequence: Array.isArray(batch.interviewOrderIds) && batch.interviewOrderIds.includes(row._id) ? batch.interviewOrderIds.indexOf(row._id) + 1 : null });
  else if (published) Object.assign(out, { decision: row.decision, publicNote: row.publicNote });
  return out;
}
function expectVersion(row, value) {
  F.version(value);
  if (row.version !== value) fail(R.VERSION_CONFLICT, '数据已更新，请刷新后重试');
}
function assertOpen(row) {
  if (windowState(row) !== 'open' || row.archivedAt !== null || row.resultPublishedAt !== null) {
    fail(R.WINDOW_CLOSED, '当前不在报名时间内');
  }
}
function assertReview(row) {
  if (row.publishedAt === null) state('招新批次尚未发布');
  if (windowState(row) !== 'closed') fail(R.WINDOW_CLOSED, '报名截止后才可审核和安排面试');
  if (row.resultPublishedAt !== null || row.archivedAt !== null) state('录取结果已发布，无法修改');
}
async function requireBatch(db, id) {
  const row = await db.get(C.BATCH, F.id(id, '批次标识'));
  if (!row) fail(Codes.NOT_FOUND, '招新批次不存在');
  return row;
}
function touch(batch, patch = {}) {
  const next = { ...batch, ...patch, version: batch.version + 1, updatedAt: Date.now() };
  if (!Number.isSafeInteger(next.unresolvedCount) || next.unresolvedCount < 0) state('报名统计异常，请联系广播站');
  return next;
}
const uniqueId = (batchId, qqNumber) => `qq:${Code.digest(JSON.stringify([batchId, qqNumber]))}`;
const submitId = (keyHash) => `submit:${keyHash}`;
async function credentials(db, queryCode) {
  const codeHash = Code.digest(Code.normalize(queryCode));
  const reservation = await db.get(C.CODE, codeHash);
  const row = reservation ? await db.get(C.APPLICATION, reservation.applicationId) : null;
  if (!row || row.codeHash !== codeHash) fail(R.INVALID_CODE, '查询码无效');
  const batch = await db.get(C.BATCH, row.batchId);
  if (!batch || batch.publishedAt === null) fail(R.INVALID_CODE, '查询码无效');
  return { row, batch };
}
function pager(query) {
  const parse = (v, fallback) => v === undefined ? fallback : Number(v);
  const page = parse(query.page, 1); const pageSize = parse(query.pageSize, 20);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    fail(Codes.PARAM_ERROR, '分页参数无效，单页最多 100 条');
  }
  return { page, pageSize, skip: (page - 1) * pageSize };
}

async function current() {
  const now = Date.now();
  // Old documents lack closedAt. Avoid a null equality query which would exclude
  // them; filter closed windows in pages, including when the newest was closed early.
  for (let skip = 0; ; skip += 100) {
    const rows = await S.list(C.BATCH, { publishedAt: _.neq(null), archivedAt: null, opensAt: _.lte(now), closesAt: _.gt(now) }, { skip, limit: 100, orderBy: [['publishedAt', 'desc']] });
    const open = rows.find((row) => windowState(row, now) === 'open');
    if (open) return { batch: batchDTO(open) };
    if (rows.length < 100) break;
  }
  const latest = await S.list(C.BATCH, { publishedAt: _.neq(null), archivedAt: null }, { limit: 1, orderBy: [['publishedAt', 'desc']] });
  return { batch: latest.length ? batchDTO(latest[0]) : null };
}
async function apply(body) {
  // studentNo is accepted solely to recover a pre-upgrade, already committed
  // submission's lost response. It can never create a new registration.
  F.keys(body, ['batchId', 'submissionKey', ...FORM_FIELDS, 'studentNo']);
  const batchId = F.id(body.batchId, '批次标识');
  const keyHash = Code.submissionKey(body.submissionKey);
  // Both transaction retries and explicit credential collisions leave no partial records.
  for (let collision = 0; collision < 3; collision += 1) {
    try {
      return await S.transaction(async (tx) => {
        const retry = await tx.get(C.UNIQUE, submitId(keyHash));
        if (retry) {
          const row = await tx.get(C.APPLICATION, retry.applicationId);
          if (!row || row.batchId !== batchId || row.submissionKeyHash !== keyHash) fail(R.VERSION_CONFLICT, '提交凭证与报名内容不一致');
          const batch = await requireBatch(tx, row.batchId);
          const legacy = F.own(body, 'studentNo') && !F.own(body, 'qqNumber') && F.own(row, 'studentNo');
          F.keys(body, ['batchId', 'submissionKey', ...(legacy ? FORM_FIELDS.filter((k) => k !== 'qqNumber').concat('studentNo') : FORM_FIELDS)]);
          const fields = F.application(body, batch, legacy);
          if (row.payloadHash !== Code.payloadHash({ batchId, ...fields })) fail(R.VERSION_CONFLICT, '提交凭证与报名内容不一致');
          const originalCode = Code.decrypt(row.codeCipher, row._id);
          if (Code.digest(originalCode) !== row.codeHash) fail(Codes.SERVER_ERROR, '招新查询凭证暂不可用，请联系广播站');
          return { queryCode: originalCode, application: applicationDTO(row, batch) };
        }
        const batch = await requireBatch(tx, batchId);
        assertOpen(batch);
        F.keys(body, ['batchId', 'submissionKey', ...FORM_FIELDS]);
        const fields = F.application(body, batch);
        // QQ 号可为选填：为空时不占用唯一键，也就不再做同批次去重。
        const studentKey = fields.qqNumber ? uniqueId(batchId, fields.qqNumber) : null;
        if (studentKey && await tx.get(C.UNIQUE, studentKey)) fail(R.DUPLICATE_STUDENT, '该 QQ 号已报名，请使用原查询码查询');
        const queryCode = Code.generate(); const codeHash = Code.digest(queryCode);
        if (await tx.get(C.CODE, codeHash)) { const error = new Error('Recruitment credential collision'); error.recruitmentCollision = true; throw error; }
        const applicationId = Code.randomId(); const now = Date.now();
        const row = {
          _id: applicationId, batchId, ...fields, progress: 'submitted', decision: null,
          internalNote: '', publicNote: '', interview: null, codeHash,
          codeCipher: Code.encrypt(queryCode, applicationId), submissionKeyHash: keyHash,
          payloadHash: Code.payloadHash({ batchId, ...fields }), version: 1, createdAt: now, updatedAt: now,
        };
        const nextBatch = touch(batch, { unresolvedCount: batch.unresolvedCount + 1 });
        // 未填 QQ 号时不占用唯一键（也就没有同批次去重可言）。
        if (studentKey) await tx.set(C.UNIQUE, studentKey, { applicationId });
        await tx.set(C.UNIQUE, submitId(keyHash), { applicationId });
        await tx.set(C.CODE, codeHash, { applicationId });
        await tx.set(C.APPLICATION, applicationId, row);
        await tx.set(C.BATCH, batchId, nextBatch);
        return { queryCode, application: applicationDTO(row, nextBatch) };
      });
    } catch (e) { if (!e.recruitmentCollision) throw e; }
  }
  fail(Codes.SERVER_ERROR, '报名未完成，请稍后重试');
}
async function query(body) {
  F.keys(body, ['queryCode']);
  return S.transaction(async (tx) => {
    const { row, batch } = await credentials(tx, body.queryCode);
    return applicationDTO(row, batch);
  });
}
async function mutate(body, action) {
  F.keys(body, ['queryCode', 'version', ...(action === 'withdraw' ? [] : FORM_FIELDS)]);
  return S.transaction(async (tx) => {
    const { row, batch } = await credentials(tx, body.queryCode);
    expectVersion(row, body.version); assertOpen(batch);
    let patch; let countDelta = 0; let oldStudentKey; let newStudentKey;
    if (action === 'withdraw') {
      if (row.progress === 'withdrawn') return applicationDTO(row, batch);
      if (row.progress !== 'submitted' || row.decision !== null) state('当前报名无法撤回');
      patch = { progress: 'withdrawn' }; countDelta = -1;
    } else {
      if (action === 'resubmit' ? row.progress !== 'withdrawn' : row.progress !== 'submitted') state('当前报名无法执行此操作');
      const fields = F.application(body, batch);
      if (fields.qqNumber !== (row.qqNumber || '')) {
        // Legacy studentNo remains as historical data and keeps its old reservation.
        // It is never interpreted as a QQ number or silently migrated.
        oldStudentKey = row.qqNumber ? uniqueId(row.batchId, row.qqNumber) : null;
        newStudentKey = fields.qqNumber ? uniqueId(row.batchId, fields.qqNumber) : null;
        const owner = oldStudentKey ? await tx.get(C.UNIQUE, oldStudentKey) : null;
        const target = newStudentKey ? await tx.get(C.UNIQUE, newStudentKey) : null;
        if (oldStudentKey && (!owner || owner.applicationId !== row._id)) state('报名数据异常，请联系广播站');
        if (target && target.applicationId !== row._id) fail(R.DUPLICATE_STUDENT, '该 QQ 号已报名，请使用原查询码查询');
      }
      patch = fields;
      if (action === 'resubmit') { Object.assign(patch, { progress: 'submitted', decision: null, interview: null }); countDelta = 1; }
    }
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: Date.now() };
    const nextBatch = touch(batch, { unresolvedCount: batch.unresolvedCount + countDelta });
    if (newStudentKey !== oldStudentKey) {
      if (oldStudentKey) await tx.remove(C.UNIQUE, oldStudentKey);
      if (newStudentKey) await tx.set(C.UNIQUE, newStudentKey, { applicationId: row._id });
    }
    await tx.set(C.APPLICATION, row._id, next); await tx.set(C.BATCH, batch._id, nextBatch);
    return applicationDTO(next, nextBatch);
  });
}

async function batches(query) {
  F.keys(query, ['page', 'pageSize', 'archived']);
  const p = pager(query); const where = {};
  if (query.archived !== undefined) {
    if (![true, false, 'true', 'false', '1', '0', 1, 0].includes(query.archived)) fail(Codes.PARAM_ERROR, '归档筛选无效');
    const archived = [true, 'true', '1', 1].includes(query.archived);
    where.archivedAt = archived ? _.neq(null) : null;
  }
  const [items, total] = await Promise.all([S.list(C.BATCH, where, { ...p, limit: p.pageSize, orderBy: [['createdAt', 'desc']] }), S.count(C.BATCH, where)]);
  return { items: items.map((r) => batchDTO(r, true)), total, page: p.page, pageSize: p.pageSize };
}
async function createBatch(body) {
  F.keys(body, BATCH_FIELDS); const fields = F.batch(body); const id = Code.randomId(); const now = Date.now();
  const row = { _id: id, ...fields, publishedAt: null, closedAt: null, resultPublishedAt: null, archivedAt: null,
    interviewOrderIds: [], orderGeneratedAt: null, unresolvedCount: 0, version: 1, createdAt: now, updatedAt: now };
  await S.transaction(async (tx) => { await tx.set(C.BATCH, id, row); });
  return batchDTO(row, true);
}
async function batchDetail(id) { return batchDTO(await requireBatch(S, id), true); }
function reserveWindow(control, batch, now = Date.now()) {
  const windows = (control ? control.windows : []).filter((w) => w.batchId !== batch._id && w.closesAt > now);
  if (windows.some((w) => batch.opensAt < w.closesAt && batch.closesAt > w.opensAt)) state('报名时间与其他已发布批次重叠');
  if (batch.closesAt > now) windows.push({ batchId: batch._id, opensAt: batch.opensAt, closesAt: batch.closesAt });
  return { windows, updatedAt: now };
}
async function updateBatch(id, body) {
  F.keys(body, ['version', ...BATCH_FIELDS]);
  return S.transaction(async (tx) => {
    const row = await requireBatch(tx, id); expectVersion(row, body.version);
    if (row.archivedAt !== null) state('已归档批次无法修改');
    const supplied = BATCH_FIELDS.filter((k) => F.own(body, k));
    if (row.publishedAt !== null) {
      if (supplied.includes('questions') || supplied.includes('title')) state('发布后题目结构和批次名称已锁定');
      if ((manuallyClosed(row) || Date.now() >= row.opensAt) && supplied.some((k) => ['opensAt', 'closesAt'].includes(k))) state('报名开始或手动截止后时间已锁定');
    }
    const fields = F.batch({ ...row, ...body }, row.publishedAt !== null);
    const next = touch(row, fields);
    let control;
    if (row.publishedAt !== null && supplied.some((k) => ['opensAt', 'closesAt'].includes(k))) {
      control = reserveWindow(await tx.get(C.CONTROL, 'global'), next);
    }
    if (control) await tx.set(C.CONTROL, 'global', control);
    await tx.set(C.BATCH, row._id, next);
    return batchDTO(next, true);
  });
}
async function publishBatch(id, body) {
  F.keys(body, ['version']);
  return S.transaction(async (tx) => {
    const row = await requireBatch(tx, id); expectVersion(row, body.version);
    if (row.publishedAt !== null) state('招新批次已发布');
    const complete = F.batch(row, true);
    const next = touch(row, { ...complete, publishedAt: Date.now() });
    const control = reserveWindow(await tx.get(C.CONTROL, 'global'), next);
    await tx.set(C.CONTROL, 'global', control); await tx.set(C.BATCH, row._id, next);
    return batchDTO(next, true);
  });
}
async function closeBatch(id, body) {
  F.keys(body, ['version']);
  return S.transaction(async (tx) => {
    const row = await requireBatch(tx, id);
    if (row.publishedAt === null || row.archivedAt !== null) state('只能截止已发布且未归档的批次');
    if (manuallyClosed(row)) return batchDTO(row, true);
    expectVersion(row, body.version);
    const control = await tx.get(C.CONTROL, 'global');
    const next = touch(row, { closedAt: Date.now() });
    const windows = (control ? control.windows : []).filter((window) => window.batchId !== row._id);
    await tx.set(C.CONTROL, 'global', { windows, updatedAt: Date.now() });
    await tx.set(C.BATCH, row._id, next);
    return batchDTO(next, true);
  });
}
function savedOrder(batch) {
  const ids = batch.interviewOrderIds === undefined ? [] : batch.interviewOrderIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) state('面试顺序数据异常，请联系广播站');
  return ids;
}
function shuffle(ids) {
  const out = ids.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function assertOrderSize(batch, ids) {
  // JSON does not include BSON's array-index keys and per-string metadata.
  // Count those conservatively, then retain headroom below the 1 MiB document cap.
  const next = { ...batch, interviewOrderIds: ids, orderGeneratedAt: Date.now(), version: batch.version + 1 };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') + ids.length * 16 > 900 * 1024) {
    state('面试名单超过批次存储容量，未保存任何顺序，请联系广播站');
  }
}
async function generateInterviewOrder(id, body) {
  F.keys(body, ['version', 'confirm']);
  if (body.confirm !== undefined && body.confirm !== 'REGENERATE') fail(Codes.PARAM_ERROR, '覆盖确认无效');
  const row = await requireBatch(S, id); expectVersion(row, body.version); assertReview(row);
  if (row.orderGeneratedAt != null && body.confirm !== 'REGENERATE') state('请确认覆盖已有面试顺序');
  const candidates = [];
  // No findAllPaged default maximum: every candidate page is read to completion.
  // Keep only IDs so even long answers do not accumulate in function memory.
  for (let skip = 0; ; skip += 100) {
    const page = await S.list(C.APPLICATION, { batchId: row._id, progress: _.in(['submitted', 'interview']), decision: _.neq('rejected') },
      { skip, limit: 100, orderBy: [['_id', 'asc']] });
    page.forEach((application) => candidates.push(application._id));
    assertOrderSize(row, candidates);
    if (page.length < 100) break;
  }
  if (!candidates.length) state('没有可生成顺序的有效报名');
  const order = shuffle(candidates);
  return S.transaction(async (tx) => {
    const latest = await requireBatch(tx, id); expectVersion(latest, body.version); assertReview(latest);
    if (latest.orderGeneratedAt != null && body.confirm !== 'REGENERATE') state('请确认覆盖已有面试顺序');
    assertOrderSize(latest, order);
    const next = touch(latest, { interviewOrderIds: order, orderGeneratedAt: Date.now() });
    await tx.set(C.BATCH, latest._id, next);
    return batchDTO(next, true);
  });
}
function orderItem(row, batch, sequence) {
  return {
    id: row._id, name: row.name, qqNumber: row.qqNumber || '', grade: row.grade, className: row.className,
    // 名单里的面试信息同样按「个人单独配置优先，否则批次统一安排」取值。
    interview: arrangement(row.interview || batch.interview),
    interviewCustom: !!row.interview,
    status: status(row, batch), interviewSequence: sequence,
  };
}
async function orderRows(batch, ids, start = 0) {
  if (!ids.length) return [];
  const rows = await S.list(C.APPLICATION, { batchId: batch._id, _id: _.in(ids) }, { limit: ids.length });
  const byId = new Map(rows.map((row) => [row._id, row]));
  if (byId.size !== ids.length) state('面试名单存在缺失记录，请联系广播站');
  return ids.map((id, i) => orderItem(byId.get(id), batch, start + i + 1));
}
async function interviewOrder(id, query = {}) {
  F.keys(query, ['page', 'pageSize']);
  const batch = await requireBatch(S, id); const p = pager(query); const ids = savedOrder(batch);
  const items = await orderRows(batch, ids.slice(p.skip, p.skip + p.pageSize), p.skip);
  // A regenerated order or review during the read must not mix two versions.
  expectVersion(await requireBatch(S, id), batch.version);
  return { batch: batchDTO(batch, true), items, total: ids.length, page: p.page, pageSize: p.pageSize, orderGeneratedAt: iso(batch.orderGeneratedAt) };
}
function beijingTime(value) {
  if (!value) return '';
  const date = bj.shifted(new Date(value).getTime());
  return `${bj.ymd(date)} ${bj.pad2(date.getUTCHours())}:${bj.pad2(date.getUTCMinutes())}`;
}
async function exportInterviewOrder(id, query = {}) {
  F.keys(query, []);
  const batch = await requireBatch(S, id); const ids = savedOrder(batch);
  if (batch.orderGeneratedAt == null) state('请先生成面试顺序');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('面试名单');
  sheet.columns = [
    { header: '序号', key: 'sequence', width: 8 }, { header: '姓名', key: 'name', width: 18 },
    { header: 'QQ 号', key: 'qqNumber', width: 18, style: { numFmt: '@' } },
    { header: '年级', key: 'grade', width: 16 }, { header: '班级', key: 'className', width: 16 },
    { header: '面试时间（北京时间）', key: 'at', width: 25 }, { header: '面试地点', key: 'location', width: 28 },
    { header: '状态', key: 'status', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const labels = { submitted: '已提交', interview: '待面试',
    accepted: batch.resultPublishedAt == null ? '拟录取·未发布' : '已录取',
    rejected: batch.resultPublishedAt == null ? '拟不录取·未发布' : '未录取', withdrawn: '已撤回' };
  // Read the entire stored list, irrespective of the table's page and filters.
  for (let start = 0; start < ids.length; start += 100) {
    const items = await orderRows(batch, ids.slice(start, start + 100), start);
    items.forEach((item) => sheet.addRow({ sequence: item.interviewSequence, name: item.name, qqNumber: item.qqNumber,
      grade: item.grade, className: item.className, at: beijingTime(item.interview && item.interview.at),
      location: item.interview ? item.interview.location : '', status: labels[item.status] || item.status }));
  }
  expectVersion(await requireBatch(S, id), batch.version);
  const buffer = await workbook.xlsx.writeBuffer();
  const title = batch.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60);
  return { filename: `招新面试名单_${title}_${bj.dayKey(Date.now()).replace(/-/g, '')}.xlsx`,
    base64: Buffer.from(buffer).toString('base64'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
async function publishResults(id, body) {
  F.keys(body, ['version']);
  const row = await requireBatch(S, id); expectVersion(row, body.version); assertReview(row);
  // Transaction API supports document access only. This count is fenced by the
  // batch version; every application write also writes that batch in its transaction.
  const actual = await S.count(C.APPLICATION, { batchId: row._id, progress: _.in(['submitted', 'interview']), decision: null });
  return S.transaction(async (tx) => {
    const latest = await requireBatch(tx, id); expectVersion(latest, body.version); assertReview(latest);
    if (latest.unresolvedCount !== actual) state('报名统计异常，请联系广播站');
    if (actual !== 0) state('仍有报名未确定录取结果');
    const next = touch(latest, { resultPublishedAt: Date.now() });
    await tx.set(C.BATCH, latest._id, next);
    return batchDTO(next, true);
  });
}
async function archiveBatch(id, body) {
  F.keys(body, ['version']);
  return S.transaction(async (tx) => {
    const row = await requireBatch(tx, id);
    if (row.archivedAt !== null) return batchDTO(row, true);
    expectVersion(row, body.version);
    if (row.resultPublishedAt === null) state('录取结果发布后才可归档');
    const next = touch(row, { archivedAt: Date.now() });
    await tx.set(C.BATCH, row._id, next);
    return batchDTO(next, true);
  });
}
async function applications(query) {
  F.keys(query, ['batchId', 'page', 'pageSize', 'grade', 'status']);
  const batch = await requireBatch(S, query.batchId); const p = pager(query);
  const where = { batchId: batch._id };
  if (query.grade !== undefined && query.grade !== '') where.grade = F.text(query.grade, '年级', 40);
  if (query.status !== undefined && query.status !== '') {
    if (!['submitted', 'interview', 'accepted', 'rejected', 'withdrawn'].includes(query.status)) fail(Codes.PARAM_ERROR, '报名状态无效');
    if (['accepted', 'rejected'].includes(query.status)) { where.decision = query.status; where.progress = _.neq('withdrawn'); }
    else if (query.status === 'withdrawn') where.progress = 'withdrawn';
    else if (query.status === 'interview') {
      // 有了批次统一安排后，所有未定结果的报名都等价于「待面试」。
      where.progress = batch.interview ? _.in(['submitted', 'interview']) : 'interview';
      where.decision = null;
    } else {
      where.progress = 'submitted'; where.decision = null;
      // 同理，此时不存在「仅已提交」的报名，直接给空页而不是把待面试混进来。
      if (batch.interview) return { items: [], total: 0, page: p.page, pageSize: p.pageSize };
    }
  }
  const [items, total] = await Promise.all([S.list(C.APPLICATION, where, { ...p, limit: p.pageSize, orderBy: [['createdAt', 'desc']] }), S.count(C.APPLICATION, where)]);
  return { items: items.map((r) => applicationDTO(r, batch, true)), total, page: p.page, pageSize: p.pageSize };
}
async function adminRecord(db, id) {
  const row = await db.get(C.APPLICATION, F.id(id, '报名标识'));
  if (!row) fail(Codes.NOT_FOUND, '报名记录不存在');
  return { row, batch: await requireBatch(db, row.batchId) };
}
async function applicationDetail(id) {
  const { row, batch } = await adminRecord(S, id); return applicationDTO(row, batch, true);
}
async function review(id, body) {
  F.keys(body, ['version', 'decision', 'internalNote', 'publicNote']);
  return S.transaction(async (tx) => {
    const { row, batch } = await adminRecord(tx, id); expectVersion(row, body.version); assertReview(batch);
    if (row.progress === 'withdrawn') state('已撤回报名不可审核');
    const patch = {}; let delta = 0;
    if (F.own(body, 'decision')) {
      if (body.decision !== null && !['accepted', 'rejected'].includes(body.decision)) fail(Codes.PARAM_ERROR, '录取决定无效');
      // 面试改成批次级统一安排后，判据是「有没有生效的面试安排」，而不是单条 progress。
      if (body.decision === 'accepted' && !arranged(row, batch)) state('请先安排面试时间，再拟定录取');
      if (!['submitted', 'interview'].includes(row.progress)) state('当前报名不可审核');
      if (body.decision === null && row.decision !== null) delta = 1;
      else if (body.decision !== null && row.decision === null) delta = -1;
      patch.decision = body.decision;
    }
    if (F.own(body, 'internalNote')) patch.internalNote = F.text(body.internalNote, '内部备注', 2000, false);
    if (F.own(body, 'publicNote')) patch.publicNote = F.text(body.publicNote, '对外说明', 2000, false);
    if (!Object.keys(patch).length) fail(Codes.PARAM_ERROR, '请填写审核内容');
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: Date.now() };
    const nextBatch = touch(batch, { unresolvedCount: batch.unresolvedCount + delta });
    await tx.set(C.APPLICATION, row._id, next); await tx.set(C.BATCH, batch._id, nextBatch);
    return applicationDTO(next, nextBatch, true);
  });
}
// 批次级「统一安排」：一次设置/清除，覆盖批次内所有未单独配置的报名。
// 传 at: null 或 '' 即清除统一安排。
async function interviewPlan(id, body) {
  F.keys(body, ['version', 'at', 'location', 'note']);
  const cleared = body.at === null || body.at === '';
  const plan = cleared ? null : { at: F.time(body.at, '面试时间'), location: F.text(body.location, '面试地点', 200), note: F.text(body.note, '面试说明', 2000, false) };
  return S.transaction(async (tx) => {
    const row = await requireBatch(tx, id); expectVersion(row, body.version); assertReview(row);
    const next = touch(row, { interview: plan });
    await tx.set(C.BATCH, row._id, next);
    return batchDTO(next, true);
  });
}
// 个人「单独配置」面试时间：传 at: null 即清除覆盖，重新跟随批次统一安排。
async function interview(id, body) {
  F.keys(body, ['version', 'at', 'location', 'note']);
  const cleared = body.at === null || body.at === '';
  const plan = cleared ? null : { at: F.time(body.at, '面试时间'), location: F.text(body.location, '面试地点', 200), note: F.text(body.note, '面试说明', 2000, false) };
  return S.transaction(async (tx) => {
    const { row, batch } = await adminRecord(tx, id); expectVersion(row, body.version); assertReview(batch);
    if (row.progress === 'withdrawn' || row.decision !== null) state('当前报名不可安排面试');
    // 清除个人覆盖后进度交回「已提交」；批次有统一安排时由 status() 派生出「待面试」，
    // 这样批次统一安排被清除后不会残留一个「待面试却没有时间」的脏进度。
    const progress = plan ? 'interview' : 'submitted';
    const next = { ...row, progress, interview: plan, version: row.version + 1, updatedAt: Date.now() };
    const nextBatch = touch(batch);
    await tx.set(C.APPLICATION, row._id, next); await tx.set(C.BATCH, batch._id, nextBatch);
    return applicationDTO(next, nextBatch, true);
  });
}
// 删除批次：连带清除该批次的报名、查询码与唯一键占位（不可恢复）。
// 子记录逐条删除（天然幂等），批次本体最后删；中途失败时残留子记录可重跑清理。
async function deleteBatch(id, body) {
  F.keys(body, ['confirm']);
  const row = await requireBatch(S, id);
  const total = await S.count(C.APPLICATION, { batchId: row._id });
  if (total > 0 || row.publishedAt !== null) {
    if (typeof body.confirm !== 'string' || body.confirm.trim() !== row.title) state('请原样输入批次名称以确认删除');
  }
  let removed = 0;
  for (let round = 0; round < 500; round += 1) {
    const page = await S.list(C.APPLICATION, { batchId: row._id }, { limit: 100, orderBy: [['_id', 'asc']] });
    if (!page.length) break;
    for (const item of page) {
      if (item.codeHash) await S.remove(C.CODE, item.codeHash);
      if (item.submissionKeyHash) await S.remove(C.UNIQUE, submitId(item.submissionKeyHash));
      if (item.qqNumber) await S.remove(C.UNIQUE, uniqueId(row._id, item.qqNumber));
      // 历史学号占位沿用 student: 前缀，命名空间与 QQ 号隔离。
      if (item.studentNo) await S.remove(C.UNIQUE, `student:${Code.digest(JSON.stringify([row._id, item.studentNo]))}`);
      await S.remove(C.APPLICATION, item._id);
    }
    removed += page.length;
  }
  if (await S.count(C.APPLICATION, { batchId: row._id })) state('报名记录未能全部清除，请重试删除');
  await S.remove(C.BATCH, row._id);
  const control = await S.get(C.CONTROL, 'global');
  if (control && Array.isArray(control.windows) && control.windows.some((item) => item.batchId === row._id)) {
    await S.set(C.CONTROL, 'global', { windows: control.windows.filter((item) => item.batchId !== row._id), updatedAt: Date.now() });
  }
  return { id: row._id, title: row.title, deletedApplications: removed };
}

module.exports = { current, apply, query, mutate, batches, createBatch, batchDetail, updateBatch, publishBatch, closeBatch,
  generateInterviewOrder, interviewOrder, exportInterviewOrder, publishResults, archiveBatch, applications, applicationDetail,
  review, interviewPlan, interview, deleteBatch, _internals: { batchDTO, applicationDTO, windowState, status, arranged, uniqueId, shuffle, assertOrderSize } };
