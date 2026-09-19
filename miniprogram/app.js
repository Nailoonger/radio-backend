// app.js
const { request } = require('./utils/request.js');

// 自定义导航（navigationStyle: custom）下，页面要自己让出「状态栏 + 右上角微信胶囊」。
// 胶囊高度固定 32px、上下各留 4px，所以整行按 44px 预留。
let windowInfo = {};
try {
  windowInfo = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
} catch (e) {
  windowInfo = {};
}
const STATUS_BAR_HEIGHT = windowInfo.statusBarHeight || 20;

/* 导航带高度按真实胶囊算：留白 = 胶囊上边距 × 2 + 胶囊高。
   写死的 88rpx 在华为等胶囊偏低的机型上会差好几个像素，内容会顶到胶囊。 */
let NAV_BAR_HEIGHT = 44;
try {
  const rect = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
  if (rect && rect.height > 0) {
    NAV_BAR_HEIGHT = Math.max((rect.top - STATUS_BAR_HEIGHT) * 2 + rect.height, 44);
  }
} catch (e) { /* 拿不到就用默认 44 */ }

App({
  globalData: {
    // 关键：模拟器要走 80 端口（nginx 反代），不能直连 3000
    // 因为 Docker 后端 3000 端口没暴露到主机，只有 nginx 80 暴露
    //
    // 真机扫码：改成电脑局域网 IP（如 http://192.168.1.100/api），手机电脑同 WiFi
    //   注意要用 80 端口（不是 3000），因为 Docker 只暴露了 nginx 80
    // 真机/体验版：走腾讯云服务器（2026-09-19 部署，公网 IP）
    // 调试期用 IP；正式化（域名+备案+HTTPS）后换成 https://域名/api
    baseURL: 'http://129.28.26.180/api',
    token: '',
    userInfo: null,
    switches: {},

    // 布局常量（自定义导航用）
    statusBarHeight: STATUS_BAR_HEIGHT,
    navBarHeight: NAV_BAR_HEIGHT,
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
   * 从后台切回前台时重拉一次：管理后台的改动能在下次回前台时立刻反映到 tabBar。
   * 顺序上 App.onShow 早于 Page.onShow，所以页面读到的已经是新值。
   */
  onShow() {
    this.fetchSwitches();
  },

  /**
   * 拉取所有模块开关状态（公开接口，无需登录）
   * 存入 app.globalData.switches
   */
  fetchSwitches() {
    // 并发去重：App.onShow 与页面 onShow 有可能同一拍各触发一次
    if (this._switchesPending) return this._switchesPending;

    this._switchesPending = new Promise((resolve) => {
      // 这里直接用 wx.request，避免 request.js 在 app 还没 ready 时调用 getApp()
      wx.request({
        // 注意：模块开关的用户端接口挂在 /api/user 下，正确路径是 /user/switch/list
        // （写成 /switch/list 会 404，而且 isModuleEnabled 有兜底，所以之前一直没被发现）
        url: this.globalData.baseURL + '/user/switch/list',
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
    }).then((data) => {
      this._switchesPending = null;
      return data;
    });

    return this._switchesPending;
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
   * 头像机制：全站头像一律「姓名首字圆形」（姓作图），不收集、不允许用户更换，
   *   所以这里不再向登录接口传 avatar（传了后端也会丢弃）。
   *
   * 开发模式（NODE_ENV !== 'production'）：跳过真 wx.login，直接用 mock_<timestamp> code。
   *   这样在微信开发者工具里即使没配 AppID 也能联调通过。
   *   注意：要走真 wx.login 联调，需确保后端 .env 中 MOCK_WECHAT=1。
   */
  login(nickname = '') {
    const sendLogin = (code) =>
      request('/user/login', 'POST', { code, nickname })
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
   * 学号 + 密码登录（2026-09 起的主通道）
   * POST /api/user/login/account  body: { username, password }
   * 成功后将 token 存到 storage + globalData；user.isDefaultPwd=true 表示还是初始密码
   */
  loginByAccount(username, password) {
    return request('/user/login/account', 'POST', { username, password })
      .then((data) => {
        this.globalData.token = data.token;
        this.globalData.userInfo = data.user;
        wx.setStorageSync('token', data.token);
        wx.setStorageSync('userInfo', data.user);
        return data;
      });
  },

  /**
   * 修改密码（首登激活 / 主动改密）
   * PUT /api/user/change-password  成功后返回新 token（旧的因 pv 变化作废）
   */
  changePassword(oldPassword, newPassword) {
    return request('/user/change-password', 'PUT', { oldPassword, newPassword })
      .then((data) => {
        this.globalData.token = data.token;
        this.globalData.userInfo = data.user;
        wx.setStorageSync('token', data.token);
        wx.setStorageSync('userInfo', data.user);
        return data;
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
