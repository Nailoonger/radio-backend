// pages/notices/notices.js
// 公告列表：分页（GET /api/user/notice/list?page=&pageSize=）
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');

Page({
  data: {
    statusBarHeight: 20,
    list: [],
    page: 1,
    pageSize: 10,
    total: 0,
    finished: false,
    loading: true,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  reload() {
    this.setData({ page: 1, list: [], finished: false, loading: true });
    return this.fetch();
  },

  fetch() {
    const { page, pageSize } = this.data;
    return request('/user/notice/list', 'GET', { page, pageSize })
      .then((data) => {
        const list = page === 1 ? data.list : this.data.list.concat(data.list);
        this.setData({
          list: list.map(n => ({ ...n, publishTimeFmt: fmtDate(n.publishTime) })),
          total: data.total,
          finished: list.length >= data.total,
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  loadMore() {
    if (this.data.finished || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.fetch();
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/noticeDetail/noticeDetail?id=${e.currentTarget.dataset.id}` });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
