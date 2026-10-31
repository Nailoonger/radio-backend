// pages-partner/notices/notices.js · v1（2026-11-01）
//
// 伙伴端「站内公告」：**用 admin_token 读**，不是学生端那一页。
//
// ⚠️⚠️ 为什么非要做这一页：「我的」六张卡里三端都有「站内公告」（2026-11-01 陛下定），
//    但原来指着的 `/pages/notices/notices` 走的是 **学生端 token**（`/user/notice/list`）——
//    社干/超管在伙伴端根本没有学生身份，点进去 40101，列表空、还把人往学生登录页赶。
//    所以这里改用 `/admin/notice/list`（asAdmin，三档都能读），页面自己渲染。
//
// 口径：
//   · 只显示 `isShow = 1` 的（与学生端一致）：隐藏中的公告是还没发出去的草稿，
//     伙伴端是「看通知」不是「管通知」，管理入口在电脑端后台。
//   · 点一行展开 / 收起正文（正文默认收 3 行），避免长公告把列表冲散。

const { adminRequest } = require('../../utils/request.js');

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(typeof v === 'number' ? v : String(v).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    list: [],
    openId: 0,       // 当前展开的那条（0 = 全收起）
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({ statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true });
    return adminRequest('/admin/notice/list', 'GET', { page: 1, pageSize: 50 })
      .then((d) => {
        const rows = ((d && d.list) || [])
          .filter((x) => Number(x.isShow) !== 0)
          .map((x, i) => ({
            k: Number(x.id) || i,
            id: Number(x.id) || 0,
            title: x.title || '（无标题）',
            content: x.content || '',
            isTop: Number(x.isTop) === 1,
            timeText: fmtTime(x.publishTime || x.createTime),
          }));
        this.setData({ loading: false, list: rows });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onToggle(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    this.setData({ openId: this.data.openId === id ? 0 : id });
  },
});
