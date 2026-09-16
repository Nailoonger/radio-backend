// pages/about/about.js
const { request } = require('../../utils/request.js');

Page({
  data: {
    intro: '',
    schedule: '',
    contact: '',
  },

  onLoad() {
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
});
