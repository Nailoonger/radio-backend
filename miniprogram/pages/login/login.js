// pages/login/login.js
// 登录两步式：
//   step=login    学号 + 密码登录（主通道）；微信一键登录降级为次要入口（开关 account_login_required
//                 打开时后端直接拒绝，这里只负责把后端文案透传出来）
//   step=activate 首登激活：还是初始密码（isDefaultPwd）时强制改密，成功后拿新 token 返回
const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    step: 'login',          // login | activate
    username: '',
    password: '',
    pwd2: '',
    loading: false,
    // v2 视觉新增：密码可见性 / 登录错误条 / 激活步密码规则实时提示
    showPwd: false,
    showPwd2: false,
    loginError: '',
    rLen: false,
    rLetter: false,
    rDigit: false,
    // 激活步用的信息
    realName: '',
    className: '',
  },

  onLoad() {
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 });
  },

  togglePwd() { this.setData({ showPwd: !this.data.showPwd }); },
  togglePwd2() { this.setData({ showPwd2: !this.data.showPwd2 }); },

  inputUsername(e) { this.setData({ username: e.detail.value, loginError: '' }); },
  inputPassword(e) {
    const v = e.detail.value || '';
    const patch = { password: v, loginError: '' };
    if (this.data.step === 'activate') {
      // 激活步：密码规则实时点亮
      patch.rLen = v.length >= 8;
      patch.rLetter = /[A-Za-z]/.test(v);
      patch.rDigit = /\d/.test(v);
    }
    this.setData(patch);
  },
  inputPwd2(e) { this.setData({ pwd2: e.detail.value }); },

  /** 学号 + 密码登录 */
  async doAccountLogin() {
    const { username, password, loading } = this.data;
    if (loading) return;
    if (!String(username).trim() || !password) {
      return wx.showToast({ title: '请输入学号和密码', icon: 'none' });
    }
    this.setData({ loading: true });
    try {
      const data = await app.loginByAccount(String(username).trim(), password);
      const u = data.user || {};
      if (u.isDefaultPwd) {
        // 初始密码首次登录 → 进入激活步（改密后旧 token 立即作废，必须换新的）
        this.setData({
          step: 'activate',
          _initialPwd: password,   // 激活时作为 oldPassword
          password: '',
          loginError: '',
          rLen: false, rLetter: false, rDigit: false,
          realName: u.name || u.nickname || '',
          className: u.className || '',
        });
        return;
      }
      this.done();
    } catch (e) {
      // v2：错误走按钮上方的错误条，不再弹 toast
      this.setData({ loginError: (e && e.message) || '登录失败，请稍后再试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 首登激活：设置新密码 */
  async doActivate() {
    const { password, pwd2, loading } = this.data;
    if (loading) return;
    if (!password || password.length < 8) {
      return wx.showToast({ title: '新密码至少 8 位', icon: 'none' });
    }
    if (!(/[A-Za-z]/.test(password) && /\d/.test(password))) {
      return wx.showToast({ title: '新密码需同时含字母和数字', icon: 'none' });
    }
    if (password !== pwd2) {
      return wx.showToast({ title: '两次输入不一致', icon: 'none' });
    }
    this.setData({ loading: true });
    try {
      // oldPassword = 登录时的初始密码（进入激活步时存到 _initialPwd）
      await app.changePassword(this.data._initialPwd, password);
      wx.showToast({ title: '激活成功' });
      this.done();
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '激活失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  skipActivate() {
    // 跳过激活：当前 token 仍有效（isDefaultPwd 只是提示，不强制），允许先逛逛
    wx.showToast({ title: '已跳过，建议尽快修改初始密码', icon: 'none' });
    this.done();
  },

  done() {
    wx.showToast({ title: '登录成功' });
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/index/index' });
    }, 600);
  },

  /** 微信一键登录（老通道；开关打开时后端会拒绝，文案照透） */
  async doLogin() {
    this.setData({ loading: true });
    try {
      await app.login();
      this.done();
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },
});
