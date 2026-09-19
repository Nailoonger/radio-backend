// pages/memberDetail/memberDetail.js
// 详情页支持两种类型，由页面路径的 type 参数决定：
//   /pages/memberDetail/memberDetail?id=1&type=cadre  → 社干（cadre 表）
//   /pages/memberDetail/memberDetail?id=1&type=staff  → 部员（staff 表）
const { request } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    type: 'cadre',     // 'cadre' 社干 | 'staff' 部门人员
    member: null,
    loading: true,
    programList: [],   // 负责栏目（仅部员的 staff.programs 字段，按逗号切分）
  },

  onLoad(options) {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      type: options.type === 'staff' ? 'staff' : 'cadre',
    });

    const endpoint = this.data.type === 'staff'
      ? `/user/staff/${options.id}`
      : `/user/cadre/${options.id}`;

    request(endpoint)
      .then((m) => {
        const programList = m.programs
          ? m.programs.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
          : [];
        // 头像补全
        if (m.avatar && !m.avatar.startsWith('http')) {
          const origin = getApp().globalData.baseURL.replace(/\/api\/?$/, '');
          m.avatar = origin + m.avatar;
        }
        m.initial = (m.name || '?').charAt(0);   // 没传照片时的首字兜底
        this.setData({ member: m, programList, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/members/members' });
  },
});
