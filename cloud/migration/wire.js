'use strict';

/**
 * 落盘格式（"wire format"）—— 源快照与云库导出**共用同一套编码**
 *
 * 为什么要单独一层：JSON 没有 Date 类型。若两边各用各的编码（一边 ISO 字符串、
 * 一边 `{ $date: ... }`），`verify.js` 比出来的差异就全是噪音，真差异反而被淹没。
 * ⇒ 统一成**微信云开发控制台导入/导出的 ISODate 格式**：
 *
 *     { "createTime": { "$date": "2018-08-31T17:30:00.882Z" } }
 *
 * 官方要求（已核实 developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/database/import.html）：
 *   1. JSON **Lines**（记录之间 `\n`，不是数组）
 *   2. 键名首尾不能是 `.`、不能含连续 `.`
 *   3. 时间必须写成 `{ "$date": "<ISO>" }` —— 写成裸 ISO 字符串会被当普通字符串，
 *      之后 `_.gte(new Date())` 这类时间条件全部**静默失效**
 */

const DATE_TAG = '$date';

/** 是不是「未还原的」`{ $date: ... }` 包装（深度只看一层，够用且不会误伤业务字段） */
function isWireDate(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
    && Object.keys(v).length === 1 && Object.keys(v)[0] === DATE_TAG;
}

/** JS 值 → 落盘值（Date → `{ $date: ISO }`） */
function toWire(v) {
  if (v instanceof Date) return { [DATE_TAG]: v.toISOString() };
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = toWire(v[k]); });
    return o;
  }
  return v;
}

/** 落盘值 → JS 值（`{ $date }` → Date） */
function fromWire(v) {
  if (Array.isArray(v)) return v.map(fromWire);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === DATE_TAG) {
      const d = new Date(v[DATE_TAG]);
      return Number.isNaN(d.getTime()) ? v : d;
    }
    const o = {};
    keys.forEach((k) => { o[k] = fromWire(v[k]); });
    return o;
  }
  return v;
}

/** 一行 JSONL */
const toLine = (doc) => JSON.stringify(toWire(doc));

/**
 * 解析一批文档 —— **同时接受 JSON 数组与 JSON Lines**
 *
 * 为什么两种都要收：云开发控制台「导出」有时给数组、有时给 JSON Lines，
 * 版本不同不一致。只认一种会在真机上直接卡住，而这是纯格式问题，不该让人手工改文件。
 */
function parseDocs(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return [];
  if (s[0] === '[') return fromWire(JSON.parse(s));
  return s.split(/\r?\n/).filter((l) => l.trim()).map((l) => fromWire(JSON.parse(l)));
}

/** 一批文档 → JSONL 文本 */
function toJsonLines(docs) {
  return docs.map(toLine).join('\n') + (docs.length ? '\n' : '');
}

/**
 * 值相等判定（供双向校验使用）
 *
 * ⚠️ Date 必须**按时刻比**，不能用 `===`（两个实例即使同一时刻也不相等）。
 * ⚠️ 数组/对象递归比，不能 `JSON.stringify` 后比字符串（键顺序不同会误报）。
 */
function sameValue(a, b) {
  /**
   * 容错：任一側还是**未还原的 `{ $date: ... }` 包装**（例如某条链路忘了调 fromWire），
   * 先还原再比。真实踩过：快照写了 `$date` 而云库导出是 Date，直接比就冒出几十条
   * 「字段不一致」的假差异，真差异反而被淹没。宁可在这里宽容，也不要让校验失去信号。
   */
  const aw = isWireDate(a) ? fromWire(a) : a;
  const bw = isWireDate(b) ? fromWire(b) : b;
  if (aw !== a || bw !== b) return sameValue(aw, bw);

  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : (a === null || a === undefined ? NaN : new Date(a).getTime());
    const tb = b instanceof Date ? b.getTime() : (b === null || b === undefined ? NaN : new Date(b).getTime());
    if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
    return ta === tb;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    if (ka.join('\u0000') !== kb.join('\u0000')) return false;
    return ka.every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

/** 值的人类可读形式（报错信息用；Date 打成 ISO，避免看到 `{}`) */
function show(v) {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && Object.keys(v)[0] === DATE_TAG) {
    return `${DATE_TAG}(${v[DATE_TAG]})`;
  }
  return JSON.stringify(v);
}

module.exports = { DATE_TAG, isWireDate, toWire, fromWire, toLine, parseDocs, toJsonLines, sameValue, show };
