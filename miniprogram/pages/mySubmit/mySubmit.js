// pages/mySubmit/mySubmit.js
const { request } = require('../../utils/request.js');
const { submitStatusText, submitStatusClass, fmtDate, fmtIso, fmtSlot, fmtMd } = require('../../utils/format.js');
const windowBar = require('../../utils/windowBar.js');
const app = getApp();

/** 筛选项 → 状态码（顺序 = 界面上的格位顺序，也是 Hero 统计的阅读顺序） */
const FILTER_ORDER = ['', '0', '3', '4', '1', '2'];

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
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
    statusFilter: '',  // ''=全部 / 0 待审 / 3 候补中 / 4 已补位 / 1 已通过 / 2 已驳回
    loggedIn: false,
    // Hero 卡：六格统计（前端汇总，零接口）+ 班级·学号副行
    // v2 起要覆盖 0~4 全部状态，否则「全部」对不上账（候补中的点歌会凭空消失）
    stats: { all: 0, pending: 0, queued: 0, promoted: 0, passed: 0, rejected: 0 },
    heroMeta: '',
    // 点歌时间窗口状态条（v2，常驻）
    winEnabled: false,
    winOpen: true,
    winLine1: '',
    winLine2: '',
    winClosesAt: '',
  },

  onLoad() {
    this.wb = windowBar.create(this);
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      navBarHeight: app.globalData.navBarHeight || 44,
      loggedIn: !!app.globalData.token,
    });
  },

  onHide() { if (this.wb) this.wb.stopTimer(); },
  onUnload() { if (this.wb) this.wb.stopTimer(); },

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
    // 点歌时间窗口常驻展示（接口要登录，没登录就不拉）
    if (app.globalData.token) this.wb.load();
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

  /** Hero 六格统计：单独拉一次全量（学生投稿量级很小），前端按状态汇总 */
  fetchStats() {
    return request('/user/submit/my', 'GET', { page: 1, pageSize: 200 })
      .then((data) => {
        const rows = data.list || [];
        const cnt = (s) => rows.filter((x) => Number(x.status) === s).length;
        this.setData({
          stats: {
            all: data.total ?? rows.length,
            pending: cnt(0),
            queued: cnt(3),
            promoted: cnt(4),
            passed: cnt(1),
            rejected: cnt(2),
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
        // 状态文案 / 标签配色 / 时间 / 候补卡统一在这里算好，WXML 不写三元式
        const raw = page === 1 ? data.list : data.list || [];
        const incoming = (raw || []).map((x) => this.decorate(x));
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

  decorate(x) {
    const o = {
      ...x,
      // ⚠️ 必须带 type：点歌的 status=1 叫「已排期」，文稿的叫「已通过」
      statusText: submitStatusText(x.status, x.type),
      statusClass: submitStatusClass(x.status),
      createTimeText: fmtDate(x.createTime),
      submitAtText: fmtMd(x.createTime),
      // 点歌才有「时段」：已排期/已补位看实际排期，其余看学生首选
      slotText: x.type === 1 ? fmtSlot(x.scheduledSlot || x.wantBroadcastTime) : '',
      qv: { kind: 'none' },
    };
    o.qv = this.cardView(o);
    return o;
  },

  /**
   * 候补卡三形态（docs/song-queue-v2.md §7.1）：文案全部来自服务端 card，前端只负责排版
   *   waiting  候补中   深色卡（主角）：位次 / 前面几人 / 上限 / 首选 / 截止 / 放弃候补
   *   promoted 已补位   深色卡：实际时段放大 + 为什么不是首选（服务端 hint）
   *   failed   未补上   羊皮纸卡（失败不抢主角位）：理由 + 首选时段 + 提交时间
   */
  cardView(item) {
    const c = item.card;
    if (!c || c.type !== 'queue' || !c.status) return { kind: 'none' };

    if (c.status === 'waiting') {
      const limit = Number(c.queueLimit) || 0;
      const ahead = Number(c.aheadCount) || 0;
      const pos = Number(c.queuePos) || 0;
      return {
        kind: 'waiting',
        chips: ['候补中'].concat(pos ? ['第 ' + pos + ' 位'] : []),
        title: item.songName || '点歌',
        meta1: (ahead > 0 ? '前面还有 ' + ahead + ' 人' : '排在下一位') + ' · 候补上限 ' + (limit > 0 ? limit + ' 人' : '不限'),
        meta2: [item.singer, c.preferred ? '首选 ' + fmtSlot(c.preferred) : ''].filter(Boolean).join(' · '),
        barPct: limit > 0 ? Math.min(100, Math.max(6, Math.round((pos || 1) / limit * 100))) : 0,
        hint: c.hint || '下周任意时段有空位时按提交先后自动补位',
        deadline: c.finalizeAt ? fmtIso(c.finalizeAt) + ' 截止，没补上会自动告诉你' : '',
        canLeave: true,
      };
    }

    if (c.status === 'promoted') {
      return {
        kind: 'promoted',
        chips: ['已补位'],
        title: fmtSlot(c.scheduledSlot) || '已补位',
        meta1: [item.songName, item.singer].filter(Boolean).join(' · '),
        meta2: c.changed && c.preferred ? '你首选：' + fmtSlot(c.preferred) : '',
        hint: c.hint || '',
        deadline: c.finalizeAt ? '审核截止 ' + fmtIso(c.finalizeAt) : '',
        canLeave: false,
      };
    }

    if (c.status === 'failed') {
      return {
        kind: 'failed',
        title: [item.songName, item.singer].filter(Boolean).join(' — ') || '点歌',
        reason: c.reason || '本次未补上',
        footText: [
          c.preferred ? '首选时段：' + fmtSlot(c.preferred) : '',
          item.submitAtText ? '提交于 ' + item.submitAtText : '',
        ].filter(Boolean).join(' · '),
        canLeave: false,
      };
    }

    return { kind: 'none' };
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
    this.setData({
      statusFilter,
      statusIndex: Math.max(0, FILTER_ORDER.indexOf(statusFilter)),
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
    if (this.wb) this.wb.stopTimer();
    this.setData({
      loggedIn: false,
      userInfo: {},
      nicknameInitial: '同',
      heroMeta: '',
      stats: { all: 0, pending: 0, queued: 0, promoted: 0, passed: 0, rejected: 0 },
      winEnabled: false,
      winLine1: '',
      winLine2: '',
      list: [],
      total: 0,
      page: 1,
      finished: true,
      loading: false,
    });
    wx.showToast({ title: '已退出登录', icon: 'none' });
  },

  /** 撤销待审投稿（status=0）：释放正式位，服务端会立刻递补下一位候补 */
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

  /** 放弃候补（status=3）：出队 → 位子让给下一位，行会被删掉 */
  async leaveQueue(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '放弃候补',
        content: '放弃后这条点歌会离开候补队列，位子立刻让给下一位同学。确定放弃？',
        confirmText: '放弃',
        confirmColor: '#B42318',
        success: ({ confirm }) => resolve(confirm),
      });
    });
    if (!ok) return;
    try {
      await request(`/user/submit/${id}/leave-queue`, 'POST');
      wx.showToast({ title: '已退出候补队列' });
      this.reload();
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
    }
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
});
