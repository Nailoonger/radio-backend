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
 * 缓存有效期
 *
 * ⚠️ 原来是**永久缓存**（拿到一次就一直用），于是超管改了开关，社干那边不重新登录
 *    永远是旧值 —— 陛下 2026-10-31 原话「好像不会实时更新权限，要重新登录才会更新」。
 *    改成短 TTL：页面切回来（onShow）会重新问，但 15 秒内多次切页不会重复打请求。
 */
const TTL_MS = 15 * 1000;

let cached = null;
let cachedAt = 0;
let inflight = null;

/**
 * 取当前账号的权限位
 * @param {boolean} force 忽略缓存重取（例如刚在权限管理页改完）
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

/** 已经拿到的权限位（同步；没拿过或已过期就是 null） */
function peek() {
  const fresh = cached && (Date.now() - cachedAt) < TTL_MS;
  return fresh ? cached : null;
}

/** 退出登录 / 换账号时必须调，否则下一个人会看到上一个人的权限 */
function clear() {
  cached = null;
  cachedAt = 0;
  inflight = null;
}

module.exports = { load, peek, clear };
