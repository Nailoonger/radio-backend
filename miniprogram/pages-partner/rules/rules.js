// pages-partner/rules/rules.js · v1（2026-10-28 排班规则）
//
// 两条硬约束：每天最多场次 / 每周最多场次。GET 读、PUT 存（超管）。
// ⚠️ 值域 1~14：0 会让生成算法无解，服务端也拦。前端只做加减，不让人手输脏值。
// ⚠️ 关掉开关 = 不限制（服务端按 99 处理），不是「设为 0」。

const { adminRequest } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    saving: false,
    dirty: false,
    canEdit: true,
    items: [],
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      canEdit: Number(info.role) === 0,
    });
    this.load();
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true });
    return adminRequest('/partner/rules', 'GET', {})
      .then((d) => {
        this.setData({
          loading: false,
          dirty: false,
          items: ((d && d.items) || []).map((x) => ({
            key: x.key, name: x.name, value: Number(x.value) || 1, on: x.on !== false,
          })),
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  step(e) {
    if (!this.data.canEdit) return;
    const { key, d } = e.currentTarget.dataset;
    const items = this.data.items.map((x) => {
      if (x.key !== key) return x;
      const v = Math.min(14, Math.max(1, x.value + Number(d)));
      return Object.assign({}, x, { value: v });
    });
    this.setData({ items, dirty: true });
  },

  onToggle(e) {
    if (!this.data.canEdit) return;
    const key = e.currentTarget.dataset.key;
    const on = !!e.detail.value;
    this.setData({
      items: this.data.items.map((x) => (x.key === key ? Object.assign({}, x, { on }) : x)),
      dirty: true,
    });
  },

  onSave() {
    if (this.data.saving || !this.data.dirty) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    adminRequest('/partner/rules', 'PUT', {
      items: this.data.items.map((x) => ({ key: x.key, value: x.value, on: x.on })),
    })
      .then((d) => {
        wx.hideLoading();
        this.setData({
          saving: false,
          dirty: false,
          items: ((d && d.items) || []).map((x) => ({
            key: x.key, name: x.name, value: Number(x.value) || 1, on: x.on !== false,
          })),
        });
        wx.showToast({ title: '已保存', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },
});
