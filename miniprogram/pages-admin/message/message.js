// pages-admin/message/message.js
//
// 留言审核（2026-10-01）
//
// 沿用 admin-web 既有的「通过 / 屏蔽」两个动作，不新增语义：
//   通过 → PUT /admin/message/:id/approve
//   屏蔽 → PUT /admin/message/:id/reject  { reason }   ⚠️ 服务端 reason 硬校验必填，
//          所以这里用带输入框的模态框收原因（列表页放不下输入区）。
//
// 「来自《节目》」：message 表只有 programId，界面要显示节目名，
// 所以启动时拉一次节目列表建 id→title 映射；拉不到就只显示时间（降级，不报错）。

const { adminRequest } = require('../../utils/request.js');
const { fmtMd } = require('../../utils/format.js');

const TABS = [0, 1, 2];              // 0 待审核 / 1 展示 / 2 驳回
const TAB_LABELS = ['待审核', '已展示', '已屏蔽'];

Page({
  data: {
    statusBarHeight: 20,
    tabs: TAB_LABELS,
    tabIndex: 0,
    counts: [0, 0, 0],
    loading: true,
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-admin/login/login' });
      return;
    }
    this.programMap = {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });

    // 先把节目名拿到，再渲染列表 —— 否则首屏会有一瞬「来自《undefined》」
    this.loadPrograms().then(() => {
      this.fetchCounts();
      this.fetchList(true);
    });
  },

  onPullDownRefresh() {
    Promise.all([this.fetchCounts(), this.fetchList(true)])
      .then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchList(false);
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages-admin/todo/todo' });
    }
  },

  switchTab(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (idx === this.data.tabIndex) return;
    this.setData({ tabIndex: idx, list: [], page: 1, hasMore: false, loading: true });
    this.fetchList(true);
  },

  loadPrograms() {
    return adminRequest('/admin/program/list', 'GET', { page: 1, pageSize: 200 })
      .then((d) => {
        const map = {};
        ((d && d.list) || []).forEach((p) => { map[String(p.id)] = p.title || ''; });
        this.programMap = map;
      })
      .catch(() => { this.programMap = {}; });
  },

  fetchCounts() {
    const one = (status) =>
      adminRequest('/admin/message/list', 'GET', { status, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0);
    return Promise.all(TABS.map(one)).then((counts) => this.setData({ counts }));
  },

  fetchList(reset) {
    const page = reset ? 1 : this.data.page + 1;
    const status = TABS[this.data.tabIndex];
    if (reset) this.setData({ loading: true });

    return adminRequest('/admin/message/list', 'GET', { status, page, pageSize: this.data.pageSize })
      .then((d) => {
        const rows = (d && d.list) || [];
        const mapped = rows.map((r) => this.decorate(r));
        const merged = reset ? mapped : this.data.list.concat(mapped);
        const total = Number((d && d.total) || 0);
        this.setData({
          list: merged,
          page,
          total,
          hasMore: merged.length < total,
          loading: false,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  decorate(r) {
    const name = r.nickname || '匿名';
    const program = r.programId ? (this.programMap[String(r.programId)] || '') : '';
    const st = Number(r.status);
    return {
      id: r.id,
      initial: String(name).slice(0, 1),
      who: name,
      src: [fmtMd(r.createTime), program ? `来自《${program}》` : ''].filter(Boolean).join(' · '),
      body: r.content || '',
      status: st,
      // ⚠️⚠️ 同 review 页：胶囊文案在 JS 里拼好，wxml 里一行写完。
      //    WXML 的 <text> 保留换行 ⇒ 拆行写会多一个空行，把胶囊撑高、字掉到底部。
      tagText: st === 0 ? '待审核' : (st === 1 ? '已展示' : '已屏蔽'),
      tagClass: st === 0 ? 'tag-pending' : (st === 1 ? 'tag-pass' : 'tag-reject'),
    };
  },

  onApprove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showLoading({ title: '处理中', mask: true });
    adminRequest(`/admin/message/${id}/approve`, 'PUT')
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已通过', icon: 'success' });
        this.dropRow(id);
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /** 屏蔽：原因必填 —— 用带输入框的模态框收，不静默提交空理由 */
  onReject(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '屏蔽这条留言',
      editable: true,
      placeholderText: '填写屏蔽原因（必填）',
      confirmText: '屏蔽',
      confirmColor: '#B42318',
      success: (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写屏蔽原因', icon: 'none' });
          return;
        }
        this.sendReject(id, reason);
      },
    });
  },

  sendReject(id, reason) {
    wx.showLoading({ title: '处理中', mask: true });
    adminRequest(`/admin/message/${id}/reject`, 'PUT', { reason })
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已屏蔽', icon: 'success' });
        this.dropRow(id);
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  dropRow(id) {
    this.setData({
      list: this.data.list.filter((x) => x.id !== id),
      total: Math.max(0, this.data.total - 1),
    });
    this.fetchCounts();
  },
});
