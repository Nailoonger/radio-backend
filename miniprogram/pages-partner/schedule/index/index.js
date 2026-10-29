const { adminRequest } = require('../../../utils/request');
const vm = require('../view-model');
Page({
  data: { statusBarHeight: 20, ready: false, loading: true, loadError: '', roleKey: 'member', isMember: true, tabId: 'schedule', myId: 0, badges: {}, week: {}, state: 'empty', stateText: '', stateSub: '', roleSuffix: '', needText: '', weekRange: '', weekNo: '', monthLabel: '', monthList: [], monthTotal: 0, myLeaves: [], leavePending: 0 },
  onLoad() {
    const app = getApp();
    if (!app.isAdminLoggedIn()) return wx.reLaunch({ url: '/pages-partner/login/login' });
    const info = app.globalData.adminInfo || {};
    const roleKey = Number(info.role) === 0 ? 'super' : (Number(info.role) === 2 ? 'member' : 'manager');
    this.setData({ ready: true, statusBarHeight: app.globalData.statusBarHeight || 20, roleKey, isMember: roleKey === 'member', tabId: roleKey === 'member' ? 'schedule' : 'scheduling', myId: Number(info.id) || 0 });
    this.load();
  },
  onShow() { if (this._loadedOnce && !this.data.loading) this.load(); },
  onUnload() { this._gone = true; this._request = (this._request || 0) + 1; },
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

    return Promise.all([adminRequest('/partner/schedule', 'GET', {}), slotsReq]).then(([week, sl]) => {
      if (this._gone || this._request !== request) return;
      this._week = week;
      this.setData({
        week, state: week.state,
        stateText: vm.stateLabel(week.state, week.version, true),
        stateSub: week.state === 'draft' ? ' · 检查通过后才能发布'
          : (week.state === 'none' || week.state === 'empty' || !week.state)
            ? (sl.ready ? ' · 时段已发布，可以生成草稿' : ' · 值班时段还没发布')
            : '',
        needText: ` · ${week.total || 0}/${sl.needTotal || 0} 人`,
        slots: sl.slots || [],
        roleSuffix: this.data.roleKey === 'super' ? ' · 你是超管，时段与规则都可以改' : ' · 时段与规则由超管发布，你只能查看',
        weekRange: vm.weekRange(week.weekStart), weekNo: vm.weekNo(week.weekStart), loading: false,
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
  goLeave() { wx.navigateTo({ url: '/pages-partner/leave/leave' }); },
  goAvailability() { wx.navigateTo({ url: '/pages-partner/availability/availability' }); },
  goPlanning() { if (!this.data.isMember) wx.navigateTo({ url: '/pages-partner/schedule/planning/planning' }); },
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
