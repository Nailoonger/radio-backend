// pages/memberDetail/memberDetail.js
const { request } = require('../../utils/request.js');

Page({
  data: {
    member: null,
    loading: true,
    programList: [],   // 栏目数组（按逗号切分）
  },

  onLoad(options) {
    request(`/user/member/${options.id}`)
      .then((m) => {
        const programList = m.programs
          ? m.programs.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
          : [];
        // 头像补全
        if (m.avatar && !m.avatar.startsWith('http')) {
          const origin = getApp().globalData.baseURL.replace(/\/api\/?$/, '');
          m.avatar = origin + m.avatar;
        }
        this.setData({ member: m, programList, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },
});
