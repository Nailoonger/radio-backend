// pages-partner/club-notice/queue.js
// 伙伴端 · 广播通知处理台（队列）
//
// 三段：待审核 / 待播 / 已播出（原型 p-queue 的下划线标签页，不是深色胶囊）
//
// ⚠️ 一次把全部拉回来、在本地切段，不为每段各发一次请求：
//    ① 角标数字（2 / 1 / 12）本来就要全量才算得出来；
//    ② 切段零延迟；
//    ③ 数量级很小（站里一周几十条），不值得为它做服务端分页。
// ⚠️ 排序「先提交先审」由后端钉住（create_time ASC, id ASC），这里**不要重排**，
//    重排一次就会变成「最新在最上面」，而最急的恰恰是最早那条。

const { adminRequest } = require('../../utils/request.js');
const clubTime = require('../../utils/clubTime.js');

const ST_CLS = { 0: 'wait', 1: 'air', 2: 'rej', 3: 'done', 9: 'mute' };
const TABS = [
  { key: 'wait', st: 0, label: '待审核' },
  { key: 'air', st: 1, label: '待播' },
  { key: 'done', st: 3, label: '已播出' },
];

Page({
  data: {
    statusBarHeight: 20,
    tabs: TABS,
    tabIdx: 0,
    all: [],
    list: [],
    counts: { wait: 0, air: 0, done: 0, reject: 0 },
    loading: true,
    denied: false,
    denyText: '',
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
  },

  onShow() {
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  reload() {
    this.setData({ loading: !this.data.all.length });
    return adminRequest('/partner/club-notice/queue', 'GET', {})
      .then((d) => {
        const all = (d.list || []).map((x) => decorate(x));
        this.setData({ all, counts: d.count || this.data.counts, denied: false });
        this.applyTab();
      })
      .catch((err) => {
        // 40301 = 审核权限位被超管关掉（或站员）。文案用后端那句，别在页面里硬编码
        if (err && err.code === 40301) {
          this.setData({ denied: true, denyText: (err && err.message) || '暂无权限', all: [], list: [] });
          return;
        }
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  applyTab() {
    const st = this.data.tabs[this.data.tabIdx].st;
    let list = (this.data.all || []).filter((x) => Number(x.status) === st);
    // 已播出：最新的在最前（回顾用）；其余两段保持「先提交先审」
    if (st === 3) list = list.slice().reverse();
    this.setData({ list });
  },

  switchTab(e) {
    const tabIdx = Number(e.currentTarget.dataset.i);
    if (tabIdx === this.data.tabIdx) return;
    this.setData({ tabIdx });
    this.applyTab();
  },

  open(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/club-notice/detail?id=${id}` });
  },

  goKeys() {
    wx.navigateTo({ url: '/pages-partner/club-keys/keys' });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/desk/desk' });
  },
});

function decorate(x) {
  return {
    ...x,
    stCls: ST_CLS[Number(x.status)] || 'mute',
    timeText: clubTime.rel(x.createTime),
    durText: clubTime.secondsText(x.charCount),
    // 文案在 JS 里拼好：WXML 里的三元 + 字符串拼接容易和引号打架
    hopeLine: x.hopeText ? `希望 ${x.hopeText}` : '未填希望时段',
    airLine: [x.airDate, x.airSlot].filter(Boolean).length
      ? `排到 ${[x.airDate, x.airSlot].filter(Boolean).join(' ')}`
      : '已通过，还没排时段',
  };
}
