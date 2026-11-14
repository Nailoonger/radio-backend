// pages-partner/recruit/batches · v2（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-batches']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 那一屏的样子，逐条搬：
//   ① 三段**下划线标签**（`.stabs`，不是白药丸 —— v167 改成白药丸被当场退回，v169 恢复）：
//      进行中 / 已截止 / 已归档。
//   ② **点行才进配置页**（v166 口径）：批次配置是批次管理的下级页面，不在列表里同屏展开。
//   ③ 行尾红色纯文字「删除」（`.qt-del` 那种，不是胶囊）；**已归档的行不给删除**。
//   ④ 「新建招新批次」只在非归档段出现 —— 归档段摆新建按钮会被读成「新建一个归档批次」。
//   ⑤ 每行三行字：名称 + 状态 tag ／ 起止与人数 ／ 一句补充（草稿可改 / N 人待决定）。
// ═══════════════════════════════════════════════════════════════════════════
//
// 数据：服务端只有 `archived` 一个筛选，没有「进行中」这种口径 ⇒ 拉两次再前端分组：
//   未归档里 windowState !== 'closed' → 进行中；=== 'closed' → 已截止；archived=true → 已归档。
//
// ⚠️ 社干点批次：v174 是「看批次详情」（只读），真机上给的是同一个配置页，
//    但 canManage=false 时整页只读、不摆动作按钮（见 config.js 的 canManage）。
//
// ⚠️ 删除要原样输入批次名（服务端 body.confirm 校验，两边都 trim）。
//    报错文案服务端已经带了要输的原文，前端照抄，别自己编一句「名称不对」。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const TABS = [
  { key: 'live', label: '进行中' },
  { key: 'closed', label: '已截止' },
  { key: 'arch', label: '已归档' },
];
const STATE_TEXT = { draft: '草稿', upcoming: '未开始', open: '报名中', closed: '已截止' };
const STATE_CLS = { draft: 'warn', upcoming: 'gray', open: 'ok', closed: 'no' };

function shortDay(iso) { const s = fmtIso(iso); return s ? s.slice(0, 5) : ''; }
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    canManage: false,
    tabs: TABS,
    tab: 'live',
    rows: [],
    groups: { live: [], closed: [], arch: [] },
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
    const r = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    const today = new Date();
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      canManage: r === 0,
      form: {
        title: '',
        start: ymd(new Date(today.getTime() + 86400000)),
        end: ymd(new Date(today.getTime() + 14 * 86400000)),
      },
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((n) => { if (n === 0) this.setData({ canManage: true }); });
    }
    this.load().then(() => {
      /* 总览页「新建」进来（?create=1）：拉完再开层，免得层开着列表还是空的 */
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
    this.setData({ loading: !this._ready, err: '' });
    return Promise.all([
      adminRequest('/admin/recruitment/batches?archived=false&pageSize=50', 'GET'),
      adminRequest('/admin/recruitment/batches?archived=true&pageSize=50', 'GET'),
    ])
      .then((res) => {
        const live = res[0] || {};
        const arch = res[1] || {};
        const shape = (x, isArch) => {
          const state = isArch ? 'arch' : x.windowState;
          const range = shortDay(x.opensAt) && shortDay(x.closesAt)
            ? `${shortDay(x.opensAt)} ~ ${shortDay(x.closesAt)}` : '时间未设置';
          const unresolved = Number(x.unresolvedCount) || 0;
          /* 第三行那句补充：归档说时间与人数，草稿说「还没发布」，其余说「N 人待决定」 */
          let line;
          if (isArch) line = `报名 ${Number(x.interviewOrderCount) || 0} 人 · 录取结果已发布`;
          else if (!x.publishedAt) line = '还没发布 · 草稿可改';
          else if (x.resultPublishedAt) line = '结果已发布';
          else line = unresolved ? `${unresolved} 人待决定` : '全部已决定';
          return {
            id: x.id,
            key: x.id,
            title: x.title || '未命名批次',
            pub: !!x.publishedAt,
            archived: isArch,
            stateText: isArch ? '已归档' : (STATE_TEXT[x.windowState] || x.windowState),
            stateCls: isArch ? 'gray' : (STATE_CLS[x.windowState] || 'gray'),
            range,
            line,
            lineWarn: !isArch && !!x.publishedAt && !x.resultPublishedAt && unresolved > 0,
          };
        };
        const liveRows = ((live.items) || []).map((x) => shape(x, false));
        const groups = {
          live: liveRows.filter((x) => x.stateText !== '已截止'),
          closed: liveRows.filter((x) => x.stateText === '已截止'),
          arch: ((arch.items) || []).map((x) => shape(x, true)),
        };
        this._ready = true;
        this.setData({ loading: false, groups, rows: groups[this.data.tab] || [] });
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab, rows: this.data.groups[tab] || [] });
  },

  /* 点行：进这一批的配置页（社干进去是只读） */
  onOpen(e) {
    const row = this.data.rows[Number(e.currentTarget.dataset.i)];
    if (!row) return;
    if (row.archived) {
      wx.showToast({ title: '已归档批次只读，改不了', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages-partner/recruit/config/config?batchId=${row.id}` });
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
    /* ⚠️ 截止存 23:59:59 而不是次日 00:00：业务口径是「截止日 24 点关」，
       存次日零点的话每一处显示都得先减一天，漏一处就显示成后一天。 */
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
        /* 建完直接进配置页：草稿不填固定信息就能发布，但题目和介绍得在那儿写 */
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
    const row = this.data.rows[Number(e.currentTarget.dataset.i)];
    if (!row) return;
    if (row.archived) { wx.showToast({ title: '归档批次不能删', icon: 'none' }); return; }
    /* 有报名或已发布时服务端要求原样输入名称；前端据此决定要不要显示输入框 */
    this.setData({ del: { id: row.id, title: row.title, need: row.pub }, delInput: '' });
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
        if (isVersionConflict(err) || isConflict(err)) { this.load(); return; }
        wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
      });
  },
});
