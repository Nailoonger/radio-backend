'use strict';

/**
 * 社团密钥服务 —— 社团提报通知的进门凭证
 *
 * 业务口径（与小程序页面文案一一对应，改一处要回头改另一处）：
 *   ① 每个社团只有一把，长期有效，由广播站后台分配
 *   ② 社长与指导老师各持一把（同一把），换人时由社干重置
 *   ③ 弄丢或外泄找社干重新生成，旧密钥当场作废
 *
 * ═══════════ 为什么只存哈希、不存明文 ═══════════
 * 明文落库等于「谁摸到数据库谁就有全部社团的钥匙」，而重置日志、备份、导出
 * 都会把明文带出去。所以库里只留两样：
 *   `key_hash` = sha256(pepper + ':' + 明文)  —— 用来校验，不可逆
 *   `key_mask` = '····M7'                    —— 给人看的尾号，列表页显示这个
 * 明文只在**重置的那一次**返回给操作人，前端负责复制/转发出去；关掉页面就再也拿不到，
 * 想再看只能再重置一次（这正是「弄丢找社干重新生成」的语义）。
 *
 * ═══════════ 为什么是 sha256 而不是 bcrypt ═══════════
 * 两个原因：
 *   ① 校验路径要 O(1)：学生只输一串 6 位码，服务端**不知道是哪个社团**，
 *      用 bcrypt 就得把全表逐个比一遍（N 个社团 × 25ms，社团一多就顶不住）；
 *      sha256 可以拿哈希直接等值查一条。
 *   ② 加了 pepper：库被拖走也跑不出字典（6 位空间太小，裸 sha256 秒破）。
 * pepper 取 `CLUB_KEY_PEPPER`；没配就用 JWT 的同源密钥派生 —— 不新增必填环境变量。
 * ⚠️ 代价：换 `JWT_SECRET` 会让所有社团密钥一起失效（同一次改动也全体掉登录，认了）。
 */

const crypto = require('crypto');
const { SECRET: JWT_SECRET } = require('../lib/auth');
const {
  C, findOne, findById, findMany, insertOne, insertWithId, updateWhere, updateById, nextId,
} = require('../lib/db');
const { ApiError, Codes } = require('../lib/response');

function pepper() {
  return process.env.CLUB_KEY_PEPPER || `clubkey:${JWT_SECRET}`;
}

