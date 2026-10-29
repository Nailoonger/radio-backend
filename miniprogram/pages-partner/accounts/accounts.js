// pages-partner/accounts/accounts.js · v2（2026-10-30 逐条对齐 v151 的 v139 账号屏）
//
// 一页三段：统计 + 搜索 + 三 tab / 白卡列表 / 底部「批量重置」。
// 点行开**单账号抽屉**，四个动作：复制账号密码 / 重置密码 / 停用·恢复 / 删除。
//
// ⚠️⚠️ 三态（已激活 / 待激活 / 停用）没有现成字段：
//    admin 表只有 `status`(1/0) 和 `lastLoginAt`。
//    「待激活」＝ status=1 且 lastLoginAt 为空（账号发了、人还没进来）。
//    判定只写在 statusOf() 一处 —— 列表过滤、统计、批量重置的「仅待激活」共用它。
//    ⚠️ 后端 `resetPasswordBatch` 里是同一套条件（status=1 && !lastLoginAt），
//       改这里必须同步改那里，否则「预览 N 个」和「实际重置 M 个」对不上。
//
// ⚠️ 列表**一次拉全**（pageSize 上限 200，超过就续拉）：
//    统计条和三 tab 的数字必须是全量的，分页拉会算出「已激活 20」这种假数。
//    搜索也走本地过滤、不打接口 —— v151 就是这么做的（.acc-search 即时筛）。
//
// ⚠️ 导入名册（把学生拉进来当站员）**不在这屏**：
//    站员账号归管理端 web 后续的「站员表」管，后端 POST /partner/accounts/import 保留不动。
//
// ⚠️ 初始密码 = `user` + 学号（唯一口径见 cloud 侧 partner/accounts.js 文件头），
//    界面上直接把规则算给超管看、可一键复制；不在任何地方存明文。

const { adminRequest } = require('../../utils/request.js');

const PAGE_SIZE = 200;                 // 后端 pager() 的 maxSize，再大也会被截到 200
const ROLE_TEXT = { 0: '超管', 1: '社干', 2: '站员' };
const ST_TEXT = { ok: '已激活', todo: '待激活', off: '停用' };

/** 三态判定 —— 全页唯一口径（后端 resetPasswordBatch 用的是同一套） */
function statusOf(x) {
  if (Number(x.status) !== 1) return 'off';
  if (!x.lastLoginAt) return 'todo';
  return 'ok';
}

/** 后端一行 → 界面一行 */
function decorate(x) {
  const role = Number(x.role);
  const username = String(x.username || '');
  const name = x.nickname || username || ('账号' + x.id);
  const sub = [username, ROLE_TEXT[role] || '未知', String(x.department || '').trim()]
    .filter(Boolean).join(' · ');
  const st = statusOf(x);
  return {
    id: x.id,
    name,
    username,
    sub,
    role,
    stKey: st,
    stText: ST_TEXT[st],
    stCls: st === 'ok' ? 'ok' : (st === 'off' ? 'off' : 'warn'),
    initPwd: username ? ('user' + username) : '',
  };
}

/** 批量重置的范围规则 —— 与后端 resetPasswordBatch 的 RANGES 一一对应 */
function inRange(a, range) {
  if (range === 'cadre') return a.role === 1;
  if (range === 'staff') return a.role === 2;
  if (range === 'todo') return a.stKey === 'todo';
  return true;
}

