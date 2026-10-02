// 公开招新门面：查询码仅在页面及一次性内存通信中存在，不写 URL 或长期缓存。
const transport = require('./request.js');
const PENDING_KEY = 'recruitment_pending_submission';
const RETRY_TTL = 24 * 60 * 60 * 1000;
let nextContext = null;

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
    return saved;
  } catch (e) { return null; }
}

function savePending(submissionKey, payload, batch) {
  const saved = { submissionKey, payload, batch, expiresAt: Date.now() + RETRY_TTL };
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
function normalizeForm(fields, questions, answers = {}) {
  const limits = { name: 40, studentNo: 32, grade: 40, className: 40 };
  const labels = { name: '姓名', studentNo: '学号', grade: '年级', className: '班级' };
  const payload = {};
  Object.keys(limits).forEach((key) => {
    const value = String(fields[key] || '').trim();
    if (!value) throw { code: 40001, message: '请填写' + labels[key] };
    if (charLength(value) > limits[key]) throw { code: 40001, message: labels[key] + '最多 ' + limits[key] + ' 字' };
    payload[key] = value;
  });
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
    40911: '该学号已报名，请使用原查询码查询；遗失查询码请联系广播站',
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
  normalizeForm, decorateQuestions, timeText, errorText, charLength,
};
