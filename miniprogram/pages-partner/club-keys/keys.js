// pages-partner/club-keys/keys.js
// 伙伴端 · 社团密钥（列表）
//
// ⚠️ 列表里**永远只有掩码**（`····M7`）。明文只在「重置」那一次返回，
//    这是后端 services/clubKey 的硬口径 —— 库里根本没有明文可读。
//    原型里那行 `S9K3M7` 是示意，真机上这一格显示的是掩码。
//
// ⚠️ 权限：clubkey 位（超管恒有，社干看超管分发）。后端是闸，这里只处理 40301 的展示。
//
// ⚠️ 「新建社团」那一行**只给超管**（2026-11-09）：多一家社团会立刻出现在全校学生的
//    轮播里（publicList 不筛 status），这是增减组织、不是密钥操作 —— 社干有 clubkey
//    位也只给看 / 重置 / 作废。所以这里读的是 `role === 0`，不是 clubkey 位。

const { adminRequest } = require('../../utils/request.js');
const partnerRole = require('../../utils/partnerRole.js');

Page({
  data: {
    statusBarHeight: 20,
    list: [],
    count: { total: 0, active: 0, blank: 0 },
    loading: true,
    denied: false,
    denyText: '',
    /** 超管才显示「＋ 新建社团」那一行 */
    isSuper: false,
  },

  onLoad() {
    const role = partnerRole.role();
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      isSuper: role === 0,
    });
    /* 缓存里没有 role（老版本写下的）时问一次 /partner/me 自愈。
       ⚠️ 只在「拿不到角色」这一种情况下发请求；正常路径零延迟。
          拿不到就保持 false —— 宁可少一个入口，也别让社干看见不该有的按钮。 */
    if (!partnerRole.known(role)) {
      partnerRole.ensure().then((r) => {
        if (this.data.isSuper !== (r === 0)) this.setData({ isSuper: r === 0 });
      });
    }
  },

  onShow() {
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  reload() {
    this.setData({ loading: !this.data.list.length });
    return adminRequest('/partner/club-keys', 'GET', {})
      .then((d) => {
        this.setData({
          list: (d.list || []).map((x) => ({
            ...x,
            initial: (x.name || '社').charAt(0),
            stText: x.status === 1 ? '有效' : '已作废',
            stCls: x.status === 1 ? 'done' : 'rej',
            sub: x.status === 1
              ? `密钥 ${x.mask || '——'}${x.ownerName ? ' · ' + x.ownerName : ''}`
              : `密钥已作废${x.ownerName ? ' · ' + x.ownerName : ''}`,
          })),
          count: d.count || this.data.count,
          denied: false,
        });
      })
      .catch((err) => {
        if (err && err.code === 40301) {
          this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  open(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/club-keys/edit?id=${id}` });
  },

  /** 新建一家（只有超管看得见那个入口） */
  goCreate() {
    wx.navigateTo({ url: '/pages-partner/club-keys/create' });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/club-notice/queue' });
  },
});
