#!/usr/bin/env node
'use strict';

// Execute the real script-setup and API facade with isolated, offline dependencies.
// The release CI installs admin-web dependencies before running cloud regression.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
const vue = require(path.join(ROOT, 'admin-web/node_modules/vue'));
const IMPORTS = /^import[\s\S]*?from\s+['"][^'"]+['"];?\r?$/gm;
const NOW = Date.parse('2026-10-03T12:00:00+08:00');
class TestDate extends Date { static now() { return NOW; } }
let passed = 0;
let failed = 0;

function equal(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); passed++; }
  catch { failed++; console.error(`失败：${label}`); }
}
async function rejects(work, predicate, label) {
  try { await assert.rejects(work, predicate); passed++; }
  catch { failed++; console.error(`失败：${label}`); }
}
async function scenario(label, work) {
  try { await work(); }
  catch (error) { failed++; console.error(`失败：${label}（${error?.message || '意外异常'}）`); }
}
const normalized = (value) => JSON.parse(JSON.stringify(value));
const batch = (patch = {}) => ({
  id: 'batch-test', title: '测试招新', intro: '测试介绍', version: 1,
  opensAt: '2026-10-10T00:00:00+08:00', closesAt: '2026-10-20T00:00:00+08:00',
  publishedAt: '2026-10-01T00:00:00+08:00', closedAt: '2026-10-03T11:00:00+08:00',
  windowState: 'closed', resultPublishedAt: null, archivedAt: null, unresolvedCount: 1,
  questions: [], orderGeneratedAt: null, interviewOrderCount: 0, ...patch,
});
const application = (id = 'application-1', patch = {}) => ({
  id, batchId: 'batch-test', batch: batch(), name: '测试报名者', qqNumber: '123456789',
  grade: '高一', className: '1 班', answers: {}, progress: 'interview', decision: null,
  internalNote: '', publicNote: '', version: 1,
  interview: { at: '2026-10-05T04:00:00Z', location: '广播室', note: '' }, ...patch,
});

function createPage({ superAdmin = true, overrides = {}, confirm = async () => {} } = {}) {
  const file = fs.readFileSync(path.join(ROOT, 'admin-web/src/views/Recruitment.vue'), 'utf8');
  const script = file.split('<script setup>')[1]?.split('</script>')[0];
  if (!script) throw new Error('Recruitment.vue script setup 未找到');
  const requests = [], warnings = [], confirmations = [];
  const defaultHandlers = {
    listBatches: async () => ({ items: [batch()], total: 1 }), getBatch: async () => batch(),
    listApplications: async () => ({ items: [], total: 0 }), getApplication: async (id) => application(id),
    createBatch: async () => batch(), updateBatch: async () => batch(), publishBatch: async () => batch(),
    publishResults: async () => batch(), archiveBatch: async () => batch(), closeBatch: async () => batch(),
    reviewApplication: async () => application(), arrangeInterview: async () => application(),
    generateInterviewOrder: async () => batch({ orderGeneratedAt: new Date(NOW).toISOString(), interviewOrderCount: 1 }),
    getInterviewOrder: async () => ({ batch: batch(), items: [], total: 0, orderGeneratedAt: null }),
    exportInterviewOrder: async () => new Blob([]),
  };
  const handlers = Object.fromEntries(Object.entries(defaultHandlers).map(([name, fallback]) => [name, async (...args) => {
    requests.push({ name, args });
    return (overrides[name] || fallback)(...args);
  }]));
  const module = { exports: {} };
  const context = vm.createContext({
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed,
    onMounted: () => {}, onBeforeUnmount: () => {},
    ElMessage: { warning: (message) => warnings.push(message), success: () => {} },
    ElMessageBox: { confirm: async (...args) => { confirmations.push(args); return confirm(...args); } },
    EmptyState: {}, useAuthStore: () => ({ isSuperAdmin: superAdmin }),
    clearPageHeader: () => {}, setPageHeader: () => {}, recruitmentAvailable: true,
    recruitmentUnavailableMessage: '', crypto: crypto.webcrypto, Date: TestDate, Intl,
    URL, Blob, document: {}, setTimeout, module, ...handlers,
  });
  const expose = [
    'isClosed', 'batchState', 'canGenerateOrder', 'selectedBatch', 'config', 'configStarted', 'openConfig',
    'detail', 'detailVisible', 'detailRows', 'detailDirty', 'interviewDirty', 'detailLoading',
    'interviewForm', 'reviewForm', 'assignDetail', 'canReview', 'saveInterview', 'saveReview',
    'openApplication', 'navigateDetail', 'closeDetail', 'beforeDetailClose', 'clearDetail', 'generateOrder',
  ];
  new vm.Script(`${script.replace(IMPORTS, '')}\nmodule.exports = { ${expose.join(',')} };`, {
    filename: 'Recruitment.vue/script-setup',
  }).runInContext(context);
  return { page: module.exports, requests, warnings, confirmations };
}

