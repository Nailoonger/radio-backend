// pages/mySubmit/mySubmit.js
const { request } = require('../../utils/request.js');
const { submitStatusText, submitStatusClass, fmtDate } = require('../../utils/format.js');
const app = getApp();

Page({
  data: {
    list: [],
    loading: true,
    page: 1,
    pageSize: 10,
    total: 0,
    finished: false,
    statusFilter: '',  // ''=全部 / 0=待审 / 1=通过 / 2=驳回
    loggedIn: false,
  },

  onLoad() {
    this.setData({ loggedIn: !!app.globalData.token });
  },

  onShow() {
    this.setData({ loggedIn: !!app.globalData.token });
    this.reload();
  },

  reload() {
    if (!app.globalData.token) {
      this.setData({ list: [], loading: false, total: 0, finished: true });
      return Promise.resolve();
    }
    this.setData({ page: 1, list: [], finished: false, loading: true });
    return this.fetch();
  },

  fetch() {
    const { page, pageSize, statusFilter } = this.data;
    const params = { page, pageSize };
    if (statusFilter !== '') params.status = statusFilter;
    return request('/user/submit/my', 'GET', params)
      .then((data) => {
        const list = page === 1 ? data.list : this.data.list.concat(data.list);
        this.setData({
          list,
          total: data.total,
          finished: list.length >= data.total,
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));
  },

  loadMore() {
    if (this.data.finished || this.data.loading) return;
    this.setData({ page: this.data.page + 1 });
    this.fetch();
  },

  switchFilter(e) {
    const statusFilter = e.currentTarget.dataset.status;
    this.setData({ statusFilter });
    this.reload();
  },

  async doLogin() {
    try {
      await app.login();
      this.setData({ loggedIn: true });
      this.reload();
    } catch (e) {
      wx.showToast({ title: '登录失败', icon: 'none' });
    }
  },

  async cancel(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((resolve) => {
      wx.showModal({ title: '提示', content: '确认撤销该投稿？', success: ({ confirm }) => resolve(confirm) });
    });
    if (!ok) return;
    try {
      await request(`/user/submit/${id}`, 'DELETE');
      wx.showToast({ title: '已撤销' });
      this.reload();
    } catch (err) {
      if (err && err.code === 40302) {
        wx.showToast({ title: '该模块暂时关闭，请稍后再试', icon: 'none' });
      } else {
        wx.showToast({ title: (err && err.message) || '撤销失败', icon: 'none' });
      }
    }
  },
});
