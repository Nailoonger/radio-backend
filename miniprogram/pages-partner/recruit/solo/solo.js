// pages-partner/recruit/solo · v1（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-solo']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 这一屏只干一件事：**只覆盖这一个人的面试时间**，批次统一安排保持不变。
//   ① 报名人卡：首字头像 + 姓名 + 年级班级 · QQ + 右侧「单独配置」tag
//   ② 表单：面试时间（日期 + 时刻）/ 地点 / 说明（报名者可见）
//   ③ 两个动作：保存单独配置 / 恢复统一（只有已单独配置过才给）
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 接口是 `PUT /admin/recruitment/applications/:id/interview`（asAdmin，带 version），
//   不是批次级的那个 —— 批次级在「面试安排」页（`PUT /batches/:id/interview`）。
//
// ⚠️ `at: null` ＝清掉覆盖、退回跟批次；服务端会把这个人的进度交回「已提交」，
//   批次有统一安排时由后端派生出「待面试」，不会留下没时间的脏状态。
//
// ⚠️ 每次成功必须重拉（拿到新 version），否则第二次保存必 40910。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const { fmtIso } = require('../../../utils/format.js');

function pad(n) { return String(n).padStart(2, '0'); }
function cmpDay(a, b) { return String(a).localeCompare(String(b)); }