/* ── 密钥字符集：去掉 0/O/1/I/L ──
 * 这五个字符在打印稿和手抄里最容易认错，而密钥是要社长照着念/抄的。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_LEN = 6;

/* 学生票有效期：2 小时。够提报几条，又短到泄露了也不会长期可用 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function hashKey(plain) {
  return crypto.createHash('sha256').update(`${pepper()}:${String(plain || '').trim().toUpperCase()}`).digest('hex');
}

/** 生成一串新密钥（明文，只在内存里活一次） */
function genKey() {
  let out = '';
  for (let i = 0; i < KEY_LEN; i += 1) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

/** '····M7' —— 列表页只露最后两位 */
function maskOf(plain) {
  const s = String(plain || '');
  if (!s) return '已作废';
  return `····${s.slice(-2)}`;
}

/** 归一：学生手输可能带空格/横线/小写 */
function normalize(plain) {
  return String(plain || '').replace(/[\s-]/g, '').toUpperCase();
}

/* ═════════ 种子 ═════════
 * 这五家是 2026-11-06 陛下点名要轮播的社团（摄影协会 / 电视台 / 青年志愿者协会 /
 * 学生会 / 无与伦比吉他协会），不是凭空编的。惰性写入：表空才建，
 * 建完就是一个「有钥匙但还没发给社长」的状态（key_hash 为空 → 谁都进不来，
 * 必须由社干点一次重置才有真钥匙）。
 */
const SEED_CLUBS = [
  { name: '摄影协会', avatar: '' },
  { name: '电视台', avatar: '' },
  { name: '青年志愿者协会', avatar: '' },
  { name: '学生会', avatar: '' },
  { name: '无与伦比吉他协会', avatar: '' },
];

/* ⚠️⚠️ 云开发查一个**没建过**的集合是**抛错**（-502005），不是返回空数组。
 *    所以「表还不存在」这条路径必须自己兜住，否则第一次打开密钥页就是 50001。
 *    与 partner/_kit.js 的 readOr / isMissingCollection 同一口径（那边不能直接 require：
 *    _kit 依赖 services，反向 require 会成为循环依赖）。 */
function isMissingCollection(err) {
  const msg = String((err && (err.errMsg || err.message)) || err);
  return /collection not exists|-502005|Db or Table not exist|not exist/i.test(msg);
}

async function readOr(fn, fallback) {
  try { return await fn(); } catch (e) { if (isMissingCollection(e)) return fallback; throw e; }
}

async function ensureSeeded() {
  const existing = await readOr(() => findMany(C.CLUB_KEY, {}, { limit: 1 }), []);
  if (existing.length) return;
  for (let i = 0; i < SEED_CLUBS.length; i += 1) {
    const name = SEED_CLUBS[i].name;
    /* ⚠️ 用 `club:<社团名>` 当 `_id` 而不是让云库自动生成：
     *    两个请求同时发现表空时会各插一遍，自动 `_id` 挡不住重复 ⇒ 轮播里出现两个「电视台」。
     *    业务键当主键，第二遍直接撞 _id（下面 catch 掉），天然幂等。
     * ⚠️ 数字 `id` 仍然发一个：URL、外键、前端跳转一律用它（见 lib/db.js parseId 的口径）。 */
    const docId = `club:${name}`;
    if (await readOr(() => findById(C.CLUB_KEY, docId), null)) continue;
    const id = await nextId(C.CLUB_KEY);
    const doc = {
      id,
      club_name: name,
      club_avatar: SEED_CLUBS[i].avatar,
      key_hash: '',
      key_mask: '',
      status: 0,                 // 0=还没发钥匙 / 已作废；1=有效
      owner_name: '',
      teacher_name: '',
      reset_at: '',
      reset_by: '',
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
    };
    try {
      await insertWithId(C.CLUB_KEY, docId, doc);
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || e);
      if (/duplicate|already exist|-501001|-502002/i.test(msg)) continue;  // 并发下另一方刚建好
      if (!isMissingCollection(e)) throw e;
      // 表还不存在：建一次再写（这是「第一次打开密钥页」的正常路径，不是异常）
      const { db } = require('../lib/db');
      try { if (db && typeof db.createCollection === 'function') await db.createCollection(C.CLUB_KEY); } catch (e2) { /* 已存在 */ }
      try { await insertWithId(C.CLUB_KEY, docId, doc); }
      catch (e3) { if (!/duplicate|already exist|-501001|-502002/i.test(String((e3 && (e3.errMsg || e3.message)) || e3))) throw e3; }
    }
  }
}

function dto(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.club_name,
    avatar: row.club_avatar || '',
    // ⚠️ 永远不返回 key_hash
    mask: row.key_mask || '',
    status: Number(row.status) === 1 ? 1 : 0,
    ownerName: row.owner_name || '',
    teacherName: row.teacher_name || '',
    resetAt: row.reset_at || '',
    resetBy: row.reset_by || '',
  };
}

async function list() {
  await ensureSeeded();
  const rows = await findMany(C.CLUB_KEY, {}, { orderBy: [['id', 'asc']], limit: 100 });
  return rows.map(dto);
}

/**
 * 按数字 id 取一家社团（不存在报 40401）
 *
 * ⚠️ 先 `ensureSeeded()`：伙伴端可能没打开过列表就直接调「重置」（分享链接、深链、
 *    或者测试脚本），这时表还是空的，会得到一句莫名其妙的「没有这个社团」。
 *    播种是幂等的，代价是一次查询 —— 比让人排查「为什么 5 家变 0 家」便宜得多。
 */
async function mustRow(id) {
  await ensureSeeded();
  const row = await findOne(C.CLUB_KEY, { id: Number(id) });
  if (!row) throw new ApiError(Codes.NOT_FOUND, '没有这个社团');
  return row;
}

