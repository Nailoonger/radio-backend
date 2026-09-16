// app.js
const { request } = require('./utils/request.js');

App({
  globalData: {
    // 关键：模拟器要走 80 端口（nginx 反代），不能直连 3000
    // 因为 Docker 后端 3000 端口没暴露到主机，只有 nginx 80 暴露
    //
    // 真机扫码：改成电脑局域网 IP（如 http://192.168.1.100/api），手机电脑同 WiFi
    //   注意要用 80 端口（不是 3000），因为 Docker 只暴露了 nginx 80
    baseURL: 'http://127.0.0.1:80/api',
    token: '',
    userInfo: null,
    switches: {},
  },

  onLaunch() {
    // 恢复登录态
    const token = wx.getStorageSync('token');
    const userInfo = wx.getStorageSync('userInfo');
    if (token) this.globalData.token = token;
    if (userInfo) this.globalData.userInfo = userInfo;

    // 拉取模块开关（不阻塞首屏）
    this.fetchSwitches();
  },

  /**
   * 拉取所有模块开关状态（公开接口，无需登录）
   * 存入 app.globalData.switches
   */
  fetchSwitches() {
    return new Promise((resolve) => {
      // 这里直接用 wx.request，避免 request.js 在 app 还没 ready 时调用 getApp()
      wx.request({
        url: this.globalData.baseURL + '/switch/list',
        success: (res) => {
          if (res.data && res.data.code === 0 && Array.isArray(res.data.data.list)) {
            const map = {};
            res.data.data.list.forEach((s) => { map[s.key] = s.value; });
            this.globalData.switches = map;
          }
          resolve(this.globalData.switches);
        },
        fail: () => resolve(this.globalData.switches),
      });
    });
  },

  /**
   * 判断模块是否启用（默认 on，向后兼容）
   */
  isModuleEnabled(key) {
    const v = this.globalData.switches[key];
    return v === undefined || v !== 'off';
  },

  /**
   * 微信登录：wx.login 拿 code，调用后端 /api/user/login
   * 成功后将 token 存到 storage + globalData
   *
   * 开发模式（NODE_ENV !== 'production'）：跳过真 wx.login，直接用 mock_<timestamp> code。
   *   这样在微信开发者工具里即使没配 AppID 也能联调通过。
   *   注意：要走真 wx.login 联调，需确保后端 .env 中 MOCK_WECHAT=1。
   */
  login(nickname = '', avatar = '') {
    const sendLogin = (code) =>
      request('/api/user/login', 'POST', { code, nickname, avatar })
        .then((data) => {
          this.globalData.token = data.token;
          this.globalData.userInfo = data.user;
          wx.setStorageSync('token', data.token);
          wx.setStorageSync('userInfo', data.user);
          return data;
        });

    // 小程序无 process 全局，这里通过 __DEV__ 标记判断（微信开发者工具默认注入）
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    if (isDev) {
      const code = 'mock_debug_' + Date.now();
      return sendLogin(code);
    }
    return new Promise((resolve, reject) => {
      wx.login({
        success: ({ code }) => sendLogin(code).then(resolve).catch(reject),
        fail: reject,
      });
    });
  },

  /**
   * 退出登录
   */
  logout() {
    this.globalData.token = '';
    this.globalData.userInfo = null;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
  },

  /**
   * 统一 toast 工具
   */
  toast(title, icon = 'none') {
    wx.showToast({ title, icon, duration: 1500 });
  },
});
