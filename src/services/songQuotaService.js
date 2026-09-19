'use strict';

/**
 * 点歌名额服务 —— 日 / 周 名额的原子占用、自动驳回、快照
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 并发设计（这是本模块最要紧的部分，改动前先读完）
 * ═══════════════════════════════════════════════════════════════════════
 * 1) 绝不「先 SELECT used，再写回 used + 1」。
 *    那是经典超发：两个管理员同时通过 → 都读到 used=19 → 都写 20 → 实际放出 21 个名额。
 *    这里只允许一条带条件的 UPDATE：
 *        UPDATE song_quota SET used = used + 1
 *         WHERE period = ? AND period_key = ? AND used < :limit
 *    命中 1 行 = 抢到名额；命中 0 行 = 名额已满（或本周期行还没建）。
 *    InnoDB 会对该行加排他锁，同一行的并发请求天然串行化 —— 不需要显式锁，也不需要
 *    SELECT ... FOR UPDATE（那会多一次往返，还容易出现锁顺序问题）。
 *
 * 2) 计数器必须落在数据库，不能放进程内存。
 *    内存计数在「多实例 / pm2 cluster / 重启」下会各算各的，直接超发。放 DB 则天然共享。
 *
 * 3) 「拿到本周期那一行」靠 UNIQUE(period, period_key) 保证唯一。
 *    并发首建时只有一个 INSERT 成功，其余走 findOrCreate 的冲突重试分支 —— 不会建出两行，
 *    也就不会出现「两份计数各加一半」。
 *
 * 4) 事务边界：占位（claim）必须和「把这条改成已通过」在**同一个事务**里。
 *    这样任一环节失败（周名额刚好满了）整体回滚，日名额不会白扣。
 *    ⚠️ 事务内不要做任何外部 IO（微信接口、HTTP），否则锁持有时间会被拉长，
 *    同一段时间里所有点歌审核都会排在后面等这个行锁。
 *
 * 5) 自动驳回（sweep）放在**事务提交之后**执行，且是幂等的：
 *    WHERE status = 0 —— 重复执行只会命中更少的行，不会把已通过/已人工驳回的改掉。
 *
 * 6) 时区：日/周边界按 **Asia/Shanghai** 计算，并且不依赖进程 TZ。
 *    （后端容器目前没设 TZ，即 UTC；若直接用 dayjs() 取「今天」，
 *     日切点会变成北京时间早上 8 点。）
 *
 * 7) 失败策略（写死在这里，别改）：
 *    - **写路径（claim / 读上限）**：只有「表不存在」（老库没跑迁移）才降级成「不限制」，
 *      其它异常一律上抛 → 事务回滚 → 这次通过失败并报错。
 *      宁可让管理员重试一次，也绝不因为一次数据库抖动把当日名额全放开（超发）。
 *    - **读路径（status / exhausted / sweep）**：宽容处理，出错只打日志并按「未满」返回。
 *      它只影响提示与自动驳回时机，不影响名额判定本身，兜底还有 sweep 重跑。
 */

const { Op } = require('sequelize');
const dayjs = require('dayjs');
const { sequelize, SongQuota, SystemSetting, Submit } = require('../models');

const PERIOD = { DAY: 1, WEEK: 2 };
const LIMIT_CACHE_TTL = 10 * 1000;       // 名额上限的读缓存，写入口会主动清

const SETTING_KEY = { [PERIOD.DAY]: 'song_quota_daily', [PERIOD.WEEK]: 'song_quota_weekly' };
const SYSTEM_REASON = {
  [PERIOD.DAY]: '今日点歌名额已满，系统自动驳回',
  [PERIOD.WEEK]: '本周点歌名额已满，系统自动驳回',
};

let limitCache = null;
let limitCacheAt = 0;
let warned = false;

function warnOnce(err, where) {
  if (warned) return;
  warned = true;
  // 只打一次，避免刷日志；fail-open 的痕迹必须留下
  console.warn(`[songQuota] ${where} 失败，本次按「不限名额」处理：${err.message}`);
}

