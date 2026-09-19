// pages/about/about.js
const { request } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    intro: '',
    schedule: '',
    contact: '',
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    Promise.all([
      request('/user/station/intro').catch(() => null),
      request('/user/station/schedule').catch(() => null),
      request('/user/station/contact').catch(() => null),
    ]).then(([intro, schedule, contact]) => {
      this.setData({
        intro: intro?.value || '暂未介绍',
        schedule: schedule?.value || '暂未公布',
        contact: contact?.value || '暂未提供',
      });
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
