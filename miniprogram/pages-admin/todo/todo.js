// pages-admin/todo/todo.js
//
// 待办台（管理端登录后的落地页，2026-10-01）
//
// 只做两件事：告诉老师"今天有多少要处理"，并给两个入口。
// 一期全部范围就是这两个入口 —— 排期 / 批量 / 学生账号 / 系统设置仍在电脑端。
//
// 计数口径：取各接口的 total，**是全部待处理量**，不是严格"今日新增"。
//   投稿待审 = GET /admin/submit/list?reviewStatus=0   （审核维度，最准）
//   留言待审 = GET /admin/message/list?status=0
// 只取 pageSize=1 —— 我们只要 total，不拉数据。
//
// ⚠️ token 走 admin_token（app.adminLogin 写入、request.adminRequest 读取），
//    与学生端 token 分键，同机双登不会互相顶掉。

const { adminRequest } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    adminName: '管理员',
    loading: true,
    submitPending: 0,
    messagePending: 0,
    total: 0,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      // 没登录直接踢回管理端登录页（老师从收藏/分享进来时的兜底）
      wx.reLaunch({ url: '/pages-admin/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      adminName: info.nickname || info.username || '管理员',
    });
  },

  onShow() {
    this.fetchCounts();
  },

  onPullDownRefresh() {
    this.fetchCounts().then(() => wx.stopPullDownRefresh());
  },

  fetchCounts() {
    this.setData({ loading: true });
    return Promise.all([
      adminRequest('/admin/submit/list', 'GET', { reviewStatus: 0, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0),
      adminRequest('/admin/message/list', 'GET', { status: 0, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0),
    ]).then(([submitPending, messagePending]) => {
      this.setData({
        submitPending,
        messagePending,
        total: submitPending + messagePending,
        loading: false,
      });
    });
  },

  goReview() {
    wx.navigateTo({ url: '/pages-admin/review/review' });
  },

  goMessage() {
    wx.navigateTo({ url: '/pages-admin/message/message' });
  },

  doLogout() {
    wx.showModal({
      title: '退出管理端',
      content: '退出后需要重新输入管理员账号密码。',
      confirmText: '退出',
      confirmColor: '#B42318',
      success: (res) => {
        if (!res.confirm) return;
        const app = getApp();
        if (app && app.adminLogout) app.adminLogout();
        wx.reLaunch({ url: '/pages-admin/login/login' });
      },
    });
  },
});
