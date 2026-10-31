'use strict';

/**
 * 伙伴端 · 值班时段配置
 *
 *   GET  /partner/slots           读（草稿 + 当前生效版）
 *   PUT  /partner/slots/draft     存草稿（超管）
 *   POST /partner/slots/publish   发布（超管，版本 +1）
 *
 * ═══════════ 数据模型：版本表而不是「一条配置」 ═══════════
 * 集合 duty_slot_versions，一行 = 一个版本：
 *   { version, state: 'draft'|'published', templates: [...], publishedAt, publishedBy, reason }
 *
 * 为什么不直接存一条 `{ templates }` 就完事：
 *   班表发布时要把「当时的时段配置」钉死。若时段是可覆盖的单条记录，
 *   社干改了 10 月的时段，9 月已发布班表里的岗位名/时间就会跟着变 —— 历史失真。
 *   版本表让「每周班表引用哪个时段版本」成为可能（P2 的 baseVersion 会用到）。
 *
 * 状态机（刻意做得很窄）：
 *   无草稿 ──PUT draft──> draft ──publish──> published（草稿消失）
 *   下次 PUT draft 时，新草稿的 version = 历史最大 version + 1
 *   ⚠️ 撤回（withdraw）不复用版本号 —— 那是 P2 的事，这里只管时段版本。
 *
 * ⚠️ 「草稿唯一」靠查询 + 条件更新保证，不靠唯一索引：
 *    云数据库没有部分唯一索引，`state='draft'` 唯一只能靠
 *    `updateWhere({ _id, state: 'draft' })` 返回 0 来发现并发。
 */

const { C, findOne, findMany, insertOne, updateWhere, updateById, removeWhere } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const {
  asPartner, asSuperPartner,
  normalizeTemplates, templatesToSlots,
  currentWeekStart,
} = require('./_kit');

/**
 * 首次配置的默认值班时段。
 *
 * 一周只有周一有早会：06:50–07:30，主持部 1 人 + 播音部 2 人 —— 这是**业务规则**，不是演示数据，
 * 所以库完全为空时直接给这份，省得每次重配都要手打一遍（陛下 2026-10-29 的要求）。
 * 只在「没有草稿、也没有已发布版本」时使用；用户一旦保存过，就再也不走这里。
 */
function defaultTemplates() {
  return [
    { day: 0, title: '早会', start: 410, end: 450, dept: '主持部', role: '主持', count: 1 },
    { day: 0, title: '早会', start: 410, end: 450, dept: '播音部', role: '播音', count: 2 },
  ];
}

/** 对外形状：把模板展开成前端直接能渲染的东西 */
function versionDto(v) {
  if (!v) return null;
  const templates = Array.isArray(v.templates) ? v.templates : [];
  return {
    id: v.id === undefined ? null : v.id,
    version: Number(v.version) || 0,
    state: v.state || 'draft',
    templates,
    slots: templatesToSlots(templates),
    slotCount: templates.length,
    dayCount: new Set(templates.map((t) => t.day)).size,
    publishedAt: v.publishedAt || null,
    publishedBy: v.publishedBy || null,
    publishedByName: v.publishedByName || '',
    reason: v.reason || '',
    updateTime: v.updateTime || v.createTime || null,
  };
}

/** 取当前草稿（全局至多一条） */
async function findDraft() {
  const rows = await findMany(C.DUTY_SLOT_VERSION, { state: 'draft' }, { limit: 5 });
  return rows[0] || null;
}

/** 取最新已发布版本（按 version 倒序取第一条） */
async function findPublished() {
  const rows = await findMany(C.DUTY_SLOT_VERSION, { state: 'published' }, {
    orderBy: [['version', 'desc']],
    limit: 1,
  });
  return rows[0] || null;
}

/** 历史最大版本号（草稿与已发布一起算，保证版本号单调） */
async function maxVersion() {
  const rows = await findMany(C.DUTY_SLOT_VERSION, {}, { orderBy: [['version', 'desc']], limit: 1 });
  const top = rows[0];
  return top ? Number(top.version) || 0 : 0;
}

