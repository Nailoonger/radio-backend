'use strict';

/**
 * 伙伴端接口契约（单一事实源）
 *
 * ═══════════ 这个文件解决什么问题 ═══════════
 * 前后端是两套独立代码，中间**没有编译期约束**。最容易出的不是「接口 404」（那个一跑就现），
 * 而是**字段级漂移**：
 *   · 后端某天把 `dutyRoles` 改名 `roles` → 前端读 `undefined`，界面静默变空，不报错
 *   · 后端 `JSON.stringify` 把 `undefined` 丢掉 → 前端拿到 `undefined` 而不是 `null`，
 *     `v-if="x === null"` 分支永远不进（这个坑在 cloud/lib/db.js 头注里记过一次）
 *   · 后端返回 `Date` 对象 → 过一遍 JSON 变 ISO 字符串，前端 `new Date(v)` 能转但
 *     `v.getTime()` 直接崩
 *
 * 所以把「每个接口返回什么」写成**可执行的声明**，然后：
 *   ① `check-contract.js` 静态校验：契约里的 path 必须在路由表里（E3）
 *   ② `verify-contract.js` 运行时校验：用 harness 跑**真实 handler**，
 *      把真实响应和这里的形状逐字段对撞（字段缺失 / 类型不符 / null 语义）
 *
 * ═══════════ 形状写法 ═══════════
 *   'number' 'string' 'boolean'        基本类型
 *   'string[]' 'number[]'              基本类型数组
 *   'any'                              不校验（时间戳、任意对象）
 *   'string|null'                      可空
 *   { a:'number', b:'string' }         对象，**字段必须齐全**（多出来的不管）
 *   [{ a:'number' }]                   数组，**单元素数组 = 元素模板**
 *   'object|null'                      整个对象可为 null
 *
 * ⚠️ 约定：**字段必须存在**，值可以是 null。后端 handler 用 `pick()` 投影时缺字段补 null，
 *    就是为了满足这条 —— `undefined` 会被 JSON.stringify 整个丢掉，前端连字段名都看不到。
 */

/** 可排时间的时段选项（由时段模板展开而来） */
const SLOT_OPTION = {
  slotKey: 'string',   // '<day>-<seq>'，如 '0-1'
  day: 'number',       // 0=周一 … 4=周五
  seq: 'number',       // 该天第几个时段，从 1 起
  title: 'string',
  start: 'number',     // 当天分钟数，410 = 06:50
  end: 'number',
  dept: 'string',
  role: 'string',
  count: 'number',
  timeText: 'string',  // '06:50-07:20'
};

/** 时段模板（写入用，没有 slotKey/seq/timeText） */
const SLOT_TEMPLATE = {
  day: 'number',
  title: 'string',
  start: 'number',
  end: 'number',
  dept: 'string',
  role: 'string',
  count: 'number',
};

/** 时段版本（草稿或已发布） */
const SLOT_VERSION = {
  id: 'number|null',
  version: 'number',
  state: 'string',            // 'draft' | 'published'
  templates: [SLOT_TEMPLATE],
  slots: [SLOT_OPTION],
  slotCount: 'number',
  dayCount: 'number',
  publishedAt: 'any',         // Date（过 JSON 变 ISO 字符串）或 null
  publishedBy: 'number|null',
  publishedByName: 'string',
  reason: 'string',
  updateTime: 'any',
};

/** 人员池里的一项（**绝不含 password**） */
const PERSON = {
  personId: 'number',
  name: 'string',
  username: 'string',
  department: 'string',
  dutyRoles: 'string[]',
  isSuper: 'boolean',
};

/** 某人的可排时间填报 */
const AVAILABILITY = {
  personId: 'number',
  weekStart: 'string',        // '2026-11-02'（周一）
  picks: [{ slotKey: 'string', can: 'boolean', slot: 'object|null' }],
  canCount: 'number',
  totalCount: 'number',
  reason: 'string',
  source: 'string',           // 'self' | 'proxy'
  slotVersion: 'number',
  stale: 'boolean',           // 依据的时段版本已过期，需重填
  confirmedAt: 'any',
  confirmedBy: 'number|null',
  confirmedByName: 'string',
};

