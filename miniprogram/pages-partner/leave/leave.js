// pages-partner/leave/leave.js · v2（2026-11-01 只留「我的请假」）
//
// ⚠️⚠️ v1 是一页两角色（站员申请 / 社干审批），已拆开：
//   · 这一页现在**三个角色同一套**：从我本周的班次里挑一场 + 写事由 → POST /partner/leave；
//     下面是我这周请过的假，待批的可以撤回。
//   · 审批搬去 pages-partner/leave-review/（工作台「站内协作 · 请假审批」进）。
//   为什么拆：社干从「我的 · 请假进度」点进来看到的是**别人的待批队列**，
//   自己想请假反而没地方请 —— 两件事挤一页，两边都别扭（2026-11-01 陛下定）。
//
// ⚠️ 一条请假 = 一个「场次」（日期 + 时段），不是整天 —— 站员可能只请午间那一场。
// ⚠️ 提交只能挑**已发布班表里本人的班次**（服务端二次校验）；批准后那一格会从班表上让开，
//    整周退回草稿，需补齐人手重新发布（见 cloud/.../partner/leave.js#review）。

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

Page({
  data: {
    statusBarHeight: 20,
    offset: 0,
    weekStart: '',
    weekText: '',
    isThisWeek: true,
    loading: true,
    submitting: false,

    shifts: [],
    pickKey: '',
    reason: '',
    monthUsed: 0,
    mine: [],
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      myId: Number(info.id) || 0,
    });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  prevWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset - 1 }, () => this.load()); },
  nextWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset + 1 }, () => this.load()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  /**
   * 翻周的基准（服务端给的「本周」周一）。
   *
   * ⚠️⚠️ 2026-10-31 改：原来前端用 `new Date().getDay()` 自己算周一（mondayOf），
   *    与后端「周日 0 点就算下一周」对不上 —— 周日打开请假页看到的是上一周，
   *    想给「明天（周一）」请假反而要手动翻到下一周。现在 offset=0 不传 week，由云函数定。
   */
  _baseWeek: '',

  load() {
    const offset = Number(this.data.offset) || 0;
    const known = this._baseWeek || '';
    const week = offset === 0 ? '' : (known ? addDays(known, offset * 7) : '');
    this.setData({
      loading: true,
      isThisWeek: offset === 0,
      weekStart: week || this.data.weekStart,
      weekText: week ? rangeText(week, 5) : this.data.weekText,
    });

    // 三个角色都是「我的请假」：我的班次 + 我请过的假（2026-11-01 起审批不在这里）
    const q = week ? { week } : {};
    return Promise.all([
      adminRequest('/partner/schedule/mine', 'GET', q).catch(() => ({ list: [] })),
      adminRequest('/partner/leave/mine', 'GET', q).catch(() => ({ list: [] })),
    ]).then(([sch, lv]) => {
      // 服务端回的才是权威周一（offset=0 时顺便记成翻周基准）
      const ws = (lv && lv.weekStart) || (sch && sch.weekStart) || week || this.data.weekStart;
      if (offset === 0 && ws) this._baseWeek = ws;
      const shifts = ((sch && sch.list) || []).map((x) => ({
        key: `${x.day}|${x.slot}`,
        day: x.day,
        slot: x.slot,
        label: `${x.dayName} ${x.slot}`,
      }));
      const mine = ((lv && lv.list) || []).map((x) => ({
        id: x.id,
        dayText: dayNameOf(x.day, ws),
        slot: x.slot,
        reason: x.reason,
        status: Number(x.status) || 0,
        statusText: x.statusText,
        rejectReason: x.rejectReason || '',
        tagCls: Number(x.status) === 1 ? 'done' : (Number(x.status) === 2 ? 'no' : 'warn'),
      }));
      this.setData({
        loading: false,
        weekStart: ws,
        weekText: rangeText(ws, 5),
        shifts,
        mine,
        monthUsed: Number(lv && lv.monthUsed) || 0,
        pickKey: shifts.length && shifts.some((s) => s.key === this.data.pickKey) ? this.data.pickKey : '',
      });
    });
  },

  pickShift(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ pickKey: this.data.pickKey === key ? '' : key });
  },

  onReason(e) { this.setData({ reason: e.detail.value }); },

  onSubmit() {
    const { pickKey, reason, weekStart, submitting } = this.data;
    if (submitting) return;
    if (!pickKey) {
      wx.showToast({ title: '先选一场', icon: 'none' });
      return;
    }
    if (!reason.trim()) {
      wx.showToast({ title: '写一下事由', icon: 'none' });
      return;
    }
    const [day, slot] = pickKey.split('|');
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });
    adminRequest('/partner/leave', 'POST', { weekStart, day, slot, reason: reason.trim() })
      .then(() => {
        wx.hideLoading();
        this.setData({ submitting: false, reason: '', pickKey: '' });
        wx.showToast({ title: '已提交，等社干批', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
      });
  },

  onCancel(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '撤回请假',
      content: '撤回后这一条作废，可以重新提交。',
      confirmText: '撤回',
      success: (res) => {
        if (!res.confirm) return;
        adminRequest(`/partner/leave/${id}`, 'DELETE')
          .then(() => {
            wx.showToast({ title: '已撤回', icon: 'success' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: (err && err.message) || '撤回失败', icon: 'none' }));
      },
    });
  },
});
