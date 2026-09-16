// pages/noticeDetail/noticeDetail.js
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');

Page({
  data: { notice: null, loading: true },

  onLoad(options) {
    const id = options.id;
    request(`/user/notice/${id}`)
      .then((data) => {
        this.setData({ notice: { ...data, publishTimeFmt: fmtDate(data.publishTime) }, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },
});