/**
 * GET /partner/slots
 *
 * 返回三样：
 *   published —— 当前生效（站员/社干看到的就是它）
 *   draft     —— 待发布草稿（可能为 null）
 *   editing   —— 前端应该打开来编辑的那份（有草稿用草稿，没草稿用已发布的副本）
 *
 * ⚠️ 社干只读：canEdit=false。前端据此把输入框置灰，**但真正的拦截在 PUT/POST 里**，
 *    前端置灰只是体验，不是安全边界。
 */
async function get(ctx) {
  const p = await asPartner(ctx);
  const [published, draft] = await Promise.all([findPublished(), findDraft()]);

  const canEdit = p.isSuper;
  const editing = draft
    ? versionDto(draft)
    : (published
      ? Object.assign(versionDto(published), { version: (Number(published.version) || 0) + 1, state: 'draft', id: null })
      : versionDto({ version: 1, state: 'draft', templates: defaultTemplates() }));

  return {
    /**
     * 这一版时段**生效的那一周**（值班周口径：周日 0 点起算下周）。
     * ⚠️ 2026-10-31：时段页顶部「第 N 周 10/26 – 10/30」原来是小程序端 `getDay()` 自己算的，
     *    与后端周日切周的口径对不上（周日会显示成上一周）。现在由这里给，前端只渲染。
     */
    weekStart: currentWeekStart(),
    canEdit,
    canPublish: canEdit,
    published: versionDto(published),
    draft: versionDto(draft),
    editing,
    hasPublished: !!published,
    // 社干看到的提示语由前端决定，这里只给事实
    pendingDraft: !!draft,
  };
}

/**
 * PUT /partner/slots/draft   body: { templates: [...] }
 *
 * 存草稿。有草稿就覆盖，没草稿就新建一条（version = 历史最大 + 1）。
 *
 * ⚠️ 允许存**空模板**（0 条）：配置到一半要退出是常态，
 *    拦住会让用户丢掉已填内容。真正拦「空配置不能发布」的是 publish。
 */
async function saveDraft(ctx) {
  const p = await asSuperPartner(ctx);
  const body = ctx.body || {};
  if (body.templates === undefined) {
    throw new ApiError(Codes.PARAM_ERROR, '缺少 templates');
  }
  const templates = normalizeTemplates(body.templates);
  const now = new Date();

  const draft = await findDraft();
  if (draft) {
    const n = await updateWhere(
      C.DUTY_SLOT_VERSION,
      { _id: draft._id, state: 'draft' },
      { templates, updateTime: now, updateBy: p.id }
    );
    // 并发下被别人抢先发布 → 本条的 state 已不是 draft
    if (n === 0) throw new ApiError(Codes.CONFLICT, '该草稿刚被发布或修改，请刷新后重试');
    const fresh = await findOne(C.DUTY_SLOT_VERSION, { _id: draft._id });
    return { draft: versionDto(fresh), created: false };
  }

  const version = (await maxVersion()) + 1;
  const doc = {
    id: null, // 业务数字 id 在 insert 后回填（本集合靠 _id 定位，id 仅供排查日志）
    version,
    state: 'draft',
    templates,
    publishedAt: null,
    publishedBy: null,
    publishedByName: '',
    reason: '',
    createTime: now,
    updateTime: now,
    updateBy: p.id,
  };
  const _id = await insertOne(C.DUTY_SLOT_VERSION, doc);
  const saved = await findOne(C.DUTY_SLOT_VERSION, { _id });
  return { draft: versionDto(saved), created: true };
}

/**
 * POST /partner/slots/publish   body: { reason? }
 *
 * 发布草稿 = 把草稿那一条翻成 published。版本号在草稿创建时已经定好，
 * 这里**不重新算**，否则并发下两个请求会算出同一个号。
 */
