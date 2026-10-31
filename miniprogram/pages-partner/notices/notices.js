// pages-partner/notices/notices.js · v2（2026-11-01 社干/超管可就地新建与修改）
//
// 伙伴端「站内公告」：**用 admin_token 读**，不是学生端那一页。
//
// ⚠️ 为什么非要做这一页：「我的」六张卡里三端都有「站内公告」（2026-11-01 陛下定），
//    但原来指着的 `/pages/notices/notices` 走的是 **学生端 token**（`/user/notice/list`）——
//    社干/超管在伙伴端根本没有学生身份，点进去 40101，列表空、还把人往学生登录页赶。
//
// ⚠️⚠️ v2 口径（陛下 2026-11-01）：
//   「社干和超管可以在伙伴端新建然后发布，数据和管理端 web 是相通的，可以修改和设置置顶。」
//   ⇒ 读写都走 `/admin/notice/*`（`asAdmin`，三档都能读，社干/超管能写）——
//      **同一张 notice 表、同一套接口**，所以和管理端 web 天然是同一份数据，不存在"两边同步"。
//   ⇒ 列表**不过滤 isShow**：没发布的（草稿）也要在这里看得见，不然发完就消失，
//      以为丢了；未发布的行用灰标签标出来。
//   ⇒ 站员（role=2）不显示「新建 / 编辑」：公告由社干/超管出（陛下原话只点了这两个角色）。
//
// 依赖接口：GET /admin/notice/list · POST /admin/notice/create · PUT /admin/notice/:id

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
    openId: 0,        // 当前展开正文的那条（0 = 全收起）
    canEdit: false,   // 社干 / 超管才给「新建 · 编辑」
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const role = Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      // 0 超管 / 1 社干 能写；2 站员只读（三档必须写满，别落成 `role !== 2`）
      canEdit: role === 0 || role === 1,
    });
    this.load();
  },

  /** 从编辑页回来要看到刚改的东西 ⇒ onShow 重拉（首次 onLoad 已经拉过，这里跳过重复） */
  onShow() {
    if (this._loaded) this.load();
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
        const rows = ((d && d.list) || []).map((x, i) => {
          const content = x.content || '';
          return {
            k: Number(x.id) || i,
            id: Number(x.id) || 0,
            title: x.title || '（无标题）',
            content,
            isTop: Number(x.isTop) === 1,
            isShow: Number(x.isShow) !== 0,
            timeText: fmtTime(x.publishTime || x.createTime),
            // 列表里正文只给一眼，展开才看全文；太短的就不显示「展开」
            long: content.length > 60,
          };
        });
        this._loaded = true;
        this.setData({ loading: false, list: rows });
      })
      .catch((err) => {
        this._loaded = true;
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onToggle(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    this.setData({ openId: this.data.openId === id ? 0 : id });
  },

  onNew() {
    wx.navigateTo({ url: '/pages-partner/notices/edit/edit' });
  },

  onEdit(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    wx.navigateTo({ url: `/pages-partner/notices/edit/edit?id=${id}` });
  },
});
