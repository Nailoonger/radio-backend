// pages/club-notice/club-notice.js
// 通知进度 —— 一条通知走到哪一步了
//
// 四种形态共用这一屏（原型是三个屏，但只有底部按钮和顶部徽章不同）：
//   待审核 → 可撤回 / 可复制
//   待播   → 可复制（已经排上了，撤回要找社干）
//   已播出 → 可复制 / 再提一条
//   已驳回 → 按理由改一版重新提报
//
// ⚠️ 「能不能改/撤」由后端下发（canEdit / canWithdraw / canResubmit），
//    页面**不自己按 status 再判一遍** —— 两处判必然有一天对不上。

const { request } = require('../../utils/request.js');
const clubTicket = require('../../utils/clubTicket.js');
const clubTime = require('../../utils/clubTime.js');

const ST_CLS = { 0: 'wait', 1: 'air', 2: 'rej', 3: 'done', 9: 'mute' };

Page({
  data: {
    statusBarHeight: 20,
    id: null,
    record: null,
    timeline: [],
    stCls: 'mute',
    loading: true,
    statusTime: '',
  },

  onLoad(q) {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      id: q && q.id ? Number(q.id) : null,
    });
    const ticket = clubTicket.getTicket();
    if (!ticket) {
      wx.redirectTo({ url: '/pages/club-code/club-code' });
      return;
    }
    if (!this.data.id) {
      wx.showToast({ title: '参数不对', icon: 'none' });
      return;
    }
    this.load();
  },

  onShow() {
    // 从「改一版」回来时要刷新（编辑页保存后 navigateBack 到这里）
    if (this._loadedOnce) this.load();
    this._loadedOnce = true;
  },

  load() {
    const ticket = clubTicket.getTicket();
    if (!ticket) { wx.redirectTo({ url: '/pages/club-code/club-code' }); return Promise.resolve(); }
    return request(`/user/club-notice/${this.data.id}`, 'GET', { ticket })
      .then((d) => {
        const r = d.record || {};
        const st = Number(r.status);
        this.setData({
          record: r,
          stCls: ST_CLS[st] || 'mute',
          timeline: (d.timeline || []).map((t) => ({
            ...t,
            cls: t.state === 'done' ? 'done' : (t.state === 'now' ? 'now' : (t.state === 'bad' ? 'bad' : 'pending')),
          })),
          statusTime: statusStamp(r),
          // 文案在 JS 里拼好：WXML 里的三元 + 字符串拼接可读性太差，且容易和引号打架
          hopeTip: '社干审核内容，通过后排进播出单'
            + (r.hopeText ? `（你希望 ${r.hopeText}）` : '')
            + '，播出当天你会在这里看到「已播出」。',
        });
      })
      .catch((err) => {
        if (err && err.code === 40101) {
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '打不开这条', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  copy() {
    const r = this.data.record || {};
    wx.setClipboardData({
      data: r.body || '',
      success: () => wx.showToast({ title: '内容已复制' }),
    });
  },

  withdraw() {
    wx.showModal({
      title: '撤回这条',
      content: '撤回后这条不会播出，也不能恢复。确定撤回？',
      confirmText: '撤回',
      confirmColor: '#B42318',
      success: ({ confirm }) => {
        if (!confirm) return;
        const ticket = clubTicket.getTicket();
        request(`/user/club-notice/${this.data.id}/withdraw`, 'POST', { ticket })
          .then(() => { wx.showToast({ title: '已撤回' }); this.load(); })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '撤回失败', icon: 'none' });
            this.load();
          });
      },
    });
  },

  /** 改一版重新提报：被驳回时走这里（同一条单据改正文，不新建） */
  edit() {
    wx.navigateTo({ url: `/pages/club-new/club-new?id=${this.data.id}` });
  },

  /** 再提一条（已播出之后最常见的动作） */
  again() {
    wx.redirectTo({ url: '/pages/club-new/club-new' });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/club-desk/club-desk' });
  },
});

/**
 * 徽章旁边那句小字：不同状态看的是**不同的时刻**
 * （待审核看提交时刻、已驳回看退回时刻、已播出看播完时刻 —— 不是一律显示提交时间）
 */
function statusStamp(r) {
  const st = Number(r.status);
  if (st === 0) return `${clubTime.stamp(r.createTime)} 提交`;
  if (st === 1) {
    const at = [r.airDate, r.airSlot].filter(Boolean).join(' ');
    return at ? `排到 ${at}` : '已通过，等待排播';
  }
  if (st === 2) return `${clubTime.stamp(r.reviewTime)} 退回`;
  if (st === 3) return `${clubTime.stamp(r.airTime)} 播完`;
  return `${clubTime.stamp(r.updateTime)} 撤回`;
}
