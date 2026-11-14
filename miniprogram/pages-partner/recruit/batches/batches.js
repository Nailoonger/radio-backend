// pages-partner/recruit/batches · v1（2026-11-14 批次管理）
//
// 三段：进行中 / 已截止 / 已归档。**服务端只有 archived 一个筛选**，没有「进行中」这种状态口径，
// 所以这里拉两次（archived=false / true），未归档那批再按 windowState 前端分组：
//   draft / upcoming / open → 进行中      closed → 已截止      archivedAt 有值 → 已归档
//
// ⚠️ 新建只给超管（asSuper）。新建弹层只收三样：名称 / 开始日 / 截止日 ——
//    固定信息和题目都在「批次配置」页里改，别把配置塞进弹层（那是 v166 踩过的层级错）。
//
// ⚠️ 时间写成 `YYYY-MM-DDT00:00:00+08:00` 起、`YYYY-MM-DDT23:59:59+08:00` 止：
//    业务口径是「开始日零点开、截止日 24 点关」。**截止存 23:59:59 而不是次日 00:00** ——
//    存次日零点的话，每一处显示（批次行、配置页、报名页）都得先减一天，
//    漏一处就显示成「11-08 ~ 11-19」，比丢那 1 秒危险得多。
//
// ⚠️ 删除要原样输入批次名（服务端 body.confirm 校验），有报名或已发布的批次才要输；
//    服务端的报错文案已经带了要输的原文，前端照抄提示，不要自己编一句「名称不对」。

const { adminRequest } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const TABS = [
  { key: 'live', label: '进行中' },
  { key: 'closed', label: '已截止' },
  { key: 'arch', label: '已归档' },
];
const STATE_TEXT = { draft: '草稿', upcoming: '未开始', open: '报名中', closed: '已截止' };

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dayOf(iso) { const s = fmtIso(iso); return s ? s.slice(0, 5) : '—'; }

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    canManage: false,
    tabs: TABS,
    tab: 'live',
    groups: { live: [], closed: [], arch: [] },
    rows: [],
    /* 新建弹层 */
    sheet: false,
    form: { title: '', start: '', end: '' },
    creating: false,
    /* 删除确认层 */
    del: null,
    delInput: '',
    deleting: false,
  },

  onLoad(q) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const roleNum = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    const today = new Date();
    const start = new Date(today.getTime() + 86400000);
    const end = new Date(today.getTime() + 14 * 86400000);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      canManage: roleNum === 0,
      form: { title: '', start: ymd(start), end: ymd(end) },
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((r) => {
        if (r === 0 && !this.data.canManage) this.setData({ canManage: true });
      });
    }
    this.load().then(() => {
      /* 从总览页「新建」进来（?create=1）：拉完再开层，免得层开着列表还是空的 */
      if (String(q && q.create) === '1' && this.data.canManage) this.setData({ sheet: true });
    });
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true });
    return Promise.all([
      adminRequest('/admin/recruitment/batches?archived=false&pageSize=50', 'GET'),
      adminRequest('/admin/recruitment/batches?archived=true&pageSize=50', 'GET'),
    ])
      .then(([live, arch]) => {
        const shape = (x) => ({
          id: x.id,
          title: x.title || '未命名批次',
          state: x.windowState,
          stateText: STATE_TEXT[x.windowState] || x.windowState,
          range: dayOf(x.opensAt) + ' ~ ' + dayOf(x.closesAt),
          unresolved: Number(x.unresolvedCount) || 0,
          resultPublished: !!x.resultPublishedAt,
          archived: !!x.archivedAt,
          /* 删除要不要输名字：有报名或已发布的服务端才要求，前端据此决定输入框显不显示 */
          needConfirm: (Number(x.unresolvedCount) || 0) > 0 || !!x.publishedAt,
        });
        const rows = ((live && live.items) || []).map(shape);
        const groups = {
          live: rows.filter((x) => x.state !== 'closed'),
          closed: rows.filter((x) => x.state === 'closed'),
          arch: ((arch && arch.items) || []).map(shape),
        };
        this.setData({ loading: false, groups, rows: groups[this.data.tab] || [] });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab, rows: this.data.groups[tab] || [] });
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/recruit/config/config?batchId=${id}` });
  },

  /* ── 新建 ── */
  onNew() {
    if (!this.data.canManage) return;
    this.setData({ sheet: true });
  },
  onSheetClose() { if (!this.data.creating) this.setData({ sheet: false }); },
  onTitle(e) { this.setData({ 'form.title': e.detail.value }); },
  onStart(e) { this.setData({ 'form.start': e.detail.value }); },
  onEnd(e) { this.setData({ 'form.end': e.detail.value }); },

  onCreate() {
    if (this.data.creating) return;
    const f = this.data.form;
    const title = (f.title || '').trim();
    if (!title) { wx.showToast({ title: '先写批次名称', icon: 'none' }); return; }
    if (!f.start || !f.end) { wx.showToast({ title: '选开始日和截止日', icon: 'none' }); return; }
    if (f.start >= f.end) { wx.showToast({ title: '截止日要晚于开始日', icon: 'none' }); return; }
    this.setData({ creating: true });
    wx.showLoading({ title: '创建中', mask: true });
    adminRequest('/admin/recruitment/batches', 'POST', {
      title,
      intro: '',
      opensAt: `${f.start}T00:00:00+08:00`,
      closesAt: `${f.end}T23:59:59+08:00`,
    })
      .then((d) => {
        wx.hideLoading();
        this.setData({ creating: false, sheet: false });
        wx.showToast({ title: '草稿已建', icon: 'success' });
        /* 建完直接进配置页：草稿不填固定信息/题目就没法发布 */
        wx.navigateTo({ url: `/pages-partner/recruit/config/config?batchId=${d.id}` });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ creating: false });
        wx.showToast({ title: (err && err.message) || '创建失败', icon: 'none' });
      });
  },

  /* ── 删除 ── */
  onDel(e) {
    if (!this.data.canManage) return;
    const { id, title, need } = e.currentTarget.dataset;
    this.setData({ del: { id, title, need: String(need) === '1' }, delInput: '' });
  },
  onDelClose() { if (!this.data.deleting) this.setData({ del: null, delInput: '' }); },
  onDelInput(e) { this.setData({ delInput: e.detail.value }); },
  onDelOk() {
    const d = this.data.del;
    if (!d || this.data.deleting) return;
    const typed = (this.data.delInput || '').trim();
    if (d.need && typed !== String(d.title).trim()) {
      wx.showToast({ title: '要原样输入批次名称', icon: 'none' });
      return;
    }
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中', mask: true });
    adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.id)}`, 'DELETE', { confirm: typed })
      .then(() => {
        wx.hideLoading();
        this.setData({ deleting: false, del: null, delInput: '' });
        wx.showToast({ title: '已删除', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ deleting: false });
        wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
      });
  },
});