Page({
  data: {
    statusBarHeight: 20,

    loading: true,
    listAll: [],          // 全量（已 decorate）
    vis: [],              // 当前 tab + 关键词过滤后的
    cnt: { ok: 0, todo: 0, off: 0 },
    tabs: [
      { k: 'all', t: '全部', n: 0 },
      { k: 'todo', t: '待激活', n: 0 },
      { k: 'off', t: '已停用', n: 0 },
    ],
    tab: 'all',
    kw: '',

    // 单账号抽屉
    who: null,

    // 批量重置抽屉
    resetOpen: false,
    range: 'todo',
    ranges: [
      { k: 'all', t: '全部' },
      { k: 'cadre', t: '社干' },
      { k: 'staff', t: '站员' },
      { k: 'todo', t: '仅待激活' },
    ],
    preview: [],
    resetting: false,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    if (Number(info.role) !== 0) {
      // 只有超管能进；非超管直接退回去，不给「看得见点不动」的界面
      wx.showToast({ title: '只有超管能管账号', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
      return;
    }
    this.setData({ statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    this.fetchAll();
  },

  onPullDownRefresh() {
    this.fetchAll().then(() => wx.stopPullDownRefresh());
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  /** 点空白处关闭抽屉时不要穿透触发底下的行 */
  noop() {},

  // ───────── 数据 ─────────
  fetchAll() {
    this.setData({ loading: true });
    const acc = [];
    const step = (page) => adminRequest('/admin/admin/list', 'GET', {
      keyword: '', page, pageSize: PAGE_SIZE,
    }).then((d) => {
      const rows = ((d && d.list) || []).map(decorate);
      rows.forEach((r) => acc.push(r));
      const total = Number((d && d.total) || 0);
      // 只有「本页拉满了且还没拉够总数」才继续 —— 否则会空转一次
      if (rows.length >= PAGE_SIZE && acc.length < total) return step(page + 1);
      return null;
    });

    return step(1)
      .then(() => {
        this.setData({ loading: false, listAll: acc });
        this.applyFilter();
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  applyFilter() {
    const listAll = this.data.listAll || [];
    const tab = this.data.tab;
    const q = String(this.data.kw || '').trim().toLowerCase();

    const cnt = { ok: 0, todo: 0, off: 0 };
    listAll.forEach((a) => { cnt[a.stKey] = (cnt[a.stKey] || 0) + 1; });

    const vis = listAll.filter((a) => {
      if (tab === 'todo' && a.stKey !== 'todo') return false;
      if (tab === 'off' && a.stKey !== 'off') return false;
      if (!q) return true;
      return (a.name + ' ' + a.sub).toLowerCase().indexOf(q) >= 0;
    });

    this.setData({
      vis,
      cnt,
      tabs: [
        { k: 'all', t: '全部', n: listAll.length },
        { k: 'todo', t: '待激活', n: cnt.todo },
        { k: 'off', t: '已停用', n: cnt.off },
      ],
    });
  },

  onKw(e) {
    this.setData({ kw: e.detail.value });
    this.applyFilter();
  },

  onTab(e) {
    const k = e.currentTarget.dataset.k;
    if (k === this.data.tab) return;
    this.setData({ tab: k });
    this.applyFilter();
  },

  // ───────── 单账号抽屉 ─────────
  onOpenWho(e) {
    const item = this.data.vis[Number(e.currentTarget.dataset.idx)];
    if (!item) return;
    this.setData({ who: item });
  },

  onCloseWho() {
    this.setData({ who: null });
  },

  onCopy() {
    const w = this.data.who;
    if (!w || !w.initPwd) return;
    // 复制的是「账号 + 初始密码」两行，超管粘到微信里就能直接发给人
    wx.setClipboardData({ data: `账号：${w.username}\n初始密码：${w.initPwd}` });
  },

  onResetOne() {
    const w = this.data.who;
    if (!w) return;
    if (!w.username) {
      wx.showToast({ title: '这个账号没有学号，无法算初始密码', icon: 'none' });
      return;
    }
    this._confirm({
      title: '重置密码',
      content: `把「${w.name}」的密码重置成「${w.initPwd}」？他下次登录要用新密码。`,
      confirmText: '重置',
      then: () => this._put(w.id, { password: w.initPwd }, '密码已重置'),
    });
  },

  onToggleStatus() {
    const w = this.data.who;
    if (!w) return;
    const toOff = w.stKey !== 'off';
    this._confirm({
      title: toOff ? '停用账号' : '恢复启用',
      content: toOff
        ? `停用「${w.name}」？停用后他登不上伙伴端，排班/请假记录都还在。`
        : `恢复「${w.name}」的账号？恢复后他可以用原密码登录。`,
      confirmText: toOff ? '停用' : '启用',
      then: () => this._put(w.id, { status: toOff ? 0 : 1 }, toOff ? '已停用' : '已启用'),
    });
  },

  onRemove() {
    const w = this.data.who;
    if (!w) return;
    wx.showModal({
      title: '删除账号',
      content: `删掉「${w.name}」的伙伴账号？删掉后这个学号可以重新加入，但以他名义记录的历史不会跟着消失。`,
      confirmText: '删除',
      confirmColor: '#B42318',
      success: (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '删除中', mask: true });
        adminRequest(`/admin/admin/${w.id}`, 'DELETE')
          .then(() => {
            wx.hideLoading();
            this.setData({ who: null });
            wx.showToast({ title: '已删除', icon: 'success' });
            return this.fetchAll();
          })
          .catch((err) => {
            wx.hideLoading();
            // 后端护栏的原文（不能删自己 / 至少保留一个超管）直接透出来
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      },
    });
  },

  /** 二次确认 + 执行体（重置/停用只差文案，收一处免得两边漏 confirm） */
  _confirm(o) {
    wx.showModal({
      title: o.title,
      content: o.content,
      confirmText: o.confirmText,
      success: (r) => { if (r.confirm) o.then(); },
    });
  },

  _put(id, body, okText) {
    wx.showLoading({ title: '处理中', mask: true });
    adminRequest(`/admin/admin/${id}`, 'PUT', body)
      .then(() => {
        wx.hideLoading();
        this.setData({ who: null });
        wx.showToast({ title: okText, icon: 'success' });
        return this.fetchAll();
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  // ───────── 批量重置抽屉 ─────────
  onOpenReset() {
    const range = 'todo';
    this.setData({
      resetOpen: true,
      range,
      preview: (this.data.listAll || []).filter((a) => inRange(a, range)),
    });
  },

  onCloseReset() {
    if (this.data.resetting) return;
    this.setData({ resetOpen: false });
  },

  onRange(e) {
    const range = e.currentTarget.dataset.k;
    if (range === this.data.range) return;
    this.setData({
      range,
      preview: (this.data.listAll || []).filter((a) => inRange(a, range)),
    });
  },

  onDoReset() {
    const n = (this.data.preview || []).length;
    if (!n || this.data.resetting) return;
    const self = this.data;
    wx.showModal({
      title: '批量重置',
      content: `把 ${n} 个账号的密码重置成 user+学号？旧密码立即失效；如果里面有你自己的账号，下次登录要用新密码。`,
      confirmText: '重置',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ resetting: true });
        wx.showLoading({ title: '重置中', mask: true });
        adminRequest('/admin/admin/reset-password/batch', 'POST', { range: self.range })
          .then((d) => {
            wx.hideLoading();
            this.setData({ resetting: false, resetOpen: false });
            const got = Number((d && d.resetCount) || 0);
            const more = !!(d && d.truncated);
            wx.showModal({
              title: '完成',
              content: `重置了 ${got} 个账号${more ? `（超出单次上限，还有 ${Number(d.total) - got} 个没处理）` : ''}。密码已回到 user+学号。`,
              showCancel: false,
              confirmText: '知道了',
            });
            return this.fetchAll();
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ resetting: false });
            wx.showToast({ title: (err && err.message) || '重置失败', icon: 'none' });
          });
      },
    });
  },
});