/** 能力位：前端据此显示/隐藏入口，**后端给，前端不自己推** */
const ABILITIES = {
  canEditSlots: 'boolean',
  canPublishSlots: 'boolean',
  canEditRules: 'boolean',
  canManageAccounts: 'boolean',
  canProxyAvailability: 'boolean',
  canManageSchedule: 'boolean',
  isPartner: 'boolean',
};

const contract = {
  // ─────────────────────────── 身份 ───────────────────────────

  'GET /partner/me': {
    method: 'GET',
    path: '/partner/me',
    auth: 'admin',
    desc: '当前伙伴的身份、值班资格与能力位。伙伴端所有页面第一屏都调它。',
    req: {},
    resp: {
      id: 'number',
      username: 'string',
      nickname: 'string',
      name: 'string',            // 昵称优先，兜底账号名，再兜底「账号<id>」
      role: 'number',            // 0=超管 1=社干
      roleKey: 'string',         // 'super' | 'manager'
      roleText: 'string',
      isSuper: 'boolean',
      department: 'string',
      dutyRoles: 'string[]',
      qualified: 'boolean',      // 部门和岗位都填了才算「能被排班」
      createTime: 'any',
      lastLoginAt: 'any',
      abilities: ABILITIES,
    },
  },

  'PUT /partner/me/duty': {
    method: 'PUT',
    path: '/partner/me/duty',
    auth: 'admin',
    desc: '自助维护部门与值班岗位（白名单校验，岗位自动去重）。',
    req: { department: 'string?', dutyRoles: 'string[]?' },
    resp: {
      department: 'string',
      dutyRoles: 'string[]',
      qualified: 'boolean',
      abilities: ABILITIES,
    },
  },

  // ─────────────────────────── 人员池 ───────────────────────────

  'GET /partner/people': {
    method: 'GET',
    path: '/partner/people',
    auth: 'admin',
    desc: '人员池 = admin 表 status=1 的账号，personId 就是 admin.id。',
    req: {},
    resp: { list: [PERSON], total: 'number' },
  },

  'GET /partner/people/:id': {
    method: 'GET',
    path: '/partner/people/:id',
    auth: 'admin',
    desc: '单个成员（代录前确认对方资格）。',
    req: {},
    resp: PERSON,
  },

  'PUT /partner/people/:id/duty': {
    method: 'PUT',
    path: '/partner/people/:id/duty',
    auth: 'admin',
    desc: '超管替别人配值班资格（部门 + 岗位）；部门不传＝保持原值。',
    req: { department: 'string?', dutyRoles: 'string[]' },
    resp: {
      personId: 'number',
      name: 'string',
      department: 'string',
      dutyRoles: 'string[]',
      qualified: 'boolean',
      by: 'number',
    },
  },

  // ─────────────────────────── 值班时段 ───────────────────────────

  'GET /partner/slots': {
    method: 'GET',
    path: '/partner/slots',
    auth: 'admin',
    desc: '草稿 + 当前生效版 + 前端该打开来编辑的那份。社干 canEdit=false。',
    req: {},
    resp: {
      canEdit: 'boolean',
      canPublish: 'boolean',
      published: 'object|null',
      draft: 'object|null',
      editing: 'object',         // 有草稿用草稿，没草稿用已发布版的副本（version+1）
      hasPublished: 'boolean',
      pendingDraft: 'boolean',
    },
  },

  'GET /partner/slots/published': {
    method: 'GET',
    path: '/partner/slots/published',
    auth: 'admin',
    desc: '只读的当前生效时段，给可排时间页拉选项用。',
    req: {},
    resp: { published: 'object|null', ready: 'boolean' },
  },

  'PUT /partner/slots/draft': {
    method: 'PUT',
    path: '/partner/slots/draft',
    auth: 'super',
    desc: '存草稿（仅超管）。允许空模板，空草稿不能发布。',
    req: { templates: [SLOT_TEMPLATE] },
    resp: { draft: SLOT_VERSION, created: 'boolean' },
  },

  'POST /partner/slots/publish': {
    method: 'POST',
    path: '/partner/slots/publish',
    auth: 'super',
    desc: '发布草稿（仅超管）。版本号在草稿创建时已定好，这里不重算。',
    req: { reason: 'string?' },
    resp: { published: SLOT_VERSION },
  },

  'DELETE /partner/slots': {
    method: 'DELETE',
    path: '/partner/slots',
    auth: 'super',
    desc: '重置全部时段（仅超管）：删掉所有版本（含已发布），回到「从未配置」。'
      + 'publish 拒绝空模板，所以有了已发布版本后，这是唯一能清干净的入口；日常改时段走 draft。',
    req: { confirm: 'string（必须原样 "RESET"）', reason: 'string（≥2 字）' },
    resp: { removed: 'number', cleared: 'array<{version,state}>' },
  },

  // ─────────────────────────── 可排时间 ───────────────────────────

  'GET /partner/availability': {
    method: 'GET',
    path: '/partner/availability',
    auth: 'admin',
    desc: '时段选项 + 人员池 + 我的填报 + 汇总，一次给全（避免「已确认 x/y」闪烁）。',
    req: { week: 'string?', personId: 'number?' },
    resp: {
      weekStart: 'string',
      weekDates: 'string[]',     // 5 个，周一 ~ 周五
      slotVersion: 'number',
      slots: [SLOT_OPTION],
      ready: 'boolean',          // 时段未发布时为 false
      people: [PERSON],
      me: 'object|null',
      target: 'object|null',     // 代录查看某人时才有
      targetId: 'number',
      summary: {
        total: 'number',
        confirmed: 'number',
        pending: 'number',
        rows: [{
          personId: 'number', name: 'string', department: 'string',
          dutyRoles: 'string[]', isSuper: 'boolean',
          confirmed: 'boolean', canCount: 'number', source: 'string',
          confirmedAt: 'any', stale: 'boolean',
        }],
      },
      abilities: { canProxy: 'boolean' },
    },
  },

  'PUT /partner/availability': {
    method: 'PUT',
    path: '/partner/availability',
    auth: 'admin',
    desc: '自填或代录。personId 不等于自己 ⇒ 代录，必须留原因（≥2 字）。',
    req: {
      week: 'string?',
      personId: 'number?',
      picks: [{ slotKey: 'string', can: 'boolean' }],
      reason: 'string?',
    },
    resp: {
      weekStart: 'string',
      personId: 'number',
      isProxy: 'boolean',
      availability: AVAILABILITY,
    },
  },

  'DELETE /partner/availability': {
    method: 'DELETE',
    path: '/partner/availability',
    auth: 'admin',
    desc: '撤销填报。只能撤自己的、或自己代录的。',
    req: { week: 'string?', personId: 'number?' },
    resp: { removed: 'number' },
  },
};

