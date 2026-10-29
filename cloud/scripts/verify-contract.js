#!/usr/bin/env node
'use strict';

/**
 * 前后端接口对齐检查（运行时）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/verify-contract.js
 *
 * ═══════════ 和 check-contract.js 的分工 ═══════════
 *   check-contract.js  静态：前端调的**路径**在不在路由表里（抓 404）
 *   verify-contract.js 运行时：后端真实返回的**字段**符不符合契约（抓字段漂移）
 *
 * 后者更重要也更难抓。路径写错会立刻 404，一眼就现；
 * 字段漂移是**静默**的 —— 后端把 `dutyRoles` 改名 `roles`，
 * 前端读到 undefined，界面只是空了一块，不报错、不告警，可能要等用户来问才发现。
 *
 * ═══════════ 怎么跑 ═══════════
 * 用 harness 的内存假库 + 真 handler（不是 mock），所以这里断言的是**线上会返回的东西**。
 * 每个接口调用后立刻用 `cloud/contracts/partner.js` 的形状校验响应，
 * 收集「字段缺失 / 类型不符 / null 语义不对」三类问题。
 *
 * ⚠️ 调用**顺序有依赖**：可排时间必须在时段发布之后才能填。
 *    所以这里不是「按契约字母序遍历」，而是手写一条真实业务流。
 *    新增接口时要在这里补一行，否则它永远不会被校验到。
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const contract = require('../contracts/partner');

const lines = [];
let failed = 0;

function section(t) { lines.push(`\n---- ${t} ----`); }
function pass(msg) { lines.push(`OK   ${msg}`); }
function fail(msg) { failed++; lines.push(`FAIL ${msg}`); }

// ─────────────────────────── 形状校验 ───────────────────────────

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 单值类型校验
 * 支持后缀：`?`（可选，req 用）、`|null`（可空）
 */
function checkType(v, t, at, errs) {
  if (t === 'any') return;

  let base = String(t);
  let optional = false;
  let nullable = false;
  if (base.endsWith('?')) { optional = true; base = base.slice(0, -1); }
  if (base.endsWith('|null')) { nullable = true; base = base.slice(0, -5); }

  if (optional && v === undefined) return;

  if (v === null) {
    if (nullable) return;
    errs.push(`${at}: 值为 null，但契约声明 ${t}（后端应返回实际值，不要用 null 顶替）`);
    return;
  }

  if (base.endsWith('[]')) {
    if (!Array.isArray(v)) {
      errs.push(`${at}: 期望数组，实际 ${typeOf(v)}`);
      return;
    }
    const el = base.slice(0, -2);
    v.forEach((x, i) => checkType(x, el, `${at}[${i}]`, errs));
    return;
  }

  if (base === 'object') {
    if (typeOf(v) !== 'object') errs.push(`${at}: 期望 object，实际 ${typeOf(v)}`);
    return;
  }
  if (base === 'array') {
    if (!Array.isArray(v)) errs.push(`${at}: 期望 array，实际 ${typeOf(v)}`);
    return;
  }

  const actual = typeOf(v);
  if (base !== actual) {
    const preview = actual === 'object' || actual === 'array'
      ? ''
      : `（值 ${JSON.stringify(v).slice(0, 40)}）`;
    errs.push(`${at}: 期望 ${base}，实际 ${actual}${preview}`);
  }
}

/**
 * 递归校验形状
 *  - 字符串 → checkType
 *  - 单元素数组 → 元素模板，actual 必须是数组
 *  - 对象 → 每个键**必须存在**（`?` 结尾的除外）
 */
function checkShape(actual, shape, at, errs) {
  if (typeof shape === 'string') return checkType(actual, shape, at, errs);

  if (Array.isArray(shape)) {
    if (!Array.isArray(actual)) {
      errs.push(`${at}: 期望数组，实际 ${typeOf(actual)}`);
      return;
    }
    const itemShape = shape[0];
    if (itemShape === undefined) return;   // [] 表示「任意数组」
    actual.forEach((v, i) => checkShape(v, itemShape, `${at}[${i}]`, errs));
    return;
  }

  if (shape && typeof shape === 'object') {
    if (typeOf(actual) !== 'object') {
      errs.push(`${at}: 期望对象，实际 ${typeOf(actual)}`);
      return;
    }
    Object.keys(shape).forEach((k) => {
      const optional = k.endsWith('?');
      const key = optional ? k.slice(0, -1) : k;
      if (!(key in actual) || actual[key] === undefined) {
        if (!optional) {
          errs.push(`${at}.${key}: 字段缺失（undefined 会被 JSON.stringify 整个丢掉，前端连键名都看不到）`);
        }
        return;
      }
      checkShape(actual[key], shape[k], `${at}.${key}`, errs);
    });
  }
}

// ─────────────────────────── 调用 + 校验 ───────────────────────────

const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });
const MGR_TOKEN = sign({ id: 2, username: 'mgr', role: 1 });

const WEEK = '2026-11-02';   // 周一

const TPL = [
  { day: 0, title: '早间开台', start: 410, end: 440, dept: '播音部', role: '播音', count: 1 },
  { day: 0, title: '午间漫游', start: 720, end: 750, dept: '主持部', role: '主持', count: 2 },
  { day: 2, title: '晚间点歌', start: 1140, end: 1170, dept: '播音部', role: '播音', count: 1 },
];