/** 日历格子（与 config / interview 页同一套）：a===b 时那天是深蓝单选 */
function monthCells(y, m, a, b) {
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 0; i < first; i += 1) out.push({ d: '', cls: 'blank' });
  for (let d = 1; d <= days; d += 1) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    let cls = '';
    if (a && b && cmpDay(key, a) >= 0 && cmpDay(key, b) <= 0) {
      cls = (key === a && key === b) ? 'cap solo' : 'mid';
    }
    out.push({ d: String(d), cls });
  }
  return out;
}
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    batchId: '',
    id: '',
    version: 0,
    a: null,
    batchPlanAt: '',
    batchPlanPlace: '',
    /* 表单 */
    date: '',
    time: '',
    place: '',
    note: '',
    custom: false,
    saving: false,
    /* 面试日期：字段装整段 + 点开原地展开日历（单选一天），跟「报名时间」同一套组件 */
    soloCal: { open: false, y: 0, m: 0, sel: '' },
    soloCalCells: [],
    soloCalMonth: '',
    soloCalHint: '',
    soloCalWeeks: WEEKDAYS,
    /* 时刻下拉：两栏（左时右分），点选即回填 */
    timeOpen: false,
    timeHours: [],
    timeMinutes: [],
    selH: '',
    selM: '',
  },

  onLoad(q) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      batchId: (q && q.batchId) || '',
      id: (q && q.id) || '',
    });
    this.load();
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    if (!this.data.id) return Promise.resolve();
    this.setData({ loading: !this._ready, err: '' });
    return adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}`, 'GET')
      .then((d) => {
        const b = (d && d.batch) || {};
        const own = d.interviewCustom ? (d.interview || {}) : null;
        const batchItv = b.interview || null;
        const at = own && own.at ? fmtIso(own.at) : '';
        /* 没单独配置过就把批次统一那一条预填进来 —— 从这儿改，改完才是「单独配置」 */
        const seed = at || (batchItv && batchItv.at ? fmtIso(batchItv.at) : '');
        let date = '';
        let time = '';
        if (seed) {
          const y = new Date().getFullYear();
          date = `${y}-${String(seed).slice(0, 5)}`;
          time = String(seed).slice(6, 11);
        }
        this._ready = true;
        this.setData({
          loading: false,
          version: Number(d.version) || 0,
          a: {
            initial: String(d.name || '?').charAt(0),
            name: d.name || '',
            grade: d.grade || '',
            className: d.className || '',
            qq: d.qqNumber || '',
          },
          custom: !!d.interviewCustom,
          batchPlanAt: batchItv && batchItv.at ? fmtIso(batchItv.at) : '',
          batchPlanPlace: (batchItv && batchItv.location) || '',
          date,
          time,
          place: (own ? own.location : (batchItv && batchItv.location)) || '',
          note: (own ? own.note : (batchItv && batchItv.note)) || '',
        });
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* 面试日期：点字段开/收日历；单选一天，确定回填（与「报名时间」同一套视觉） */
  onSoloCalOpen() {
    const c = this.data.soloCal;
    if (c.open) { this.setData({ soloCal: Object.assign({}, c, { open: false }) }); return; }
    const now = new Date();
    const from = this.data.date;
    const y = from ? Number(from.slice(0, 4)) : now.getFullYear();
    const m = from ? Number(from.slice(5, 7)) : now.getMonth() + 1;
    this.setData({ soloCal: { open: true, y, m, sel: from || '' } });
    this.refreshSoloCal();
  },
  onSoloCalNav(e) {
    const step = Number(e.currentTarget.dataset.step) || 0;
    const c = this.data.soloCal;
    let m = c.m + step;
    let y = c.y;
    if (m > 12) { m = 1; y += 1; }
    if (m < 1) { m = 12; y -= 1; }
    this.setData({ soloCal: Object.assign({}, c, { y, m }) });
    this.refreshSoloCal();
  },
  onSoloCalDay(e) {
    const d = String(e.currentTarget.dataset.d || '');
    if (!d) return;
    const c = this.data.soloCal;
    this.setData({ soloCal: Object.assign({}, c, { sel: `${c.y}-${pad(c.m)}-${pad(Number(d))}` }) });
    this.refreshSoloCal();
  },
  onSoloCalClear() {
    this.setData({ soloCal: Object.assign({}, this.data.soloCal, { sel: '' }) });
    this.refreshSoloCal();
  },
  onSoloCalClose() {
    this.setData({ soloCal: Object.assign({}, this.data.soloCal, { open: false }) });
  },
  onSoloCalOk() {
    const c = this.data.soloCal;
    if (!c.sel) { wx.showToast({ title: '先点选面试那一天', icon: 'none' }); return; }
    this.setData({ date: c.sel, soloCal: Object.assign({}, c, { open: false }) });
  },
  refreshSoloCal() {
    const c = this.data.soloCal;
    if (!c.y || !c.m) return;
    this.setData({
      soloCalCells: monthCells(c.y, c.m, c.sel, c.sel),
      soloCalMonth: `${c.y} 年 ${c.m} 月`,
      soloCalHint: c.sel ? `面试那天：${c.sel.slice(5, 7)}-${c.sel.slice(8, 10)}` : '点选面试那一天；确定后回填字段',
    });
  },

  /* 时刻：两栏（左时右分），点选即回填。规则与面试安排页同一套。 */
  onTimeOpen() {
    const open = !this.data.timeOpen;
    if (!open) { this.setData({ timeOpen: false }); return; }
    const cur = String(this.data.time || '');
    this.setData({
      timeOpen: true,
      timeHours: this.buildHours(cur.slice(0, 2)),
      timeMinutes: this.buildMinutes(cur.slice(3, 5)),
      selH: cur.slice(0, 2),
      selM: cur.slice(3, 5),
    });
  },
  onTimeHour(e) {
    const v = String(e.currentTarget.dataset.v || '');
    if (!v) return;
    this.setData({ selH: v });
    if (this.data.selM) this.commitTime();
  },
  onTimeMinute(e) {
    const v = String(e.currentTarget.dataset.v || '');
    if (!v) return;
    this.setData({ selM: v });
    if (this.data.selH) this.commitTime();
  },
  commitTime() {
    const { selH, selM } = this.data;
    if (!selH || !selM) return;
    this.setData({ time: `${selH}:${selM}`, timeOpen: false });
  },
  buildHours(cur) {
    const out = [];
    for (let h = 6; h <= 23; h += 1) out.push(pad(h));
    if (cur && /^\d{2}$/.test(cur) && out.indexOf(cur) < 0) { out.push(cur); out.sort(); }
    return out;
  },
  buildMinutes(cur) {
    const out = [];
    for (let m = 0; m < 60; m += 5) out.push(pad(m));
    if (cur && /^\d{2}$/.test(cur) && out.indexOf(cur) < 0) { out.push(cur); out.sort(); }
    return out;
  },

  onPlace(e) { this.setData({ place: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },

  onSave() {
    if (this.data.saving) return;
    const d = this.data;
    if (!d.date || !d.time) { wx.showToast({ title: '先选面试日期和时刻', icon: 'none' }); return; }
    if (!String(d.place || '').trim()) { wx.showToast({ title: '面试地点不能空着', icon: 'none' }); return; }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    adminRequest(`/admin/recruitment/applications/${encodeURIComponent(d.id)}/interview`, 'PUT', {
      version: d.version,
      at: `${d.date}T${d.time}:00+08:00`,
      location: d.place,
      note: d.note,
    })
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已保存单独配置', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '这条刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  onReset() {
    if (this.data.saving) return;
    wx.showModal({
      title: '恢复统一安排',
      content: '清掉这一个人的单独安排，改回跟随批次的统一安排。批次也没排就是「未安排」。',
      confirmText: '恢复',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ saving: true });
        wx.showLoading({ title: '处理中', mask: true });
        adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}/interview`, 'PUT', {
          version: this.data.version,
          at: null,
        })
          .then(() => {
            wx.hideLoading();
            this.setData({ saving: false });
            wx.showToast({ title: '已恢复统一安排', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ saving: false });
            if (isVersionConflict(err) || isConflict(err)) { this.load(); return; }
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },
});
