// utils/partnerRole.js · v1（2026-11-02）
//
// 伙伴端「当前角色」的唯一读法。
//
// ⚠️ 为什么要有它（2026-11-02 陛下：「你把超管的排班工作台里面的排班规则也做成弹窗干啥，
//    那这样超管怎么修改排班规则」）：
//    排班工作台 / 班表页都是**进页那一刻**把 `adminInfo.role` 抄进 data（isSuper / roleKey），
//    之后点的每一处都读那份快照。缓存里的 adminInfo 一旦缺 `role`（老版本写下的、
//    或者只存了 id/username），快照就是错的 —— 超管被判成社干，点「排班规则」
//    落到只读弹层，整站再没有第二个能改规则的入口。
//
// 三层口径（照 me.js 那套，别另发明）：
//   ① globalData.adminInfo（登录/刷新时写）
//   ② wx.getStorageSync('adminInfo')（冷启动恢复用）
//   ③ 两处都没有 role ⇒ 问一次 GET /partner/me，拿到后写回 ①②（自愈，只在这一种情况下发请求）
//
// 三档写满（铁律）：0 超管 / 1 社干 / 2 站员。少写一档 = 某个角色拿到别人的入口。

const { adminRequest } = require('./request');

const STORAGE_KEY = 'adminInfo';

/**
 * `sync()` 的实例级缓存
 *   at      —— 上次成功对账的时间（TTL 15 秒：切 tab 很快，不必每次都打接口）
 *   me      —— 上次的 /partner/me 响应（TTL 内直接复用）
 *   pending —— 正在进行的那次对账（多个页面 onShow 撞在同一拍）
 */
let syncCache = { at: 0, me: null, pending: null };
const SYNC_TTL = 15000;

/** 本地那份 adminInfo（globalData 优先，其次 storage），永远返回对象 */
function info() {
  let app = null;
  try { app = getApp(); } catch (e) { app = null; }
  const fromApp = (app && app.globalData && app.globalData.adminInfo) || null;
  const fromStore = (wx.getStorageSync && wx.getStorageSync(STORAGE_KEY)) || null;
  const merged = fromApp || fromStore || {};
  return merged && typeof merged === 'object' ? merged : {};
}

/** 角色号是否已可信（0/1/2 才算；undefined、''、'abc' 都不算） */
function known(role) {
  return role === 0 || role === 1 || role === 2;
}

/** 同步读：拿不到就是 NaN，调用方别自己 Number(undefined) 当 0 用 */
function role() {
  const r = Number(info().role);
  return known(r) ? r : NaN;
}

/** 写回 ①②（两处都写，冷启动下次读得到） */
function remember(patch) {
  try {
    const merged = Object.assign({}, info(), patch);
    if (wx.setStorageSync) wx.setStorageSync(STORAGE_KEY, merged);
    let app = null;
    try { app = getApp(); } catch (e) { app = null; }
    if (app && app.globalData) app.globalData.adminInfo = merged;
  } catch (e) { /* 写缓存失败不影响本次判定 */ }
  return patch;
}

/**
 * 保证拿到一个可信角色号（Promise<number>）
 * - 本地已有 0/1/2 → 直接 resolve，**不发请求**（正常路径零延迟）
 * - 本地没有 → 问 /partner/me，写回缓存再 resolve
 * - 问不到（断网 / 401）→ resolve NaN，调用方按「不确定」处理，别当成社干
 */
function ensure() {
  const r = role();
  if (known(r)) return Promise.resolve(r);
  return adminRequest('/partner/me', 'GET', {})
    .then((me) => {
      if (!me) return NaN;
      // ⚠️ 字段名照后端：role / nickname / username / createTime（见 me.js applyAdmin 头注）
      remember({ id: me.id, username: me.username, nickname: me.nickname, role: me.role, createTime: me.createTime });
      const next = Number(me.role);
      return known(next) ? next : NaN;
    })
    .catch(() => NaN);
}

/** 角色号 → 伙伴端内部的三个 key（全站口径一致，别再各页自己三元） */
function roleKeyOf(r) {
  const n = Number(r);
  return n === 0 ? 'super' : (n === 2 ? 'member' : (n === 1 ? 'manager' : ''));
}

/**
 * 和服务端对一次账 —— 角色的**唯一刷新入口**
 *
 * 2026-11-02 陛下：「管理端 web 在账号管理那里切换账号角色，无法实时同步，导致权限错乱」
 *   伙伴端所有页的 roleKey 都是 onLoad 时从缓存抄的（`adminInfo.role`），
 *   超管在电脑端把某人改成站员之后，那人切回小程序**底栏还是 5 格、审核入口还在**，
 *   点进去才被后端 40301 拦住 —— 界面和权限对不上，这就是「不同步」。
 *
 * 现在每个 tab 页 onShow 调一次 sync：
 *   · 15 秒 TTL + 并发去重（切 tab 很快，不会每次都打接口）
 *   · 服务端说了算：写回 storage + globalData，`role()` 之后读到的就是新值
 *   · 返回 changed，页面据此重排底栏 / 把已经没有入口的人送回去
 *
 * @param {boolean} force 忽略 TTL（下拉刷新、疑似刚被改时用）
 * @returns {Promise<{prev:number, next:number, changed:boolean, me:object|null}>}
 */
function sync(force) {
  const cur = role();
  /* TTL 命中还要多看一眼本地角色：别的地方（如「我的」页 fetchMe）可能刚把 storage 写新了，
     这时再拿 15 秒前的缓存就等于把人按回旧角色。两者不一致 ⇒ 重新拉。 */
  if (!force && syncCache.me && Date.now() - syncCache.at < SYNC_TTL
      && known(cur) && Number(syncCache.me.role) === cur) {
    return Promise.resolve({ prev: cur, next: cur, changed: false, me: syncCache.me });
  }
  if (syncCache.pending) return syncCache.pending;

  syncCache.pending = adminRequest('/partner/me', 'GET', {})
    .then((me) => {
      const prev = role();
      const next = me ? Number(me.role) : NaN;
      if (me) {
        // 字段名照后端：role / nickname / username / createTime（见 me.js applyAdmin 头注）
        remember({ id: me.id, username: me.username, nickname: me.nickname, role: me.role, createTime: me.createTime });
      }
      syncCache = { at: Date.now(), me: me || null, pending: null };
      return {
        prev,
        next: known(next) ? next : NaN,
        // 只有「两边都可信且不相等」才算变了 —— 查不到时不要把界面打回默认值
        changed: known(prev) && known(next) && prev !== next,
        me: me || null,
      };
    })
    .catch(() => {
      // 断网 / 401（request.js 已清 token 跳登录）都不改界面，保持旧值
      syncCache = { at: 0, me: syncCache.me, pending: null };
      const r = role();
      return { prev: r, next: r, changed: false, me: null };
    });
  return syncCache.pending;
}

/** 角色变了要提示一句，别让人以为是页面自己抽风 */
function toastChanged() {
  if (wx.showToast) wx.showToast({ title: '权限已更新', icon: 'none' });
}

module.exports = { info, role, known, ensure, remember, roleKeyOf, sync, toastChanged, STORAGE_KEY };
