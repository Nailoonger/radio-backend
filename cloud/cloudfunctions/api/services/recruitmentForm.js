'use strict';

const { ApiError, Codes } = require('../lib/response');
const { randomId } = require('./recruitmentCode');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function bad(message) { throw new ApiError(Codes.PARAM_ERROR, message); }
function object(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${label}格式不正确`);
  return value;
}
function keys(value, allowed) {
  object(value);
  if (Object.keys(value).some((k) => !allowed.includes(k))) bad('包含不支持的字段');
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    bad(`请填写${label}`);
  }
  const out = value.trim();
  if (required && !out) bad(`请填写${label}`);
  if (Array.from(out).length > max) bad(`${label}最多 ${max} 字`);
  return out;
}
function id(value, label = '标识') {
  if (typeof value !== 'string' || !/^[a-z\d_-]{1,64}$/i.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) bad(`${label}无效`);
  return value;
}
// 固定信息的默认配置：四项都必填；年级只有高一/初一，班级 1~15 班。
// 超管可在批次配置里改「必填」并维护这两个选项列表（见 fixedFields）。
const FIXED_KEYS = ['name', 'qqNumber', 'grade', 'className'];
const DEFAULT_FIXED_FIELDS = Object.freeze({
  name: { required: true, options: [] },
  qqNumber: { required: true, options: [] },
  grade: { required: true, options: ['高一', '初一'] },
  className: { required: true, options: Array.from({ length: 15 }, (_, index) => `${index + 1}班`) },
});
const FIXED_LABEL = { name: '姓名', qqNumber: 'QQ 号', grade: '年级', className: '班级' };
function optionList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) bad(`${label}选项最多 50 个`);
  const seen = new Set();
  return value.map((raw) => {
    const out = text(raw, label, 40);
    if (seen.has(out)) bad(`${label}选项不可重复`);
    seen.add(out);
    return out;
  });
}
// 只收白名单字段；缺项沿用默认值，避免历史批次（没有 fixedFields）行为突变。
function fixedFields(value) {
  const raw = value === undefined || value === null ? {} : object(value, '固定信息');
  keys(raw, FIXED_KEYS);
  const out = {};
  FIXED_KEYS.forEach((key) => {
    const item = raw[key];
    if (item !== undefined && item !== null) keys(item, ['required', 'options']);
    const fallback = DEFAULT_FIXED_FIELDS[key];
    const required = item && item.required !== undefined ? item.required : fallback.required;
    if (typeof required !== 'boolean') bad('必填设置无效');
    const source = item && item.options !== undefined ? item.options : fallback.options;
    out[key] = { required, options: optionList(source, FIXED_LABEL[key]) };
  });
  return out;
}
// 年级 / 班级：配置了选项就必须是选项之一；没配选项则退回自由文本。
function pick(value, key, config) {
  const label = FIXED_LABEL[key];
  const list = (config && config.options) || [];
  const required = !config || config.required !== false;
  if (!list.length) return text(value, label, 40, required);
  const out = text(value, label, 40, required);
  if (!out) return '';
  if (!list.includes(out)) bad(`${label}请从选项中选择`);
  return out;
}
function time(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  // Require an explicit timezone for strings; local host timezone cannot affect storage.
  let n = value;
  if (typeof value === 'string') {
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) bad(`${label}必须包含时区`);
    n = Date.parse(value);
  }
  if (!Number.isSafeInteger(n) || n < 0 || n > 8640000000000000) bad(`${label}无效`);
  return n;
}
function questions(value) {
  if (!Array.isArray(value) || value.length > 20) bad('自定义问题最多 20 题');
  const ids = new Set();
  return value.map((raw) => {
    keys(raw, ['id', 'type', 'title', 'required', 'options']);
    const qid = raw.id ? id(raw.id, '问题标识') : randomId();
    if (ids.has(qid)) bad('问题标识不可重复');
    ids.add(qid);
    if (!['text', 'textarea', 'single', 'multiple'].includes(raw.type)) bad('不支持的题型');
    if (raw.required !== undefined && typeof raw.required !== 'boolean') bad('必填设置无效');
    const out = { id: qid, type: raw.type, title: text(raw.title, '题目', 200), required: !!raw.required, options: [] };
    if (['single', 'multiple'].includes(out.type)) {
      if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 20) bad('选择题需要 2～20 个选项');
      const optionIds = new Set(); const labels = new Set();
      out.options = raw.options.map((option) => {
        keys(option, ['id', 'label']);
        const oid = option.id ? id(option.id, '选项标识') : randomId();
        const label = text(option.label, '选项', 100);
        if (optionIds.has(oid) || labels.has(label)) bad('选项不可重复');
        optionIds.add(oid); labels.add(label);
        return { id: oid, label };
      });
    } else if (raw.options !== undefined && (!Array.isArray(raw.options) || raw.options.length)) bad('文本题不能配置选项');
    return out;
  });
}
function batch(value, complete = false) {
  const out = {
    title: text(value.title, '批次名称', 100, complete),
    intro: text(value.intro, '招新介绍', 10000, complete),
    opensAt: time(value.opensAt, '开始时间', !complete),
    closesAt: time(value.closesAt, '截止时间', !complete),
    questions: questions(value.questions === undefined ? [] : value.questions),
    fixedFields: fixedFields(value.fixedFields),
  };
  if (out.opensAt !== null && out.closesAt !== null && out.opensAt >= out.closesAt) bad('开始时间必须早于截止时间');
  return out;
}
function application(value, batchRow, legacy = false) {
  const fixed = (batchRow && batchRow.fixedFields) || DEFAULT_FIXED_FIELDS;
  const qs = (batchRow && batchRow.questions) || [];
  const required = (key) => !fixed[key] || fixed[key].required !== false;
  const identity = legacy
    ? { studentNo: text(value.studentNo, '原学号', 32) }
    : { qqNumber: text(value.qqNumber, 'QQ 号', 12, required('qqNumber')) };
  if (!legacy && identity.qqNumber && !/^[0-9]{5,12}$/.test(identity.qqNumber)) bad('QQ 号须为 5～12 位数字');
  // 历史补录（legacy）只用于把升级前的原请求原样重放以取回查询码，
  // 因此不做新规则校验（选项列表是升级后才有的），否则老记录永远对不上 payloadHash。
  const out = {
    name: text(value.name, '姓名', 40, required('name')), ...identity,
    grade: legacy ? text(value.grade, '年级', 40) : pick(value.grade, 'grade', fixed.grade),
    className: legacy ? text(value.className, '班级', 40) : pick(value.className, 'className', fixed.className),
    answers: {},
  };
  const raw = value.answers === undefined ? {} : object(value.answers, '答案');
  if (Object.keys(raw).some((k) => !qs.some((q) => q.id === k))) bad('包含未知问题的答案');
  qs.forEach((q) => {
    const a = own(raw, q.id) ? raw[q.id] : undefined;
    if (q.type === 'text' || q.type === 'textarea') {
      const v = text(a, q.title, q.type === 'text' ? 200 : 2000, q.required);
      if (v) out.answers[q.id] = v;
    } else if (q.type === 'single') {
      if (a === undefined || a === null || a === '') { if (q.required) bad(`请回答${q.title}`); return; }
      if (typeof a !== 'string' || !q.options.some((o) => o.id === a)) bad(`${q.title}的选项无效`);
      out.answers[q.id] = a;
    } else {
      if (a === undefined || a === null) { if (q.required) bad(`请回答${q.title}`); return; }
      if (!Array.isArray(a) || a.length > q.options.length || new Set(a).size !== a.length
        || a.some((v) => typeof v !== 'string' || !q.options.some((o) => o.id === v))) bad(`${q.title}的选项无效`);
      if (!a.length) { if (q.required) bad(`请回答${q.title}`); return; }
      // Selection order is not meaningfully different for retry identity.
      out.answers[q.id] = a.slice().sort();
    }
  });
  return out;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) bad('请提供有效的数据版本');
  return value;
}
module.exports = { own, object, keys, text, id, time, questions, batch, application, version,
  fixedFields, DEFAULT_FIXED_FIELDS, FIXED_KEYS };
