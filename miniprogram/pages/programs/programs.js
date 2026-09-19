// pages/programs/programs.js
// 节目单：未来 7 天的节目预告（GET /api/user/program/schedule）
const { request } = require('../../utils/request.js');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    statusBarHeight: 20,
    groups: [],      // [{ date, label, list }]
    loading: true,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  fetch() {
    this.setData({ loading: true });
    // 不带参数，后端默认返回今天起 7 天
    return request('/user/program/schedule')
      .then((data) => {
        this.setData({ groups: this.groupByDate(data.list || []), loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  /** 按日期分组，今天/明天单独标注 */
  groupByDate(list) {
    const stamp = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const today = stamp(new Date());
    const tomorrow = stamp(new Date(Date.now() + 86400000));

    const map = new Map();
    list.forEach((p) => {
      const d = p.broadcastDate || '未定';
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(p);
    });

    return [...map.keys()].map((d) => ({
      date: d,
      label: d === today ? '今天' : d === tomorrow ? '明天' : this.labelOf(d),
      list: map.get(d),
    }));
  },

  labelOf(dateStr) {
    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
    const [y, m, d] = parts;
    const w = WEEK[new Date(y, m - 1, d).getDay()];
    return `${m} 月 ${d} 日 · ${w}`;
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${e.currentTarget.dataset.id}` });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
