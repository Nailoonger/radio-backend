// pages/notices/notices.js
// 公告列表：分页（GET /api/user/notice/list?page=&pageSize=）
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');
const skeleton = require('../../utils/skeleton.js');

Page({
  data: {
    statusBarHeight: 20,
    list: [],
    page: 1,
    pageSize: 10,
    total: 0,
    finished: false,
    loading: true,
    // 加载骨架三件套（见 utils/skeleton.js）：sk 显不显示 / skOut 淡出中 / enter 挂进场
    sk: true,   // ⚠️ 初值必须 true：骨架首帧就画，不能先渲染内容再盖上来（2026-11-13 陛下退回）
    skOut: false,
    enter: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    // ⚠️ 闸门要在 reload 之前装好；落定条件就用「首屏那次 fetch 结束」——
    //    列表为空也要落定，否则空态页会一直盖着骨架。
    this.skGate = skeleton.create(this, { when: () => !this.data.loading });
    this.skGate.boot();
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
        }, () => { this.skGate && this.skGate.check(); });
      })
      .catch(() => this.setData({ loading: false }, () => { this.skGate && this.skGate.check(); }));
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
