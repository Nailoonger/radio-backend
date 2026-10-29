// v151 人员轮值：只统计服务端给出的已发布班次，零场次成员也保留。
const { adminRequest } = require('../../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20, ready: false, loading: true, loadError: '',
    monthLabel: '本月', total: 0, peopleCount: 0, sort: 'count',
    raw: [], list: [], myId: 0,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    if (![0, 1].includes(Number(info.role))) {
      wx.reLaunch({ url: '/pages-partner/schedule/index/index' });
      return;
    }
    this.setData({ ready: true, myId: Number(info.id) || 0,
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    return this.load();
  },
  onShow() { if (this.data.ready && !this.data.loading) this.load(); },
  onUnload() { this._gone = true; },
  onPullDownRefresh() { return this.load().then(() => wx.stopPullDownRefresh()); },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/schedule/index/index' });
  },

  load() {
    if (!this.data.ready) return Promise.resolve();
    const request = (this._request || 0) + 1;
    this._request = request;
    this.setData({ loading: true, loadError: '' });
    return Promise.all([
      adminRequest('/partner/schedule/month', 'GET', {}),
      adminRequest('/partner/people', 'GET', {}),
    ]).then(([month, people]) => {
      if (this._gone || this._request !== request) return;
      const byId = {};
      ((people && people.list) || []).forEach((person) => {
        const personId = Number(person.personId);
        if (!personId) return;
        byId[personId] = { personId, personName: person.name || person.username || '伙伴',
          department: person.department || '', count: 0, lastDay: '' };
      });
      ((month && month.list) || []).forEach((person) => {
        const personId = Number(person.personId);
        if (!personId) return;
        const known = byId[personId] || {};
        byId[personId] = {
          personId, personName: person.personName || known.personName || '伙伴',
          department: person.department || known.department || '',
          count: Math.max(0, Number(person.count) || 0), lastDay: person.lastDay || '',
        };
      });
      const raw = Object.keys(byId).map((id) => byId[id]);
      const total = raw.reduce((sum, row) => sum + row.count, 0);
      this.setData({ loading: false, raw, total, peopleCount: raw.length,
        monthLabel: month && month.month ? `${Number(String(month.month).slice(5))} 月` : '本月' });
      this.sortRows();
    }).catch((err) => {
      if (this._gone || this._request !== request) return;
      this.setData({ loading: false, loadError: (err && err.message) || '轮值数据加载失败，请重试' });
      if (err && Number(err.code) === 40101) wx.reLaunch({ url: '/pages-partner/login/login' });
    });
  },

  toggleSort() {
    this.setData({ sort: this.data.sort === 'count' ? 'recent' : 'count' });
    this.sortRows();
  },
  sortRows() {
    const raw = this.data.raw || [];
    const max = Math.max(1, ...raw.map((row) => row.count));
    const list = raw.slice().sort((a, b) => {
      const delta = this.data.sort === 'recent'
        ? String(b.lastDay).localeCompare(String(a.lastDay)) : b.count - a.count;
      return delta || b.count - a.count || a.personName.localeCompare(b.personName, 'zh-CN');
    }).map((row) => Object.assign({}, row, {
      percent: Math.round(row.count / max * 100), mine: row.personId === this.data.myId,
      recentText: row.lastDay ? `最近 ${String(row.lastDay).slice(5).replace('-', '/')}` : '本月尚未安排',
    }));
    this.setData({ list });
  },
});
