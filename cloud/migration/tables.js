'use strict';

/**
 * 阶段 8 · 表级迁移规则（**唯一声明处**）
 *
 * 上游：`cloud/docs/data-model-mapping.md`
 * 下游：`transform.js`（行 → 云文档）/ `unique-keys.js`（唯一键补登记）/ `export.js`（读源库）
 *
 * ⚠️ 本文件只声明「模型里读不出来的东西」：
 *    - 集合是否迁移
 *    - `_id` 是自增还是业务键、业务键怎么拼
 *    - 哪些字段是 JSON 文本需要反序列化
 *    - 要补登记哪些唯一键
 *    **字段名 / 时间字段一律从 Sequelize 模型的 rawAttributes 推导**（见 export.js），
 *    避免这里写一份、模型里改了另一份，两边悄悄漂移。
 */

/**
 * 业务键 `_id` 的构造描述
 * @typedef {{ kind:'business', prefix:string, parts:string[] }} BusinessIdRule
 */

/** 参与迁移的表（顺序即导出顺序；`song_quota` 已退役，不在列） */
const TABLES = [
  {
    name: 'user',
    model: 'User',
    // ⚠️ defaultScope 排除 password。迁移必须显式带哈希，否则存量账号全部登不上。
    scope: 'withPassword',
    idRule: { kind: 'auto' },
    uniques: [
      { scope: 'user_name', parts: ['username'] },
      { scope: 'user_openid', parts: ['openid'] },
      { scope: 'user_seat', parts: ['grade', 'classNo', 'seatNo'] },
    ],
  },
  {
    name: 'admin',
    model: 'Admin',
    idRule: { kind: 'auto' },
    uniques: [{ scope: 'admin', parts: ['username'] }],
  },
  { name: 'submit', model: 'Submit', idRule: { kind: 'auto' }, uniques: [] },
  { name: 'program', model: 'Program', idRule: { kind: 'auto' }, uniques: [] },
  { name: 'notice', model: 'Notice', idRule: { kind: 'auto' }, uniques: [] },
  { name: 'message', model: 'Message', idRule: { kind: 'auto' }, uniques: [] },
  {
    name: 'system_setting',
    model: 'SystemSetting',
    idRule: { kind: 'business', prefix: 'setting', parts: ['key'] },
    uniques: [{ scope: 'setting', parts: ['key'] }],
  },
  {
    name: 'system_switch',
    model: 'SystemSwitch',
    idRule: { kind: 'business', prefix: 'switch', parts: ['key'] },
    uniques: [{ scope: 'switch', parts: ['key'] }],
  },
  { name: 'cadre', model: 'Cadre', idRule: { kind: 'auto' }, uniques: [] },
  { name: 'staff', model: 'Staff', idRule: { kind: 'auto' }, uniques: [] },
  {
    name: 'notice_ack',
    model: 'NoticeAck',
    idRule: { kind: 'business', prefix: 'ack', parts: ['openid', 'noticeKey'] },
    uniques: [{ scope: 'ack', parts: ['openid', 'noticeKey'] }],
  },
  { name: 'import_batch', model: 'ImportBatch', idRule: { kind: 'auto' }, uniques: [] },
  {
    name: 'cleanup_log',
    model: 'CleanupLog',
    idRule: { kind: 'auto' },
    // 原 TEXT(JSON) → 反序列化成数组/对象。解析失败保留原串 + warning（不静默丢数据）
    jsonFields: ['disabledAccounts'],
    uniques: [],
  },
  {
    name: 'weekly_schedule',
    model: 'WeeklySchedule',
    // ⚠️ weekStartDate 是 DATEONLY（'YYYY-MM-DD' 字符串）—— 绝不是 Date，
    //    转成 Date 会把 _id 拼成 "week:Mon Sep 28 2026..."，周行再也查不到。
    idRule: { kind: 'business', prefix: 'week', parts: ['weekStartDate'] },
    uniques: [{ scope: 'week', parts: ['weekStartDate'] }],
  },
  { name: 'assignment_log', model: 'AssignmentLog', idRule: { kind: 'auto' }, uniques: [] },
  { name: 'request_status_log', model: 'RequestStatusLog', idRule: { kind: 'auto' }, uniques: [] },
];

/** 明确不迁移的表 —— 列出原因，防止后来者不小心加回来 */
const SKIPPED = [
  { name: 'song_quota', reason: '已退役（v2 起无日/周名额概念，表已停写），见 data-model-mapping.md §二.11' },
];

/** `unique_keys` / `sequence` 是迁移自己产出的辅助集合，不是源表 */
const AUX = ['unique_keys', 'sequence'];

const byName = {};
TABLES.forEach((t) => { byName[t.name] = t; });

/** 业务键所需的字段里有 NULL/空 → 拼出来的 `_id` 会塌成同一个（静默丢行） */
function missingKeyParts(rule, row) {
  if (rule.kind !== 'business') return [];
  return rule.parts.filter((p) => {
    const v = row[p];
    return v === null || v === undefined || v === '';
  });
}

/** 拼业务键（不含前缀）；`sep` 默认 ':' */
function buildKey(parts, row, sep = ':') {
  return parts.map((p) => String(row[p])).join(sep);
}

/** 业务键 `_id` */
function buildId(rule, row) {
  return `${rule.prefix}:${buildKey(rule.parts, row)}`;
}

module.exports = { TABLES, SKIPPED, AUX, byName, missingKeyParts, buildKey, buildId };
