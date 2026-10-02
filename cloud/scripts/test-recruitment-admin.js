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
// 请求里常夹着「保存后再回读」的次要调用，按名字取最后一次才是被测动作。
const lastNamed = (requests, name) => requests.filter((item) => item.name === name).at(-1);
const batch = (patch = {}) => ({
  id: 'batch-test', title: '测试招新', intro: '测试介绍', version: 1,
  opensAt: '2026-10-10T00:00:00+08:00', closesAt: '2026-10-20T00:00:00+08:00',
  publishedAt: '2026-10-01T00:00:00+08:00', closedAt: '2026-10-03T11:00:00+08:00',
  windowState: 'closed', resultPublishedAt: null, archivedAt: null, unresolvedCount: 1,
  questions: [], orderGeneratedAt: null, interviewOrderCount: 0, ...patch,
});
const application = (id = 'application-1', patch = {}) => ({
  id, batchId: 'batch-test', batch: batch(), name: '测试报名者', qqNumber: '123456789',
  grade: '高一', className: '1班', answers: {}, progress: 'interview', decision: null,
  internalNote: '', publicNote: '', version: 1,
  interview: { at: '2026-10-05T04:00:00Z', location: '广播室', note: '' }, interviewCustom: false, status: 'interview', ...patch,
});

function createPage({ superAdmin = true, overrides = {}, confirm = async () => {}, promptReply = '测试招新' } = {}) {
  const file = fs.readFileSync(path.join(ROOT, 'admin-web/src/views/Recruitment.vue'), 'utf8');
  const script = file.split('<script setup>')[1]?.split('</script>')[0];
  if (!script) throw new Error('Recruitment.vue script setup 未找到');
  const requests = [], warnings = [], confirmations = [], prompts = [];
  const defaultHandlers = {
    listBatches: async () => ({ items: [batch()], total: 1 }), getBatch: async () => batch(),
    listApplications: async () => ({ items: [], total: 0 }), getApplication: async (id) => application(id),
    createBatch: async () => batch(), updateBatch: async () => batch(), publishBatch: async () => batch(),
    publishResults: async () => batch(), archiveBatch: async () => batch(), closeBatch: async () => batch(),
    reviewApplication: async () => application(), arrangeInterview: async () => application(),
    arrangeBatchInterview: async () => batch({ interview: { at: '2026-10-05T04:00:00Z', location: '广播室', note: '' } }),
    deleteBatch: async () => ({ id: 'batch-test', title: '测试招新', deletedApplications: 1 }),
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
    ElMessageBox: {
      confirm: async (...args) => { confirmations.push(args); return confirm(...args); },
      prompt: async (...args) => {
        prompts.push(args);
        if (typeof promptReply === 'function') return { value: promptReply(...args) };
        if (promptReply === null) throw new Error('cancel');
        return { value: promptReply };
      },
    },
    EmptyState: {}, useAuthStore: () => ({ isSuperAdmin: superAdmin }),
    clearPageHeader: () => {}, setPageHeader: () => {}, recruitmentAvailable: true,
    recruitmentUnavailableMessage: '', crypto: crypto.webcrypto, Date: TestDate, Intl,
    URL, Blob, document: {}, setTimeout, module, ...handlers,
  });
  const expose = [
    'isClosed', 'batchState', 'canGenerateOrder', 'selectedBatch', 'config', 'configStarted', 'openConfig',
    'canEditFixed', 'fixedFieldsPayload', 'validateConfig', 'saveConfig', 'FIXED_FIELDS', 'OPTION_FIELDS',
    'detail', 'detailVisible', 'detailRows', 'detailDirty', 'detailLoading', 'removeBatch',
    'planVisible', 'planBatch', 'planForm', 'planRoster', 'planQuery', 'canPlan', 'canEditSolo', 'openPlan',
    'savePlan', 'clearPlanConfirm', 'openSolo', 'soloVisible', 'soloTarget', 'soloForm', 'saveSolo', 'clearSolo',
    'reviewForm', 'assignDetail', 'canReview', 'saveReview',
    'openApplication', 'navigateDetail', 'closeDetail', 'beforeDetailClose', 'clearDetail', 'generateOrder',
  ];
  new vm.Script(`${script.replace(IMPORTS, '')}\nmodule.exports = { ${expose.join(',')} };`, {
    filename: 'Recruitment.vue/script-setup',
  }).runInContext(context);
  return { page: module.exports, requests, warnings, confirmations, prompts };
}

