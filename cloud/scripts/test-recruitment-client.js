'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const storage = new Map();
let envelope;
const output = [];
const originalLog = console.log;
console.log = (...args) => output.push(args);
global.getApp = () => ({ globalData: { token: 'student-token', adminToken: 'admin-token' } });
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  getRandomValues: ({ length, success }) => { const bytes = crypto.randomBytes(length); success({ randomValues: Uint8Array.from(bytes).buffer }); },
  cloud: { callFunction: ({ data, success }) => { envelope = data; success({ result: { code: 0, data: { queryCode: '23456789ABCDEFGH', privateText: '学生信息' } } }); } },
};
const transport = require(path.join(__dirname, '../../miniprogram/utils/request'));
const client = require(path.join(__dirname, '../../miniprogram/utils/recruitment'));
let count = 0;
let failed = 0;
function check(name, work) { count++; try { work(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } }
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
  client.savePending(key, { batchId: 'b', name: '张同学' }, { id: 'b' });
  check('可恢复原提交凭证和内容', () => { const value = client.pendingSubmission(); assert.strictEqual(value.submissionKey, key); assert.strictEqual(value.payload.name, '张同学'); });
  client.clearPending();
  check('成功后清理提交凭证', () => assert.ok(!client.pendingSubmission()));
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
  const fields = { name: ' 同学 ', studentNo: '01', grade: '初一', className: '一班' };
  check('固定四项归一化且不校验年级', () => assert.strictEqual(client.normalizeForm(fields, questions, { t: '答', m: ['a'] }).name, '同学'));
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
  await transport.request('/admin/notice/list', 'GET', {}, 'admin');
  check('管理端token仍独立', () => assert.strictEqual(envelope.token, 'admin-token'));
  await transport.request('/user/me');
  check('学生端token仍保留', () => assert.strictEqual(envelope.token, 'student-token'));
})().catch(e => { failed++; console.error(e); }).finally(() => {
  console.log = originalLog;
  console.log(`结论：断言 ${count} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
});