const SCHEDULE_SUMMARY = { needed: 'number', filled: 'number', missing: 'number', fixed: 'number' };
const SCHEDULE_PERSON = { personId: 'number', personName: 'string', slotKey: 'string', department: 'string', role: 'string', source: 'string', fixed: 'boolean' };
const SCHEDULE_WEEK = {
  weekStart: 'string', state: 'string', version: 'number', revision: 'number', slotVersion: 'number',
  publishedAt: 'any', publishedByName: 'string', withdrawnAt: 'any', slotOrder: 'string[]',
  total: 'number', summary: SCHEDULE_SUMMARY, canManage: 'boolean', canWithdraw: 'boolean',
  days: [{ day: 'string', dayName: 'string', total: 'number', slots: [{
    slot: 'string', timeText: 'string', start: 'number', end: 'number', people: [SCHEDULE_PERSON],
    groups: [{ slotKey: 'string', department: 'string', role: 'string', count: 'number', people: [SCHEDULE_PERSON] }],
  }] }],
};
const MUTATION = { weekStart: 'string', revision: 'number' };
Object.assign(contract, {
  'GET /partner/schedule': {
    method: 'GET', path: '/partner/schedule', auth: 'admin', desc: '按周返回模板空格与并行岗位。站员仅看正式人选，草稿内容不外泄。',
    req: { week: 'string?' }, resp: SCHEDULE_WEEK,
  },
  'GET /partner/schedule/mine': {
    method: 'GET', path: '/partner/schedule/mine', auth: 'admin', desc: '本人正式班次，未发布或撤回周返回空。',
    req: { week: 'string?' }, resp: { weekStart: 'string', count: 'number', list: [{ day: 'string', dayName: 'string', slot: 'string', slotKey: 'string', timeText: 'string', department: 'string' }] },
  },
  'GET /partner/schedule/month': {
    method: 'GET', path: '/partner/schedule/month', auth: 'admin', desc: '按周一归属月份汇总正式场次，包含活跃人员的零场。',
    req: { month: 'string?' }, resp: { month: 'string', weeks: 'string[]', total: 'number', list: [{ personId: 'number', personName: 'string', department: 'string', count: 'number', lastDay: 'string' }] },
  },
  'GET /partner/schedule/check': {
    method: 'GET', path: '/partner/schedule/check', auth: 'manager', desc: '实时校验资格、可排时间、请假、场次上限、重叠与缺岗。',
    req: { week: 'string?' }, resp: { weekStart: 'string', revision: 'number', valid: 'boolean', issues: 'array', missing: 'array', summary: SCHEDULE_SUMMARY },
  },
  'GET /partner/schedule/candidates': {
    method: 'GET', path: '/partner/schedule/candidates', auth: 'manager', desc: '指定岗位的候选人，包含不可选原因及当前固定状态。',
    req: { week: 'string?', day: 'string', slotKey: 'string' },
    resp: { weekStart: 'string', revision: 'number', slotKey: 'string', count: 'number', list: [{ personId: 'number', name: 'string', department: 'string', eligible: 'boolean', reasons: 'string[]', selected: 'boolean', fixed: 'boolean', count: 'number' }] },
  },
  'PUT /partner/schedule/generate': {
    method: 'PUT', path: '/partner/schedule/generate', auth: 'manager', desc: '生成或重排草稿，保留固定人选；正式周须先由超管撤回。',
    req: MUTATION, resp: { week: SCHEDULE_WEEK, generated: 'number', missing: 'array', limits: { dayMax: 'number', weekMax: 'number' } },
  },
  'PUT /partner/schedule/cell': {
    method: 'PUT', path: '/partner/schedule/cell', auth: 'manager', desc: '独立调整一个部门岗位，换人要留原因，手改默认固定且不能绕过硬条件。',
    req: { ...MUTATION, day: 'string', slotKey: 'string', personIds: 'number[]', reason: 'string?', fixed: 'boolean?' },
    resp: { week: SCHEDULE_WEEK, cell: { day: 'string', slot: 'string', slotKey: 'string', personIds: 'number[]' } },
  },
  'POST /partner/schedule/publish': {
    method: 'POST', path: '/partner/schedule/publish', auth: 'manager', desc: '服务端重校验并发布；只有缺岗可经allowMissing明确确认，人员硬冲突仍拦截。',
    req: { ...MUTATION, allowMissing: 'boolean?', reason: 'string?' }, resp: { week: SCHEDULE_WEEK },
  },
  'POST /partner/schedule/withdraw': {
    method: 'POST', path: '/partner/schedule/withdraw', auth: 'super', desc: '超管撤回正式周，保留全部原人选建立固定草稿，后续发布版本递增。',
    req: { ...MUTATION, reason: 'string?' }, resp: { week: SCHEDULE_WEEK },
  },
  'DELETE /partner/schedule/draft': {
    method: 'DELETE', path: '/partner/schedule/draft', auth: 'manager', desc: '只清当前草稿人选，保留时段和历史发布版本。正式周禁止清空。',
    req: MUTATION, resp: { week: SCHEDULE_WEEK },
  },
  'GET /partner/schedule/history': {
    method: 'GET', path: '/partner/schedule/history', auth: 'manager', desc: '真实发布与调整记录；快照只返回超管，所有旧版本只读。',
    req: { week: 'string?' },
    resp: { weekStart: 'string', version: 'number', publishedAt: 'any', publishedByName: 'string',
      list: [{ id: 'number', action: 'string', actionText: 'string', operatorName: 'string', actorName: 'string', reason: 'string', createdAt: 'any', createTime: 'any', version: 'number', summary: SCHEDULE_SUMMARY }],
      versions: [{ version: 'number', publishedAt: 'any', publishedByName: 'string', total: 'number' }],
    },
  },
});

module.exports = contract;
