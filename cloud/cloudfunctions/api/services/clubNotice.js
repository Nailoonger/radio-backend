'use strict';

/**
 * 社团提报通知 —— 一条「社团要广播里念一段话」的单据
 *
 * 业务链（与原型 preview/notice-hub-v5 的 13 屏一一对应）：
 *
 *   社团（输密钥进来）                广播站（社干）
 *   ├─ 提报 ──────────────► 待审核 ── 审核通过 ──► 待播 ── 标记 ──► 已播出
 *   │                        └── 驳回（必写理由）──► 已驳回 ── 学生改一版重提
 *   └─ 未审核前可改 / 可撤
 *
 * ═══════════ 状态机（数字与文案只在这里定义）═══════════
 *   0 待审核 → 1 待播（通过并排期）/ 2 已驳回 / 9 已撤回
 *   1 待播   → 3 已播出
 * 其余跳转一律拒绝。**没有任何「跳过审核直接播」的路径** —— 站里口播的东西，
 * 不过一遍审核就上麦，出事是全校听见。
 *
 * ═══════════ 为什么标题是后端派生的 ═══════════
 * 原型里学生只填一段「通知内容」（s-new 屏只有正文 + 希望播出 + 附言三栏），
 * 但列表和队列需要一行标题（qcard 的 `.qt`）。所以：
 *   · 提报时**不给学生加一栏**，`summaryOf(body)` 取首句前 20 字当标题
 *   · 伙伴端审核时可以改（课堂通知常常需要更准的标题），存在同一个 `title` 字段
 * 这样既不违背「学生只写一段话」，列表也不至于把整段正文塞进一行。
 *
 * ═══════════ 提报人是谁 ═══════════
 * 取 `club_keys.owner_name`（密钥表里的社团负责人 = 社长），兜底用登录学生的昵称。
 * 提报人**不是**用来鉴权的（鉴权走 ticket 里的 clubId），只是给人看的落款。
 */

const { C, findOne, findMany, insertOne, updateWhere, nextId, ensureCollections } = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');

/* ⚠️⚠️ 云开发查**没建过**的集合是**抛错**（-502005），不是返回空数组。
 *    2026-11-07 密钥页就这么炸过一次（陛下看到「服务器繁忙…-502005…」）。
 *    这里两层保险：进每条路径先建表（幂等、每实例一次），读操作再套 readOr 当空表。 */
function isMissingCollection(err) {
  const msg = String((err && (err.errMsg || err.message)) || err);
  return /collection not exists|-502005|Db or Table not exist|not exist/i.test(msg);
}

async function readOr(fn, fallback) {
  try { return await fn(); } catch (e) { if (isMissingCollection(e)) return fallback; throw e; }
}

/** 单据表先建出来（幂等，每实例只试一次） */
async function ready() {
  await ensureCollections([C.CLUB_NOTICE]);
}

/** 状态（数字）—— 与前端 st.wait / st.air / st.rej / st.done 四个徽章对应 */
const ST = { WAIT: 0, AIR: 1, REJECT: 2, DONE: 3, WITHDRAW: 9 };

/** 状态文案 —— 与小程序 .st 徽章、伙伴端队列三段标题共用，改词只改这里 */
const ST_TEXT = {
  0: '待审核',
  1: '待播',
  2: '已驳回',
  3: '已播出',
  9: '已撤回',
};

/** 正文上限：原型里最长的一条 112 字。给到 300 是留足「一整段活动通知」的余地 */
const MAX_BODY = 300;
/** 同一社团「待审核」中的条数上限 —— 不是每次提报的次数限制，是防刷屏 */
const MAX_PENDING = 5;

function nowIso() {
  return new Date().toISOString();
}

/**
 * 正文 → 列表标题（首 20 字；能在分句处收尾就在分句处收，避免把词组切一半）
 *
 * ⚠️ 这只是**列表预览**，不是终稿标题：伙伴端审核时可以随时改（review 的 `title`）。
 *    所以规则宁可简单可预测，也不要去猜「哪个词才是重点」。
 */
function summaryOf(body) {
  const s = String(body || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= 20) return s.replace(/[，。！？；、,.!?;]$/, '');
  const head = s.slice(0, 20);
  // 在 [8, 20) 里找最后一个分句标点；太靠前的（如第 5 字）切出来只剩半句，不如硬截
  let cut = -1;
  for (let i = 8; i < head.length; i += 1) {
    if ('，。！？；、,.!?;'.indexOf(head[i]) >= 0) cut = i;
  }
  if (cut > 0) return head.slice(0, cut);
  return `${head}…`;
}

