// 公开招新门面：查询码仅在页面及一次性内存通信中存在，不写 URL 或长期缓存。
const transport = require('./request.js');
const PENDING_KEY = 'recruitment_pending_submission';
const RETRY_TTL = 24 * 60 * 60 * 1000;
// v3：QQ 号可为选填（超管可关掉它的「必填」），年级/班级改成从选项里挑。
const FORM_VERSION = 3;
let nextContext = null;

// —— 固定信息：默认四项都必填；年级只有高一/初一，班级 1~15 班。——
// 与云端 recruitmentForm.DEFAULT_FIXED_FIELDS 保持一致；历史批次（没有 fixedFields）走这里的默认值。
const FIXED_LIMITS = { name: 40, qqNumber: 12, grade: 40, className: 40 };
const FIXED_LABELS = { name: '姓名', qqNumber: 'QQ 号', grade: '年级', className: '班级' };
const DEFAULT_FIXED_FIELDS = {
  name: { required: true, options: [] },
  qqNumber: { required: true, options: [] },
  grade: { required: true, options: ['高一', '初一'] },
  className: { required: true, options: Array.from({ length: 15 }, (_, i) => (i + 1) + '班') },
};
function fixedOf(source) {
  const out = {};
  Object.keys(FIXED_LIMITS).forEach((key) => {
    const item = source && source[key];
    const fallback = DEFAULT_FIXED_FIELDS[key];
    out[key] = {
      required: item && typeof item.required === 'boolean' ? item.required : fallback.required,
      options: item && Array.isArray(item.options) ? item.options.map(String) : fallback.options.slice(),
    };
  });
  return out;
}
// 空串表示「选填且没填」；非空则必须是 5～12 位数字（重试凭证也用同一条判据）。
function validQq(value) { return typeof value === 'string' && (value === '' || /^\d{5,12}$/.test(value)); }

function api(path, method = 'GET', body = {}) {
  if (transport.getMode() !== 'cloud') {
    return Promise.reject({ code: -1, message: '招新服务暂不可用，请稍后再试' });
  }
  return transport.request('/user/recruitment/' + path, method, body, 'public', { sensitive: true });
}

function setContext(context) { nextContext = context; }
function takeContext() {
  const context = nextContext;
  nextContext = null;
  return context;
}
function clearContext() { nextContext = null; }

function pendingSubmission() {
  try {
    const saved = wx.getStorageSync(PENDING_KEY);
    if (!saved) return null;
    if (!saved.expiresAt || saved.expiresAt <= Date.now() || !saved.submissionKey || !saved.payload) {
      wx.removeStorageSync(PENDING_KEY);
      return null;
    }
    const owns = (key) => Object.prototype.hasOwnProperty.call(saved.payload, key);
    if ((saved.formVersion === FORM_VERSION || saved.formVersion === 2)
      && owns('qqNumber') && !owns('studentNo') && validQq(saved.payload.qqNumber)) return saved;
    // 旧表单仅凭原 key 原 payload 向服务端恢复已存在的报名，不能将学号转换成 QQ 或另建记录。
    if (!owns('qqNumber') && owns('studentNo') && typeof saved.payload.studentNo === 'string'
      && (saved.formVersion === undefined || saved.formVersion === 1)) return { ...saved, legacyRetry: true };
    wx.removeStorageSync(PENDING_KEY);
    return null;
  } catch (e) { return null; }
}

function savePending(submissionKey, payload, batch) {
  if (!payload || !validQq(payload.qqNumber) || Object.prototype.hasOwnProperty.call(payload, 'studentNo')) {
    throw { code: 40001, message: 'QQ 号须为 5～12 位数字（选填的批次可以留空）' };
  }
  const saved = { formVersion: FORM_VERSION, submissionKey, payload, batch, expiresAt: Date.now() + RETRY_TTL };
  // 保存失败时禁止发送请求，否则首次响应丢失后无法安全重试。
  try { wx.setStorageSync(PENDING_KEY, saved); }
  catch (e) { throw { code: -1, message: '无法保存本次提交凭证，请检查设备存储后重试' }; }
  return saved;
}
function clearPending() {
  try { wx.removeStorageSync(PENDING_KEY); } catch (e) {}
}

function submissionKey() {
  return new Promise((resolve, reject) => {
    const fail = () => reject({ code: -1, message: '无法生成安全提交凭证，请升级微信后重试' });
    if (typeof wx.getRandomValues !== 'function') return fail();
    wx.getRandomValues({
      length: 16,
      success(res) {
        const bytes = new Uint8Array(res.randomValues || new ArrayBuffer(0));
        if (bytes.length !== 16) return fail();
        resolve(Array.from(bytes).map((byte) => ('0' + byte.toString(16)).slice(-2)).join(''));
      },
      fail,
    });
  });
}

