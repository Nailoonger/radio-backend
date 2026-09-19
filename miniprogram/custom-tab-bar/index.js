// custom-tab-bar/index.js
// 胶囊浮动底部导航（设计稿「01/02/03/04」底部）
//
// ==================== 动画契约（v9 定稿，改这里之前先读完） ====================
// 微信 custom-tab-bar 的机制：每个 tab 页有自己独立的 tabBar 组件实例。
// 跨页滑动的全部翻车（冷启动没动画 / 方向错 / 两次动画 / 动画像被删了）都源于：
//   「渲染过的实例」才能演 transition；没渲染过的实例只有初始位置（第 1 格）。
//
// v9 方案：滑动发生在【目标页】，起点是【来源格】，用 setData 的渲染完成回调
// 替代猜时间的 setTimeout（回调 = 该次渲染已完成，元素已真实停在起点，transition 必生效）。
//
//   1) switchTab（用户点按）：不演动画、不延迟，只记录来源格到 globalData.tabFrom，
//      然后立刻 wx.switchTab —— 切页与点按同步（用户拍板，不要滑完再切）。
//   2) setSelected（页面到达）：两步——
//      ① setData({noanim:true, selected:来源格, revealed:true}) 瞬移到起点并显影
//      ② setData 的渲染完成回调里 setData({noanim:false, selected:目标格}) 滑向终点
//      只此一次滑动，起点=来源格，冷启动同样生效（首次渲染即按起点就位）。
//   3) 来源页不做任何预动画 —— 它的 selected 永远等于自己的格位，不存在毒化，
//      也就不存在「回到该页又滑一次」的两次动画。
//   4) revealed：指示器在第一次 setSelected 落位前不渲染（初始值不可信）。
// ==============================================================================

Component({
  options: {
    // 让 app.wxss 里的 :host 之外的全局变量可用
    addGlobalClass: true,
  },

  data: {
    selected: 0,
    // 指示器显影开关：第一次 setSelected 落位前不渲染（契约 4）
    revealed: false,
    // 瞬移开关：落位到起点时同帧禁用过渡（契约 2①）
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

  methods: {
    /**
     * 【契约 1】用户点按 tab：只记录来源格 + 立刻切页，不演动画、不延迟。
     */
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item || index === this.data.selected) return;

      const app = getApp();
      if (app) app.globalData.tabFrom = this.data.selected;
      wx.switchTab({ url: item.pagePath });
    },

    /**
     * 【契约 2】页面 onShow 调用：指示器从来源格滑到本格格位（只此一次滑动）。
     * 首次渲染即按起点就位（冷启动生效），渲染完成回调里再滑向终点。
     */
    setSelected(index) {
      const app = getApp();
      const from = (app && app.globalData && app.globalData.tabFrom !== undefined)
        ? app.globalData.tabFrom
        : this.data.selected;
      if (app && app.globalData) app.globalData.tabFrom = undefined;

      if (from === index) {
        this.setData({ selected: index, revealed: true });
        return;
      }

      // ① 瞬移到起点（同帧禁过渡）+ 显影；② 渲染完成回调里恢复过渡滑向终点
      this.setData({ noanim: true, selected: from, revealed: true }, () => {
        this.setData({ noanim: false, selected: index });
      });
    },
  },
});
