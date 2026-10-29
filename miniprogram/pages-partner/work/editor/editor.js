// pages-partner/work/editor/editor.js · v1（2026-10-28 写稿 · 时长尺）
//
// 一篇稿的编辑态：标题 / 栏目 / 正文 / 时长尺 → 存草稿 / 提交审核。
// 接口：POST /partner/draft（新建）· PUT /partner/draft/:id（存）· PUT /partner/draft/:id/submit
//
// ⚠️ 时长按「字数 ÷ 语速」估：语速默认 240 字/分钟（服务端同一口径，服务端为准）。
//    这里算的只是给人看的即时反馈，落库的 seconds 由服务端重算 —— 两边公式必须一致，
//    否则会出现「编辑器显示 3:00、列表里变 2:58」这种看着像 bug 的漂移。
//
// ⚠️ 待审 / 已通过的稿不能改（服务端硬拦），前端同步禁用并说明原因。
//
// 不做：AI 找稿 / AI 续写 / 换个说法 —— 没有服务端能力，不摆假按钮。

const { adminRequest } = require('../../../utils/request.js');

const RATE = 240;              // 字/分钟
const SCALE = 1.6;             // 刻度带满量程 = 目标 × 1.6（超了也看得见）

function countWords(s) {
  return String(s || '').replace(/\s/g, '').length;
}
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

Page({
  data: {
    statusBarHeight: 20,
    isNew: true,
    loading: true,
    notFound: false,
    readonly: false,
    lockText: '',
    saving: false,

    id: 0,
    version: 1,
    title: '',
    columnName: '',
    body: '',
    columns: [],

    wordCount: 0,
    seconds: 0,
    curText: '0:00',
    targets: [{ sec: 120, label: '2:00' }, { sec: 180, label: '3:00' }, { sec: 300, label: '5:00' }],
    targetSec: 180,
    targetText: '3:00',
    pct: 0,
    targetPct: 0,
    dialHint: '',
  },

  onLoad(query) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.loadColumns();

    const id = Number(query && query.id);
    if (!id) {
      this.setData({ isNew: true, loading: false });
      this.recalc();
      return;
    }
    this.setData({ id, isNew: false });
    this.fetchOne(id);
  },

  /** 栏目候选：本周节目名去重（公开接口；拉不到就不显示这一块，不报错） */
  loadColumns() {
    adminRequest('/user/program/weekly', 'GET', {})
      .then((d) => {
        const list = (d && d.list) || [];
        const names = [];
        list.forEach((p) => {
          const t = (p && p.title) || '';
          if (t && names.indexOf(t) < 0) names.push(t);
        });
        if (names.length) this.setData({ columns: names.slice(0, 8) });
      })
      .catch(() => { /* 栏目是加分项，拿不到就算了 */ });
  },

  fetchOne(id) {
    adminRequest(`/partner/draft/${id}`, 'GET', {})
      .then((d) => {
        if (!d) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        const st = Number(d.status) || 0;
        const readonly = st === 1 || st === 2;
        this.setData({
          loading: false,
          title: d.title || '',
          columnName: d.columnName || '',
          body: d.body || '',
          version: Number(d.version) || 1,
          readonly,
          lockText: st === 1
            ? '这篇在社干那里排队审着，审完才能改。'
            : (st === 2 ? '这篇已经通过了，不能再改（要改就新建一版）。' : ''),
        }, () => this.recalc());
      })
      .catch((err) => {
        this.setData({ loading: false, notFound: true });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onBody(e) { this.setData({ body: e.detail.value }, () => this.recalc()); },

  pickColumn(e) {
    if (this.data.readonly) return;
    const v = e.currentTarget.dataset.v;
    this.setData({ columnName: this.data.columnName === v ? '' : v });
  },

  pickTarget(e) {
    const sec = Number(e.currentTarget.dataset.v);
    const hit = this.data.targets.find((t) => t.sec === sec);
    this.setData({ targetSec: sec, targetText: hit ? hit.label : mmss(sec) }, () => this.recalc());
  },

  /** 字数 → 时长 → 游标位置（公式与服务端一致） */
  recalc() {
    const words = countWords(this.data.body);
    const seconds = Math.round((words / RATE) * 60);
    const target = this.data.targetSec;
    const pct = Math.min(100, (seconds / (target * SCALE)) * 100);
    const targetPct = (1 / SCALE) * 100;
    const diff = seconds - target;
    let hint;
    if (!words) hint = `目标 ${mmss(target)}，按每分钟 ${RATE} 字算`;
    else if (diff < -20) hint = `还差 ${mmss(-diff)}（约 ${Math.ceil((-diff / 60) * RATE)} 字）`;
    else if (diff <= 20) hint = '长度刚好，可以交了';
    else hint = `超出 ${mmss(diff)}，考虑删一点`;
    this.setData({
      wordCount: words,
      seconds,
      curText: mmss(seconds),
      pct: Math.round(pct * 10) / 10,
      targetPct,
      dialHint: hint,
    });
  },

  /** AI 三个动作：服务未接入，按钮照方案摆着，点了如实告知 */
  onAiAction(e) {
    const act = (e.currentTarget.dataset && e.currentTarget.dataset.act) || '该功能';
    wx.showModal({
      title: act,
      content: '该功能暂未开放，敬请期待。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/work/work' });
  },

  /** 存草稿：新建走 POST，已有走 PUT（带 baseVersion 做乐观锁） */
  persist() {
    const d = this.data;
    const payload = {
      title: d.title.trim(),
      columnName: d.columnName,
      body: d.body,
      rate: RATE,
    };
    if (d.isNew) {
      return adminRequest('/partner/draft', 'POST', payload).then((r) => {
        this.setData({ id: r.id, isNew: false, version: Number(r.version) || 1 });
        return r;
      });
    }
    payload.baseVersion = d.version;
    return adminRequest(`/partner/draft/${d.id}`, 'PUT', payload).then((r) => {
      this.setData({ version: Number(r.version) || this.data.version });
      return r;
    });
  },

  onSave() {
    if (this.data.saving) return;
    if (!this.data.title.trim() && !this.data.body.trim()) {
      wx.showToast({ title: '先写点东西', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    this.persist()
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已存草稿', icon: 'success' });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  onSubmit() {
    if (this.data.saving) return;
    if (!countWords(this.data.body)) {
      wx.showToast({ title: '正文是空的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '提交审核',
      content: '提交后进社干待办台，这期间不能再改。',
      confirmText: '提交',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ saving: true });
        wx.showLoading({ title: '提交中', mask: true });
        this.persist()
          .then(() => adminRequest(`/partner/draft/${this.data.id}/submit`, 'PUT', {}))
          .then(() => {
            wx.hideLoading();
            this.setData({ saving: false, readonly: true, lockText: '已提交，等社干审。' });
            wx.showToast({ title: '已提交', icon: 'success' });
            setTimeout(() => {
              wx.reLaunch({ url: '/pages-partner/work/work' });
            }, 700);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ saving: false });
            wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
          });
      },
    });
  },
});
