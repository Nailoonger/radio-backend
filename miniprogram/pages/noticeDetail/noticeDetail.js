// pages/noticeDetail/noticeDetail.js
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');
const skeleton = require('../../utils/skeleton.js');

Page({
  // sk 初值必须 true —— 骨架从第一帧就在，不能先渲染空壳再盖骨架（2026-11-13 口径）
  data: { statusBarHeight: 20, notice: null, loading: true, sk: true, skOut: false, enter: false },

  onLoad(options) {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.skGate = skeleton.create(this, { when: () => !this.data.loading });
    this.skGate.boot();

    const id = options.id;
    request(`/user/notice/${id}`)
      .then((data) => {
        this.setData({ notice: { ...data, publishTimeFmt: fmtDate(data.publishTime) }, loading: false }, () => {
          this.skGate.check();
        });
      })
      .catch(() => {
        this.setData({ loading: false }, () => this.skGate.check());
      });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