async function detail(id) {
  const row = await mustRow(id);
  return dto(row);
}

/**
 * 重置：生成新明文，写进库的只有新哈希与新掩码，旧哈希当场被覆盖（= 作废）
 * 返回的 `plain` 是**唯一一次**能看到明文的机会，调用方必须原样给前端。
 */
async function reset(id, byName) {
  const row = await mustRow(id);

  const plain = genKey();
  const now = new Date().toISOString();
  await updateWhere(C.CLUB_KEY, { _id: row._id }, {
    key_hash: hashKey(plain),
    key_mask: maskOf(plain),
    status: 1,
    reset_at: now,
    reset_by: byName || '',
    update_time: now,
  });
  return { plain, mask: maskOf(plain), record: dto({ ...row, key_mask: maskOf(plain), status: 1, reset_at: now, reset_by: byName || '' }) };
}

/** 启用 / 作废（作废 = 情况与"还没发钥匙"一致：谁都进不来） */
async function setStatus(id, status, byName) {
  const row = await mustRow(id);
  const on = Number(status) === 1 ? 1 : 0;
  const patch = { status: on, update_time: new Date().toISOString() };
  if (!on) {
    // 作废就把哈希清掉：留着哈希等于钥匙还能用，只是列表显示"已作废"——那是假作废
    patch.key_hash = '';
    patch.key_mask = '';
    patch.reset_by = byName || '';
    patch.reset_at = new Date().toISOString();
  }
  await updateWhere(C.CLUB_KEY, { _id: row._id }, patch);
  return dto({ ...row, ...patch });
}

/**
 * 改社团信息（头像 / 社长 / 指导老师）
 *
 * ⚠️⚠️ 这个函数**不碰 key_hash / status**。
 *    密钥的生成与作废只走 reset / setStatus —— 混进一个「顺手也能改密钥」的接口，
 *    迟早出现「我只想换张社团图，结果把钥匙换了，社长当场进不来」。
 * ⚠️ 文本字段统一 trim + 截断 20 字（社长姓名/老师姓名），不校验是否真人 —— 这栏是给人看的备注。
 */
async function saveInfo(id, patch, byName) {
  const row = await mustRow(id);

  const p = patch || {};
  const data = { update_time: new Date().toISOString(), update_by: byName || '' };
  if (p.avatar !== undefined) data.club_avatar = String(p.avatar || '');
  if (p.ownerName !== undefined) data.owner_name = String(p.ownerName || '').trim().slice(0, 20);
  if (p.teacherName !== undefined) data.teacher_name = String(p.teacherName || '').trim().slice(0, 20);

  // 只带了 update_time/update_by 说明一个字段都没给：报错而不是静默写一条空更新
  if (Object.keys(data).length <= 2) throw new ApiError(Codes.PARAM_ERROR, '没有要改的内容');

  await updateWhere(C.CLUB_KEY, { _id: row._id }, data);
  return dto({ ...row, ...data });
}

/** 按明文找社团（校验的主路径，一次查询） */
async function findByPlain(plain) {
  const k = normalize(plain);
  if (k.length !== KEY_LEN) return null;
  // readOr：表还没建（一次都没发过钥匙）时按「没有这把钥匙」处理，不是 50001
  const row = await readOr(() => findOne(C.CLUB_KEY, { key_hash: hashKey(k), status: 1 }), null);
  return row || null;
}

/* ═════════ 学生票据 ═════════
 * 输对密钥后发一个 ticket，前端存在本地，后续提报接口带它。
 * 只存 ticket 的哈希（同一个理由：票据也是凭据），过期由 expire_at 判断。
 */
async function issueSession(clubRow) {
  const ticket = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  await insertOne(C.CLUB_SESSION, {
    ticket_hash: hashKey(ticket),
    club_id: clubRow.id,
    club_name: clubRow.club_name,
    create_at: new Date(now).toISOString(),
    expire_at: new Date(now + SESSION_TTL_MS).toISOString(),
  });
  return { ticket, expireAt: now + SESSION_TTL_MS };
}

