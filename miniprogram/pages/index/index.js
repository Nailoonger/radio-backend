// pages/index/index.js
const { request } = require('../../utils/request.js');
const { fmtDate, orDash } = require('../../utils/format.js');

// 启动动画最短停留时长：入场 1.7s 播完再淡出，避免闪一下就没了
const LAUNCH_MIN_MS = 1700;
// 兜底：接口一直不回来也不能把用户关在启动页里
const LAUNCH_MAX_MS = 4000;

Page({
  data: {
    statusBarHeight: 20,
    currentProgram: null,  // 正在直播
    weekly: [],            // 本周节目单
    notices: [],           // 公告
    loading: true,
  },

  /** 自定义 tabBar 渲染在页面内容之上，遮罩盖不住它，所以启动期间
   *  让胶囊退到屏幕外（容器无底色，不会有任何"多出来一块"的感觉）。 */
  setTabBar(state) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData(state);
    }
  },

  onLoad() {
    console.log('[index] onLoad, baseURL =', getApp().globalData.baseURL);
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      navBarHeight: getApp().globalData.navBarHeight || 44,
    });
    this._launchedAt = Date.now();
    this._launchDismissed = false;
    this.setTabBar({ hidden: true });
    // 接口超时兜底
    setTimeout(() => this.dismissLaunch(), LAUNCH_MAX_MS);
    this.loadAll();
  },

  onShow() {
    // 自定义 tabBar：指示器落位（滑动动画发生在来源页的 switchTab 里）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(0);
    }
    // 启动动画还没放完：胶囊继续留在屏幕外；放完了就滑上来
    if (this._launchDismissed) this.setTabBar({ hidden: false });
    else this.setTabBar({ hidden: true });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    this.setData({ loading: true });
    return Promise.all([
      request('/user/program/current').catch(() => null),
      request('/user/program/weekly').catch(() => ({ list: [] })),
      request('/user/notice/list?pageSize=5').catch(() => ({ list: [] })),
    ]).then(([current, weekly, noticePage]) => {
      this.setData({
        currentProgram: current,
        weekly: weekly.list || [],
        notices: noticePage.list || [],
        loading: false,
      });
      // 数据就绪：启动动画可以退场了（里面会补足最短停留时长）
      this.dismissLaunch();
    });
  },

  /** 数据先到就立刻退场，数据后到就停在声波律动态（本身是加载态） */
  dismissLaunch() {
    if (this._launchDismissed) return;
    const mask = this.selectComponent('#launch');
    if (!mask) { this._launchDismissed = true; return; }
    const elapsed = Date.now() - (this._launchedAt || Date.now());
    const wait = Math.max(0, LAUNCH_MIN_MS - elapsed);
    setTimeout(() => {
      if (this._launchDismissed) return;
      this._launchDismissed = true;
      const m = this.selectComponent('#launch');
      if (m) m.dismiss();
      // 胶囊自下而上滑入（480ms），与遮罩 420ms 淡出同步
      this.setTabBar({ hidden: false, enter: true });
    }, wait);
  },

  goSubmit() {
    // 记录来源格：投稿页的指示器从「首页」滑过去
    getApp().globalData.tabFrom = 0;
    wx.switchTab({ url: '/pages/submit/submit' });
  },

  goCurrent() {
    const p = this.data.currentProgram;
    if (!p || !p.id) return;
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${p.id}` });
  },

  goNoticeDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/noticeDetail/noticeDetail?id=${id}` });
  },

  goProgramDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${id}` });
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  /** 本周节目单 → 查看全部 */
  goPrograms() {
    wx.navigateTo({ url: '/pages/programs/programs' });
  },

  /** 校园公告 → 全部公告 */
  goNotices() {
    wx.navigateTo({ url: '/pages/notices/notices' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },
});
