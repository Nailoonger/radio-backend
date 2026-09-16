// pages/index/index.js
const { request } = require('../../utils/request.js');
const { fmtDate, orDash } = require('../../utils/format.js');

Page({
  data: {
    currentProgram: null,  // 正在直播
    weekly: [],            // 本周节目单
    notices: [],           // 公告
    loading: true,
  },

  onLoad() {
    console.log('[index] onLoad, baseURL =', getApp().globalData.baseURL);
    this.loadAll();
  },

  onShow() {
    // tab 切换刷新
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    this.setData({ loading: true });
    return Promise.all([
      request('/user/program/current').catch(() => null),
      request('/user/program/weekly').catch(() => ({ list: [] })),
      request('/user/notice/list?pageSize=5').catch(() => ({ list: [] })),
    ]).then(([current, weekly, noticePage]) => {
      this.setData({
        currentProgram: current,
        weekly: weekly.list || [],
        notices: noticePage.list || [],
        loading: false,
      });
    });
  },

  goSubmit() {
    wx.switchTab({ url: '/pages/submit/submit' });
  },

  goNoticeDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/noticeDetail/noticeDetail?id=${id}` });
  },

  goProgramDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${id}` });
  },

  goAbout() {
    console.log('[index] goAbout called');
    wx.navigateTo({ url: '/pages/about/about' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },
});