function text(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 记录 → 前端 DTO（字段名驼峰，与小程序 data 一一对应） */
function dto(row, club) {
  if (!row) return null;
  const st = Number(row.status);
  return {
    id: row.id,
    clubId: row.club_id,
    clubName: row.club_name || (club && club.club_name) || '',
    clubAvatar: (club && club.club_avatar) || row.club_avatar || '',
    title: row.title || summaryOf(row.body),
    body: row.body || '',
    hopeText: row.hope_text || '',
    note: row.note || '',
    submitByName: row.submit_by_name || '',
    // 徽章文案跟着状态走，前端不再自己映射一遍（少一处会漂的映射）
    status: st,
    statusText: ST_TEXT[st] || '',
    rejectReason: row.reject_reason || '',
    reviewByName: row.review_by_name || '',
    reviewTime: row.review_time || '',
    airSlot: row.air_slot || '',
    airDate: row.air_date || '',
    airTime: row.air_time || '',
    airByName: row.air_by_name || '',
    createTime: row.create_time || '',
    updateTime: row.update_time || '',
    // 未审核前才可改可撤 —— 由后端算，别让前端各自判一遍
    canEdit: st === ST.WAIT,
    canWithdraw: st === ST.WAIT,
    // 被驳回的可以「按这个理由改一版重新提报」，语义上等价于新建，但前端要知道走哪条提示
    canResubmit: st === ST.REJECT,
    // 「已播出」要靠站里点确认，学生端只能看
    charCount: String(row.body || '').length,
  };
}

/**
 * 时间线（学生端「走到哪一步了」四步）
 *
 * ⚠️ 不另起一张流水表：这四步全部能从单据字段推出来（create/review/air 三个时刻 + 驳回理由），
 *    单独存一份必然与主记录分叉（改了主记录忘了写流水，时间线就骗人）。
 *    真要审计，走 `duty_logs` 那种日志表，不在这条线上做。
 */
function timelineOf(row) {
  const st = Number(row.status);
  const steps = [];

  steps.push({
    key: 'submit',
    title: '已提交',
    text: `${row.create_time ? shortTime(row.create_time) : ''}${row.submit_by_name ? ` · ${row.submit_by_name}` : ''}`,
    state: 'done',
  });

  if (st === ST.WITHDRAW) {
    steps.push({ key: 'withdraw', title: '已撤回', text: '你把这条件撤回了，不会播出', state: 'bad' });
    return steps;
  }

  if (st === ST.WAIT) {
    steps.push({ key: 'review', title: '审核中', text: '社干会在今天内处理', state: 'now' });
    steps.push({ key: 'plan', title: '排入播出单', text: '审核通过后自动排', state: 'pending' });
    steps.push({ key: 'air', title: '已播出', text: '播出当天由站里点确认', state: 'pending' });
    return steps;
  }

  if (st === ST.REJECT) {
    steps.push({
      key: 'review',
      title: '审核未通过',
      text: `${shortTime(row.review_time)}${row.review_by_name ? ` · ${row.review_by_name}` : ''}（社干）`,
      state: 'bad',
    });
    steps.push({ key: 'plan', title: '排入播出单', text: '等审核通过后才会排', state: 'pending' });
    return steps;
  }

  // 1 待播 / 3 已播出
  steps.push({
    key: 'review',
    title: '审核通过',
    text: `${shortTime(row.review_time)}${row.review_by_name ? ` · ${row.review_by_name}` : ''}（社干）`,
    state: 'done',
  });
  steps.push({
    key: 'plan',
    title: '排入播出单',
    text: [row.air_date, row.air_slot].filter(Boolean).join(' ') || '已排定',
    state: 'done',
  });
  if (st === ST.DONE) {
    steps.push({
      key: 'air',
      title: '已播出',
      text: `${shortTime(row.air_time)}${row.air_by_name ? ` · ${row.air_by_name} 点了已播出` : ''}`,
      state: 'done',
    });
  } else {
    steps.push({ key: 'air', title: '已播出', text: '播出当天由站里点确认', state: 'now' });
  }
  return steps;
}

/** ISO → '11-05 14:20'（北京时区，学生端时间线用短格式） */
function shortTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 入参校验：正文必填、长度、以及「待审核中不许堆一堆」 */
function assertBody(raw) {
  const body = text(raw, MAX_BODY * 2);
  if (!body) throw new ApiError(Codes.PARAM_ERROR, '请填写通知内容');
  if (body.length < 8) throw new ApiError(Codes.PARAM_ERROR, '内容太短了，多写两句吧');
  if (body.length > MAX_BODY) throw new ApiError(Codes.PARAM_ERROR, `通知内容最多 ${MAX_BODY} 字`);
  return body;
}

/**
 * 提报
 *
 * @param {object} club  club_keys 那一行（由 ticket 解析出来，**不由前端传**）
 * @param {object} user  登录学生
 */
async function create(club, user, input) {
  const body = assertBody(input && input.body);

  await ready();
  const pending = await readOr(
    () => findMany(C.CLUB_NOTICE, { club_id: club.id, status: ST.WAIT }, { limit: MAX_PENDING + 1 }),
    []
  );
  if (pending.length >= MAX_PENDING) {
    throw new ApiError(Codes.CONFLICT, `还有 ${pending.length} 条没审核，等处理完再提新的吧`);
  }

  const id = await nextId(C.CLUB_NOTICE);
  const now = nowIso();
  const row = {
    id,
    club_id: club.id,
    club_name: club.club_name || '',
    club_avatar: club.club_avatar || '',
    title: summaryOf(body),
    body,
    hope_text: text(input && input.hopeText, 40),
    note: text(input && input.note, 100),
    // 落款：负责人 → （有登录就退到学号）→ 「社长」
    // ⚠️ 提报**不要求登录**，所以 user 常常是 null；空着的话伙伴端会看到一片空白
    submit_by_name: club.owner_name || (user && user.username) || '社长',
    submit_by_user_id: Number(user && user.uid) || 0,
    status: ST.WAIT,
    reject_reason: '',
    review_by_name: '',
    review_time: '',
    air_date: '',
    air_slot: '',
    air_time: '',
    air_by_name: '',
    create_time: now,
    update_time: now,
  };
  await insertOne(C.CLUB_NOTICE, row);
  return dto(row, club);
}

/** 本社团的提交（最新在前） */
async function myList(club) {
  await ready();
  const rows = await readOr(
    () => findMany(C.CLUB_NOTICE, { club_id: club.id }, { orderBy: [['id', 'desc']], limit: 100 }),
    []
  );
  const count = {
    total: rows.length,
    wait: rows.filter((r) => Number(r.status) === ST.WAIT).length,
    air: rows.filter((r) => Number(r.status) === ST.AIR).length,
    done: rows.filter((r) => Number(r.status) === ST.DONE).length,
    reject: rows.filter((r) => Number(r.status) === ST.REJECT).length,
  };
  return { list: rows.map((r) => dto(r, club)), count };
}

/** 一条（带归属校验：不是自己社团的当作不存在，别泄露别家的单据） */
async function one(club, id) {
  const n = Number(id);
  const row = Number.isInteger(n) && n > 0
    ? await readOr(() => findOne(C.CLUB_NOTICE, { id: n }), null)
    : null;
  if (!row || Number(row.club_id) !== Number(club.id)) {
    throw new ApiError(Codes.NOT_FOUND, '没有这条通知');
  }
  return row;
}

/** 详情（学生端） */
async function detail(club, id) {
  const row = await one(club, id);
  return { record: dto(row, club), timeline: timelineOf(row) };
}

/** 未审核前修改（改了正文，标题跟着重算 —— 否则列表标题与实际内容对不上） */
async function update(club, id, input) {
  const row = await one(club, id);
  if (Number(row.status) !== ST.WAIT) {
    throw new ApiError(Codes.CONFLICT, '已经开始审核了，改不了了');
  }
  const body = assertBody(input && input.body);
  const patch = {
    body,
    title: summaryOf(body),
    update_time: nowIso(),
  };
  if (input && input.hopeText !== undefined) patch.hope_text = text(input.hopeText, 40);
  if (input && input.note !== undefined) patch.note = text(input.note, 100);

  await updateWhere(C.CLUB_NOTICE, { _id: row._id, status: ST.WAIT }, patch);
  return dto({ ...row, ...patch }, club);
}

/** 撤回（只有待审核能撤；已通过的不能单方面撤，得找社干） */
async function withdraw(club, id) {
  const row = await one(club, id);
  if (Number(row.status) !== ST.WAIT) {
    throw new ApiError(Codes.CONFLICT, '已经在排播了，撤回请直接找社干');
  }
  const patch = { status: ST.WITHDRAW, update_time: nowIso() };
  // ⚠️ 条件里带 status：两个人同时点撤回，第二个更新 0 行 ⇒ 状态没被改花
  await updateWhere(C.CLUB_NOTICE, { _id: row._id, status: ST.WAIT }, patch);
  return dto({ ...row, ...patch }, club);
}

/* ═══════════════ 伙伴端 ═══════════════ */

/**
 * 队列（三段：待审核 / 待播 / 已播出）
 *
 * ⚠️ 排序是**先提交先审**（create_time ASC, id ASC），与 /admin/submit/list 同一口径：
 *    按时间倒序会让「昨天那条老的最后才看到」，而它恰恰最急。
 */
async function queue(status) {
  await ready();
  const st = Number(status);
  const where = Number.isFinite(st) ? { status: st } : {};
  const rows = st === ST.DONE
    ? await readOr(() => findMany(C.CLUB_NOTICE, where, { orderBy: [['id', 'desc']], limit: 100 }), [])
    : await readOr(() => findMany(C.CLUB_NOTICE, where, { orderBy: [['id', 'asc']], limit: 100 }), []);

  const all = await readOr(() => findMany(C.CLUB_NOTICE, {}, { limit: 100 }), []);
  const count = {
    wait: all.filter((r) => Number(r.status) === ST.WAIT).length,
    air: all.filter((r) => Number(r.status) === ST.AIR).length,
    done: all.filter((r) => Number(r.status) === ST.DONE).length,
    reject: all.filter((r) => Number(r.status) === ST.REJECT).length,
  };
  return { list: rows.map((r) => dto(r)), count };
}

/** 按数字 id 取**原始行**（伙伴端审核要用它拿 _id；不存在报 40401） */
async function findRow(id) {
  await ready();
  const n = Number(id);
  const row = Number.isInteger(n) && n > 0
    ? await readOr(() => findOne(C.CLUB_NOTICE, { id: n }), null)
    : null;
  if (!row) throw new ApiError(Codes.NOT_FOUND, '没有这条通知');
  return row;
}

/** 伙伴端详情（不按社团过滤：站里要能看到所有社团的单子） */
async function adminDetail(id) {
  const row = await findRow(id);
  return { record: dto(row), timeline: timelineOf(row) };
}

/**
 * 审核：通过（并排期）或驳回（必写理由）
 *
 * @param {object} input { pass:true, date?, slot?, title? } 或 { pass:false, reason }
 *   `slot` 形如 '午间 12:20'、`date` 形如 '2026-11-07' —— 原型里「排到」「播几遍」两栏，
 *   本期只落「排到哪一天哪个时段」，遍数暂不做（站里口播本来就是一遍）。
 */
async function review(row, admin, input) {
  const st = Number(row.status);
  if (st !== ST.WAIT) throw new ApiError(Codes.CONFLICT, '这条已经处理过了');

  const by = (admin && (admin.nickname || admin.username)) || '';
  const now = nowIso();
  const b = input || {};

  if (b.pass === true || b.pass === 'true') {
    const patch = {
      status: ST.AIR,
      review_by_name: by,
      review_time: now,
      update_time: now,
      air_date: text(b.date, 10),
      air_slot: text(b.slot, 20),
    };
    if (b.title !== undefined) patch.title = text(b.title, 30) || summaryOf(row.body);
    // ⚠️ 条件带 status：两个社干同时点「通过」不会把状态改成别的
    const n = await updateWhere(C.CLUB_NOTICE, { _id: row._id, status: ST.WAIT }, patch);
    if (!n) throw new ApiError(Codes.CONFLICT, '这条已经处理过了');
    return dto({ ...row, ...patch });
  }

  const reason = text(b.reason, 120);
  if (reason.length < 4) {
    // 不写理由的驳回，学生只会反复重提同一条 —— 所以这里是硬拦，不是提醒
    throw new ApiError(Codes.PARAM_ERROR, '驳回要写明原因，学生要照着改');
  }
  const patch = {
    status: ST.REJECT,
    reject_reason: reason,
    review_by_name: by,
    review_time: now,
    update_time: now,
  };
  const n = await updateWhere(C.CLUB_NOTICE, { _id: row._id, status: ST.WAIT }, patch);
  if (!n) throw new ApiError(Codes.CONFLICT, '这条已经处理过了');
  return dto({ ...row, ...patch });
}

/** 标记已播出（只有待播能标） */
async function markAir(row, admin) {
  if (Number(row.status) !== ST.AIR) {
    throw new ApiError(Codes.CONFLICT, '只有待播的才能标已播出');
  }
  const patch = {
    status: ST.DONE,
    air_time: nowIso(),
    air_by_name: (admin && (admin.nickname || admin.username)) || '',
    update_time: nowIso(),
  };
  const n = await updateWhere(C.CLUB_NOTICE, { _id: row._id, status: ST.AIR }, patch);
  if (!n) throw new ApiError(Codes.CONFLICT, '这条已经被别人标过了');
  return dto({ ...row, ...patch });
}

module.exports = {
  ST, ST_TEXT, MAX_BODY, MAX_PENDING,
  summaryOf, timelineOf, shortTime, dto,
  create, myList, one, detail, update, withdraw,
  queue, findRow, adminDetail, review, markAir,
};
