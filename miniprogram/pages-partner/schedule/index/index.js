const { adminRequest } = require('../../../utils/request');
const perm = require('../../../utils/perm');
const vm = require('../view-model');
Page({
  /** 正在查看的周（空串 = 本周，由云函数按北京时间决定，前端不自己算）
   *  ⚠️ 别和下面 load 里的 `this._week` 混：那一个是整个 week 对象（导出、判断状态用），
   *     这个名字是「要看哪一周」的字符串。两个都叫 _week 会互相覆盖（翻周后导出就错行）。 */
  _viewWeek: '',
  /** 本周周一 —— 用来判断「现在看的是不是本周」 */
  _baseWeek: '',
  data: { statusBarHeight: 20, ready: false, loading: true, loadError: '', roleKey: 'member', isMember: true, tabId: 'schedule', myId: 0, badges: {}, week: {}, state: 'empty', stateText: '', stateSub: '', needText: '', weekStart: '', weekText: '', isThisWeek: true, monthLabel: '', monthList: [], monthTotal: 0, myLeaves: [], leavePending: 0,
    /* 2026-10-31：社干能不能进排班工作台（超管分发）。true 是默认值，只有确知被关掉才变 false
       —— 权限接口挂了不该把人锁在门外（后端 asScheduler 还会再拦一次）。 */
    canPlan: true, denyPlan: '暂无权限' },
  onLoad() {
    const app = getApp();
    if (!app.isAdminLoggedIn()) return wx.reLaunch({ url: '/pages-partner/login/login' });
    const info = app.globalData.adminInfo || {};
    const roleKey = Number(info.role) === 0 ? 'super' : (Number(info.role) === 2 ? 'member' : 'manager');
    this.setData({ ready: true, statusBarHeight: app.globalData.statusBarHeight || 20, roleKey, isMember: roleKey === 'member', tabId: roleKey === 'member' ? 'schedule' : 'scheduling', myId: Number(info.id) || 0 });
    // 社干才查权限：超管恒放行、站员根本进不了工作台
    if (roleKey === 'manager') {
      perm.load().then((pm) => {
        if (this._gone || !pm) return;
        this.setData({
          canPlan: pm.schedule !== false,
          denyPlan: (pm.text && pm.text.schedule) || '暂无权限',
        });
      });
    }
    this.load();
  },
  onShow() {
    // 切回页面时刷新一次权限（TTL 只有 1 秒）：超管刚关掉就点不进去，不用等重新登录
    this.refreshPerm();
    // 停在这一页不动时也要收到权限变化（10 秒一轮）
    if (this.data.roleKey === 'manager') {
      perm.startPolling('schedule', (pm) => this._applyPerm(pm));
    }
    if (this._loadedOnce && !this.data.loading) this.load();
  },

  /** 权限可能刚被超管改过 —— 只重问权限，不整页重拉 */
  refreshPerm() {
    if (this.data.roleKey !== 'manager') return Promise.resolve();
    return perm.load().then((pm) => {
      if (this._gone || !pm) return;
      this._applyPerm(pm);
    });
  },

  /** 把权限落到「工作台入口能不能点」上（只动入口，班表照看） */
  _applyPerm(pm) {
    if (!pm || this._gone) return;
    this.setData({
      canPlan: pm.schedule !== false,
      denyPlan: (pm.text && pm.text.schedule) || '暂无权限',
    });
  },

  onHide() { perm.stopPolling('schedule'); },
  onUnload() {
    perm.stopPolling('schedule');
    this._gone = true;
    this._request = (this._request || 0) + 1;
  },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()); },
  load() {
    if (!this.data.ready) return Promise.resolve();
    const request = (this._request || 0) + 1;
    this._request = request;
    this.setData({ loading: true, loadError: '' });
    // 已发布时段一起拉：状态条后缀（原型「值班时段还没发布／时段已发布…」）
    // 和工作台行的「8/12 人」都靠它；失败时 catch 掉，不拖垮整页（规范五·4）
    const slotsReq = adminRequest('/partner/slots/published', 'GET', {})
      .then((d) => {
        const list = (d.published && d.published.slots) || [];
        return {
          ready: !!d.ready,
          needTotal: list.reduce((n, s) => n + (Number(s.count) || 1), 0),
          slots: list,                       // 给 duty-timetable 铺整周空表
        };
      })
      .catch(() => ({ ready: false, needTotal: 0 }));

    return Promise.all([adminRequest('/partner/schedule', 'GET', this._viewWeek ? { week: this._viewWeek } : {}), slotsReq]).then(([week, sl]) => {
      if (this._gone || this._request !== request) return;
      this._week = week;
      // 基准周 = 第一次（不带 week）拿到的 weekStart，云函数按北京时间给的周一周
      const ws = week.weekStart || '';
      if (!this._baseWeek && ws) this._baseWeek = ws;
      const isThisWeek = !this._baseWeek || ws === this._baseWeek;
      this.setData({
        week, state: week.state,
        stateText: vm.stateLabel(week.state, week.version, true),
        stateSub: week.state === 'draft' ? ' · 检查通过后才能发布'
          : (week.state === 'none' || week.state === 'empty' || !week.state)
            ? (sl.ready ? ' · 时段已发布，可以生成草稿' : ' · 值班时段还没发布')
            : '',
        needText: ` · ${week.total || 0}/${sl.needTotal || 0} 人`,
        slots: sl.slots || [],
        weekStart: ws, weekText: ws ? vm.weekRange(ws) : '', isThisWeek,
        loading: false,
      });
      return Promise.allSettled([
        adminRequest('/partner/leave/mine', 'GET', { week: week.weekStart }),
        adminRequest('/partner/schedule/month', 'GET', {}),
      ]).then(([lv, mo]) => {
        if (this._gone || this._request !== request) return;
        const myLeaves = lv.status === 'fulfilled' ? (lv.value.list || []).map((x) => ({
          id: x.id, label: `${vm.shortDate(x.day)} ${x.slot}`, status: Number(x.status),
          statusText: x.statusText || ['待批', '已批准', '已驳回', '已撤销'][Number(x.status)] || '',
          tagCls: Number(x.status) === 0 ? 'warn' : (Number(x.status) === 1 ? 'done' : 'no'),
        })) : [];
        const month = mo.status === 'fulfilled' ? mo.value : {};
        this.setData({ myLeaves, leavePending: myLeaves.filter((x) => x.status === 0).length,
          monthLabel: month.month ? `${Number(String(month.month).slice(5))} 月·全站公开` : '本月·全站公开',
          monthList: (month.list || []).map((p) => Object.assign({}, p, { mine: Number(p.personId) === this.data.myId })),
          monthTotal: (month.list || []).reduce((n, p) => n + (Number(p.count) || 0), 0),
        });
      });
    }).catch((e) => {
      if (this._gone || this._request !== request) return;
      this._week = null;
      this.setData({ loading: false, week: {}, loadError: e.message || '班表加载失败，请重试' });
      if (Number(e.code) === 40101) wx.reLaunch({ url: '/pages-partner/login/login' });
    }).finally(() => { if (!this._gone && this._request === request) this._loadedOnce = true; });
  },
  /** 翻周：±1 周，整页重拉（班表 / 请假 / 本月场次全部按 weekStart 走，不用另开通道）。
   *  与排班工作台 planning.shiftWeek 同一套写法，别自己另发明一套。 */
  shiftWeek(n) {
    if (this.data.loading) return;
    const from = this._viewWeek || this.data.week.weekStart || this._baseWeek;
    if (!from) return;
    this._viewWeek = vm.addDays(from, n * 7);
    this.load();
  },
  onPrevWeek() { this.shiftWeek(-1); },
  onNextWeek() { this.shiftWeek(1); },
  goLeave() { wx.navigateTo({ url: '/pages-partner/leave/leave' }); },
  goAvailability() { wx.navigateTo({ url: '/pages-partner/availability/availability' }); },
  goPlanning() {
    if (this.data.isMember) return;
    /* 排班权限被关掉时就在这儿弹窗，别跳过去再被 planning 弹回来 ——
       页面闪一下再退，看起来像卡了。 */
    if (this.data.canPlan === false) {
      wx.showModal({
        title: this.data.denyPlan,
        content: '超管没有给你开排班工作台的权限。要用，找超管在「权限管理」里开一下。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.navigateTo({ url: '/pages-partner/schedule/planning/planning' });
  },
  goWorkload() { if (!this.data.isMember) wx.navigateTo({ url: '/pages-partner/schedule/workload/workload' }); },
  goHistory() { if (!this.data.isMember) wx.navigateTo({ url: '/pages-partner/schedule/history/history?week=' + this.data.week.weekStart }); },
  onExport() {
    if (!this._week || this._week.state !== 'published') return wx.showToast({ title: '本周未发布', icon: 'none' });
    wx.setClipboardData({ data: vm.exportText(this._week) });
  },
  onTab(e) {
    const id = e.detail && e.detail.id;
    if (!id || id === this.data.tabId) return;
    // ⚠️ tabbar 的 id：站员=schedule / 社干·超管=scheduling，两个都要有（desk.js 踩过同一坑）
    const routes = { desk: 'desk/desk', home: 'desk/desk', submissions: 'review/review', 'my-drafts': 'work/work', schedule: 'schedule/index/index', scheduling: 'schedule/index/index', me: 'me/me' };
    if (routes[id]) wx.reLaunch({ url: '/pages-partner/' + routes[id] });
  },
});
