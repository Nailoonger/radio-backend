// pages-partner/leave-review/leave-review.js · v1（2026-11-01 请假审批独立页）
//
// 陛下原话：「超管和社干的请假审批功能模块做到工作台站内协作那里作为入口，
//            我的页面依旧是请假进度和站员的一样。」
//
// 所以这一页只干一件事：审批。两档 tab —— 待审批 / 已审批。
//   · 待审批：按周（要对着本周班表批），先请先批（服务端 createTime asc）
//   · 已审批：不分周，按处理时间倒序，已批准 / 已驳回都在里面（靠标签区分）
//
// ⚠️ 以前审批和「我的请假」挤在 leave 一页靠 role 分支：
//    社干从「我的 · 请假进度」进去看到的是别人的待批队列，自己想请假反而没地方请。
//    现在拆成两页 —— leave 三端都只放「我的请假」，审批只在这里。
//
// ⚠️ 批准 = 两件事（2026-11-01 起）：改请假状态 + 班表这一格让开、整周退回草稿。
//    返回体的 `scheduleWithdrawn` 为 true 就提示「班表已退回草稿」，否则用户会以为班表没变。
//    班表要等补齐人手重新发布，这期间主页大白卡显示「本周班表已撤回」。

const { adminRequest } = require('../../utils/request.js');
const { addDays, md, rangeText } = require('../../utils/dates.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];

function dayNameOf(dateStr, weekStart) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const w = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart || '');
  if (!m || !w) return dateStr || '';
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const b = Date.UTC(Number(w[1]), Number(w[2]) - 1, Number(w[3]));
  const i = Math.round((a - b) / 86400000);
  return DAY_NAMES[i] || md(dateStr);
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
    tabIdx: 0,              // 0 待审批 / 1 已审批
    offset: 0,
    weekStart: '',
    weekText: '',
    isThisWeek: true,
    loading: true,
    busy: false,

    pending: [],
    pendingCount: 0,
    reviewed: [],
    reviewedCount: 0,
  },

  _baseWeek: '',

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
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

  onTab(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    if (i === this.data.tabIdx) return;
    this.setData({ tabIdx: i }, () => this.load());
  },

  prevWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset - 1 }, () => this.load()); },
  nextWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset + 1 }, () => this.load()); },

  load() {
    return this.data.tabIdx === 1 ? this.loadReviewed() : this.loadPending();
  },

  loadPending() {
    const offset = Number(this.data.offset) || 0;
    const known = this._baseWeek || '';
    const week = offset === 0 ? '' : (known ? addDays(known, offset * 7) : '');
    this.setData({
      loading: true,
      isThisWeek: offset === 0,
      weekStart: week || this.data.weekStart,
      weekText: week ? rangeText(week, 5) : this.data.weekText,
    });

    return adminRequest('/partner/leave/pending', 'GET', week ? { week } : {})
      .then((r) => {
        const ws = (r && r.weekStart) || week || this.data.weekStart;
        if (offset === 0 && ws) this._baseWeek = ws;
        const list = ((r && r.list) || []).map((x) => Object.assign({}, x, {
          dayText: dayNameOf(x.day, ws),
          timeText: fmtTime(x.createTime),
        }));
        this.setData({
          loading: false,
          pending: list,
          // 角标用**全站**待批数（服务端 counts.pending），不是本周列表长度：
          // 周日一过本周归零，但还有上周没批的，显示 0 会让人以为批完了
          pendingCount: Number((r && r.counts && r.counts.pending) || list.length),
          weekStart: ws,
          weekText: rangeText(ws, 5),
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  loadReviewed() {
    this.setData({ loading: true });
    return adminRequest('/partner/leave/reviewed', 'GET', {})
      .then((r) => {
        const list = ((r && r.list) || []).map((x) => Object.assign({}, x, {
          dayText: dayNameOf(x.day, x.weekStart),
          doneText: fmtTime(x.reviewedAt),
          tagCls: Number(x.status) === 1 ? 'done' : 'no',
          // 「本人撤回」的条目不在这里（服务端已过滤：没有 reviewedAt）
        }));
        this.setData({
          loading: false,
          reviewed: list,
          reviewedCount: list.length,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onApprove(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.busy) return;
    wx.showModal({
      title: '批准请假',
      content: '批准后这一格从班表上让开，整周退回草稿，补齐人手后重新发布。',
      confirmText: '批准',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        wx.showLoading({ title: '处理中', mask: true });
        adminRequest(`/partner/leave/${id}/review`, 'PUT', { approve: true })
          .then((r) => {
            wx.hideLoading();
            this.setData({ busy: false });
            const withdrawn = !!(r && r.scheduleWithdrawn);
            wx.showToast({
              title: withdrawn ? '已批准 · 班表退回草稿' : '已批准',
              icon: withdrawn ? 'none' : 'success',
            });
            this.load();
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ busy: false });
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },

  onReject(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.busy) return;
    wx.showModal({
      title: '驳回请假',
      editable: true,
      placeholderText: '写清理由（申请人能看到）',
      confirmText: '驳回',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写理由', icon: 'none' });
          return;
        }
        this.setData({ busy: true });
        wx.showLoading({ title: '处理中', mask: true });
        adminRequest(`/partner/leave/${id}/review`, 'PUT', { approve: false, reason })
          .then(() => {
            wx.hideLoading();
            this.setData({ busy: false });
            wx.showToast({ title: '已驳回', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ busy: false });
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },
});