/* ------------------------------------------------------------------ *
 * 时间：统一走 utils/bjTime（固定 +08:00，与进程 TZ 无关）
 * 这里保留同名局部别名，函数体不用改
 * ------------------------------------------------------------------ */
const bj = require('../utils/bjTime');
const shifted = bj.shifted;
const pad2 = bj.pad2;
const dayKey = bj.dayKey;
const weekKey = bj.weekKey;
const dayRange = bj.dayRange;
const weekRange = bj.weekRange;

/* ------------------------------------------------------------------ *
 * 名额上限（KV：song_quota_daily / song_quota_weekly，0 或空 = 不限）
 * ------------------------------------------------------------------ */
function parseLimit(v) {
  const n = parseInt(String(v === null || v === undefined ? '' : v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function getLimits() {
  const now = Date.now();
  if (limitCache && now - limitCacheAt < LIMIT_CACHE_TTL) return limitCache;
  try {
    const rows = await SystemSetting.findAll({
      where: { key: { [Op.in]: [SETTING_KEY[PERIOD.DAY], SETTING_KEY[PERIOD.WEEK]] } },
    });
    const map = {};
    rows.forEach((r) => {
      const k = r.get ? r.get('key') : r.key;
      const v = r.get ? r.get('value') : r.value;
      map[k] = v;
    });
    limitCache = {
      daily: parseLimit(map[SETTING_KEY[PERIOD.DAY]]),
      weekly: parseLimit(map[SETTING_KEY[PERIOD.WEEK]]),
    };
    limitCacheAt = now;
  } catch (e) {
    // 读不到上限就没法判定名额。表不存在 = 迁移还没跑 → 按不限制（功能未上线）；
    // 其它错误 → 上抛，谁调用谁决定。绝不把「读失败」当成「不限制」静默放行，
    // 否则一次数据库抖动就能把当日名额全部放开。
    if (!isMissingTable(e)) throw e;
    warnOnce(e, '读取名额设置（system_setting 不存在，按不限制处理）');
    limitCache = { daily: 0, weekly: 0 };
    limitCacheAt = now;
  }
  return limitCache;
}

function clearLimitCache() { limitCache = null; limitCacheAt = 0; }

/** 写入名额上限（写 KV，清缓存，返回最新快照） */
async function setLimits({ daily, weekly }, adminId) {
  const items = [
    { key: SETTING_KEY[PERIOD.DAY], value: String(parseLimit(daily)) },
    { key: SETTING_KEY[PERIOD.WEEK], value: String(parseLimit(weekly)) },
  ];
  for (const it of items) {
    const row = await SystemSetting.findOne({ where: { key: it.key } });
    if (row) await row.update({ value: it.value });
    else await SystemSetting.create({ key: it.key, value: it.value, desc: '点歌名额上限（0=不限）' });
  }
  clearLimitCache();
  return snapshot();
}

/* ------------------------------------------------------------------ *
 * 原子占位
 * ------------------------------------------------------------------ */
function scopesOf(limits, ts) {
  return [
    { period: PERIOD.DAY, key: dayKey(ts), limit: limits.daily, range: dayRange(ts), name: 'daily' },
    { period: PERIOD.WEEK, key: weekKey(ts), limit: limits.weekly, range: weekRange(ts), name: 'weekly' },
  ];
}

/** 本周期行不存在时补建（靠唯一键兜住并发首建） */
async function ensureRow(scope, transaction) {
  // ⚠️ 这里**不能**用 findOrCreate：它会额外开一个 SAVEPOINT 并先 SELECT，
  //    实测在并发下（SQLite 尤其明显）直接抛锁异常，被下面的兜底逻辑吞掉后
  //    就会「每次都返回成功」→ 名额形同虚设。
  //    改成 INSERT IGNORE / ON CONFLICT DO NOTHING：唯一键冲突直接跳过，一条语句搞定。
  try {
    await SongQuota.bulkCreate(
      [{ period: scope.period, periodKey: scope.key, used: 0 }],
      { ignoreDuplicates: true, transaction }
    );
  } catch (e) {
    const dup = e && (e.name === 'SequelizeUniqueConstraintError' || /UNIQUE|duplicate/i.test(String(e.message)));
    if (!dup) throw e;   // 冲突是预期内的（别人刚建好了），其它错误照抛
  }
}

/** 表还没建（老库没执行迁移）—— 只对这种情况降级 */
function isMissingTable(e) {
  return /no such table|doesn't exist|ER_NO_SUCH_TABLE/i.test(String(e && e.message));
}

/**
 * 抢占一个名额 —— 全程只有一条 UPDATE，不需要先读
 * @returns {Promise<{ok:boolean, used?:number}>}
 */
async function claimOneShot(scope, transaction) {
  const [affected] = await SongQuota.update(
    { used: sequelize.literal('used + 1') },
    {
      where: {
        period: scope.period,
        periodKey: scope.key,
        used: { [Op.lt]: scope.limit },   // ← 名额上限写进 WHERE，判断与自增不可分割
      },
      transaction,
    }
  );
  return affected === 1;
}

/**
 * 审核通过时占名额：日 + 周 一起占，任一不满足就整体失败（由调用方事务回滚）
 * @param {{transaction: import('sequelize').Transaction, now?: number}} opts
 * @returns {Promise<{ok:true, maxed:Array}|{ok:false, scope:string, limit:number, used:number}>}
 */
async function claim({ transaction, now = Date.now() } = {}) {
  try {
    const limits = await getLimits();
    const scopes = scopesOf(limits, now).filter((s) => s.limit > 0); // 0 = 不限，连行都不用建
    if (!scopes.length) return { ok: true, maxed: [] };

    const maxed = [];
    for (const s of scopes) {
      let got = await claimOneShot(s, transaction);
      if (!got) {
        // 两种可能：本周期行还没建，或者确实满了。补建后再抢一次。
        await ensureRow(s, transaction);
        got = await claimOneShot(s, transaction);
      }
      if (!got) {
        const row = await SongQuota.findOne({
          where: { period: s.period, periodKey: s.key },
          transaction,
        });
        return { ok: false, scope: s.name, limit: s.limit, used: row ? row.used : s.limit };
      }
      // 刚好把名额占满 → 记录，提交后要触发自动驳回
      if (s.limit - (await currentUsed(s, transaction)) <= 0) maxed.push(s);
    }
    return { ok: true, maxed };
  } catch (e) {
    // ⚠️ 这里**只**对「表不存在」降级（老库还没跑迁移，不能让审核全挂），
    //    其它任何异常一律上抛 —— 宁可让这次通过失败并报错，也绝不超发。
    //    读路径（status/exhausted）是相反的宽容策略，见各自注释。
    if (isMissingTable(e)) {
      warnOnce(e, '占名额（song_quota 表不存在，按不限制处理）');
      return { ok: true, maxed: [] };
    }
    throw e;
  }
}

async function currentUsed(scope, transaction) {
  const row = await SongQuota.findOne({
    where: { period: scope.period, periodKey: scope.key },
    transaction,
  });
  return row ? Number(row.used) : 0;
}

/** 名额是否已用尽（用户端提交前的提醒用；只读，不占位） */
async function status(now = Date.now()) {
  const limits = await getLimits();
  const out = { daily: null, weekly: null };
  try {
    for (const s of scopesOf(limits, now)) {
      const used = s.limit > 0 ? await currentUsed(s) : 0;
      out[s.name] = {
        limit: s.limit,
        used,
        remaining: s.limit > 0 ? Math.max(0, s.limit - used) : null,
        exhausted: s.limit > 0 ? used >= s.limit : false,
        periodKey: s.key,
      };
    }
  } catch (e) {
    warnOnce(e, '读取名额用量');
  }
  return out;
}

/** 名额是否已满（fail-open：查不到就当没满） */
async function exhausted(now = Date.now()) {
  const st = await status(now);
  return {
    daily: !!(st.daily && st.daily.exhausted),
    weekly: !!(st.weekly && st.weekly.exhausted),
  };
}

/** 归还一个名额（删除一条「已通过的点歌」时调用，避免名额泄漏） */
async function release(now = Date.now()) {
  try {
    const limits = await getLimits();
    for (const s of scopesOf(limits, now).filter((x) => x.limit > 0)) {
      await SongQuota.update(
        { used: sequelize.literal('used - 1') },
        { where: { period: s.period, periodKey: s.key, used: { [Op.gt]: 0 } } }
      );
    }
  } catch (e) {
    warnOnce(e, '归还名额');
  }
}

/* ------------------------------------------------------------------ *
 * 自动驳回：名额满了之后，把本周期内还没审的点歌全部驳回
 * 幂等 —— WHERE status = 0，重复跑只会命中更少的行
 * ------------------------------------------------------------------ */
async function sweep(scopeName, now = Date.now()) {
  try {
    const limits = await getLimits();
    const scope = scopesOf(limits, now).find((s) => s.name === scopeName);
    if (!scope) return 0;
    const [affected] = await Submit.update(
      {
        status: 2,
        rejectReason: SYSTEM_REASON[scope.period],
        autoRejected: 1,
        reviewerId: null,
        reviewTime: new Date(),
      },
      {
        where: {
          type: 1,                 // 只处理点歌，文稿不受名额影响
          status: 0,               // 只动还没审的 → 幂等
          createTime: { [Op.gte]: scope.range.start, [Op.lt]: scope.range.end },
        },
      }
    );
    if (affected) {
      await SongQuota.update(
        { exhaustedAt: new Date() },
        { where: { period: scope.period, periodKey: scope.key, exhaustedAt: null } }
      );
    }
    return affected;
  } catch (e) {
    warnOnce(e, '自动驳回');
    return 0;
  }
}

/** 把当前所有「已满」的周期都扫一遍（审核/提交后发现名额满时调用，提交后异步执行） */
async function sweepAllExhausted(now = Date.now()) {
  const st = await exhausted(now);
  const result = {};
  if (st.daily) result.daily = await sweep('daily', now);
  if (st.weekly) result.weekly = await sweep('weekly', now);
  return result;
}

/** 名额满了但还挂着多少条待审（给后台显示「还有 N 条需要处理」） */
async function pendingWhileExhausted(now = Date.now()) {
  const st = await status(now);
  const targets = [];
  if (st.daily && st.daily.exhausted) targets.push(dayRange(now));
  else if (st.weekly && st.weekly.exhausted) targets.push(weekRange(now));
  if (!targets.length) return 0;
  let n = 0;
  for (const r of targets) {
    n += await Submit.count({
      where: { type: 1, status: 0, createTime: { [Op.gte]: r.start, [Op.lt]: r.end } },
    });
  }
  return n;
}

/** 后台「名额」面板用的一次性快照 */
async function snapshot(now = Date.now()) {
  const st = await status(now);
  const pending = await pendingWhileExhausted(now);
  return {
    daily: st.daily,
    weekly: st.weekly,
    pendingWhileExhausted: pending,
    autoRejectedToday: await Submit.count({
      where: {
        type: 1,
        autoRejected: 1,
        createTime: { [Op.gte]: dayRange(now).start, [Op.lt]: dayRange(now).end },
      },
    }),
  };
}

/**
 * 清空名额计数器（仅供超管「一键清空点歌数据」使用）。
 * 全部删掉而不是清零当前周期：历史周期的行没有保留价值（exhausted_at 只是留痕），
 * 当前周期行会在下次 claim / status 时由 ensureRow 重建，从 0 重新计数。
 */
async function resetCounters() {
  const n = await SongQuota.destroy({ where: {} });
  limitCache = null;
  limitCacheAt = 0;
  return n;
}

module.exports = {
  PERIOD,
  SYSTEM_REASON,
  SETTING_KEY,
  dayKey,
  weekKey,
  dayRange,
  weekRange,
  getLimits,
  setLimits,
  clearLimitCache,
  claim,
  release,
  status,
  exhausted,
  sweep,
  sweepAllExhausted,
  pendingWhileExhausted,
  snapshot,
  parseLimit,
  resetCounters,
};