function createFacade(mode, cloudUrl = 'https://offline.invalid/api') {
  const requests = [];
  const http = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, async (...args) => {
    requests.push({ method, args }); return null;
  }]));
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(ROOT, 'admin-web/src/api/recruitment.js'), 'utf8')
    .replace(IMPORTS, '').replace(/^export /gm, '');
  const context = vm.createContext({ http, requestMode: mode, cloudApiUrl: cloudUrl, module });
  new vm.Script(`${source}\nmodule.exports = { closeBatch, generateInterviewOrder, getInterviewOrder, exportInterviewOrder, arrangeBatchInterview, deleteBatch };`, {
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
    await api.arrangeBatchInterview('batch-test', { version: 10, at: null, location: '', note: '' });
    equal(requests.at(-1).method, 'put', '批次统一面试安排使用 PUT');
    equal(requests.at(-1).args[0], '/admin/recruitment/batches/batch-test/interview', '统一安排走批次级面试接口');
    equal(normalized(requests.at(-1).args[1]), { version: 10, at: null, location: '', note: '' }, '清除统一安排原样传 at: null');
    await api.deleteBatch('batch/id?', { confirm: '测试招新' });
    equal(requests.at(-1).method, 'delete', '删除批次使用 DELETE');
    equal(requests.at(-1).args[0], '/admin/recruitment/batches/batch%2Fid%3F', '删除批次标识正确编码');
    equal(normalized(requests.at(-1).args[1]), { confirm: '测试招新' }, '删除批次携带原文确认');
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

  await scenario('批次级统一面试安排与清除', async () => {
    // 统一安排保存在批次上：用带 interview 的批次回读，验证「保存 → 回读」这条链。
    const plan = { at: '2026-10-05T04:00:00Z', location: '广播室', note: '请提前到场' };
    const { page, requests, warnings } = createPage({ overrides: {
      arrangeBatchInterview: async () => batch({ interview: plan }),
      getBatch: async () => batch({ interview: plan }),
    } });
    page.selectedBatch.value = batch(); page.planBatch.value = batch(); page.planVisible.value = true;
    equal(page.canPlan.value, true, '报名截止后可统一安排面试');
    page.planForm.at = '2026-10-05 12:00:00'; page.planForm.location = ' 广播室 '; page.planForm.note = '请提前到场';
    await page.savePlan();
    const saved = lastNamed(requests, 'arrangeBatchInterview');
    equal(!!saved, true, '统一安排调用批次级接口');
    equal(saved.args[1].at, Date.parse('2026-10-05T12:00:00+08:00'), '北京时间输入转换为正确 UTC 时间');
    equal(saved.args[1].location, '广播室', '地点去空白后提交');
    equal(page.planBatch.value.interview.location, '广播室', '统一安排回读为服务端响应');
    equal(page.selectedBatch.value.interview.location, '广播室', '批次摘要同步最新安排');
    page.planForm.location = '';
    const before = requests.filter((item) => item.name === 'arrangeBatchInterview').length;
    await page.savePlan();
    equal(requests.filter((item) => item.name === 'arrangeBatchInterview').length, before, '缺地点时不发请求');
    equal(warnings.some((message) => message.includes('面试时间和地点')), true, '缺地点给出明确提示');
    await page.clearPlanConfirm();
    equal(requests.filter((item) => item.name === 'arrangeBatchInterview').at(-1).args[1].at, null, '清除统一安排用 at: null');
    const locked = createPage({});
    locked.page.planBatch.value = batch({ resultPublishedAt: new Date(NOW).toISOString() });
    equal(locked.page.canPlan.value, false, '结果发布后统一安排锁定');
    locked.page.planForm.at = '2026-10-05 12:00:00'; locked.page.planForm.location = '广播室';
    await locked.page.savePlan();
    equal(locked.requests.filter((item) => item.name === 'arrangeBatchInterview').length, 0, '锁定后越过按钮也不发请求');
  });

  await scenario('单人单独配置与恢复统一安排', async () => {
    const solo = application('application-2', { version: 4, interviewCustom: true, interview: { at: '2026-10-06T04:00:00Z', location: '小会议室', note: '' } });
    const { page, requests, warnings } = createPage({ overrides: {
      arrangeInterview: async (id, body) => (body.at === null
        ? application(id, { version: 5, interviewCustom: false, interview: { at: '2026-10-05T04:00:00Z', location: '广播室', note: '' } })
        : solo),
    } });
    page.planBatch.value = batch(); page.planVisible.value = true;
    equal(page.canEditSolo(application('application-2', { version: 3 })), true, '未定结果的报名可单独配置');
    equal(page.canEditSolo(application('application-3', { status: 'withdrawn' })), false, '已撤回不可单独配置');
    equal(page.canEditSolo(application('application-4', { decision: 'rejected', status: 'rejected' })), false, '已有决定不可单独配置');
    const target = application('application-2', { version: 3 });
    page.openSolo(target);
    equal(page.soloVisible.value, true, '打开单独配置弹窗');
    equal(page.soloForm.location, '广播室', '弹窗带入现有面试信息');
    page.soloForm.location = ' 小会议室 ';
    await page.saveSolo();
    const saved = lastNamed(requests, 'arrangeInterview');
    equal(!!saved, true, '单独配置调用单人面试接口');
    equal(saved.args[0], 'application-2', '只对目标报名发起请求');
    equal(saved.args[1].at, Date.parse('2026-10-05T12:00:00+08:00'), '弹窗带入的北京时间原样换算回 UTC');
    equal(page.soloVisible.value, false, '保存后关闭弹窗');
    page.openSolo(solo);
    const before = requests.filter((item) => item.name === 'arrangeInterview').length;
    page.soloForm.at = '';
    await page.saveSolo();
    equal(requests.filter((item) => item.name === 'arrangeInterview').length, before, '缺时间不重复提交');
    equal(warnings.some((message) => message.includes('面试时间和地点')), true, '单人缺时间给出提示');
    page.soloForm.at = '2026-10-06 12:00:00';
    await page.clearSolo();
    equal(requests.filter((item) => item.name === 'arrangeInterview').at(-1).args[1].at, null, '恢复统一安排用 at: null');
    equal(page.soloVisible.value, false, '恢复后关闭弹窗');
  });

  await scenario('删除批次要求原样输入批次名称', async () => {
    const cancelled = createPage({ promptReply: null });
    await cancelled.page.removeBatch(batch());
    equal(cancelled.requests.filter((item) => item.name === 'deleteBatch').length, 0, '取消输入不发删除请求');

    const mismatched = createPage({ promptReply: '别的批次' });
    await mismatched.page.removeBatch(batch());
    equal(mismatched.requests.filter((item) => item.name === 'deleteBatch').length, 0, '批次名称不匹配不发删除请求');
    equal(mismatched.warnings.some((message) => message.includes('名称不一致')), true, '名称不匹配给出提示');
    equal(mismatched.prompts.length, 1, '删除前必须弹输入框确认');

    const { page, requests, confirmations } = createPage();
    page.selectedBatch.value = batch();
    await page.removeBatch(batch({ unresolvedCount: 3 }));
    const removed = lastNamed(requests, 'deleteBatch');
    equal(!!removed, true, '确认后调用删除接口');
    equal(removed.args[0], 'batch-test', '按批次标识删除');
    equal(removed.args[1].confirm, '测试招新', '把批次名称原样交给云端复核');
    equal(page.selectedBatch.value, null, '删除当前选中批次后清空选中');
    equal(confirmations.length, 0, '删除只用输入确认，不叠加二次弹窗');
  });

  await scenario('处理台只保留审核决定', async () => {
    const reviewed = application('application-1', { version: 3, internalNote: '审核草稿' });
    const { page, requests, warnings } = createPage({ overrides: { reviewApplication: async () => reviewed } });
    page.assignDetail(application());
    page.reviewForm.internalNote = '审核草稿'; page.reviewForm.decision = 'accepted';
    equal(!!page.canReview.value, true, '截止后允许审核');
    await page.saveReview();
    equal(lastNamed(requests, 'reviewApplication').args[1].decision, 'accepted', '审核决定随请求提交');
    equal(page.detail.value.internalNote, '审核草稿', '审核备注更新为服务端响应');
    equal(page.detailDirty.value, false, '保存后不再有未保存修改');
    page.reviewForm.decision = '';
    const before = requests.length;
    await page.saveReview();
    equal(requests.length, before + 1, '仅保存审核备注可独立提交');
    equal(lastNamed(requests, 'reviewApplication').args[1].decision, undefined, '未选决定时不携带该字段');
    equal(warnings.length, 0, '正常审核流程不产生警告');
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
