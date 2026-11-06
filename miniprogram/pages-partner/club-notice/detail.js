// pages-partner/club-notice/detail.js
// 伙伴端 · 审核处理台（原型 p-review）+ 待播的「标记已播出」（原型 p-air 的动作）
//
// 两种形态：
//   待审核 → 排期 + 驳回理由 + 「驳回 / 通过并排入待播」
//   待播   → 「标记已播出」
//   其余   → 只读（审核过 / 驳回 / 撤回的单子再看也不该能改）
//
// ⚠️ 通过**不强制填时段**：站里常常课间先审完、下午排播时再补。
//    强制必填会让社干在十分钟课间审不动一条通知。后端也不强制，两边一致。
//
// ⚠️ 驳回理由**必须写、至少 4 字**（后端硬拦）。这不是刁难：
//    不写理由的驳回，学生只会反复重提同一条。

const { adminRequest } = require('../../utils/request.js');
const clubTime = require('../../utils/clubTime.js');

const ST_CLS = { 0: 'wait', 1: 'air', 2: 'rej', 3: 'done', 9: 'mute' };
const SLOTS = ['早读 07:30', '午间 12:20', '傍晚 17:30'];

Page({
  data: {
    statusBarHeight: 20,
    id: null,
    record: null,
    timeline: [],
    stCls: 'mute',
    statusTime: '',
    slots: SLOTS,
    date: '',
    slot: '',
    passHint: '通过后自动通知提报方',
    reason: '',
    busy: false,
    loading: true,
    denied: false,
    denyText: '',
    // 今天（北京），日期选择器的起点 —— 不允许排到过去
    today: '',
  },

  onLoad(q) {
    const d = bjToday();
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      id: q && q.id ? Number(q.id) : null,
      today: d,
      date: d,
    });
    if (!this.data.id) { wx.showToast({ title: '参数不对', icon: 'none' }); return; }
    this.reload();
  },

  reload() {
    this.setData({ loading: !this.data.record });
    return adminRequest(`/partner/club-notice/${this.data.id}`, 'GET', {})
      .then((d) => {
        const r = d.record || {};
        this.setData({
          record: r,
          stCls: ST_CLS[Number(r.status)] || 'mute',
          statusTime: stampOf(r),
          durText: clubTime.secondsText(r.charCount),
          airLine: [r.airDate, r.airSlot].filter(Boolean).length
            ? `${[r.airDate, r.airSlot].filter(Boolean).join(' ')} · 由 ${r.reviewByName || '社干'} 通过`
            : `已通过（${r.reviewByName || '社干'}），还没排时段`,
          timeline: (d.timeline || []).map((t) => ({
            ...t,
            cls: t.state === 'done' ? 'done' : (t.state === 'now' ? 'now' : (t.state === 'bad' ? 'bad' : 'pending')),
          })),
          // 已经排过期的单子：把当时的排期回填进表单，改排时不用重敲
          date: r.airDate || this.data.today,
          slot: r.airSlot || '',
        });
        this.syncHint();
      })
      .catch((err) => {
        if (err && err.code === 40301) {
          this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '打不开这条', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  onDate(e) {
    this.setData({ date: e.detail.value });
    this.syncHint();
  },

  onSlot(e) {
    this.setData({ slot: e.detail.value });
    this.syncHint();
  },

  pickSlot(e) {
    this.setData({ slot: e.currentTarget.dataset.v });
    this.syncHint();
  },

  /** 底栏那句提示跟着排期实时变 —— 让社干在点「通过」之前就看清楚会通知成什么 */
  syncHint() {
    const { date, slot } = this.data;
    this.setData({
      passHint: slot ? `通过后自动通知提报方：已排入 ${date} ${slot}` : '通过后自动通知提报方（还没排时段，也可以先通过）',
    });
  },

  onReason(e) {
    this.setData({ reason: e.detail.value || '' });
  },

  pass() {
    if (this.data.busy) return;
    const { date, slot } = this.data;
    this.setData({ busy: true });
    adminRequest(`/partner/club-notice/${this.data.id}/review`, 'PUT', {
      pass: true, date, slot,
    })
      .then(() => {
        wx.showToast({ title: '已通过' });
        setTimeout(() => this.back(), 500);
      })
      .catch((err) => this.fail(err));
  },

  reject() {
    if (this.data.busy) return;
    const reason = (this.data.reason || '').trim();
    if (reason.length < 4) {
      wx.showToast({ title: '驳回要写原因，学生照着改', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    adminRequest(`/partner/club-notice/${this.data.id}/review`, 'PUT', { pass: false, reason })
      .then(() => {
        wx.showToast({ title: '已驳回' });
        setTimeout(() => this.back(), 500);
      })
      .catch((err) => this.fail(err));
  },

  air() {
    if (this.data.busy) return;
    wx.showModal({
      title: '标记已播出',
      content: '确认这一段已经在广播里念过了？提报方会同步看到「已播出」。',
      confirmText: '确认已播',
      success: ({ confirm }) => {
        if (!confirm) return;
        this.setData({ busy: true });
        adminRequest(`/partner/club-notice/${this.data.id}/air`, 'PUT', {})
          .then(() => {
            wx.showToast({ title: '已标记' });
            this.reload();
          })
          .catch((err) => this.fail(err));
      },
    });
  },

  fail(err) {
    this.setData({ busy: false });
    if (err && err.code === 40301) {
      this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
      return;
    }
    wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
    // 40901（已被别人处理过）⇒ 屏幕上这份已经是旧的了，必须重拉
    if (err && err.code === 40901) this.reload();
  },

  copy() {
    const r = this.data.record || {};
    wx.setClipboardData({
      data: r.body || '',
      success: () => wx.showToast({ title: '内容已复制' }),
    });
  },

  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/club-notice/queue' });
  },

  goBack() { this.back(); },
});

function bjToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function stampOf(r) {
  const st = Number(r.status);
  if (st === 0) return `${clubTime.stamp(r.createTime)} 提交`;
  if (st === 1) {
    const at = [r.airDate, r.airSlot].filter(Boolean).join(' ');
    return at ? `排到 ${at}` : '已通过，还没排时段';
  }
  if (st === 2) return `${clubTime.stamp(r.reviewTime)} 驳回`;
  if (st === 3) return `${clubTime.stamp(r.airTime)} 已播出`;
  return `${clubTime.stamp(r.updateTime)} 已撤回`;
}
