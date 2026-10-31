/**
 * 权限位（超管分发的「排班 / 审核」开关）—— 2026-10-31
 *
 * 只有一个接口：`GET /partner/permissions/mine`。
 *
 * ⚠️⚠️ 这里**只是入口拦截**，不是权限本身。真正的闸在云函数 `_kit.asScheduler /
 *    asReviewer` 里 —— 前端能做的一切都能被绕过（改包、直接调接口）。
 *    所以两边的话术必须一致：被拒时弹窗的标题一律取接口返回的 `text`，
 *    别在页面里写死「暂无权限」四个字，否则改词就要改两处。
 *
 * ⚠️ 取不到（断网 / 超时）时**放行**：把人锁在门外比让他点进去再被拒更难受，
 *    而且后端那一层照样会拦，不会真的越权。这是有意的 fail-open，别改成 fail-closed。
 */

const { adminRequest } = require('./request.js');

/**
 * 缓存有效期 —— **只用于「同一轮渲染里顺手再问一次」的去重，不再当缓存用**
 *
 * ⚠️ 演进史（别往回走）：
 *   ① 第一版是**永久缓存** ⇒ 超管改完，社干不重新登录永远看不到（陛下原话「要重新登录才会更新」）
 *   ② 第二版给 15 秒 TTL ⇒ 切页面能更新了，但「改完切回去」还可能吃到 15 秒内的旧值
 *   ③ 现在：**1 秒**。切页面就是最新值；同一秒内几个页面一起问只发一个请求。
 *     「按页面切换就实时」这件事，靠 TTL 缩短解决，别再引入更长的缓存。
 */
const TTL_MS = 1 * 1000;

/**
 * 前台轮询间隔
 *
 * ⚠️ 为什么还要轮询：TTL 只管「切页面」，社干要是**停在工作台不动**，
 *    超管改了开关他也不知道。定时问一次是唯一不需要推送通道的办法。
 *
 * 成本：只有**社干**、且只在「工作台 / 班表 / 审核」这三页前台时才轮询。
 *      三五个人 × 10 秒一次 ≈ 每小时一千多次 callFunction，
 *      量级远在免费额度内；每次只读 1~3 条文档，很轻。
 * ⚠️ 想更快就改这个数（比如 5 秒），别去动 TTL —— 那是两件事。
 */
const POLL_MS = 10 * 1000;

let cached = null;
let cachedAt = 0;
let inflight = null;

/** 活跃的轮询订阅者：key → onChange。用 key 而不是单个回调，多页面叠栈时不会互相踩掉 */
const pollers = {};
let timer = null;
let primed = false;
let lastJson = '';

/**
 * 取当前账号的权限位
 * @param {boolean} force 忽略缓存重取
 * @returns {Promise<null|{isSuper:boolean, schedule:boolean, review:boolean, proxy:boolean, text:object}>}
 */
function load(force) {
  const fresh = cached && (Date.now() - cachedAt) < TTL_MS;
  if (!force && fresh) return Promise.resolve(cached);
  // 并发合并：同一次渲染里几个页面同时问，只打一个请求
  if (inflight) return inflight;
  inflight = adminRequest('/partner/permissions/mine', 'GET', {})
    .then((d) => {
      cached = d || null;
      cachedAt = Date.now();
      inflight = null;
      return cached;
    })
    .catch(() => {
      // 取不到就作废缓存，下次重试；调用方按「不知道」处理（放行，后端仍会拦）
      inflight = null;
      cached = null;
      cachedAt = 0;
      return null;
    });
  return inflight;
}

/** 已经拿到的权限位（同步；没拿过就是 null） */
function peek() {
  return cached;
}

function tick() {
  load(true).then((pm) => {
    if (!pm) return;
    const j = JSON.stringify(pm);
    if (!primed) {          // 第一次只记基线，不触发回调（页面刚自己问过，不重复处理）
      primed = true;
      lastJson = j;
      return;
    }
    if (j === lastJson) return;
    lastJson = j;
    Object.keys(pollers).forEach((k) => {
      try { pollers[k](pm); } catch (e) { /* 单个页面出错不能拖垮别人 */ }
    });
  });
}

/**
 * 订阅权限变化（页面 onShow 调，onHide/onUnload 必须停）
 * @param {string} key 页面标识（如 'planning' / 'review' / 'schedule'）
 * @param {(pm:object)=>void} onChange 权限变了才回调（没变一次都不会响）
 */
function startPolling(key, onChange) {
  if (!key) return;
  pollers[key] = onChange || function () {};
  if (timer) return;         // 已有定时器：只登记，不重复起
  primed = !!cached;
  lastJson = cached ? JSON.stringify(cached) : '';
  timer = setInterval(tick, POLL_MS);
}

/** 退订（最后一个退了才真的关掉定时器） */
function stopPolling(key) {
  if (key) delete pollers[key];
  if (!Object.keys(pollers).length && timer) {
    clearInterval(timer);
    timer = null;
    primed = false;
    lastJson = '';
  }
}

/** 退出登录 / 换账号时必须调，否则下一个人会看到上一个人的权限 */
function clear() {
  cached = null;
  cachedAt = 0;
  inflight = null;
  Object.keys(pollers).forEach((k) => delete pollers[k]);
  if (timer) { clearInterval(timer); timer = null; }
  primed = false;
  lastJson = '';
}

module.exports = { load, peek, clear, startPolling, stopPolling, POLL_MS, TTL_MS };

module.exports = { load, peek, clear };