function charLength(value) { return Array.from(String(value || '')).length; }
// fixedFields 来自批次 DTO；不传则按默认配置（四项必填、年级/班级走默认选项）校验。
function normalizeForm(fields, questions, answers = {}, fixedFields) {
  const fixed = fixedOf(fixedFields);
  // QQ 号必须是字符串：数字会丢前导零（'0012345' → 12345），一律拒绝。
  if (fields.qqNumber !== undefined && fields.qqNumber !== null && typeof fields.qqNumber !== 'string') {
    throw { code: 40001, message: 'QQ 号须为 5～12 位数字' };
  }
  const payload = {};
  Object.keys(FIXED_LIMITS).forEach((key) => {
    const rule = fixed[key];
    const label = FIXED_LABELS[key];
    const value = String(fields[key] || '').trim();
    if (!value) {
      if (rule.required) throw { code: 40001, message: '请填写' + label };
      payload[key] = '';
      return;
    }
    if (charLength(value) > FIXED_LIMITS[key]) throw { code: 40001, message: label + '最多 ' + FIXED_LIMITS[key] + ' 字' };
    if (rule.options.length && rule.options.indexOf(value) === -1) throw { code: 40001, message: '请从给出的' + label + '选项中选择' };
    payload[key] = value;
  });
  if (payload.qqNumber && !/^\d{5,12}$/.test(payload.qqNumber)) throw { code: 40001, message: 'QQ 号应为 5～12 位数字' };
  payload.answers = {};
  (questions || []).forEach((question) => {
    const raw = answers[question.id];
    let value;
    if (question.type === 'text' || question.type === 'textarea') {
      value = String(raw || '').trim();
      const limit = question.type === 'text' ? 200 : 2000;
      if (charLength(value) > limit) throw { code: 40001, message: '「' + question.title + '」最多 ' + limit + ' 字' };
    } else {
      value = question.type === 'multiple' ? (Array.isArray(raw) ? raw : []) : String(raw || '');
      const choices = question.type === 'multiple' ? value : (value ? [value] : []);
      const ids = (question.options || []).map((option) => option.id);
      if (choices.some((id) => ids.indexOf(id) === -1) || new Set(choices).size !== choices.length) {
        throw { code: 40001, message: '请重新选择「' + question.title + '」' };
      }
    }
    if (question.required && !value.length) throw { code: 40001, message: '请回答「' + question.title + '」' };
    if (value.length) payload.answers[question.id] = value;
  });
  return payload;
}

// 招新范围文案由批次的年级选项派生，别再写死「仅限高一、初一」。
function gradeScopeText(fixedSource) {
  const options = fixedOf(fixedSource).grade.options;
  return options.length ? '限' + options.join('、') + '学生报名。' : '年级请如实填写。';
}

// 顶部说明随配置变化：必填项和「从选项里挑」的都是超管在后台定的，不能写死。
function fixedHint(fixed) {
  const required = Object.keys(FIXED_LIMITS).filter((key) => fixed[key].required).map((key) => FIXED_LABELS[key]);
  const picked = ['grade', 'className'].filter((key) => fixed[key].options.length).map((key) => FIXED_LABELS[key]);
  const parts = [required.length ? '带 * 的 ' + required.join('、') + ' 必填' : '以下信息均为选填'];
  if (picked.length) parts.push(picked.join('、') + '请从给出的选项中选择');
  return parts.join('；') + '。';
}

function decorateQuestions(questions, answers = {}) {
  return (questions || []).map((question) => {
    const answer = answers[question.id];
    const selected = Array.isArray(answer) ? answer : (answer ? [answer] : []);
    const options = (question.options || []).map((option) => ({ ...option, checked: selected.indexOf(option.id) >= 0 }));
    return {
      ...question,
      value: typeof answer === 'string' ? answer : '',
      options,
      answerText: question.type === 'single' || question.type === 'multiple'
        ? options.filter((option) => option.checked).map((option) => option.label).join('、') || '未填写'
        : answer || '未填写',
    };
  });
}

function timeText(value) {
  if (!value) return '';
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return '';
  // 固定北京时间，设备时区不会改变展示。
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate())
    + ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
}

function errorText(error) {
  const messages = {
    40404: '查询码无效，请检查后重试',
    40304: '当前不在报名时间内，无法提交、修改或撤回',
    40910: '报名信息已更新，请重新查询后操作；提交重试请保留原内容',
    40911: '该 QQ 号已报名，请使用原查询码查询；遗失查询码请联系广播站',
    40912: '当前报名状态不允许此操作，请重新查询',
    42901: '操作过于频繁，请稍后重试',
  };
  return messages[error && error.code] || (error && error.message) || '服务暂不可用，请稍后重试';
}

function navigate(url, context, options = {}) {
  setContext(context);
  wx.navigateTo({ ...options, url, fail() { clearContext(); wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); } });
}

function goBack() {
  if (getCurrentPages().length > 1) wx.navigateBack();
  else wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
}

module.exports = {
  current: () => api('current'),
  apply: (body) => api('apply', 'POST', body),
  query: (queryCode) => api('query', 'POST', { queryCode }),
  update: (body) => api('application', 'PUT', body),
  withdraw: (queryCode, version) => api('withdraw', 'POST', { queryCode, version }),
  resubmit: (body) => api('resubmit', 'POST', body),
  setContext, takeContext, clearContext, navigate, goBack,
  pendingSubmission, savePending, clearPending, submissionKey,
  normalizeForm, decorateQuestions, timeText, errorText, charLength, fixedOf, fixedHint, gradeScopeText, validQq,
};
