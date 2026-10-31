// pages-partner/feedback/feedback.js · v1（2026-10-28 互评）
//
// 「不是考核，是当场说一句。评语只按人聚合，不显示谁评的。」（v151 原文）
// 所以：不打分、不打标签，就一段话 ≤200 字；我收到的只显示内容与场次，不显示评价人。
//
// 接口：GET /partner/feedback/pending?week= · POST /partner/feedback · GET /partner/feedback/mine?week=

const { adminRequest } = require('../../utils/request.js');

// ⚠️ 2026-10-31：不再在本页算周一。后端「周日 0 点起算下一周」，
//    前端 getDay() 算出来会在周日差一周（反馈会挂到上一周的场次上）。
//    这里只把服务端回的 weekStart 存起来，后续请求原样带回去。
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
    weekStart: '',
    loading: true,
    pending: [],
    doneCount: 0,
    received: [],
    target: null,
    text: '',
    submitting: false,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      weekStart: '',
    });
    this.load();
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    const week = this.data.weekStart;
    this.setData({ loading: true });
    const q = week ? { week } : {};
    return Promise.all([
      adminRequest('/partner/feedback/pending', 'GET', q).catch(() => ({ list: [] })),
      adminRequest('/partner/feedback/mine', 'GET', q).catch(() => ({ list: [] })),
    ]).then(([pd, mi]) => {
      const list = ((pd && pd.list) || []).map((x, i) => Object.assign({}, x, {
        k: i,
        dayName: x.dayName || x.day || '',
        done: !!x.done,
      }));
      const received = ((mi && mi.list) || []).map((x) => ({
        id: x.id,
        text: x.text,
        dayName: x.dayName || '',
        slot: x.slot || '',
        timeText: fmtTime(x.createTime),
      }));
      this.setData({
        loading: false,
        // 服务端回的才是权威周一（不传 week 时它就是「本周」，周日 0 点起算下周）
        weekStart: (pd && pd.weekStart) || (mi && mi.weekStart) || week,
        pending: list,
        doneCount: list.filter((x) => x.done).length,
        received,
      });
    });
  },

  pick(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const t = this.data.pending[idx];
    if (!t) return;
    if (t.done) {
      wx.showToast({ title: '这一场已经评过了', icon: 'none' });
      return;
    }
    this.setData({ target: t, text: '' });
  },

  backToList() { this.setData({ target: null, text: '' }); },

  onText(e) { this.setData({ text: e.detail.value }); },

  onSubmit() {
    const { target, text, weekStart, submitting } = this.data;
    if (submitting || !target) return;
    if (!text.trim()) {
      wx.showToast({ title: '写一句再交', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });
    adminRequest('/partner/feedback', 'POST', {
      weekStart,
      day: target.day,
      slot: target.slot,
      targetId: target.personId,
      text: text.trim(),
    })
      .then(() => {
        wx.hideLoading();
        this.setData({ submitting: false, target: null, text: '' });
        wx.showToast({ title: '已提交', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
      });
  },
});
