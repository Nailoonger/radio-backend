// pages-partner/leave/leave.js · v1（2026-10-28 请假）
//
// 一个页面两种角色：
//   站员 —— 从我本周的班次里挑一场 + 写事由 → POST /partner/leave；可撤回待批的
//   社干 —— 待批队列 → PUT /partner/leave/:id/review（批准 / 驳回必须写理由）
//
// ⚠️ 一条请假 = 一个「场次」（日期 + 时段），不是整天 —— 站员可能只请午间那一场。
// ⚠️ 批准只改请假状态，**不动班表**；班表那格变空是生成/修订时按已批请假过滤出来的。

const { adminRequest } = require('../../utils/request.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];

function mondayOf(offset) {
  const now = new Date();
  const dow = now.getDay() === 0 ? 7 : now.getDay();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow - 1) + offset * 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function md(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${m[2]}/${m[3]}` : '';
}
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
    isManager: true,
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
    pending: [],
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
      // 站员（role=2）只能看自己的：请假页是"申请 + 我的"，考勤页是"我的考勤"
      isManager: Number(((app.globalData || {}).adminInfo || {}).role) === 0
        || Number(((app.globalData || {}).adminInfo || {}).role) === 1,
      myId: Number(info.id) || 0,
    });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  prevWeek() { this.setData({ offset: this.data.offset - 1 }, () => this.load()); },
  nextWeek() { this.setData({ offset: this.data.offset + 1 }, () => this.load()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    const weekStart = mondayOf(this.data.offset);
    this.setData({ loading: true, weekStart, isThisWeek: this.data.offset === 0 });
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date(weekStart.replace(/-/g, '/'));
    const end = new Date(d.getTime() + 4 * 86400000);
    this.setData({
      // ⚠️ 不拼「本周」二字：本周 / 非本周由 .wk-tag 胶囊显示（2026-10-30 统一口径）
      weekText: `${md(weekStart)} – ${md(`${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`)}`,
    });

    if (this.data.isManager) {
      return adminRequest('/partner/leave/pending', 'GET', { week: weekStart })
        .then((r) => {
          const list = ((r && r.list) || []).map((x) => Object.assign({}, x, {
            dayText: dayNameOf(x.day, weekStart),
            timeText: fmtTime(x.createTime),
          }));
          this.setData({ loading: false, pending: list });
        })
        .catch((err) => {
          this.setData({ loading: false });
          wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
        });
    }

    // 站员视角：我的班次 + 我的请假
    return Promise.all([
      adminRequest('/partner/schedule/mine', 'GET', { week: weekStart }).catch(() => ({ list: [] })),
      adminRequest('/partner/leave/mine', 'GET', { week: weekStart }).catch(() => ({ list: [] })),
    ]).then(([sch, lv]) => {
      const shifts = ((sch && sch.list) || []).map((x) => ({
        key: `${x.day}|${x.slot}`,
        day: x.day,
        slot: x.slot,
        label: `${x.dayName} ${x.slot}`,
      }));
      const mine = ((lv && lv.list) || []).map((x) => ({
        id: x.id,
        dayText: dayNameOf(x.day, weekStart),
        slot: x.slot,
        reason: x.reason,
        status: Number(x.status) || 0,
        statusText: x.statusText,
        rejectReason: x.rejectReason || '',
        tagCls: Number(x.status) === 1 ? 'done' : (Number(x.status) === 2 ? 'no' : 'warn'),
      }));
      this.setData({
        loading: false,
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

  onApprove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '批准请假',
      content: '批准后这一场从班表里让开（下次生成/修订时生效）。',
      confirmText: '批准',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        adminRequest(`/partner/leave/${id}/review`, 'PUT', { approve: true })
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已批准', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },

  onReject(e) {
    const id = e.currentTarget.dataset.id;
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
        wx.showLoading({ title: '处理中', mask: true });
        adminRequest(`/partner/leave/${id}/review`, 'PUT', { approve: false, reason })
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已驳回', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.hideLoading();
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },
});
