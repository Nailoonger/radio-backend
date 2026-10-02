'use strict';

// End-to-end public/administrator contracts, through the actual cloud gateway.
// The harness serializes transactions and rolls them back; it is not a proof of
// the managed cloud's transaction conflicts, indexes or access rules.
const assert = require('assert');
const path = require('path');
const H = require('./harness');
const API = process.env.HARNESS_API_DIR || path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(__dirname, '..', 'cloudfunctions', 'api', 'lib', 'auth'));
const Code = require(path.join(__dirname, '..', 'cloudfunctions', 'api', 'services', 'recruitmentCode'));
const ExcelJS = require('exceljs');
process.env.RECRUITMENT_CODE_KEY = 'd1'.repeat(32); // Test-only key, never a production default.

let checked = 0;
let failed = 0;
let source = 0;
const realNow = Date.now;
const base = realNow();
let now = base;
Date.now = () => now;
const root = sign({ id: 1, role: 0, username: 'root' });
const member = sign({ id: 2, role: 1, username: 'reviewer' });
const seed = { admin: [
  { _id: 'r', id: 1, role: 0, username: 'root', status: 1 },
  { _id: 'm', id: 2, role: 1, username: 'reviewer', status: 1 },
] };

function check(name, work) {
  checked++;
  try { work(); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
function equal(name, actual, expected) { check(name, () => assert.deepStrictEqual(actual, expected)); }
function yes(name, value) { check(name, () => assert.ok(value)); }
async function request(method, url, body = {}, token = '', origin) {
  H.setOpenid(origin || `caller-${++source}`);
  return H.call(H.req(method, url, body, token));
}
async function success(method, url, body, token) {
  const r = await request(method, url, body, token);
  equal(`${method} ${url} 成功`, r.code, 0);
  if (r.code !== 0) throw new Error(`${url}: ${r.message}`);
  return r.data;
}
const admin = '/admin/recruitment';
const user = '/user/recruitment';
const form = (batchId, qqNumber, submissionKey) => ({ batchId, submissionKey,
  name: ' 王同学 ', qqNumber, grade: '高一', className: '3班',
  answers: { intro: '介绍', skill: '爱播音', radio: 'a', days: ['mon', 'wed'] },
});
const config = () => ({ title: '秋季招新', intro: '仅限高一、初一学生报名。',
  opensAt: new Date(base - 10000).toISOString(), closesAt: new Date(base + 60000).toISOString(),
  questions: [
    { id: 'intro', type: 'text', title: '介绍', required: true, options: [] },
    { id: 'skill', type: 'textarea', title: '经历', required: false, options: [] },
    { id: 'radio', type: 'single', title: '选择', required: true, options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
    { id: 'days', type: 'multiple', title: '时间', required: true, options: [{ id: 'mon', label: '周一' }, { id: 'wed', label: '周三' }] },
  ],
});

(async () => {
  H.reset(seed);
  equal('无批次时公开入口可访问', (await success('GET', `${user}/current`)).batch, null);
  equal('匿名不能配置', (await request('POST', `${admin}/batches`, config())).code, 40101);
  equal('普通管理员不能配置', (await request('POST', `${admin}/batches`, config(), member)).code, 40301);
  const bad = config(); bad.questions[2].options[1].label = '甲';
  equal('重复选项被拒绝', (await request('POST', `${admin}/batches`, bad, root)).code, 40001);
  let batch = await success('POST', `${admin}/batches`, config(), root);
  equal('草稿对公众隐藏', (await success('GET', `${user}/current`)).batch, null);
  equal('草稿不可报名', (await request('POST', `${user}/apply`, form(batch.id, '11001', '01'.repeat(16)))).code, 40304);
  equal('普管不能发布', (await request('POST', `${admin}/batches/${batch.id}/publish`, { version: batch.version }, member)).code, 40301);
  batch = await success('POST', `${admin}/batches/${batch.id}/publish`, { version: batch.version }, root);
  equal('公开窗口开放', (await success('GET', `${user}/current`)).batch.windowState, 'open');
  equal('发布题目锁定', (await request('PUT', `${admin}/batches/${batch.id}`, { version: batch.version, questions: [] }, root)).code, 40912);
  const overlapping = await success('POST', `${admin}/batches`, config(), root);
  equal('重叠窗口发布被拒绝', (await request('POST', `${admin}/batches/${overlapping.id}/publish`, { version: overlapping.version }, root)).code, 40912);
  const blank = form(batch.id, '11001', '02'.repeat(16)); blank.name = '  ';
  equal('固定必填拒绝空白', (await request('POST', `${user}/apply`, blank)).code, 40001);
  const invalid = form(batch.id, '11001', '03'.repeat(16)); invalid.answers.radio = 'unknown';
  equal('拒绝不存在选项', (await request('POST', `${user}/apply`, invalid)).code, 40001);
  const long = form(batch.id, '11001', '04'.repeat(16)); long.answers.intro = '字'.repeat(201);
  equal('拒绝超长单行答案', (await request('POST', `${user}/apply`, long)).code, 40001);
  const emptyMulti = form(batch.id, '11001', '05'.repeat(16)); emptyMulti.answers.days = [];
  equal('必填多选不可留空', (await request('POST', `${user}/apply`, emptyMulti)).code, 40001);
  const body = form(batch.id, ' 11001 ', '11'.repeat(16));
  const a = await success('POST', `${user}/apply`, body);
  equal('四项自行填写并去空白', a.application.name, '王同学');
  equal('年级按配置选项取值', a.application.grade, '高一');
  yes('随机查询码16位', /^[A-Z2-9]{16}$/.test(a.queryCode));
  const retry = await success('POST', `${user}/apply`, body);
  equal('响应丢失安全重试返回相同码', retry.queryCode, a.queryCode);
  equal('响应丢失安全重试返回同记录', retry.application.id, a.application.id);
  const different = { ...body, name: '改变内容' };
  equal('同重试凭证不同内容冲突', (await request('POST', `${user}/apply`, different)).code, 40910);
  const duplicate = await request('POST', `${user}/apply`, form(batch.id, '11001', '12'.repeat(16)));
  equal('同 QQ 号重复控制', duplicate.code, 40911);
  yes('重复不泄露查询码', !JSON.stringify(duplicate).includes(a.queryCode));
  const optional = form(batch.id, '11002', '21'.repeat(16)); delete optional.answers.skill;
  const b = await success('POST', `${user}/apply`, optional);
  yes('不同记录不同查询码', b.queryCode !== a.queryCode);
  equal('无效查询码统一错误', (await request('POST', `${user}/query`, { queryCode: 'INVALID' })).code, 40404);
  equal('学号不能查询', (await request('POST', `${user}/query`, { studentNo: '11001' })).code, 40001);
  let viewA = await success('POST', `${user}/query`, { queryCode: ` ${a.queryCode.toLowerCase()} ` });
  equal('码忽略大小写空白', viewA.id, a.application.id);
  yes('查询不回显查询码和内部字段', !('queryCode' in viewA) && !('codeHash' in viewA) && !('internalNote' in viewA) && !('decision' in viewA));
  const edit = { queryCode: a.queryCode, version: viewA.version, name: '修改姓名', qqNumber: '11002', grade: '初一', className: '1班', answers: body.answers };
  equal('改 QQ 号不能占他人号码', (await request('PUT', `${user}/application`, edit)).code, 40911);
  viewA = await success('PUT', `${user}/application`, { ...edit, qqNumber: '11003' });
  equal('修改表单', viewA.name, '修改姓名');
  equal('旧版本修改被拒绝', (await request('PUT', `${user}/application`, { ...edit, qqNumber: '11004' })).code, 40910);
  let viewB = await success('POST', `${user}/query`, { queryCode: b.queryCode });
  viewB = await success('POST', `${user}/withdraw`, { queryCode: b.queryCode, version: viewB.version });
  equal('撤回状态', viewB.progress, 'withdrawn');
  viewB = await success('POST', `${user}/resubmit`, { queryCode: b.queryCode, version: viewB.version, name: '同学乙', qqNumber: '11002', grade: '高一', className: '2班', answers: optional.answers });
  equal('重新提交沿用记录', viewB.id, b.application.id);
  equal('截止前后台审核被拒绝', (await request('PUT', `${admin}/applications/${viewA.id}/review`, { version: viewA.version, decision: 'rejected' }, member)).code, 40304);
  const preArchive = await success('GET', `${admin}/batches/${batch.id}`, {}, root);
  equal('未发布结果不可归档', (await request('POST', `${admin}/batches/${batch.id}/archive`, { version: preArchive.version }, root)).code, 40912);

  // Anonymous source must be platform-supplied; a body key is not an identity.
  H.setOpenid('');
  const forged = await H.call(H.req('POST', `${user}/query`, { queryCode: a.queryCode, source: 'cloud:forged', openid: 'forged' }));
  yes('不信用户伪造来源', forged.code !== 0);
  H.setOpenid('');
  const http = await H.call({ httpMethod: 'POST', path: '/api', requestContext: { identity: { sourceIp: '127.0.0.2' } }, body: JSON.stringify({ method: 'POST', path: `${user}/query`, body: { queryCode: a.queryCode } }) });
  equal('可信HTTP来源可查询', http.code, 0);
  for (let i = 0; i < 20; i++) await request('POST', `${user}/query`, { queryCode: a.queryCode }, '', 'limited');
  const limited = await request('POST', `${user}/query`, { queryCode: a.queryCode }, '', 'limited');
  equal('查询限流', limited.code, 42901);
  yes('限流不含报名内容', !JSON.stringify(limited).includes('修改姓名'));
  H.setOpenid('same-native-caller');
  let forgedHttp;
  for (let i = 0; i < 21; i++) {
    forgedHttp = await H.call({ httpMethod: 'POST', path: '/api',
      requestContext: { identity: { sourceIp: `forged-${i}` } },
      body: JSON.stringify({ method: 'POST', path: `${user}/query`, body: { queryCode: 'INVALID' } }),
    });
  }
  equal('原生调用伪装HTTP不能通过变IP绕过限流', forgedHttp.code, 42901);

  now = base + 60000; // At deadline, editing closes and administrator review opens.
  equal('截止时不能修改', (await request('PUT', `${user}/application`, { ...edit, qqNumber: '11003', version: viewA.version })).code, 40304);
  equal('截止时不能撤回', (await request('POST', `${user}/withdraw`, { queryCode: a.queryCode, version: viewA.version })).code, 40304);
  equal('截止时不能新报名', (await request('POST', `${user}/apply`, form(batch.id, '005', '31'.repeat(16)))).code, 40304);
  equal('截止后原提交安全重试仍取同码', (await success('POST', `${user}/apply`, body)).queryCode, a.queryCode);
  let rowA = await success('GET', `${admin}/applications/${viewA.id}`, {}, member);
  equal('未面试不能直接录取', (await request('PUT', `${admin}/applications/${viewA.id}/review`, { version: rowA.version, decision: 'accepted' }, member)).code, 40912);
  equal('面试必须有地点', (await request('PUT', `${admin}/applications/${viewA.id}/interview`, { version: rowA.version, at: new Date(now + 1000).toISOString(), location: '' }, member)).code, 40001);
  rowA = await success('PUT', `${admin}/applications/${viewA.id}/interview`, { version: rowA.version, at: new Date(now + 100000).toISOString(), location: '广播室', note: '请提前到场' }, member);
  viewA = await success('POST', `${user}/query`, { queryCode: a.queryCode });
  equal('面试安排公开', viewA.interview.location, '广播室');
  equal('面试进度', viewA.progress, 'interview');
  rowA = await success('PUT', `${admin}/applications/${viewA.id}/interview`, { version: rowA.version, at: new Date(now + 200000).toISOString(), location: '新广播室', note: '改时间' }, member);
  equal('安排修改后可见', (await success('POST', `${user}/query`, { queryCode: a.queryCode })).interview.location, '新广播室');
  rowA = await success('PUT', `${admin}/applications/${viewA.id}/review`, { version: rowA.version, decision: 'accepted', internalNote: '仅管理员可见', publicNote: '欢迎加入' }, member);
  viewA = await success('POST', `${user}/query`, { queryCode: a.queryCode });
  equal('结果发布前保留面试进度', viewA.progress, 'interview');
  yes('发布前内部决定不可见', !JSON.stringify(viewA).includes('accepted') && !JSON.stringify(viewA).includes('仅管理员可见') && !JSON.stringify(viewA).includes('欢迎加入'));
  let latest = await success('GET', `${admin}/batches/${batch.id}`, {}, root);
  equal('普管不可发布结果', (await request('POST', `${admin}/batches/${batch.id}/results`, { version: latest.version }, member)).code, 40301);
  equal('存在未决定阻止发布', (await request('POST', `${admin}/batches/${batch.id}/results`, { version: latest.version }, root)).code, 40912);
  let rowB = await success('GET', `${admin}/applications/${viewB.id}`, {}, member);
  rowB = await success('PUT', `${admin}/applications/${viewB.id}/review`, { version: rowB.version, decision: 'rejected', publicNote: '谢谢参与' }, member);
  rowB = await success('PUT', `${admin}/applications/${viewB.id}/review`, { version: rowB.version, decision: null }, member);
  equal('明确撤销拟定结果恢复未决定', (await success('GET', `${admin}/batches/${batch.id}`, {}, root)).unresolvedCount, 1);
  equal('撤销保留原公开进度', (await success('POST', `${user}/query`, { queryCode: b.queryCode })).progress, 'submitted');
  rowB = await success('PUT', `${admin}/applications/${viewB.id}/review`, { version: rowB.version, decision: null }, member);
  equal('重复撤销不重复增加计数', (await success('GET', `${admin}/batches/${batch.id}`, {}, root)).unresolvedCount, 1);
  rowB = await success('PUT', `${admin}/applications/${viewB.id}/review`, { version: rowB.version, decision: 'rejected', publicNote: '谢谢参与' }, member);
  equal('直接未录取发布前仍已提交', (await success('POST', `${user}/query`, { queryCode: b.queryCode })).progress, 'submitted');
  const list = await success('GET', `${admin}/applications`, { batchId: batch.id, status: 'accepted', page: 1, pageSize: 20 }, member);
  equal('后台状态筛选', list.total, 1);
  yes('后台列表无查询码', !JSON.stringify(list).includes(a.queryCode));
  latest = await success('GET', `${admin}/batches/${batch.id}`, {}, root);
  equal('所有有效报名已决定', latest.unresolvedCount, 0);
  latest = await success('POST', `${admin}/batches/${batch.id}/results`, { version: latest.version }, root);
  viewA = await success('POST', `${user}/query`, { queryCode: a.queryCode });
  equal('统一发布后录取可见', viewA.progress, 'accepted');
  equal('对外说明可见', viewA.publicNote, '欢迎加入');
  yes('内部备注发布后也隐藏', !JSON.stringify(viewA).includes('仅管理员可见'));
  equal('另一码只看本人未录取', (await success('POST', `${user}/query`, { queryCode: b.queryCode })).progress, 'rejected');
  equal('发布后决定锁定', (await request('PUT', `${admin}/applications/${viewA.id}/review`, { version: rowA.version, decision: 'rejected' }, member)).code, 40912);
  equal('发布后不能撤销拟定结果', (await request('PUT', `${admin}/applications/${viewB.id}/review`, { version: rowB.version, decision: null }, member)).code, 40912);
  latest = await success('POST', `${admin}/batches/${batch.id}/archive`, { version: latest.version }, root);
  equal('归档后仍能查询', (await success('POST', `${user}/query`, { queryCode: a.queryCode })).progress, 'accepted');
  const again = await success('POST', `${admin}/batches/${batch.id}/archive`, { version: 0 }, root);
  equal('重复归档幂等', again.archivedAt, latest.archivedAt);

  // Transaction rollback contract: faults after a write must undo every write.
  const before = JSON.stringify(H.dump());
  try { await H.fakeDb.runTransaction(async (tx) => {
    await tx.collection('recruitment_application').doc('fault').set({ data: { name: '不应保留' } });
    throw new Error('injected database outage');
  }); } catch (_) { /* deliberate outage */ }
  equal('事务写后异常全部回滚', JSON.stringify(H.dump()), before);

  // Parallel duplicate submissions are verified in a fresh open window.
  now = base;
  H.reset(seed);
  batch = await success('POST', `${admin}/batches`, config(), root);
  batch = await success('POST', `${admin}/batches/${batch.id}/publish`, { version: batch.version }, root);
  const configuredKey = process.env.RECRUITMENT_CODE_KEY;
  delete process.env.RECRUITMENT_CODE_KEY;
  equal('缺密钥时拒绝创建报名', (await request('POST', `${user}/apply`, form(batch.id, '21001', '51'.repeat(16)))).code, 50001);
  equal('缺密钥不占未决定计数', (await success('GET', `${admin}/batches/${batch.id}`, {}, root)).unresolvedCount, 0);
  process.env.RECRUITMENT_CODE_KEY = configuredKey;
  const runTransaction = H.fakeDb.runTransaction;
  let injected = false;
  H.fakeDb.runTransaction = work => runTransaction(tx => work({ collection(name) {
    const collection = tx.collection(name);
    return { ...collection, doc(id) {
      const doc = collection.doc(id);
      if (name === 'recruitment_application' && !injected) {
        const set = doc.set.bind(doc);
        doc.set = async options => { injected = true; await set(options); throw new Error('private database payload/queryCode must never be returned'); };
      }
      return doc;
    } };
  } }));
  const faultBody = form(batch.id, '21002', '52'.repeat(16));
  const outage = await request('POST', `${user}/apply`, faultBody);
  H.fakeDb.runTransaction = runTransaction;
  equal('数据库写后失败返回通用错误', outage.code, 50001);
  equal('数据库异常不返回详情', outage.data, null);
  equal('失败不保留半份报名', (H.dump().recruitment_application || []).length, 0);
  equal('失败不占查询码', (H.dump().recruitment_code || []).length, 0);
  equal('失败不占学号或提交凭证', (H.dump().recruitment_unique || []).length, 0);
  const recovered = await success('POST', `${user}/apply`, faultBody);
  yes('数据库恢复后原提交可成功', !!recovered.queryCode);
  const currentBatch = await success('GET', `${admin}/batches/${batch.id}`, {}, root);
  equal('恢复只计一份报名', currentBatch.unresolvedCount, 1);
  H.setOpenid('parallel');
  const pair = await Promise.all([
    H.call(H.req('POST', `${user}/apply`, form(batch.id, '21003', '41'.repeat(16)))),
    H.call(H.req('POST', `${user}/apply`, form(batch.id, '21003', '42'.repeat(16)))),
  ]);
  equal('并发同 QQ 号仅一条成功', pair.map(x => x.code).sort((x,y) => x-y), [0, 40911]);
  equal('并发仅增加一个未决定计数', (await success('GET', `${admin}/batches/${batch.id}`, {}, root)).unresolvedCount, 2);

  // QQ registration, early closure and preserved historical credentials.
  now = base; H.reset(seed);
  const basic = () => ({ ...config(), questions: [] });
  const simpleForm = (batchId, qqNumber, key) => ({ batchId, submissionKey: key,
    name: '新同学', qqNumber, grade: '初一', className: '1班', answers: {} });
  let early = await success('POST', `${admin}/batches`, basic(), root);
  equal('草稿不能手动截止', (await request('POST', `${admin}/batches/${early.id}/close`, { version: early.version }, root)).code, 40912);
  early = await success('POST', `${admin}/batches/${early.id}/publish`, { version: early.version }, root);
  for (const qq of ['', '1234', '1234567890123', '12a45', 12345]) {
    equal('QQ 必填且为 5～12 位数字字符串', (await request('POST', `${user}/apply`, simpleForm(early.id, qq, '61'.repeat(16)))).code, 40001);
  }
  const oldOnly = simpleForm(early.id, '100001', '62'.repeat(16)); delete oldOnly.qqNumber; oldOnly.studentNo = '100001';
  equal('原学号不能新建报名', (await request('POST', `${user}/apply`, oldOnly)).code, 40001);
  const earlyBody = simpleForm(early.id, ' 012345 ', '63'.repeat(16));
  const earlyApplicant = await success('POST', `${user}/apply`, earlyBody);
  equal('QQ 去空白保留前导零', earlyApplicant.application.qqNumber, '012345');
  equal('新公开记录不返回学号', 'studentNo' in earlyApplicant.application, false);
  equal('普管不能手动截止', (await request('POST', `${admin}/batches/${early.id}/close`, { version: early.version }, member)).code, 40301);
  equal('过期批次版本不能截止', (await request('POST', `${admin}/batches/${early.id}/close`, { version: early.version }, root)).code, 40910);
  let earlyLatest = await success('GET', `${admin}/batches/${early.id}`, {}, root);
  equal('开放期不能生成面试顺序', (await request('POST', `${admin}/batches/${early.id}/interview-order`, { version: earlyLatest.version }, root)).code, 40304);
  const planClose = earlyLatest.closesAt;
  earlyLatest = await success('POST', `${admin}/batches/${early.id}/close`, { version: earlyLatest.version }, root);
  equal('手动截止保存原计划时间', earlyLatest.closesAt, planClose);
  equal('手动截止状态优先', earlyLatest.windowState, 'closed');
  equal('截止不删除已报名记录', H.dump().recruitment_application.length, 1);
  equal('截止释放占位窗口', H.dump().recruitment_control[0].windows.some(x => x.batchId === early.id), false);
  const repeatClose = await success('POST', `${admin}/batches/${early.id}/close`, { version: 0 }, root);
  equal('重复截止保持首次时间和版本', [repeatClose.closedAt, repeatClose.version], [earlyLatest.closedAt, earlyLatest.version]);
  const closedEdit = { queryCode: earlyApplicant.queryCode, version: earlyApplicant.application.version,
    name: '同学', qqNumber: '012345', grade: '初一', className: '1班', answers: {} };
  equal('手动截止后禁止新增', (await request('POST', `${user}/apply`, simpleForm(early.id, '912345', '64'.repeat(16)))).code, 40304);
  equal('手动截止后禁止修改', (await request('PUT', `${user}/application`, closedEdit)).code, 40304);
  equal('手动截止后禁止撤回', (await request('POST', `${user}/withdraw`, { queryCode: earlyApplicant.queryCode, version: closedEdit.version })).code, 40304);
  equal('手动截止后禁止重提交', (await request('POST', `${user}/resubmit`, closedEdit)).code, 40304);
  equal('手动截止后仍恢复响应丢失的原码', (await success('POST', `${user}/apply`, earlyBody)).queryCode, earlyApplicant.queryCode);
  equal('不能通过调整时间重开', (await request('PUT', `${admin}/batches/${early.id}`, { version: earlyLatest.version, closesAt: base + 90000 }, root)).code, 40912);
  let manuallyReviewed = await success('PUT', `${admin}/applications/${earlyApplicant.application.id}/review`, { version: closedEdit.version, internalNote: '人工截止即可审查' }, member);
  equal('手动截止后立即进入审核', manuallyReviewed.internalNote, '人工截止即可审查');
  const fresh = await success('POST', `${admin}/batches`, basic(), root);
  const freshPublished = await success('POST', `${admin}/batches/${fresh.id}/publish`, { version: fresh.version }, root);
  equal('释放占位后原时间可发布新批次', freshPublished.windowState, 'open');
  equal('current 跳过提前关闭的旧开放时间窗', (await success('GET', `${user}/current`)).batch.id, fresh.id);
  let future = await success('POST', `${admin}/batches`, { ...basic(), opensAt: base + 120000, closesAt: base + 180000 }, root);
  future = await success('POST', `${admin}/batches/${future.id}/publish`, { version: future.version }, root);
  future = await success('POST', `${admin}/batches/${future.id}/close`, { version: future.version }, root);
  equal('尚未开始亦可截止', future.windowState, 'closed');
  equal('空候选明确拒绝生成', (await request('POST', `${admin}/batches/${future.id}/interview-order`, { version: future.version }, root)).code, 40912);

  const legacyId = 'legacy-application'; const legacyBatchId = 'legacy-batch';
  const legacyKey = '65'.repeat(16); const legacyCode = Code.generate(); const legacyHash = Code.digest(legacyCode);
  const legacyFields = { name: '旧同学', studentNo: '100001', grade: '高一', className: '2 班', answers: {} };
  const legacyBatch = { _id: legacyBatchId, ...basic(), opensAt: base - 10000, closesAt: base + 60000,
    publishedAt: base - 1000, resultPublishedAt: null, archivedAt: null, unresolvedCount: 1, version: 1, createdAt: base - 1000, updatedAt: base - 1000 };
  const legacyRow = { _id: legacyId, batchId: legacyBatchId, ...legacyFields, progress: 'submitted', decision: null,
    internalNote: '内部不可导出', publicNote: '', interview: null, version: 1, createdAt: base - 1000, updatedAt: base - 1000,
    codeHash: legacyHash, codeCipher: Code.encrypt(legacyCode, legacyId), submissionKeyHash: Code.digest(legacyKey),
    payloadHash: Code.payloadHash({ batchId: legacyBatchId, ...legacyFields }) };
  H.reset({ ...seed, recruitment_batch: [legacyBatch], recruitment_application: [legacyRow],
    recruitment_code: [{ _id: legacyHash, applicationId: legacyId }], recruitment_unique: [
      { _id: `student:${Code.digest(JSON.stringify([legacyBatchId, legacyFields.studentNo]))}`, applicationId: legacyId },
      { _id: `submit:${Code.digest(legacyKey)}`, applicationId: legacyId },
    ] });
  let legacyView = await success('POST', `${user}/query`, { queryCode: legacyCode });
  equal('旧码仍查询且未填 QQ 不冒充学号', legacyView.qqNumber, '');
  equal('原学号只在后台字段显示', (await success('GET', `${admin}/applications/${legacyId}`, {}, member)).legacyStudentNo, '100001');
  yes('旧公开 DTO 不暴露学号或顺序字段', !('studentNo' in legacyView) && !('legacyStudentNo' in legacyView) && !('interviewSequence' in legacyView) && !('orderGeneratedAt' in legacyView.batch));
  equal('缺 closedAt 旧批次仍可开放', (await success('GET', `${user}/current`)).batch.windowState, 'open');
  const legacyRetry = { batchId: legacyBatchId, submissionKey: legacyKey, ...legacyFields };
  equal('旧版原请求安全重试恢复原码', (await success('POST', `${user}/apply`, legacyRetry)).queryCode, legacyCode);
  equal('旧请求改内容仍拒绝原码', (await request('POST', `${user}/apply`, { ...legacyRetry, name: '改动' })).code, 40910);
  equal('不同凭证不能沿旧学号新建', (await request('POST', `${user}/apply`, { ...legacyRetry, submissionKey: '66'.repeat(16) })).code, 40001);
  await success('POST', `${user}/apply`, simpleForm(legacyBatchId, '100001', '67'.repeat(16)));
  yes('新 QQ 占位隔离旧学号命名空间', H.dump().recruitment_unique.some(x => x._id.startsWith('qq:')) && H.dump().recruitment_unique.some(x => x._id.startsWith('student:')));
  const legacyEdit = { queryCode: legacyCode, version: legacyView.version, name: '旧同学', qqNumber: '100001', grade: '高一', className: '2班', answers: {} };
  equal('历史补填 QQ 也不能占用他人号码', (await request('PUT', `${user}/application`, legacyEdit)).code, 40911);
  legacyView = await success('PUT', `${user}/application`, { ...legacyEdit, qqNumber: '100002' });
  equal('历史记录修改后 QQ 已补填', legacyView.qqNumber, '100002');
  equal('补填 QQ 后原学号仍保留', (await success('GET', `${admin}/applications/${legacyId}`, {}, member)).legacyStudentNo, '100001');
  equal('补填后原提交凭证仍恢复同查询码', (await success('POST', `${user}/apply`, legacyRetry)).queryCode, legacyCode);

  // 固定信息配置（必填可改 + 年级/班级选项）+ 批次级统一面试安排 + 单人覆盖 + 删除批次。
  H.reset(seed); now = base;
  let flex = await success('POST', `${admin}/batches`, { ...basic(), fixedFields: {
    name: { required: true, options: [] },
    qqNumber: { required: false, options: [] },
    grade: { required: true, options: ['高一', '初一'] },
    className: { required: false, options: [] },
  } }, root);
  flex = await success('POST', `${admin}/batches/${flex.id}/publish`, { version: flex.version }, root);
  equal('固定信息配置下发给公众', (await success('GET', `${user}/current`)).batch.fixedFields.grade.options, ['高一', '初一']);
  const offForm = (qq, grade, className, key) => ({ batchId: flex.id, submissionKey: key, name: '配置同学', qqNumber: qq, grade, className, answers: {} });
  equal('不在选项内的年级被拒绝', (await request('POST', `${user}/apply`, offForm('31001', '高二', '3班', '71'.repeat(16)))).code, 40001);
  equal('选填的班级可以留空', (await success('POST', `${user}/apply`, offForm('31001', '初一', '', '72'.repeat(16)))).application.className, '');
  const noQqOne = await success('POST', `${user}/apply`, offForm('', '初一', '', '73'.repeat(16)));
  const noQqTwo = await success('POST', `${user}/apply`, offForm('', '高一', '', '74'.repeat(16)));
  equal('选填的 QQ 号可以留空', noQqOne.application.qqNumber, '');
  yes('两个空 QQ 号各自成单不互相占用唯一键', noQqOne.application.id !== noQqTwo.application.id);
  equal('只有填了 QQ 号才产生 qq 占位', H.dump().recruitment_unique.filter(x => x._id.startsWith('qq:')).length, 1);
  equal('固定信息配置随批次回读', (await success('GET', `${admin}/batches/${flex.id}`, {}, root)).fixedFields.className.required, false);
  const flexBeforeClose = await success('GET', `${admin}/batches/${flex.id}`, {}, root);
  flex = await success('POST', `${admin}/batches/${flex.id}/close`, { version: flexBeforeClose.version }, root);
  equal('普管不能设置统一面试安排', (await request('PUT', `${admin}/batches/${flex.id}/interview`, { version: flex.version, at: new Date(now + 1000).toISOString(), location: '广播室' }, member)).code, 40301);
  const clearedPlan = await success('PUT', `${admin}/batches/${flex.id}/interview`, { version: flex.version, at: null, location: '', note: '' }, root);
  equal('统一面试可留空时间（即清除）', clearedPlan.interview, null);
  flex = await success('PUT', `${admin}/batches/${flex.id}/interview`, { version: clearedPlan.version, at: new Date(now + 100000).toISOString(), location: '广播室', note: '统一安排' }, root);
  equal('统一面试回读', flex.interview.location, '广播室');
  const flexList = await success('GET', `${admin}/applications`, { batchId: flex.id, page: 1, pageSize: 20 }, member);
  yes('统一安排后未定结果者一律待面试', flexList.items.length === 3 && flexList.items.every(x => x.status === 'interview' && x.interview.location === '广播室' && x.interviewCustom === false));
  equal('此时「已提交」筛选为空', (await success('GET', `${admin}/applications`, { batchId: flex.id, status: 'submitted', page: 1, pageSize: 20 }, member)).total, 0);
  equal('待面试筛选含全部报名', (await success('GET', `${admin}/applications`, { batchId: flex.id, status: 'interview', page: 1, pageSize: 20 }, member)).total, flexList.total);
  const flexTarget = flexList.items[0];
  equal('统一安排即可录取', (await success('PUT', `${admin}/applications/${flexTarget.id}/review`, { version: flexTarget.version, decision: 'accepted' }, member)).decision, 'accepted');
  const solo = await success('PUT', `${admin}/applications/${flexList.items[1].id}/interview`, { version: flexList.items[1].version, at: new Date(now + 200000).toISOString(), location: '小会议室', note: '单独' }, member);
  equal('单独配置生效并打标', [solo.interview.location, solo.interviewCustom], ['小会议室', true]);
  equal('单独配置不改动批次统一安排', (await success('GET', `${admin}/batches/${flex.id}`, {}, root)).interview.location, '广播室');
  equal('清除单独配置回到统一安排', (await success('PUT', `${admin}/applications/${flexList.items[1].id}/interview`, { version: solo.version, at: null, location: '', note: '' }, member)).interview.location, '广播室');
  const clearedCustom = await success('GET', `${admin}/applications/${flexList.items[1].id}`, {}, member);
  equal('清除后不再标记单独配置', [clearedCustom.interviewCustom, clearedCustom.status], [false, 'interview']);
  const afterSoloClear = await success('GET', `${admin}/batches/${flex.id}`, {}, root);
  flex = await success('PUT', `${admin}/batches/${flex.id}/interview`, { version: afterSoloClear.version, at: null, location: '', note: '' }, root);
  equal('清除统一安排回读为空', flex.interview, null);
  equal('清除统一安排后回到已提交', (await success('GET', `${admin}/applications/${flexList.items[1].id}`, {}, member)).status, 'submitted');
  equal('已定结果者不受清除影响', (await success('GET', `${admin}/applications/${flexTarget.id}`, {}, member)).status, 'accepted');
  equal('未面试不能录取的判据仍在', (await request('PUT', `${admin}/applications/${flexList.items[2].id}/review`, { version: flexList.items[2].version, decision: 'accepted' }, member)).code, 40912);
  equal('普管不能删除批次', (await request('DELETE', `${admin}/batches/${flex.id}`, {}, member)).code, 40301);
  equal('已发布批次删除需原文确认', (await request('DELETE', `${admin}/batches/${flex.id}`, {}, root)).code, 40912);
  equal('批次名不符不能删除', (await request('DELETE', `${admin}/batches/${flex.id}`, { confirm: '别的批次' }, root)).code, 40912);
  equal('删除批次连带清理报名', (await success('DELETE', `${admin}/batches/${flex.id}`, { confirm: flex.title }, root)).deletedApplications, flexList.total);
  equal('删除后报名记录清空', (H.dump().recruitment_application || []).filter(x => x.batchId === flex.id).length, 0);
  equal('删除后查询码占位清空', (H.dump().recruitment_code || []).length, 0);
  equal('删除后唯一键占位清空', (H.dump().recruitment_unique || []).length, 0);
  equal('删除后批次不再出现在列表', (await success('GET', `${admin}/batches`, { page: 1, pageSize: 20 }, root)).total, 0);

  // > 1000 candidates prove both cloud-page coverage and the absence of an old
  // findAllPaged default cap. Persisted order is tested independently of shuffle luck.
  H.reset(seed); now = base;
  let many = await success('POST', `${admin}/batches`, basic(), root);
  many = await success('POST', `${admin}/batches/${many.id}/publish`, { version: many.version }, root);
  const manyRows = Array.from({ length: 1105 }, (_, i) => ({ _id: `candidate-${String(i).padStart(4, '0')}`, batchId: many.id,
    name: `候选 ${i}`, qqNumber: String(10000000 + i), grade: '高一', className: '1 班', answers: {}, progress: 'submitted', decision: null,
    internalNote: '不可导出的内部备注', publicNote: '', interview: null, version: 1, createdAt: base, updatedAt: base }));
  const historicCandidate = { ...manyRows[0], _id: 'historical-candidate', studentNo: '20260101' }; delete historicCandidate.qqNumber;
  const excludedRows = [ { ...manyRows[0], _id: 'withdrawn-candidate', progress: 'withdrawn' }, { ...manyRows[0], _id: 'rejected-candidate', decision: 'rejected' } ];
  await Promise.all([...manyRows, historicCandidate, ...excludedRows].map(row => H.fakeDb.collection('recruitment_application').doc(row._id).set({ data: row })));
  await H.fakeDb.collection('recruitment_batch').doc(many.id).update({ data: { unresolvedCount: 1106 } });
  equal('普通管理员不能生成顺序', (await request('POST', `${admin}/batches/${many.id}/interview-order`, { version: many.version }, member)).code, 40301);
  equal('生成前不能导出不存在的顺序', (await request('GET', `${admin}/batches/${many.id}/interview-order/export`, {}, member)).code, 40912);
  many = await success('POST', `${admin}/batches/${many.id}/close`, { version: many.version }, root);
  many = await success('POST', `${admin}/batches/${many.id}/interview-order`, { version: many.version }, root);
  const savedIds = H.dump().recruitment_batch[0].interviewOrderIds.slice();
  equal('完整候选全部保存且每人恰好一次', [savedIds.length, new Set(savedIds).size], [1106, 1106]);
  yes('撤回及拟不录取排除', !savedIds.includes('withdrawn-candidate') && !savedIds.includes('rejected-candidate'));
  equal('批次 DTO 给出生成数量', many.interviewOrderCount, 1106);
  const firstOrder = await success('GET', `${admin}/batches/${many.id}/interview-order`, { page: 1, pageSize: 100 }, member);
  const lastOrder = await success('GET', `${admin}/batches/${many.id}/interview-order`, { page: 12, pageSize: 100 }, member);
  equal('最后一页覆盖超过 1000 的记录', [lastOrder.items.length, lastOrder.items[0].interviewSequence], [6, 1101]);
  equal('分页依据已保存 ID 顺序', firstOrder.items.map(x => x.id), savedIds.slice(0, 100));
  equal('刷新顺序稳定', (await success('GET', `${admin}/batches/${many.id}/interview-order`, { pageSize: 100 }, member)).items.map(x => x.id), savedIds.slice(0, 100));
  yes('名单 DTO 不含内部备注或凭证', firstOrder.items.every(x => !('internalNote' in x) && !('queryCode' in x) && !('codeHash' in x)));
  equal('管理员报名详情带真实序号', (await success('GET', `${admin}/applications/${savedIds[0]}`, {}, member)).interviewSequence, 1);
  equal('名单页上限 100', (await request('GET', `${admin}/batches/${many.id}/interview-order`, { pageSize: 101 }, member)).code, 40001);
  equal('匿名不能读取名单', (await request('GET', `${admin}/batches/${many.id}/interview-order`)).code, 40101);
  equal('未确认不覆盖旧顺序', (await request('POST', `${admin}/batches/${many.id}/interview-order`, { version: many.version }, root)).code, 40912);
  const firstRow = await success('GET', `${admin}/applications/${savedIds[0]}`, {}, member);
  await success('PUT', `${admin}/applications/${firstRow.id}/interview`, { version: firstRow.version, at: base + 120000, location: '最新广播室', note: '不要导出面试备注' }, member);
  let scheduledRow = await success('GET', `${admin}/applications/${firstRow.id}`, {}, member);
  scheduledRow = await success('PUT', `${admin}/applications/${firstRow.id}/review`, { version: scheduledRow.version, decision: 'accepted', internalNote: '不能导出此内容' }, member);
  equal('审核变化不自动重排', H.dump().recruitment_batch[0].interviewOrderIds, savedIds);
  const file = await success('GET', `${admin}/batches/${many.id}/interview-order/export`, {}, member);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(file.base64, 'base64'));
  const sheet = book.getWorksheet('面试名单');
  equal('导出全名单而非当前页', sheet.rowCount, 1107);
  equal('导出固定八列无内部备注', sheet.getRow(1).values.slice(1), ['序号', '姓名', 'QQ 号', '年级', '班级', '面试时间（北京时间）', '面试地点', '状态']);
  equal('首行采用最新面试信息与北京时间', [sheet.getRow(2).getCell(6).value, sheet.getRow(2).getCell(7).value],
    [new Date(base + 120000 + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '), '最新广播室']);
  equal('未发布决定标为拟录取', sheet.getRow(2).getCell(8).value, '拟录取·未发布');
  yes('QQ 在 Excel 中保持文本格式', manyRows.every(row => { const sequence = savedIds.indexOf(row._id); const cell = sheet.getRow(sequence + 2).getCell(3); return typeof cell.value === 'string' && cell.numFmt === '@'; }));
  equal('历史学号不导成 QQ', sheet.getRow(savedIds.indexOf(historicCandidate._id) + 2).getCell(3).value || '', '');
  yes('导出序号连续且对应保存的名单', savedIds.every((id, i) => sheet.getRow(i + 2).getCell(1).value === i + 1));
  yes('导出正文不包含内部评语', !JSON.stringify(sheet.getSheetValues()).includes('不可导出的内部备注') && !JSON.stringify(sheet.getSheetValues()).includes('不能导出此内容'));
  const manyLatest = await success('GET', `${admin}/batches/${many.id}`, {}, root);
  const randomInt = require('crypto').randomInt;
  require('crypto').randomInt = () => 0;
  now = base + 1;
  try { many = await success('POST', `${admin}/batches/${many.id}/interview-order`, { version: manyLatest.version, confirm: 'REGENERATE' }, root); }
  finally { require('crypto').randomInt = randomInt; }
  yes('确认重新生成产生新时间且保留所有候选', many.orderGeneratedAt !== firstOrder.orderGeneratedAt && many.interviewOrderCount === 1106);

  // A real review between the outside-transaction page read and the final write
  // invalidates the batch fence. A previously saved full order remains untouched.
  const originalCollection = H.fakeDb.collection; let changedDuringRead = false;
  const beforeConflict = H.dump().recruitment_batch[0].interviewOrderIds.slice();
  H.fakeDb.collection = name => {
    const collection = originalCollection(name);
    if (name === 'recruitment_application') {
      const where = collection.where.bind(collection);
      collection.where = condition => {
        const q = where(condition); const get = q.get.bind(q);
        q.get = async () => {
          const result = await get();
          if (!changedDuringRead && condition.batchId === many.id && condition.progress) {
            changedDuringRead = true;
            const target = (await originalCollection(name).doc(manyRows[1]._id).get()).data;
            await success('PUT', `${admin}/applications/${target._id}/review`, { version: target.version, decision: 'rejected' }, member);
          }
          return result;
        };
        return q;
      };
    }
    return collection;
  };
  let generatedConflict;
  try { generatedConflict = await request('POST', `${admin}/batches/${many.id}/interview-order`, { version: many.version, confirm: 'REGENERATE' }, root); }
  finally { H.fakeDb.collection = originalCollection; }
  equal('生成期间审核改变返回版本冲突', generatedConflict.code, 40910);
  equal('冲突未存半份或新顺序', H.dump().recruitment_batch[0].interviewOrderIds, beforeConflict);
  await H.fakeDb.collection('recruitment_batch').doc(many.id).update({ data: { legacyMetadata: 'x'.repeat(890000) } });
  const oversizedVersion = H.dump().recruitment_batch[0].version;
  equal('容量超限明确拒绝', (await request('POST', `${admin}/batches/${many.id}/interview-order`, { version: oversizedVersion, confirm: 'REGENERATE' }, root)).code, 40912);
  equal('容量失败不部分覆盖旧顺序', H.dump().recruitment_batch[0].interviewOrderIds, beforeConflict);
  await H.fakeDb.collection('recruitment_batch').doc(many.id).update({ data: { resultPublishedAt: base + 2, legacyMetadata: '' } });
  equal('结果发布后不得重排', (await request('POST', `${admin}/batches/${many.id}/interview-order`, { version: oversizedVersion, confirm: 'REGENERATE' }, root)).code, 40912);
})().catch(error => { failed++; console.error('FAIL suite:', error.stack); }).finally(() => {
  Date.now = realNow;
  console.log(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
});
