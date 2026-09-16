// pages/members/members.js
const { request } = require('../../utils/request.js');

Page({
  data: {
    groups: [],       // [{role, list: [...]}]
    roles: [],        // ['社长', '主播', ...]
    activeRole: '',   // 当前选中的职务，'' = 全部
    loading: true,
  },

  onLoad() {
    this.fetch();
  },

  onShow() {
    // 从详情页返回时刷新（可能下架了）
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    this.setData({ loading: true });
    try {
      const data = await request('/user/member/list');
      // 把后端返回的 /uploads/... 相对路径补全为绝对 URL（取 baseURL 的 origin）
      const origin = getApp().globalData.baseURL.replace(/\/api\/?$/, '');
      const groups = (data.groups || []).map(g => ({
        ...g,
        list: g.list.map(m => ({
          ...m,
          avatar: m.avatar && m.avatar.startsWith('http') ? m.avatar : origin + m.avatar,
        })),
      }));
      this.setData({
        groups,
        roles: data.roles || [],
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  switchRole(e) {
    const role = e.currentTarget.dataset.role || '';
    this.setData({ activeRole: role });
    // 全部时显示所有分组；选具体职务时只显示该组
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/memberDetail/memberDetail?id=${id}` });
  },
});