function createFacade(mode, cloudUrl = 'https://offline.invalid/api') {
  const requests = [];
  const http = Object.fromEntries(['get', 'post', 'put'].map((method) => [method, async (...args) => {
    requests.push({ method, args }); return null;
  }]));
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(ROOT, 'admin-web/src/api/recruitment.js'), 'utf8')
    .replace(IMPORTS, '').replace(/^export /gm, '');
  const context = vm.createContext({ http, requestMode: mode, cloudApiUrl: cloudUrl, module });
  new vm.Script(`${source}\nmodule.exports = { closeBatch, generateInterviewOrder, getInterviewOrder, exportInterviewOrder };`, {
    filename: 'api/recruitment.js',
  }).runInContext(context);
  return { api: module.exports, requests };
}

async function main() {
  await scenario('手动截止与结果发布锁定', async () => {
    const { page, requests } = createPage();
    equal(page.isClosed(batch()), true, '尚未开放的批次手动截止后即为关闭');
    equal(page.batchState(batch()), '报名已截止', '手动截止优先于未来开始时间');
    equal(page.isClosed(batch({ closedAt: null, windowState: 'upcoming' })), false, '未手动截止的未来窗口仍未关闭');
    equal(page.canGenerateOrder(batch()), true, '截止后的超管可生成顺序');
    page.openConfig(batch());
    equal(page.configStarted.value, true, '手动截止后原计划时间锁定');
    equal(page.config.closesAt, '2026-10-20 00:00:00', '原定截止时间保留');
    page.assignDetail(application());
    equal(!!page.canReview.value, true, '提前截止后允许审核');
    page.assignDetail(application('application-1', { batch: batch({ resultPublishedAt: new Date(NOW).toISOString() }) }));
    equal(!!page.canReview.value, false, '结果发布后审核只读');
    page.reviewForm.internalNote = '不可提交的编辑';
    await page.saveReview();
    equal(requests.length, 0, '结果发布后保存按钮逻辑不发审核请求');
    equal(page.canGenerateOrder(batch({ resultPublishedAt: new Date(NOW).toISOString() })), false, '结果发布后禁止生成顺序');
  });

  await scenario('普通管理员的生成权限', async () => {
    const { page, requests, confirmations } = createPage({ superAdmin: false });
    page.selectedBatch.value = batch();
    equal(page.canGenerateOrder(batch()), false, '普通管理员不可生成面试顺序');
    await page.generateOrder();
    equal(requests.length, 0, '越过按钮调用生成逻辑仍不发请求');
    equal(confirmations.length, 0, '普通管理员不进入生成确认');
    page.assignDetail(application());
    equal(!!page.canReview.value, true, '普通管理员仍可在截止后审核');
  });

  await scenario('云请求合同与直连护栏', async () => {
    const { api, requests } = createFacade('cloud');
    await api.closeBatch('batch/id?', 7);
    equal(requests.at(-1).method, 'post', '手动截止使用 POST');
    equal(requests.at(-1).args[0], '/admin/recruitment/batches/batch%2Fid%3F/close', '批次标识正确编码');
    equal(normalized(requests.at(-1).args[1]), { version: 7 }, '截止只携带版本');
    await api.generateInterviewOrder('batch-test', 8);
    equal(normalized(requests.at(-1).args[1]), { version: 8 }, '首次生成不携带覆盖凭证');
    await api.generateInterviewOrder('batch-test', 9, true);
    equal(normalized(requests.at(-1).args[1]), { version: 9, confirm: 'REGENERATE' }, '重新生成携带明确覆盖凭证');
    await api.getInterviewOrder('batch-test', { page: 3, pageSize: 20 });
    equal(normalized(requests.at(-1).args[1].params), { page: 3, pageSize: 20 }, '顺序查看分页参数原样发送');
    await api.exportInterviewOrder('batch-test');
    equal(requests.at(-1).args[0], '/admin/recruitment/batches/batch-test/interview-order/export', '导出使用独立完整名单接口');
    equal(requests.at(-1).args[1].responseType, 'blob', '云文件响应还原为 Blob');
    equal(requests.at(-1).args[1].params, undefined, '完整导出不携带当前列表分页');
    const direct = createFacade('direct');
    await rejects(() => direct.api.closeBatch('batch-test', 1), (error) => error.code === 'RECRUITMENT_CLOUD_REQUIRED', '直连模式拒绝招新写入');
    equal(direct.requests.length, 0, '直连护栏不调用不存在的 Express 接口');
    const missingUrl = createFacade('cloud', '');
    await rejects(() => missingUrl.api.exportInterviewOrder('batch-test'), (error) => error.code === 'RECRUITMENT_CLOUD_REQUIRED', '未配置云地址拒绝导出');
    equal(missingUrl.requests.length, 0, '缺云地址时不发请求');
  });

  await scenario('未保存时取消关闭与切换', async () => {
    const { page, requests, confirmations } = createPage({ confirm: async () => { throw new Error('cancel'); } });
    page.assignDetail(application()); page.detailVisible.value = true;
    page.detailRows.value = [{ id: 'application-1' }, { id: 'application-2' }];
    page.reviewForm.internalNote = '未保存的审核草稿';
    await page.navigateDetail(1);
    equal(page.detail.value.id, 'application-1', '取消切换后仍显示当前报名');
    equal(requests.length, 0, '取消切换不读取下一条');
    await page.closeDetail();
    equal(page.detailVisible.value, true, '取消关闭保留处理台');
    equal(page.reviewForm.internalNote, '未保存的审核草稿', '取消关闭保留草稿');
    let closed = 0;
    await page.beforeDetailClose(() => { closed++; });
    equal(closed, 0, 'Escape 关闭回调也遵守未保存确认');
    equal(confirmations.length, 3, '切换和两种关闭入口都提示未保存修改');
  });

  await scenario('保存面试与审核时保留另一份草稿', async () => {
    const arranged = application('application-1', { version: 2, interview: { at: '2026-10-05T04:00:00Z', location: '新广播室', note: '' } });
    const reviewed = application('application-1', { ...arranged, version: 3, internalNote: '审核草稿' });
    const { page, requests, warnings } = createPage({ overrides: {
      arrangeInterview: async () => arranged, reviewApplication: async () => reviewed,
    } });
    page.assignDetail(application());
    page.reviewForm.internalNote = '审核草稿'; page.reviewForm.decision = 'accepted';
    page.interviewForm.location = '新广播室';
    await page.saveInterview();
    equal(requests[0]?.name, 'arrangeInterview', '保存面试调用真实请求门面');
    equal(requests[0]?.args[1].at, Date.parse('2026-10-05T04:00:00Z'), '北京时间输入转换为正确 UTC 时间');
    equal(page.detail.value.interview.location, '新广播室', '已保存的面试更新为服务端响应');
    equal(page.reviewForm.internalNote, '审核草稿', '保存面试保留审核备注草稿');
    equal(page.reviewForm.decision, 'accepted', '保存面试保留尚未保存的决定');
    equal(page.detailDirty.value, true, '未保存审核草稿仍被识别');
    page.interviewForm.note = '尚未保存的面试说明';
    const before = requests.length;
    await page.saveReview();
    equal(requests.length, before, '保存最终决定前阻断未保存的面试安排');
    equal(warnings.some((message) => message.includes('请先保存面试安排')), true, '提醒先保存面试安排');
    page.reviewForm.decision = '';
    await page.saveReview();
    equal(requests.at(-1).name, 'reviewApplication', '仅保存审核备注可独立提交');
    equal(page.detail.value.internalNote, '审核草稿', '审核备注更新为服务端响应');
    equal(page.interviewForm.note, '尚未保存的面试说明', '保存审核备注保留面试草稿');
    equal(page.detailDirty.value, true, '剩余面试草稿仍需离开确认');
  });

  await scenario('确认放弃后切换到下一条', async () => {
    const { page, requests } = createPage();
    page.assignDetail(application()); page.detailVisible.value = true;
    page.detailRows.value = [{ id: 'application-1' }, { id: 'application-2' }];
    page.reviewForm.publicNote = '未保存的对外说明';
    await page.navigateDetail(1);
    equal(requests[0]?.args[0], 'application-2', '确认放弃后读取下一条');
    equal(page.detail.value.id, 'application-2', '处理台显示下一条服务端资料');
    equal(page.reviewForm.publicNote, '', '旧草稿不混入下一条');
    equal(page.detailDirty.value, false, '新报名初始状态无未保存修改');
  });

  await scenario('详情请求竞态与关闭失效', async () => {
    const pending = new Map();
    const { page } = createPage({ overrides: {
      getApplication: (id) => new Promise((resolve) => pending.set(id, resolve)),
    } });
    const first = page.openApplication({ id: 'application-1' });
    const second = page.openApplication({ id: 'application-2' });
    for (let i = 0; i < 20 && !pending.has('application-2'); i++) await Promise.resolve();
    if (!pending.has('application-2')) throw new Error('第二个详情请求未启动');
    pending.get('application-2')(application('application-2')); await second;
    pending.get('application-1')(application('application-1')); await first;
    equal(page.detail.value.id, 'application-2', '较早响应不能覆盖后打开的报名');
    equal(page.detailLoading.value, false, '新详情响应完成后加载态正确结束');
    const closing = page.openApplication({ id: 'application-3' });
    for (let i = 0; i < 20 && !pending.has('application-3'); i++) await Promise.resolve();
    if (!pending.has('application-3')) throw new Error('关闭测试请求未启动');
    page.detailVisible.value = false; page.clearDetail();
    pending.get('application-3')(application('application-3')); await closing;
    equal(page.detail.value, null, '关闭后在途响应不恢复旧报名资料');
    equal(page.detailRows.value.length, 0, '关闭后清理导航上下文');
  });

  console.log(`结论：断言 ${passed + failed} 项 / 失败 ${failed} 项`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  failed++;
  console.error(`失败：测试初始化（${error?.message || '意外异常'}）`);
  console.log(`结论：断言 ${passed + failed} 项 / 失败 ${failed} 项`);
  process.exitCode = 1;
});
