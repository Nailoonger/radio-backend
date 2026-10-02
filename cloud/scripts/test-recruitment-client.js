'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const storage = new Map();
let envelope;
let cloudResponse;
const output = [];
const originalLog = console.log;
console.log = (...args) => output.push(args);
global.getApp = () => ({ globalData: { token: 'student-token', adminToken: 'admin-token' } });
global.getCurrentPages = () => [1, 2];
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  getRandomValues: ({ length, success }) => { const bytes = crypto.randomBytes(length); success({ randomValues: Uint8Array.from(bytes).buffer }); },
  cloud: { callFunction: ({ data, success }) => { envelope = data; success({ result: { code: 0, data: cloudResponse || { queryCode: '23456789ABCDEFGH', privateText: '学生信息' } } }); } },
  navigateTo: () => {},
  navigateBack: () => {},
  redirectTo: ({ url, fail }) => { assert.ok(!url.includes('queryCode')); fail(); },
  showToast: () => {},
};
const transport = require(path.join(__dirname, '../../miniprogram/utils/request'));
const client = require(path.join(__dirname, '../../miniprogram/utils/recruitment'));
let count = 0;
let failed = 0;
function check(name, work) { count++; try { work(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } }
const pageDefinitions = {};
global.Page = definition => { pageDefinitions.current = definition; };
['recruitment', 'recruitment-form', 'recruitment-result'].forEach(name => {
  require(path.join(__dirname, '../../miniprogram/pages', name, 'index.js'));
  pageDefinitions[name] = pageDefinitions.current;
});
function page(name) {
  const definition = pageDefinitions[name];
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  instance.setData = values => Object.entries(values).forEach(([key, value]) => {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    let object = instance.data;
    while (parts.length > 1) object = object[parts.shift()];
    object[parts[0]] = value;
  });
  instance.getOpenerEventChannel = () => ({ emit: (name, record) => { instance.emitted = { name, record }; } });
  return instance;
}
(async () => {
  transport.configure({ mode: 'cloud' });
  await client.query('23456789ABCDEFGH');
  check('公开查询不发送学生token', () => assert.strictEqual(envelope.token, ''));
  check('查询码只在请求正文', () => { assert.strictEqual(envelope.path, '/user/recruitment/query'); assert.strictEqual(envelope.body.queryCode, '23456789ABCDEFGH'); });
  check('敏感响应没有写日志', () => assert.ok(!JSON.stringify(output).includes('学生信息') && !JSON.stringify(output).includes('23456789ABCDEFGH')));
  check('查询码没有持久保存', () => assert.strictEqual(storage.size, 0));
  client.setContext({ queryCode: 'code' });
  check('页间内存上下文仅消费一次', () => { assert.strictEqual(client.takeContext().queryCode, 'code'); assert.ok(!client.takeContext()); });
  const key = await client.submissionKey();
  check('重试凭证128位安全随机', () => assert.match(key, /^[a-f0-9]{32}$/));
  client.savePending(key, { batchId: 'b', name: '张同学', qqNumber: '12345' }, { id: 'b' });
  check('可恢复原提交凭证和内容', () => { const value = client.pendingSubmission(); assert.strictEqual(value.submissionKey, key); assert.strictEqual(value.payload.name, '张同学'); });
  client.clearPending();
  check('成功后清理提交凭证', () => assert.ok(!client.pendingSubmission()));
  check('新缓存拒绝学号替代QQ', () => assert.throws(() => client.savePending(key, { batchId: 'b', studentNo: '12345' }, { id: 'b' })));
  const legacyPending = { submissionKey: key, payload: { batchId: 'b', name: '旧同学', studentNo: '20240101', grade: '高一', className: '1 班', answers: {} }, batch: { id: 'b', questions: [], windowState: 'open' }, expiresAt: Date.now() + 60000 };
  storage.set('recruitment_pending_submission', legacyPending);
  check('旧缓存仅恢复原凭证不转换QQ', () => {
    const value = client.pendingSubmission();
    assert.strictEqual(value.legacyRetry, true);
    assert.strictEqual(value.payload.studentNo, '20240101');
    assert.ok(!('qqNumber' in value.payload));
    assert.strictEqual(value.submissionKey, key);
  });
  const originalApply = client.apply;
  let recoveredLegacyBody;
  client.apply = async body => { recoveredLegacyBody = body; return { queryCode: '23456789ABCDEFGH', application: {} }; };
  const legacyForm = page('recruitment-form');
  legacyForm.answers = {};
  await legacyForm.initialize({ mode: 'retry' });
  check('旧缓存恢复页QQ留空且锁定', () => { assert.strictEqual(legacyForm.data.fields.qqNumber, ''); assert.strictEqual(legacyForm.data.legacyRetry, true); assert.strictEqual(legacyForm.data.locked, true); });
  await legacyForm.submit();
  check('旧缓存重试仅发送原key原学号payload', () => { assert.deepStrictEqual(recoveredLegacyBody, { ...legacyPending.payload, submissionKey: key }); assert.ok(!('qqNumber' in recoveredLegacyBody)); });
  client.apply = originalApply;
  storage.set('recruitment_pending_submission', { ...legacyPending, formVersion: 2 });
  check('新版本缓存不能发送学号payload', () => { assert.strictEqual(client.pendingSubmission(), null); assert.strictEqual(storage.size, 0); });
  storage.set('recruitment_pending_submission', { ...legacyPending, expiresAt: Date.now() - 1 });
  check('旧缓存超过24小时过期', () => { assert.strictEqual(client.pendingSubmission(), null); assert.strictEqual(storage.size, 0); });
  const old = wx.getRandomValues;
  delete wx.getRandomValues;
  let refused = false;
  try { await client.submissionKey(); } catch (_) { refused = true; }
  wx.getRandomValues = old;
  check('不支持安全随机时拒绝降级', () => assert.ok(refused));
  const questions = [
    { id: 't', title: '文字', type: 'text', required: true, options: [] },
    { id: 'm', title: '多选', type: 'multiple', required: true, options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
    { id: 'o', title: '选填', type: 'textarea', required: false, options: [] },
  ];
  const fields = { name: ' 同学 ', qqNumber: ' 0012345 ', grade: '初一', className: '一班' };
  check('固定四项归一化且不校验年级', () => assert.strictEqual(client.normalizeForm(fields, questions, { t: '答', m: ['a'] }).name, '同学'));
  check('QQ号去空白并保留字符串前导零', () => assert.strictEqual(client.normalizeForm(fields, questions, { t: '答', m: ['a'] }).qqNumber, '0012345'));
  check('QQ号严格5至12位ASCII数字', () => {
    for (const qqNumber of ['', '1234', '1234567890123', '123a5', '１２３４５', 12345]) {
      assert.throws(() => client.normalizeForm({ ...fields, qqNumber }, questions, { t: '答', m: ['a'] }));
    }
    assert.strictEqual(client.normalizeForm({ ...fields, qqNumber: '123456789012' }, questions, { t: '答', m: ['a'] }).qqNumber, '123456789012');
  });
  check('不接受仅学号的旧表单', () => assert.throws(() => client.normalizeForm({ name: '同学', studentNo: '12345', grade: '初一', className: '一班' }, questions, { t: '答', m: ['a'] })));
  check('固定四项空白拒绝', () => assert.throws(() => client.normalizeForm({ ...fields, grade: ' ' }, questions, { t: '答', m: ['a'] })));
  check('必填多选拒绝空', () => assert.throws(() => client.normalizeForm(fields, questions, { t: '答', m: [] })));
  check('多选拒绝重复或未知答案', () => {
    assert.throws(() => client.normalizeForm(fields, questions, { t: '答', m: ['a', 'a'] }));
    assert.throws(() => client.normalizeForm(fields, questions, { t: '答', m: ['z'] }));
  });
  check('按字符数量限制多字节文本', () => {
    assert.strictEqual(client.charLength('😀中文'), 3);
    assert.throws(() => client.normalizeForm(fields, questions, { t: '字'.repeat(201), m: ['a'] }));
  });
  check('北京时间不依赖设备时区', () => assert.strictEqual(client.timeText('2026-10-02T00:00:00Z'), '2026-10-02 08:00'));
  const batch = { id: 'qq-batch', title: '招新', opensAt: '2026-10-02T00:00:00Z', closesAt: '2026-10-10T00:00:00Z', windowState: 'open', closedAt: null, questions: [] };
  let applyBody;
  client.apply = async body => { applyBody = body; return { queryCode: '23456789ABCDEFGH', application: {} }; };
  const newForm = page('recruitment-form');
  newForm.answers = {};
  await newForm.initialize({ mode: 'apply', batch });
  newForm.data.fields = fields;
  await newForm.submit();
  check('新报名仅发送QQ字段且无需登录', () => { assert.strictEqual(applyBody.qqNumber, '0012345'); assert.ok(!('studentNo' in applyBody)); assert.match(applyBody.submissionKey, /^[a-f0-9]{32}$/); });
  client.apply = originalApply;
  const legacyApplication = { id: 'old-record', name: '旧同学', qqNumber: '', grade: '高一', className: '1 班', answers: {}, batch, version: 1, canEdit: true, progress: 'submitted' };
  const editForm = page('recruitment-form');
  editForm.answers = {};
  await editForm.initialize({ mode: 'edit', application: legacyApplication, queryCode: '23456789ABCDEFGH' });
  check('历史报名修改不把旧信息填作QQ', () => { assert.strictEqual(editForm.data.fields.qqNumber, ''); assert.ok(!('studentNo' in editForm.data.fields)); });
  const originalUpdate = client.update;
  let editBody;
  client.update = async body => { editBody = body; return legacyApplication; };
  await editForm.submit();
  check('历史报名修改必须先补QQ', () => { assert.ok(!editBody); assert.ok(editForm.data.fieldError.includes('QQ')); });
  editForm.data.fields.qqNumber = '567890';
  await editForm.submit();
  check('修改报名提交QQ及原查询凭证', () => { assert.strictEqual(editBody.qqNumber, '567890'); assert.strictEqual(editBody.queryCode, '23456789ABCDEFGH'); assert.strictEqual(editBody.version, 1); assert.ok(!('studentNo' in editBody)); });
  client.update = originalUpdate;
  const closedBatch = { ...batch, windowState: 'closed', closedAt: '2026-10-03T01:00:00Z' };
  cloudResponse = { batch: closedBatch };
  const intro = page('recruitment');
  await intro.load();
  check('手动截止优先显示实际时刻', () => { assert.strictEqual(intro.data.closesText, '2026-10-03 09:00'); assert.strictEqual(intro.data.windowText, '报名已手动截止'); });
  const closedForm = page('recruitment-form');
  closedForm.answers = {};
  await closedForm.initialize({ mode: 'apply', batch: closedBatch });
  check('手动截止时不可新报名', () => { assert.strictEqual(closedForm.data.canSubmit, false); assert.strictEqual(closedForm.data.closesText, '2026-10-03 09:00'); });
  const result = page('recruitment-result');
  result._alive = true;
  result.showApplication({ ...legacyApplication, canEdit: false, batch: closedBatch });
  check('历史码查询兼容QQ为空与手动截止', () => { assert.strictEqual(result.data.application.qqNumber, ''); assert.strictEqual(result.data.closesText, '2026-10-03 09:00'); assert.strictEqual(result.data.application.canEdit, false); });
  check('公开结果不渲染历史学号或管理员面试编号', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/recruitment-result/index.wxml'), 'utf8');
    assert.ok(source.includes("application.qqNumber || '未填写'"));
    assert.ok(!source.includes('studentNo') && !source.includes('legacyStudentNo') && !source.includes('interviewSequence'));
  });
  cloudResponse = undefined;
  await transport.request('/admin/notice/list', 'GET', {}, 'admin');
  check('管理端token仍独立', () => assert.strictEqual(envelope.token, 'admin-token'));
  await transport.request('/user/me');
  check('学生端token仍保留', () => assert.strictEqual(envelope.token, 'student-token'));
})().catch(e => { failed++; console.error(e); }).finally(() => {
  console.log = originalLog;
  console.log(`结论：断言 ${count} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
});
