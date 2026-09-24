// pages/mySubmit/mySubmit.js
const { request } = require('../../utils/request.js');
const { submitStatusText, submitStatusClass, fmtDate, fmtIso, fmtSlot, fmtMd } = require('../../utils/format.js');
const windowBar = require('../../utils/windowBar.js');
const app = getApp();

/**
 * 三个桶（协议版；方案见 preview/song-queue-v3/）
 *   全部    全部投稿
 *   待审核  还没播出的 —— 待审 / 待排期 / 候补中 / 未排上 / 已驳回 / 已取消
 *   已播出  已经确定会播或播过的 —— 已排期（文稿叫「已通过」）/ 已播放
 * ⚠️ 三桶互斥且穷尽，「全部」永远等于另外两格之和，不会再出现加起来对不上。
 *    「待审核」按「还没播出」收口，里面既有还在走流程的，也有走完但没成的，
 *    到底是哪一种看行内胶囊（7 种粒度全保留）。
 */
const FILTER_ORDER = ['', 'pending', 'played'];
const PLAYED_STATUS = [1, 5]; // 1 已排期 / 已通过　5 已播放

function bucketOf(status) {
  return PLAYED_STATUS.indexOf(Number(status)) >= 0 ? 'played' : 'pending';
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    userInfo: {},
    nicknameInitial: '同',
    statusIndex: 0, // 滑动指示器格位
    list: [],
    loading: true,
    skList: false, // 列表骨架（>300ms 才显示）
    skCount: 3,
    statusFilter: '', // '' 全部 / 'pending' 待审核 / 'played' 已播出
    loggedIn: false,
    // Hero 卡三格统计（前端汇总，零额外接口）
    stats: { all: 0, pending: 0, played: 0 },
    heroMeta: '',
    // 点歌时间窗口状态条（常驻；文案服务端下发，前端不硬编码星期与时刻）
    winEnabled: false,
    winOpen: true,
    winLine1: '',
    winLine2: '',
    winClosesAt: '',
  },

  onLoad() {
    this.wb = windowBar.create(this);
    this.allRows = [];
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
      heroMeta: [info.className, info.username].filter(Boolean).join(' · '),
    });
    // 点歌时间窗口常驻展示（接口要登录，没登录就不拉）
    if (app.globalData.token) this.wb.load();
    this.reload();
  },

  reload() {
    if (!app.globalData.token) {
      this.allRows = [];
      this.setData({ list: [], loading: false, stats: { all: 0, pending: 0, played: 0 } });
      return Promise.resolve();
    }
    // 列表骨架 —— 张数 = 上一次的条数（最多 5 张），超过 300ms 才显示
    const skCount = Math.min(this.data.list.length || 3, 5);
    if (!this._skTimer) {
      this._skTimer = setTimeout(() => {
        if (this.data.loading) this.setData({ skList: true, skCount });
      }, 300);
    }
    this.setData({ loading: true });
    return this.fetch();
  },

  /**
   * 一次拉全量，统计与三桶筛选全在本地做（学生投稿量级很小，上限 200 条够用）。
   *
   * 为什么不分页：三桶是**多个 status 的并集**（「待审核」= 0/2/3/6/7），
   * 而 /user/submit/my 的 status 参数只支持单个值，服务端筛不出这一桶；
   * 与其为一格筛选改接口，不如把全量拉回来本地切 —— 顺带让切页签零延迟。
   */
  fetch() {
    return request('/user/submit/my', 'GET', { page: 1, pageSize: 200 })
      .then((data) => {
        const rows = (data.list || []).map((x) => this.decorate(x));
        this.allRows = rows;
        const cnt = (b) => rows.filter((r) => r.bucket === b).length;
        this.clearSkeleton();
        this.setData({
          stats: { all: rows.length, pending: cnt('pending'), played: cnt('played') },
          loading: false,
        });
        this.applyFilter();
      })
      .catch(() => {
        this.clearSkeleton();
        this.allRows = [];
        this.setData({ list: [], loading: false, stats: { all: 0, pending: 0, played: 0 } });
      });
  },

  /** 按当前桶切列表（纯本地，不发请求） */
  applyFilter() {
    const f = this.data.statusFilter;
    const rows = this.allRows || [];
    this.setData({ list: f ? rows.filter((r) => r.bucket === f) : rows });
  },

  decorate(x) {
    const st = Number(x.status);
    const o = {
      ...x,
      // ⚠️ 必须带 type：点歌的 status=1 叫「已排期」，文稿的叫「已通过」
      statusText: submitStatusText(st, x.type),
      statusClass: submitStatusClass(st),
      createTimeText: fmtDate(x.createTime),
      submitAtText: fmtMd(x.createTime),
      bucket: bucketOf(st),
      // 点歌才有「时段」：已排期/已播放看实际排期，其余看学生首选
      slotText: x.type === 1 ? fmtSlot(x.scheduledSlot || x.wantBroadcastTime) : '',
      slotLabel: (st === 1 || st === 5) ? '播出时段' : '希望时段',
      qv: { kind: 'none' },
    };
    o.qv = this.cardView(o);
    return o;
  },

  /**
   * 卡片形态（协议版；文案全部来自服务端 card，前端只排版）
   *   waiting    候补中  深色卡（主角）：位次 / 前面几人 / 首选 / 是否接受调剂 / 锁定时刻 / 放弃候补
   *   scheduled  已排期  深色卡：实际时段放大；被调剂过就把「首选 → 实际」都写出来
   *   failed     未排上 / 已驳回  羊皮纸卡（失败不抢主角位）：理由 + 首选时段 + 提交时间
   *   其余（待审核 / 待排期 / 已播放 / 已取消）走普通行，靠行内胶囊区分
   */
  cardView(item) {
    const c = item.card;
    if (!c || !c.status) return { kind: 'none' };

    if (c.status === 'waiting') {
      const ahead = Number(c.aheadCount) || 0;
      const pos = Number(c.queuePos) || 0;
      const allow = c.allowReschedule !== false;
      const lockAt = c.finalizeAt || c.lockAt || '';
      return {
        kind: 'waiting',
        chips: ['候补中']
          .concat(pos ? ['第 ' + pos + ' 位'] : [])
          .concat(allow ? [] : ['不接受调剂']),
        title: item.songName || '点歌',
        meta1: (ahead > 0 ? '前面还有 ' + ahead + ' 人' : '排在下一位')
          + (c.preferred ? ' · 首选 ' + fmtSlot(c.preferred) : ''),
        meta2: item.singer || '',
        hint: c.hint || '',
        deadline: lockAt ? fmtIso(lockAt) + ' 排期锁定，届时还没空位就会自动结束' : '',
        canLeave: true,
      };
    }

    if (c.status === 'scheduled') {
      return {
        kind: 'scheduled',
        chips: ['已排期'].concat(c.changed ? ['已被调剂'] : []),
        title: fmtSlot(c.scheduledSlot) || '已排期',
        meta1: [item.songName, item.singer].filter(Boolean).join(' · '),
        meta2: c.changed && c.preferred ? '你首选：' + fmtSlot(c.preferred) : '',
        hint: c.changed ? (c.hint || '') : '',
        deadline: '',
        canLeave: false,
      };
    }

    if (c.status === 'failed') {
      return {
        kind: 'failed',
        title: [item.songName, item.singer].filter(Boolean).join(' — ') || '点歌',
        // 系统驳的（排期锁定还没等到空位）叫「未排上」，人工驳的才是「已驳回」
        tagText: c.systemRejected ? '未排上' : '已驳回',
        reason: c.reason || '本次未排上',
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

  switchFilter(e) {
    const statusFilter = e.currentTarget.dataset.status;
    this.setData({
      statusFilter,
      statusIndex: Math.max(0, FILTER_ORDER.indexOf(statusFilter)),
    });
    this.applyFilter();
  },

  /** 未登录态的入口：直接去学号登录页（服务端账号门禁开着，微信一键登录会被 40302 拦） */
  doLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  /** 退出登录：清本地 token / 用户信息，回未登录态 */
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
    this.allRows = [];
    this.setData({
      loggedIn: false,
      userInfo: {},
      nicknameInitial: '同',
      heroMeta: '',
      stats: { all: 0, pending: 0, played: 0 },
      statusFilter: '',
      statusIndex: 0,
      winEnabled: false,
      winLine1: '',
      winLine2: '',
      list: [],
      loading: false,
    });
    wx.showToast({ title: '已退出登录', icon: 'none' });
  },

  /** 撤销待审投稿（status=0）：服务端会释放它占的任何资源并重跑该周排期 */
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

  /**
   * 放弃候补（schedule_status=WAITING）：置为已取消 → 位子让给下一位，
   * 服务端会随即重跑该周排期（协议版靠 reschedule 递补，不需要人工介入）。
   */
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
