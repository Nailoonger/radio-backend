// pages/noticeDetail/noticeDetail.js
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');

Page({
  data: { statusBarHeight: 20, notice: null, loading: true },

  onLoad(options) {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    const id = options.id;
    request(`/user/notice/${id}`)
      .then((data) => {
        this.setData({ notice: { ...data, publishTimeFmt: fmtDate(data.publishTime) }, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
