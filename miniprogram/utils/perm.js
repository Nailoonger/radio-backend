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

let cached = null;
let inflight = null;

/**
 * 取当前账号的权限位
 * @param {boolean} force 忽略缓存重取（例如刚在权限管理页改完）
 * @returns {Promise<null|{isSuper:boolean, schedule:boolean, review:boolean, text:object}>}
 */
function load(force) {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inflight) return inflight;
  inflight = adminRequest('/partner/permissions/mine', 'GET', {})
    .then((d) => {
      cached = d || null;
      inflight = null;
      return cached;
    })
    .catch(() => {
      inflight = null;
      return null;
    });
  return inflight;
}

/** 已经拿到的权限位（同步；没拿过就是 null） */
function peek() {
  return cached;
}

/** 退出登录 / 换账号时必须调，否则下一个人会看到上一个人的权限 */
function clear() {
  cached = null;
  inflight = null;
}

module.exports = { load, peek, clear };
