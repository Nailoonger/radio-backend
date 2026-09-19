'use strict';

/**
 * 注意事项服务（支持多份：点歌 / 文稿 …）
 *
 * 规则：
 *   1. 每份注意事项有独立的正文与版本号，存 KV：`<x>_notice` / `<x>_notice_version`；
 *   2. 正文**有变化**才让版本号 +1（同样的内容再保存一次不打扰用户）；
 *   3. 用户端进入对应模块先问一次：`needAck = 我的确认版本 < 当前版本`；
 *      确认后写入 notice_ack；提交时**服务端再校验一次**，防止绕过前端直接调接口；
 *   4. 「滑动到页底才能点我已知晓」是前端交互，服务端只能校验「确认过没有」——
 *      别误以为后端能保证「真的读完了」（docs/song-submit.md 2.3 有说明）。
 *
 * 加一份新注意事项 = 在 NOTICES 里加一行 + 前端多传一个 type，**不需要改表**。
 */

const { Op } = require('sequelize');
const { NoticeAck } = require('../models');
const kv = require('./kvService');

/** 目前两份：点歌、文稿（用户 2026-09-18 要求文稿也要一份） */
const NOTICES = {
  song: {
    label: '点歌注意事项',
    key: 'song_submit',
    kvContent: 'song_notice',
    kvVersion: 'song_notice_version',
  },
  article: {
    label: '文稿注意事项',
    key: 'article_submit',
    kvContent: 'article_notice',
    kvVersion: 'article_notice_version',
  },
};
const DEFAULT_TYPE = 'song';

const CACHE_TTL = 30 * 1000;
const cache = {};

function clearCache(type) {
  if (type && cache[type]) delete cache[type];
  else Object.keys(cache).forEach((k) => delete cache[k]);
}

function resolve(type) {
  const t = NOTICES[type] ? type : DEFAULT_TYPE;
  return { type: t, ...NOTICES[t] };
}

/** { content, version, configured } */
async function getRaw(type) {
  const spec = resolve(type);
  const hit = cache[spec.type];
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit;
  const m = await kv.getMany([spec.kvContent, spec.kvVersion]);
  const content = (m[spec.kvContent] || '').toString();
  const version = parseInt(m[spec.kvVersion], 10) || 0;
  cache[spec.type] = { content, version, configured: content.trim().length > 0, at: Date.now() };
  return cache[spec.type];
}

/** 用户视角：要不要弹、弹什么 */
async function getForUser(openid, type) {
  const spec = resolve(type);
  const { content, version, configured } = await getRaw(spec.type);
  const base = { type: spec.type, label: spec.label, key: spec.key, content: '', version };
  if (!configured) {
    // 没配置内容就不拦人（否则功能没上线就把入口堵死了）
    return { ...base, configured: false, needAck: false };
  }
  const ack = await NoticeAck.findOne({ where: { openid, noticeKey: spec.key } });
  const ackedVersion = ack ? Number(ack.version) : 0;
  return { ...base, content, configured: true, ackedVersion, needAck: ackedVersion < version };
}

/** 记录确认（幂等：重复确认不报错，版本只增不减） */
async function ack(openid, version, type) {
  const spec = resolve(type);
  const cur = await getRaw(spec.type);
  const v = Math.min(parseInt(version, 10) || cur.version, cur.version);
  const row = await NoticeAck.findOne({ where: { openid, noticeKey: spec.key } });
  if (!row) {
    await NoticeAck.create({ openid, noticeKey: spec.key, version: v });
  } else if (v > Number(row.version)) {
    await row.update({ version: v });
  }
  return getForUser(openid, spec.type);
}

/** 管理员读取一份：正文 + 版本 + 已确认人数 */
async function getForAdmin(type) {
  const spec = resolve(type);
  const { content, version, configured } = await getRaw(spec.type);
  const ackedCount = configured
    ? await NoticeAck.count({ where: { noticeKey: spec.key, version: { [Op.gte]: version } } })
    : 0;
  return { type: spec.type, label: spec.label, key: spec.key, content, version, configured, ackedCount };
}

/** 管理员读取全部（后台一次拿到两份，省一次往返） */
async function getAllForAdmin() {
  const out = {};
  for (const t of Object.keys(NOTICES)) out[t] = await getForAdmin(t);
  return out;
}

/**
 * 管理员保存：内容变了才升版本
 * @returns {Promise<{bumped:boolean}>}
 */
async function save(content, type) {
  const spec = resolve(type);
  const text = (content === undefined || content === null) ? '' : String(content);
  if (text.length > 5000) {
    const err = new Error(spec.label + '内容不能超过 5000 字');
    err.code = 40001;
    throw err;
  }
  const before = await getRaw(spec.type);
  const changed = text.trim() !== before.content.trim();
  const nextVersion = changed ? before.version + 1 : before.version;

  await kv.set(spec.kvContent, text, spec.label + '正文（留空 = 不启用）');
  await kv.set(spec.kvVersion, nextVersion, spec.label + '版本号（内容变化时 +1）');
  clearCache(spec.type);

  const fresh = await getForAdmin(spec.type);
  return { ...fresh, bumped: changed };
}

/**
 * 提交前的服务端校验：没确认就不许提交
 * @returns {Promise<{ok:boolean, reason?:string, version?:number, type:string}>}
 */
async function assertAcked(openid, type) {
  const st = await getForUser(openid, type);
  if (!st.configured || !st.needAck) return { ok: true, version: st.version, type: st.type };
  return { ok: false, reason: `请先阅读并确认${st.label}`, version: st.version, type: st.type };
}

module.exports = {
  NOTICES,
  DEFAULT_TYPE,
  resolve,
  getRaw,
  getForUser,
  getForAdmin,
  getAllForAdmin,
  save,
  ack,
  assertAcked,
  clearCache,
};
