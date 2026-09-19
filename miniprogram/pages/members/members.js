// pages/members/members.js - 风采展示（二层 tab：社干 / 部门人员）
const { request } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    loading: true,

    // 模块开关（member）：关闭时页面框架照旧渲染（标题 / 分段 tab / 筛选），
    // 但不请求数据、不渲染成员卡片
    disabled: false,

    // 顶层 tab（滑动分段控件，2 格）
    categories: [
      { key: 'cadre', label: '社干' },
      { key: 'staff', label: '部门人员' },
    ],
    categoryIndex: 0,
    activeCategory: 'cadre',

    // 数据
    cadre: [],         // 社干
    staffGroups: [],   // 部员按部门分组 [{ dept, list }]
    departments: [],   // 部门名列表（从数据取，不写死）
    visibleGroups: [], // 当前筛选下要显示的部门分组
    activeDept: '全部',
  },

  onLoad() {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      navBarHeight: getApp().globalData.navBarHeight || 44,
    });
    // 取数统一放 onShow（tab 页首次显示必定 onLoad → onShow，放两处会重复请求一次）
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(2);
    }
    // 先定「开关开没开」再取数：关闭时 fetch 直接走空数据分支
    this.loadSwitch().then(() => this.fetch());
  },

  /**
   * 读「模块开关」里的 member（风采展示）状态，返回是否为 off。
   * 只用来决定本页要不要取数 —— 底部 tabBar 不参与开关（入口保持原样，随时可进）。
   */
  loadSwitch() {
    const app = getApp();
    if (!app || typeof app.fetchSwitches !== 'function') return Promise.resolve(false);
    return app.fetchSwitches().then((sw) => {
      const off = !!(sw && sw.member === 'off');
      if (off !== this.data.disabled) this.setData({ disabled: off });
      return off;
    });
  },

  onPullDownRefresh() {
    this.loadSwitch()
      .then(() => this.fetch())
      .finally(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    // 模块关闭：页面骨架保留，数据区留空（不请求、不渲染卡片）
    if (this.data.disabled) {
      this.setData({
        loading: false,
        cadre: [],
        staffGroups: [],
        departments: [],
        visibleGroups: [],
      });
      return;
    }

    this.setData({ loading: true });
    try {
      const data = await request('/user/showcase');
      const origin = getApp().globalData.baseURL.replace(/\/api\/?$/, '');
      const absUrl = (u) => (u && u.startsWith('http')) ? u : (origin + (u || ''));

      const cadre = (data.cadre || []).map((m) => ({
        ...m,
        avatar: absUrl(m.avatar),
        initial: (m.name || '?').charAt(0),   // 没传照片时的首字兜底
      }));

      // 部员按部门分组（保留后端返回顺序），转成数组方便 wxml 遍历
      const staffGroups = Object.entries(data.staff || {}).map(([dept, list]) => ({
        dept,
        list: list.map((m) => ({
          ...m,
          avatar: absUrl(m.avatar),
          initial: (m.name || '?').charAt(0),
        })),
      }));

      this.setData({
        cadre,
        staffGroups,
        departments: staffGroups.map((g) => g.dept),
        loading: false,
      });
      this.applyFilter();
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 按当前选中的部门算出要显示的分组（wxml 里不能调 Object.keys/filter） */
  applyFilter() {
    const { activeDept, staffGroups } = this.data;
    const visibleGroups = activeDept === '全部'
      ? staffGroups
      : staffGroups.filter((g) => g.dept === activeDept);
    this.setData({ visibleGroups });
  },

  switchCategory(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index === this.data.categoryIndex) return;
    this.setData({
      categoryIndex: index,
      activeCategory: this.data.categories[index].key,
      activeDept: '全部',
    });
    this.applyFilter();
  },

  switchDept(e) {
    this.setData({ activeDept: e.currentTarget.dataset.dept });
    this.applyFilter();
  },

  goCadreDetail(e) {
    wx.navigateTo({ url: `/pages/memberDetail/memberDetail?id=${e.currentTarget.dataset.id}&type=cadre` });
  },

  goStaffDetail(e) {
    wx.navigateTo({ url: `/pages/memberDetail/memberDetail?id=${e.currentTarget.dataset.id}&type=staff` });
  },
});