function seed() {
  const t = new Date('2026-01-01T00:00:00+08:00');
  H.reset({
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: 'x', nickname: '老师', role: 0, status: 1, department: '', dutyRoles: [], createTime: t, updateTime: t },
      { _id: 'ad2', id: 2, username: 'mgr', password: 'x', nickname: '小周', role: 1, status: 1, department: '播音部', dutyRoles: ['播音'], createTime: t, updateTime: t },
    ],
  });
}

/**
 * 调一次接口并按契约校验
 * @param {string} key   契约里的 'METHOD /path'
 * @param {object} body
 * @param {string} token
 * @param {string} [label] 覆盖展示名（同一个接口在流程里会调多次）
 * @param {object} [params] 路径参数，如 { id: 2 }
 *
 * ⚠️ 契约里的 path 带占位符（`/partner/people/:id`），**请求时必须换成真实值**。
 *    第一版直接拿占位符去请求，于是 `:id` 被当成字面量传进 handler，
 *    `Number(':id')` = NaN → 40001「personId 不合法」。
 *    这不是 handler 的 bug，是校验器没做替换。
 */
async function callAndVerify(key, body, token, label, params) {
  const ct = contract[key];
  if (!ct) {
    fail(`${label || key}: 契约里没有这个接口，无法校验`);
    return null;
  }

  const realPath = String(ct.path).replace(/:([A-Za-z0-9_]+)/g, (m0, name) => {
    const v = params && params[name] !== undefined ? params[name] : '1';
    return encodeURIComponent(String(v));
  });

  const res = await H.call(H.req(ct.method, realPath, body || {}, token));

  if (res.code !== 0) {
    fail(`${label || key}: 期望 code=0，实际 ${res.code}（${res.message}）`);
    return null;
  }

  const errs = [];
  checkShape(res.data, ct.resp, 'data', errs);
  if (errs.length) {
    fail(`${label || key}: 响应形状不符（${errs.length} 处）`);
    errs.slice(0, 8).forEach((e) => lines.push(`       · ${e}`));
    if (errs.length > 8) lines.push(`       · …还有 ${errs.length - 8} 处`);
  } else {
    pass(`${label || key}: 形状符合契约`);
  }
  return res.data;
}

// ─────────────────────────── 主流程 ───────────────────────────

(async () => {
  lines.push('');
  lines.push('═══ 接口契约运行时校验（真实 handler + 内存库）═══');
  lines.push(`契约 ${Object.keys(contract).length} 条`);

  seed();

  section('1. 身份');
  await callAndVerify('GET /partner/me', {}, SUPER_TOKEN, 'GET /partner/me（超管）');
  await callAndVerify('GET /partner/me', {}, MGR_TOKEN, 'GET /partner/me（社干）');
  await callAndVerify('PUT /partner/me/duty', { department: '播音部', dutyRoles: ['播音'] }, SUPER_TOKEN);

  section('2. 人员池');
  await callAndVerify('GET /partner/people', {}, SUPER_TOKEN);
  await callAndVerify('GET /partner/people/:id', {}, MGR_TOKEN, 'GET /partner/people/:id（查社干自己）', { id: 2 });

  section('3. 值班时段');
  await callAndVerify('GET /partner/slots', {}, SUPER_TOKEN, 'GET /partner/slots（空库）');
  await callAndVerify('PUT /partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
  await callAndVerify('POST /partner/slots/publish', {}, SUPER_TOKEN);
  await callAndVerify('GET /partner/slots', {}, SUPER_TOKEN, 'GET /partner/slots（已发布）');
  await callAndVerify('GET /partner/slots', {}, MGR_TOKEN, 'GET /partner/slots（社干只读）');
  await callAndVerify('GET /partner/slots/published', {}, MGR_TOKEN);

  section('4. 可排时间');
  await callAndVerify('GET /partner/availability', { week: WEEK }, MGR_TOKEN, 'GET /partner/availability（未填）');
  await callAndVerify('PUT /partner/availability', {
    week: WEEK,
    picks: [{ slotKey: '0-1', can: true }, { slotKey: '0-2', can: false }],
    reason: '周三下午有课',
  }, MGR_TOKEN, 'PUT /partner/availability（自填）');
  await callAndVerify('PUT /partner/availability', {
    week: WEEK, personId: 1,
    picks: [{ slotKey: '0-1', can: true }],
    reason: '老师让我代填',
  }, MGR_TOKEN, 'PUT /partner/availability（代录）');
  await callAndVerify('GET /partner/availability', { week: WEEK, personId: 1 }, MGR_TOKEN, 'GET /partner/availability（代录查看）');
  await callAndVerify('DELETE /partner/availability', { week: WEEK }, MGR_TOKEN, 'DELETE /partner/availability（撤自己的）');

  // ─────────────────────────── 契约完整性 ───────────────────────────

  section('5. 契约覆盖度');
  {
    const { PARTNER_ROUTES } = require(path.join(API_DIR, 'router'));
    const declared = new Set(Object.keys(contract));
    const missing = PARTNER_ROUTES
      .map(([k]) => k)
      .filter((k) => !declared.has(k));

    if (missing.length) {
      fail(`有 ${missing.length} 条 partner 路由没有契约声明`);
      missing.forEach((m) => lines.push(`       · ${m}`));
    } else {
      pass(`partner 路由 ${PARTNER_ROUTES.length} 条全部有契约`);
    }
  }

  // ─────────────────────────── 输出 ───────────────────────────

  console.log(lines.join('\n'));
  console.log(`\n${failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'}（共 ${lines.filter((l) => /^(OK|FAIL) /.test(l)).length} 项）`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('校验脚本自身异常：', e);
  process.exit(1);
});
