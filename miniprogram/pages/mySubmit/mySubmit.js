// pages/mySubmit/mySubmit.js
const { request } = require('../../utils/request.js');
const { submitStatusText, submitStatusClass, fmtDate } = require('../../utils/format.js');
const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    userInfo: {},
    nicknameInitial: '同',
    statusIndex: 0,    // 滑动指示器格位
    list: [],
    loading: true,
    skList: false,      // v8 方案 ⑥：列表骨架（>300ms 才显示）
    skCount: 3,
    page: 1,
    pageSize: 10,
    total: 0,
    finished: false,
    statusFilter: '',  // ''=全部 / 0=待审 / 1=通过 / 2=驳回
    loggedIn: false,
    // Hero 卡：四格统计（前端汇总，零接口）+ 班级·学号副行
    stats: { all: 0, pending: 0, passed: 0, rejected: 0 },
    heroMeta: '',
  },

  onLoad() {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      navBarHeight: app.globalData.navBarHeight || 44,
      loggedIn: !!app.globalData.token,
    });
  },

  /** 从昵称里取一个字当头像兜底（WXML 不支持 (a||b)[0] 这种取下标写法，只能在 js 里算好） */
  initialOf(nickname) {
    const n = (nickname || '').trim();
    return n ? n.charAt(0) : '同';
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(3);
    }
    const info = app.globalData.userInfo || {};
    this.setData({
      loggedIn: !!app.globalData.token,
      userInfo: info,
      nicknameInitial: this.initialOf(info.nickname || info.name),
      // Hero 副行：班级 · 学号（有啥显示啥）
      heroMeta: [info.className, info.username].filter(Boolean).join(' · '),
    });
    this.reload();
  },

  reload() {
    if (!app.globalData.token) {
      this.setData({ list: [], loading: false, total: 0, finished: true });
      return Promise.resolve();
    }
    // v8 方案 ⑥：列表骨架 —— 张数 = 上一次的条数（最多 5 张），超过 300ms 才显示
    const skCount = Math.min(this.data.list.length || 3, 5);
    if (!this._skTimer) {
      this._skTimer = setTimeout(() => {
        if (this.data.loading) this.setData({ skList: true, skCount });
      }, 300);
    }
    this.setData({ page: 1, list: [], finished: false, loading: true });
    this.fetchStats();
    return this.fetch();
  },

  /** Hero 四格统计：单独拉一次全量（学生投稿量级很小），前端按状态汇总 */
  fetchStats() {
    return request('/user/submit/my', 'GET', { page: 1, pageSize: 200 })
      .then((data) => {
        const rows = data.list || [];
        this.setData({
          stats: {
            all: data.total ?? rows.length,
            pending: rows.filter((x) => x.status === 0).length,
            passed: rows.filter((x) => x.status === 1).length,
            rejected: rows.filter((x) => x.status === 2).length,
          },
        });
      })
      .catch(() => { /* 统计失败静默，Hero 显示 0 */ });
  },

  fetch() {
    const { page, pageSize, statusFilter } = this.data;
    const params = { page, pageSize };
    if (statusFilter !== '') params.status = statusFilter;
    return request('/user/submit/my', 'GET', params)
      .then((data) => {
        // 状态文案 / 标签配色 / 时间格式统一在这里算好，WXML 不写三元式
        const raw = page === 1 ? data.list : data.list || [];
        const incoming = (raw || []).map((x) => ({
          ...x,
          statusText: submitStatusText(x.status),
          statusClass: submitStatusClass(x.status),
          createTimeText: fmtDate(x.createTime),
        }));
        const list = page === 1 ? incoming : this.data.list.concat(incoming);
        this.clearSkeleton();
        this.setData({
          list,
          total: data.total,
          finished: list.length >= data.total,
          loading: false,
        });
      })
      .catch(() => {
        this.clearSkeleton();
        this.setData({ loading: false });
      });
  },

  clearSkeleton() {
    if (this._skTimer) { clearTimeout(this._skTimer); this._skTimer = null; }
    if (this.data.skList) this.setData({ skList: false });
  },

  loadMore() {
    if (this.data.finished || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.fetch();
  },

  switchFilter(e) {
    const statusFilter = e.currentTarget.dataset.status;
    // 滑动指示器需要数字格位：''=0 / 0=1 / 1=2 / 2=3
    const order = ['', '0', '1', '2'];
    this.setData({
      statusFilter,
      statusIndex: Math.max(0, order.indexOf(statusFilter)),
    });
    this.reload();
  },

  /** 未登录态的入口：直接去学号登录页（服务端账号门禁开着，微信一键登录会被 40302 拦） */
  doLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 退出登录：清本地 token / 用户信息，回未登录态。服务端 token 本身仍有寿命，但页面全部走本地判定 */
  async doLogout() {
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '退出登录',
        content: '退出后需要重新用学号和密码登录，确定退出？',
        confirmText: '退出',
        confirmColor: '#B42318',
        success: ({ confirm }) => resolve(confirm),
      });
    });
    if (!ok) return;
    app.logout();
    this.clearSkeleton();
    this.setData({
      loggedIn: false,
      userInfo: {},
      nicknameInitial: '同',
      heroMeta: '',
      stats: { all: 0, pending: 0, passed: 0, rejected: 0 },
      list: [],
      total: 0,
      page: 1,
      finished: true,
      loading: false,
    });
    wx.showToast({ title: '已退出登录', icon: 'none' });
  },

  async cancel(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((resolve) => {
      wx.showModal({ title: '提示', content: '确认撤销该投稿？', success: ({ confirm }) => resolve(confirm) });
    });
    if (!ok) return;
    try {
      await request(`/user/submit/${id}`, 'DELETE');
      wx.showToast({ title: '已撤销' });
      this.reload();
    } catch (err) {
      if (err && err.code === 40302) {
        wx.showToast({ title: '该模块暂时关闭，请稍后再试', icon: 'none' });
      } else {
        wx.showToast({ title: (err && err.message) || '撤销失败', icon: 'none' });
      }
    }
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
});
