// pages-partner/work/versions/versions.js · v1（2026-10-28 版本记录）
//
// 一篇稿的全部版本（当前版在最上），可点开看全文、可把旧版恢复成新草稿。
// 接口：GET /partner/draft/:id/versions · POST /partner/draft/:id/restore { v }
//
// ⚠️ 恢复的语义（与后端一致，也要写在界面上）：**另存为新草稿**，不覆盖当前版。
//    所以恢复后 version 还会 +1，当前这一版照样留在记录里 —— 用户的未提交修改不会被吞。

const { adminRequest } = require('../../../utils/request.js');

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fmtTime(v) {
  if (!v) return '';
  const d = new Date(typeof v === 'number' ? v : String(v).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    notFound: false,
    id: 0,
    title: '',
    columnName: '',
    current: 1,
    curStatusText: '',
    list: [],
    open: null,
  },

  onLoad(query) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const id = Number(query && query.id);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      id,
    });
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  fetch() {
    return adminRequest(`/partner/draft/${this.data.id}/versions`, 'GET', {})
      .then((d) => {
        if (!d) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        const list = (d.list || []).map((v) => {
          const st = Number(v.status) || 0;
          return {
            v: Number(v.v) || 0,
            current: !!v.current,
            body: v.body || '',
            metaText: [
              fmtTime(v.savedAt),
              `${v.wordCount || 0} 字`,
              mmss(v.seconds),
            ].filter(Boolean).join(' · '),
            statusText: v.statusText || '',
            tagCls: st === 2 ? 'done' : (st === 3 ? 'no' : (st === 1 ? 'warn' : 'gray')),
          };
        });
        const cur = list.find((x) => x.current);
        this.setData({
          loading: false,
          title: d.title || '',
          columnName: d.columnName || '',
          current: Number(d.current) || 1,
          curStatusText: cur ? cur.statusText : '',
          list,
        });
      })
      .catch((err) => {
        this.setData({ loading: false, notFound: true });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/work/work' });
  },

  onOpen(e) {
    const v = Number(e.currentTarget.dataset.v);
    const hit = this.data.list.find((x) => x.v === v);
    if (hit) this.setData({ open: hit });
  },

  closeOpen() { this.setData({ open: null }); },

  noop() { /* 点卡片内部不关闭 */ },

  onRestore(e) {
    const v = Number(e.currentTarget.dataset.v);
    wx.showModal({
      title: `恢复 v${v}`,
      content: '会以这一版的内容新建一份草稿（当前第 ' + this.data.current + ' 版原样保留）。',
      confirmText: '恢复',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '恢复中', mask: true });
        adminRequest(`/partner/draft/${this.data.id}/restore`, 'POST', { v })
          .then((d) => {
            wx.hideLoading();
            this.setData({ open: null });
            wx.showToast({ title: '已恢复为草稿', icon: 'success' });
            const id = (d && d.id) || this.data.id;
            setTimeout(() => {
              wx.redirectTo({ url: `/pages-partner/work/editor/editor?id=${id}` });
            }, 600);
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '恢复失败', icon: 'none' });
          });
      },
    });
  },
});