async function publish(ctx) {
  const p = await asSuperPartner(ctx);
  const body = ctx.body || {};
  const reason = String(body.reason || '').trim();
  if (reason.length > 200) throw new ApiError(Codes.PARAM_ERROR, '发布说明过长（上限 200 字）');

  const draft = await findDraft();
  if (!draft) throw new ApiError(Codes.PARAM_ERROR, '没有待发布的草稿，请先保存配置');

  const templates = Array.isArray(draft.templates) ? draft.templates : [];
  if (!templates.length) throw new ApiError(Codes.PARAM_ERROR, '时段为空，不能发布');

  const now = new Date();
  const n = await updateWhere(
    C.DUTY_SLOT_VERSION,
    { _id: draft._id, state: 'draft' },
    {
      state: 'published',
      publishedAt: now,
      publishedBy: p.id,
      publishedByName: p.admin.nickname || p.admin.username || '',
      reason,
      updateTime: now,
    }
  );
  if (n === 0) throw new ApiError(Codes.CONFLICT, '该草稿已被发布或修改，请刷新后重试');

  const fresh = await findOne(C.DUTY_SLOT_VERSION, { _id: draft._id });
  return { published: versionDto(fresh) };
}

/**
 * GET /partner/slots/published
 *
 * 只读的「当前生效时段」，给「可排时间」页拉选项用。
 * 单独开一个接口而不是复用 get：可排时间页不需要草稿信息，
 * 少传一半数据，也避免社干从可排时间页看到未发布的草稿内容。
 */
async function publishedOnly(ctx) {
  await asPartner(ctx);
  const published = await findPublished();
  return {
    published: versionDto(published),
    // 没有任何已发布版本时，可排时间页要显示「值班时段尚未发布」
    ready: !!published && (published.templates || []).length > 0,
  };
}

/**
 * DELETE /partner/slots   body: { confirm: 'RESET', reason }
 *
 * 把时段配置清回「从未配置」：删掉 duty_slot_versions 里的**所有版本**（草稿 + 已发布）。
 *
 * 为什么不复用 publish 发一个空版本：
 *   1) publish 本身就拒绝空模板（防误发空配置把全站可排时间清掉）；
 *   2) 空版本会在站员端留下「已发布但 0 个时段」的假历史，而真相常常是这条数据
 *      本来就不该存在（初始化 / 联调时点出来的脏数据）。删记录才是「初始化」。
 *
 * 危险动作照项目既有口径（对齐点歌清空 DELETE /admin/submit/songs）：
 * 仅超管 + confirm 口令 + 必填原因，缺一样都不动库。
 *
 * ⚠️ 刻意不写 duty_logs：那是**按周**的事件流（history 页按 weekStart 精确查），
 *    时段重置是全局配置变更，塞进去会在某周记录里冒出一条无关事件。
 *    这里留云函数日志即可（含操作者 id、删了几条、原因）。
 */
async function reset(ctx) {
  const p = await asSuperPartner(ctx);
  const body = ctx.body || {};
  if (String(body.confirm || '') !== 'RESET') {
    throw new ApiError(Codes.PARAM_ERROR, '重置需要 confirm="RESET"');
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 2) throw new ApiError(Codes.PARAM_ERROR, '请填写重置原因（不少于 2 个字）');

  // ⚠️⚠️ 云开发**不允许** `where({}).remove()`（防误删整表，直接报错 ⇒ 前端只看到 50001）。
  //    lib/db 的 removeWhere 会原样透传 where，所以这里只能按 _id 逐条删。
  //    版本表的量很小（每次保存/发布 +1 条），分批 200 循环几轮就清完了。
  const cleared = [];
  let removed = 0;
  for (let guard = 0; guard < 20; guard++) {
    const batch = await findMany(C.DUTY_SLOT_VERSION, {}, { limit: 200 });
    if (!batch.length) break;
    for (const v of batch) {
      if (!v || !v._id) continue;
      if (cleared.length < 100) cleared.push({ version: Number(v.version) || 0, state: v.state || '' });
      removed += await removeWhere(C.DUTY_SLOT_VERSION, { _id: v._id });
    }
  }
  console.log(`[partner.slots] reset by admin#${p.id}: removed=${removed}, reason=${reason}`);
  return { removed, cleared };
}

module.exports = { get, saveDraft, publish, publishedOnly, reset, findPublished, versionDto };
