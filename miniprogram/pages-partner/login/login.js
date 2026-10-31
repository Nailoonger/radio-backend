// pages-partner/login/login.js
//
// 管理端登录（2026-10-01）
// 走的是**管理员账号体系**：
//   POST /api/admin/login  { username, password } → { token, admin }
// 落库分键存 admin_token（app.adminLogin 里做），同机双登不会互相顶掉。
//
// ⚠️ 这里没有「微信一键登录」：管理员账号是独立体系，不绑定微信。
//
// 2026-10-31（陛下：伙伴端登录页复用学生端的设计）：
//   视觉层整份换成学生端那一套 —— wxml 结构照 pages/login/login，wxss 直接
//   @import 学生端那份。**本文件的方法名全部保持原样**（inputUsername / inputPassword /
//   togglePwd / doLogin / goBack / goStudentLogin / showLoginHelp 都已经对得上），
//   所以换视觉没有动一行登录逻辑。

Page({
  data: {
    statusBarHeight: 20,
    username: '',
    password: '',
    showPwd: false,
    loading: false,
    loginError: '',
  },

  onLoad() {
    const app = getApp();
    this.setData({
      statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20,
    });
    // 已经登过的直接进工作台（登录态长期保持，不必每次输入）
    if (app && app.isAdminLoggedIn && app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/desk/desk' });
    }
  },

  inputUsername(e) {
    this.setData({ username: e.detail.value, loginError: '' });
  },

  inputPassword(e) {
    this.setData({ password: e.detail.value, loginError: '' });
  },

  togglePwd() {
    this.setData({ showPwd: !this.data.showPwd });
  },

  showLoginHelp() {
    wx.showModal({
      title: '伙伴登录帮助',
      content: '请使用站内管理员分配的伙伴账号登录。忘记密码或账号停用，请联系超管处理。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#0066CC',
    });
  },

  /** 返回上一页；直接进来的话就回学生登录页 */
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  goStudentLogin() {
    wx.reLaunch({ url: '/pages/login/login' });
  },

  doLogin() {
    if (this.data.loading) return;
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');

    if (!username) return this.setData({ loginError: '请输入伙伴账号。' });
    if (!password) return this.setData({ loginError: '请输入登录密码。' });

    this.setData({ loading: true, loginError: '' });

    const app = getApp();
    app.adminLogin(username, password)
      .then(() => {
        // 伙伴端是独立链路，登录后直接落工作台（不回学生端 tab）
        wx.reLaunch({ url: '/pages-partner/desk/desk' });
      })
      .catch((err) => {
        // 后端业务错误一律 HTTP 200 + { code, message }，message 已是给用户看的文案：
        //   40101 账号或密码错误 / 40301 账号已禁用 / 42901 登录尝试过多
        const msg = (err && err.message) || '登录失败，请稍后再试。';
        this.setData({ loginError: msg, loading: false });
      });
  },
});
