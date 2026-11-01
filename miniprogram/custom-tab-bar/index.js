// custom-tab-bar/index.js
// 胶囊浮动底部导航（设计稿「01/02/03/04」底部）
//
// 动画契约 v10：沿用 v9 的「立即切页、目标页起点落位、渲染回调后播放」。
// 每页有独立实例；来源页不预播。selected 始终是真实页，visualSelected 只控制外观。
// 胶囊四段形变共 400ms；hide 与版本号阻止旧回调覆盖后续切换。

function pose(animation, left, width, height, duration) {
  return animation.left(`${left * 25}%`).width(`${width * 25}%`)
    .scaleY(height).step({ duration, timingFunction: 'ease-out' });
}

function resting(index) {
  const animation = wx.createAnimation();
  pose(animation, index, 1, 1, 0);
  return animation.export();
}

function flowing(from, to) {
  const animation = wx.createAnimation();
  const distance = Math.abs(to - from);
  const direction = Math.sign(to - from);
  // 前沿先行、后沿滞后；向左时镜像两端位置。
  pose(animation, direction > 0 ? from + distance * 0.12 : from - distance * 0.72,
    1 + distance * 0.60, 0.90, 120);
  pose(animation, direction > 0 ? from + distance * 0.80 : to,
    1 + distance * 0.20, 0.94, 120);
  pose(animation, to + direction * 0.035, 1, 1.02, 100);
  pose(animation, to, 1, 1, 60);
  return animation.export();
}

Component({
  options: {
    // 让 app.wxss 里的 :host 之外的全局变量可用
    addGlobalClass: true,
  },

  data: {
    selected: 0,
    visualSelected: 0,
    indicatorAnimation: {},
    motionClass: false,
    // 第一次 setSelected 落位前隐藏指示器。
    revealed: false,
    // 起点落位时禁用文字和图标颜色过渡；胶囊用 0ms 动画落位。
    noanim: false,
    // 启动动画期间由首页通过 getTabBar() 驱动：
    //   hidden —— 胶囊退到屏幕外（容器无底色，不会有白板出现）
    //   enter  —— 胶囊自下而上滑入（animation 加类即播，不受 setData 合并影响）
    hidden: false,
    enter: false,
    list: [
      { pagePath: '/pages/index/index',    text: '首页', icon: '/assets/tab-home.png',    iconOn: '/assets/tab-home-on.png' },
      { pagePath: '/pages/submit/submit',  text: '投稿', icon: '/assets/tab-submit.png',  iconOn: '/assets/tab-submit-on.png' },
      { pagePath: '/pages/members/members', text: '风采', icon: '/assets/tab-members.png', iconOn: '/assets/tab-members-on.png' },
      { pagePath: '/pages/mySubmit/mySubmit', text: '我的', icon: '/assets/tab-user.png',  iconOn: '/assets/tab-user-on.png' },
    ],
  },

  pageLifetimes: {
    hide() { this._motionVersion = (this._motionVersion || 0) + 1; },
  },

  methods: {
    /**
     * 【契约 1】用户点按 tab：只记录来源格 + 立刻切页，不演动画、不延迟。
     */
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item || index === this.data.selected) return;

      const app = getApp();
      const global = app.globalData;
      const request = global.tabRequest = (global.tabRequest || 0) + 1;
      global.tabFrom = this.data.selected;
      wx.switchTab({
        url: item.pagePath,
        fail: () => {
          if (global.tabRequest === request) global.tabFrom = undefined;
        },
      });
    },

    /**
     * 【契约 2】页面 onShow 调用：指示器从来源格滑到本格格位（只此一次滑动）。
     * 首次渲染即按起点就位（冷启动生效），渲染完成回调里再滑向终点。
     */
    setSelected(index) {
      const app = getApp();
      const global = app && app.globalData;
      const source = global && global.tabFrom;
      const from = Number.isInteger(source) && source >= 0 && source < 4 ? source : index;
      if (global) global.tabFrom = undefined;
      const version = this._motionVersion = (this._motionVersion || 0) + 1;
      const direction = Math.sign(index - from);

      // 真实选中态立即更新，避免起点渲染期间快速点按误判。
      this.setData({
        selected: index, visualSelected: from, revealed: true,
        noanim: true, motionClass: false, indicatorAnimation: resting(from),
      }, () => {
        if (version !== this._motionVersion) return;
        this.setData({
          noanim: false, visualSelected: index, motionClass: direction !== 0,
          indicatorAnimation: direction ? flowing(from, index) : resting(index),
        });
      });
      return direction;
    },
  },
});
