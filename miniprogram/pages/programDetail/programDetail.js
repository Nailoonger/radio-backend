// pages/programDetail/programDetail.js
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');

Page({
  data: { program: null, messages: [], loading: true },

  onLoad(options) {
    request(`/user/program/${options.id}`)
      .then((data) => {
        this.setData({
          program: data.program,
          messages: (data.messages || []).map(m => ({ ...m, createTimeFmt: fmtDate(m.createTime) })),
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },
});
