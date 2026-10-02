'use strict';

// End-to-end public/administrator contracts, through the actual cloud gateway.
// The harness serializes transactions and rolls them back; it is not a proof of
// the managed cloud's transaction conflicts, indexes or access rules.
const assert = require('assert');
const path = require('path');
const H = require('./harness');
const API = process.env.HARNESS_API_DIR || path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(__dirname, '..', 'cloudfunctions', 'api', 'lib', 'auth'));
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
const form = (batchId, studentNo, submissionKey) => ({ batchId, submissionKey,
  name: ' 王同学 ', studentNo, grade: '高二', className: '3 班',
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
  equal('草稿不可报名', (await request('POST', `${user}/apply`, form(batch.id, '001', '01'.repeat(16)))).code, 40304);
  equal('普管不能发布', (await request('POST', `${admin}/batches/${batch.id}/publish`, { version: batch.version }, member)).code, 40301);
  batch = await success('POST', `${admin}/batches/${batch.id}/publish`, { version: batch.version }, root);
  equal('公开窗口开放', (await success('GET', `${user}/current`)).batch.windowState, 'open');
  equal('发布题目锁定', (await request('PUT', `${admin}/batches/${batch.id}`, { version: batch.version, questions: [] }, root)).code, 40912);
  const overlapping = await success('POST', `${admin}/batches`, config(), root);
  equal('重叠窗口发布被拒绝', (await request('POST', `${admin}/batches/${overlapping.id}/publish`, { version: overlapping.version }, root)).code, 40912);
  const blank = form(batch.id, '001', '02'.repeat(16)); blank.name = '  ';
  equal('固定必填拒绝空白', (await request('POST', `${user}/apply`, blank)).code, 40001);
  const invalid = form(batch.id, '001', '03'.repeat(16)); invalid.answers.radio = 'unknown';
  equal('拒绝不存在选项', (await request('POST', `${user}/apply`, invalid)).code, 40001);
  const long = form(batch.id, '001', '04'.repeat(16)); long.answers.intro = '字'.repeat(201);
  equal('拒绝超长单行答案', (await request('POST', `${user}/apply`, long)).code, 40001);
  const emptyMulti = form(batch.id, '001', '05'.repeat(16)); emptyMulti.answers.days = [];
  equal('必填多选不可留空', (await request('POST', `${user}/apply`, emptyMulti)).code, 40001);
  const body = form(batch.id, ' 001 ', '11'.repeat(16));
  const a = await success('POST', `${user}/apply`, body);
  equal('四项自行填写并去空白', a.application.name, '王同学');
  equal('其他年级也可报名', a.application.grade, '高二');
  yes('随机查询码16位', /^[A-Z2-9]{16}$/.test(a.queryCode));
  const retry = await success('POST', `${user}/apply`, body);
  equal('响应丢失安全重试返回相同码', retry.queryCode, a.queryCode);
  equal('响应丢失安全重试返回同记录', retry.application.id, a.application.id);
  const different = { ...body, name: '改变内容' };
  equal('同重试凭证不同内容冲突', (await request('POST', `${user}/apply`, different)).code, 40910);
  const duplicate = await request('POST', `${user}/apply`, form(batch.id, '001', '12'.repeat(16)));
  equal('同学号重复控制', duplicate.code, 40911);
  yes('重复不泄露查询码', !JSON.stringify(duplicate).includes(a.queryCode));
  const optional = form(batch.id, '002', '21'.repeat(16)); delete optional.answers.skill;
  const b = await success('POST', `${user}/apply`, optional);
  yes('不同记录不同查询码', b.queryCode !== a.queryCode);
  equal('无效查询码统一错误', (await request('POST', `${user}/query`, { queryCode: 'INVALID' })).code, 40404);
  equal('学号不能查询', (await request('POST', `${user}/query`, { studentNo: '001' })).code, 40001);
  let viewA = await success('POST', `${user}/query`, { queryCode: ` ${a.queryCode.toLowerCase()} ` });
  equal('码忽略大小写空白', viewA.id, a.application.id);
  yes('查询不回显查询码和内部字段', !('queryCode' in viewA) && !('codeHash' in viewA) && !('internalNote' in viewA) && !('decision' in viewA));
  const edit = { queryCode: a.queryCode, version: viewA.version, name: '修改姓名', studentNo: '002', grade: '初一', className: '1 班', answers: body.answers };
  equal('改学号不能占他人学号', (await request('PUT', `${user}/application`, edit)).code, 40911);
  viewA = await success('PUT', `${user}/application`, { ...edit, studentNo: '003' });
  equal('修改表单', viewA.name, '修改姓名');
  equal('旧版本修改被拒绝', (await request('PUT', `${user}/application`, { ...edit, studentNo: '004' })).code, 40910);
  let viewB = await success('POST', `${user}/query`, { queryCode: b.queryCode });
  viewB = await success('POST', `${user}/withdraw`, { queryCode: b.queryCode, version: viewB.version });
  equal('撤回状态', viewB.progress, 'withdrawn');
  viewB = await success('POST', `${user}/resubmit`, { queryCode: b.queryCode, version: viewB.version, name: '同学乙', studentNo: '002', grade: '高一', className: '2 班', answers: optional.answers });
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
  equal('截止时不能修改', (await request('PUT', `${user}/application`, { ...edit, studentNo: '003', version: viewA.version })).code, 40304);
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
  equal('缺密钥时拒绝创建报名', (await request('POST', `${user}/apply`, form(batch.id, 'no-key', '51'.repeat(16)))).code, 50001);
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
  const faultBody = form(batch.id, 'outage', '52'.repeat(16));
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
    H.call(H.req('POST', `${user}/apply`, form(batch.id, 'same', '41'.repeat(16)))),
    H.call(H.req('POST', `${user}/apply`, form(batch.id, 'same', '42'.repeat(16)))),
  ]);
  equal('并发同学号仅一条成功', pair.map(x => x.code).sort((x,y) => x-y), [0, 40911]);
  equal('并发仅增加一个未决定计数', (await success('GET', `${admin}/batches/${batch.id}`, {}, root)).unresolvedCount, 2);
})().catch(error => { failed++; console.error('FAIL suite:', error.stack); }).finally(() => {
  Date.now = realNow;
  console.log(`结论：断言 ${checked} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
});
