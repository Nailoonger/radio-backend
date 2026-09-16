// pages/login/login.js
const app = getApp();

Page({
  data: { loading: false },

  async doLogin() {
    this.setData({ loading: true });
    try {
      await app.login();
      wx.showToast({ title: '登录成功' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.showToast({ title: '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
});