/** 读票据 → 社团；过期/伪造都返回 null（调用方统一按"请重新输入密钥"处理） */
async function readSession(ticket) {
  const t = String(ticket || '').trim();
  if (!t) return null;
  const row = await findOne(C.CLUB_SESSION, { ticket_hash: hashKey(t) });
  if (!row) return null;
  if (new Date(row.expire_at).getTime() < Date.now()) return null;
  return { clubId: row.club_id, clubName: row.club_name };
}

/**
 * 读票据 → **社团的整行原文**（提报线要用 club_keys 的 owner_name / avatar / 状态）
 *
 * ⚠️ 票据有效但社团已被作废时返回 null：作废的语义是「这把钥匙打不开门了」，
 *    不能出现「旧票据还能继续提报」这种事。
 */
async function readSessionClub(ticket) {
  const s = await readSession(ticket);
  if (!s) return null;
  const row = await readOr(() => findOne(C.CLUB_KEY, { id: Number(s.clubId) }), null);
  if (!row || Number(row.status) !== 1) return null;
  return row;
}

/**
 * 学生端轮播用的精简清单（**不含掩码、不含状态、不含谁重置过**）
 *
 * 未登录也要能看（原型 s-entry 屏的弧形轮播就是它），所以这条路**不做鉴权**。
 * 露出去的只有「社团名 + 头像」，本来就是公开的校园组织信息；
 * 掩码和 `status` 一律不出去 —— 不然谁都能从列表里看出「哪家还没设密钥」。
 */
async function publicList() {
  await ensureSeeded();
  const rows = await findMany(C.CLUB_KEY, {}, { orderBy: [['id', 'asc']], limit: 100 });
  return rows.map((r) => ({ id: r.id, name: r.club_name, avatar: r.club_avatar || '' }));
}

/* ═════════ 试错闸 ═════════
 * 6 位、31 个字符 ≈ 8.9 亿种。单点爆破不设闸也只是理论风险，
 * 但「学生账号人手一个」意味着攻击者已经有登录态 —— 一次请求 3ms，一分钟能刷两万次。
 * 所以按**来源**（openid / IP）限速：同一来源一分钟最多 8 次，成功后清零。
 *
 * ⚠️ 状态放库里（`_id = <来源>`），不放内存 —— 云函数是无状态的，多实例冷启动各算各的，
 *    内存计数等于没有。一份来源一个文档，不随分钟数增长，不需要清理任务。
 */
const MAX_TRIES_PER_MIN = 8;

async function guardTry(source) {
  const src = String(source || '').trim() || 'anon';
  const minute = Math.floor(Date.now() / 60000);

  const row = await findById(C.CLUB_KEY_TRY, src);
  const sameMinute = !!row && Number(row.minute) === minute;
  const n = sameMinute ? (Number(row.count) || 0) : 0;
  if (n >= MAX_TRIES_PER_MIN) {
    throw new ApiError(Codes.FORBIDDEN, '试得有点频繁，请一分钟后再试');
  }

  const data = { minute, count: n + 1, update_time: new Date().toISOString() };
  if (row) await updateById(C.CLUB_KEY_TRY, src, data);
  else {
    try { await insertWithId(C.CLUB_KEY_TRY, src, data); }
    catch (e) { await updateById(C.CLUB_KEY_TRY, src, data); }  // 并发首建撞上了，退化成更新
  }
  return n + 1;
}

/** 输对了就清零：不让上一次的失败挡住下一次正常使用 */
async function clearTry(source) {
  const src = String(source || '').trim() || 'anon';
  try {
    await updateById(C.CLUB_KEY_TRY, src, { minute: Math.floor(Date.now() / 60000), count: 0 });
  } catch (e) { /* 没这一行更好，什么都不用做 */ }
}

module.exports = {
  ALPHABET, KEY_LEN, SESSION_TTL_MS, MAX_TRIES_PER_MIN,
  hashKey, genKey, maskOf, normalize,
  ensureSeeded, list, publicList, detail, reset, setStatus, saveInfo, findByPlain, dto,
  issueSession, readSession, readSessionClub, guardTry, clearTry,
};
