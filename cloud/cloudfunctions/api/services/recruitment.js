'use strict';

const { ApiError, Codes } = require('../lib/response');
const R = require('./recruitmentCodes');
const S = require('./recruitmentStore');
const F = require('./recruitmentForm');
const Code = require('./recruitmentCode');
const { C, _ } = S;
const FORM_FIELDS = ['name', 'studentNo', 'grade', 'className', 'answers'];
const BATCH_FIELDS = ['title', 'intro', 'opensAt', 'closesAt', 'questions'];

function fail(code, message) { throw new ApiError(code, message); }
function state(message) { fail(R.INVALID_STATE, message); }
function iso(n) { return n === null || n === undefined ? null : new Date(n).toISOString(); }
function windowState(batch, now = Date.now()) {
  if (batch.publishedAt === null) return 'draft';
  if (now < batch.opensAt) return 'upcoming';
  return now < batch.closesAt ? 'open' : 'closed';
}
function batchDTO(row, admin = false) {
  const out = {
    id: row._id, title: row.title, intro: row.intro, opensAt: iso(row.opensAt), closesAt: iso(row.closesAt),
    publishedAt: iso(row.publishedAt), resultPublishedAt: iso(row.resultPublishedAt), archivedAt: iso(row.archivedAt),
    questions: row.questions, version: row.version, windowState: windowState(row),
  };
  if (admin) Object.assign(out, { unresolvedCount: row.unresolvedCount, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  return out;
}
function status(row) { return row.progress === 'withdrawn' ? 'withdrawn' : (row.decision || row.progress); }
function applicationDTO(row, batch, admin = false) {
  const published = batch.resultPublishedAt !== null && row.progress !== 'withdrawn';
  const out = {
    id: row._id, batchId: row.batchId, batch: batchDTO(batch, admin),
    name: row.name, studentNo: row.studentNo, grade: row.grade, className: row.className,
    answers: row.answers, progress: admin ? row.progress : (published ? row.decision : row.progress),
    interview: row.interview ? { at: iso(row.interview.at), location: row.interview.location, note: row.interview.note } : null,
    canEdit: windowState(batch) === 'open', version: row.version,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
  };
  if (admin) Object.assign(out, { decision: row.decision, internalNote: row.internalNote, publicNote: row.publicNote, status: status(row) });
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
  if (Date.now() < row.closesAt) fail(R.WINDOW_CLOSED, '报名截止后才可审核和安排面试');
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
const uniqueId = (batchId, studentNo) => `student:${Code.digest(JSON.stringify([batchId, studentNo]))}`;
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
  let rows = await S.list(C.BATCH, { publishedAt: _.neq(null), archivedAt: null, opensAt: _.lte(now), closesAt: _.gt(now) }, { limit: 1, orderBy: [['publishedAt', 'desc']] });
  if (!rows.length) rows = await S.list(C.BATCH, { publishedAt: _.neq(null), archivedAt: null }, { limit: 1, orderBy: [['publishedAt', 'desc']] });
  return { batch: rows.length ? batchDTO(rows[0]) : null };
}
async function apply(body) {
  F.keys(body, ['batchId', 'submissionKey', ...FORM_FIELDS]);
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
          const fields = F.application(body, batch.questions);
          if (row.payloadHash !== Code.payloadHash({ batchId, ...fields })) fail(R.VERSION_CONFLICT, '提交凭证与报名内容不一致');
          const originalCode = Code.decrypt(row.codeCipher, row._id);
          if (Code.digest(originalCode) !== row.codeHash) fail(Codes.SERVER_ERROR, '招新查询凭证暂不可用，请联系广播站');
          return { queryCode: originalCode, application: applicationDTO(row, batch) };
        }
        const batch = await requireBatch(tx, batchId);
        assertOpen(batch);
        const fields = F.application(body, batch.questions);
        const studentKey = uniqueId(batchId, fields.studentNo);
        if (await tx.get(C.UNIQUE, studentKey)) fail(R.DUPLICATE_STUDENT, '该学号已报名，请使用原查询码查询');
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
        await tx.set(C.UNIQUE, studentKey, { applicationId });
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
      const fields = F.application(body, batch.questions);
      if (fields.studentNo !== row.studentNo) {
        oldStudentKey = uniqueId(row.batchId, row.studentNo); newStudentKey = uniqueId(row.batchId, fields.studentNo);
        const owner = await tx.get(C.UNIQUE, oldStudentKey); const target = await tx.get(C.UNIQUE, newStudentKey);
        if (!owner || owner.applicationId !== row._id) state('报名数据异常，请联系广播站');
        if (target && target.applicationId !== row._id) fail(R.DUPLICATE_STUDENT, '该学号已报名，请使用原查询码查询');
      }
      patch = fields;
      if (action === 'resubmit') { Object.assign(patch, { progress: 'submitted', decision: null, interview: null }); countDelta = 1; }
    }
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: Date.now() };
    const nextBatch = touch(batch, { unresolvedCount: batch.unresolvedCount + countDelta });
    if (newStudentKey) { await tx.set(C.UNIQUE, newStudentKey, { applicationId: row._id }); await tx.remove(C.UNIQUE, oldStudentKey); }
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
  const row = { _id: id, ...fields, publishedAt: null, resultPublishedAt: null, archivedAt: null, unresolvedCount: 0, version: 1, createdAt: now, updatedAt: now };
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
      if (Date.now() >= row.opensAt && supplied.some((k) => ['opensAt', 'closesAt'].includes(k))) state('报名开始后时间已锁定');
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
    else { where.progress = query.status; if (query.status !== 'withdrawn') where.decision = null; }
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
      if (row.progress === 'submitted' && body.decision === 'accepted') state('已提交报名需先安排面试才可录取');
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
async function interview(id, body) {
  F.keys(body, ['version', 'at', 'location', 'note']);
  const arrangement = { at: F.time(body.at, '面试时间'), location: F.text(body.location, '面试地点', 200), note: F.text(body.note, '面试说明', 2000, false) };
  return S.transaction(async (tx) => {
    const { row, batch } = await adminRecord(tx, id); expectVersion(row, body.version); assertReview(batch);
    if (!['submitted', 'interview'].includes(row.progress) || row.decision !== null) state('当前报名不可安排面试');
    const next = { ...row, progress: 'interview', interview: arrangement, version: row.version + 1, updatedAt: Date.now() };
    const nextBatch = touch(batch);
    await tx.set(C.APPLICATION, row._id, next); await tx.set(C.BATCH, batch._id, nextBatch);
    return applicationDTO(next, nextBatch, true);
  });
}

module.exports = { current, apply, query, mutate, batches, createBatch, batchDetail, updateBatch, publishBatch, publishResults, archiveBatch, applications, applicationDetail, review, interview, _internals: { batchDTO, applicationDTO, windowState, status, uniqueId } };
