// pages-partner/schedule/slots/slots.js
//
// 伙伴端 · 值班时段配置（P1）
//
// 一页吃两态（拆解文档 §2.2「slots 页吃 slots-pub + timeslots」）：
//   编辑态（超管）—— 周一到周五各自增删时段，存草稿 → 发布
//   只读态（社干）—— 只看已发布的那一版，改不了
//
// ⚠️ 权限只在前端做「置灰」，真正的拦截在云函数（PUT/POST 都是 asSuperPartner）。
//    前端置灰是体验，不是安全边界。
//
// ⚠️ 时间在前端用 picker 的 'HH:MM'，提交时转成「当天分钟数」（410 = 06:50）。
//    为什么要转：字符串排序会出错（'9:00' > '10:00'），而重叠校验、排序、
//    同格多部门的 seq 编号全部依赖可比较的数值。
const { adminRequest } = require('../../utils/request.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const DEPARTMENTS = ['播音部', '主持部', '编辑部'];
const DUTY_ROLES = ['播音', '主持', '编辑', '记者', '技术'];
const NONE = '不限';

const pad2 = (n) => String(n).padStart(2, '0');

/** 'HH:MM' → 分钟数；非法返回 null */
function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → 'HH:MM' */
function toHHMM(min) {
  const n = Math.max(0, Math.min(1439, Number(min) || 0));
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    canEdit: false,
    hasPublished: false,
    pendingDraft: false,
    publishedInfo: '',
    draftVersion: 0,

    dayIndex: 0,
    dayTabs: [],
    dayRows: [],
    totalCount: 0,

    deptOptions: [NONE].concat(DEPARTMENTS),
    roleOptions: [NONE].concat(DUTY_ROLES),

    saving: false,
    publishing: false,
    dirty: false,
  },

  /** 全量模板（编辑中的真身）；dayRows 只是它按天切出来的一份视图 */
  _templates: [],
  /** 已发布的那份（只读态用） */
  _published: null,

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  fetch() {
    this.setData({ loading: true });
    return adminRequest('/partner/slots', 'GET', {})
      .then((d) => {
        const data = d || {};
        this._published = data.published || null;

        // 编辑用的模板：有草稿用草稿，没草稿就用「已发布版的副本」（后端已算好 editing）
        const editing = data.editing || { templates: [] };
        this._templates = (editing.templates || []).map((t) => Object.assign({}, t));

        const pub = data.published;
        this.setData({
          loading: false,
          canEdit: !!data.canEdit,
          hasPublished: !!data.hasPublished,
          pendingDraft: !!data.pendingDraft,
          draftVersion: editing.version || 0,
          publishedInfo: pub
            ? `当前生效 v${pub.version} · ${pub.slotCount} 个时段${pub.publishedAt ? ' · ' + String(pub.publishedAt).slice(5, 10).replace('-', '/') + ' 发布' : ''}`
            : '还没有发布过任何时段',
        });
        this.rebuild();
        // 刚拉下来的数据不算「未保存的修改」
        this.setData({ dirty: false });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /** 由 _templates 重算 tab 角标 + 当前天的行 */
  rebuild() {
    const tpl = this._templates;
    const dayTabs = DAY_NAMES.map((name, i) => ({
      day: i,
      name,
      count: tpl.filter((t) => Number(t.day) === i).length,
    }));

    const cur = this.data.dayIndex;
    // 当前天被删空时不要跳走（用户可能正在删），保持原位
    const day = cur;
    const rows = tpl
      .map((t, idx) => ({ t, idx }))
      .filter((x) => Number(x.t.day) === day)
      .sort((a, b) => (Number(a.t.start) || 0) - (Number(b.t.start) || 0))
      .map((x) => ({
        idx: x.idx,
        title: x.t.title || '',
        start: Number(x.t.start) || 0,
        end: Number(x.t.end) || 0,
        startText: toHHMM(x.t.start),
        endText: toHHMM(x.t.end),
        dept: x.t.dept || '',
        role: x.t.role || '',
        deptText: x.t.dept || NONE,
        roleText: x.t.role || NONE,
        count: Number(x.t.count) || 1,
      }));

    this.setData({
      dayTabs,
      dayRows: rows,
      totalCount: tpl.length,
      dirty: true,
    });
  },

  onSwitchDay(e) {
    const i = Number(e.currentTarget.dataset.i) || 0;
    this.setData({ dayIndex: i });
    this.rebuild();
  },

  // ─────────── 行内编辑 ───────────

  onEditTitle(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const t = this._templates[idx];
    if (!t) return;
    t.title = e.detail.value;
    // 只改这一行的文案，不整表重算（输入时重算会让光标跳位）
    const rows = this.data.dayRows;
    const r = rows.find((x) => x.idx === idx);
    if (r) r.title = t.title;
    this.setData({ dayRows: rows, dirty: true });
  },

  onTimeChange(e) {
    const { idx, field } = e.currentTarget.dataset;
    const t = this._templates[Number(idx)];
    if (!t) return;
    const min = toMin(e.detail.value);
    if (min === null) return;
    t[field] = min;

    const rows = this.data.dayRows;
    const r = rows.find((x) => x.idx === Number(idx));
    if (r) {
      r[field] = min;
      r[field + 'Text'] = toHHMM(min);
    }
    this.setData({ dayRows: rows, dirty: true });
  },

  onPickDept(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const t = this._templates[idx];
    if (!t) return;
    const v = this.data.deptOptions[Number(e.detail.value)] || NONE;
    t.dept = v === NONE ? '' : v;

    const rows = this.data.dayRows;
    const r = rows.find((x) => x.idx === idx);
    if (r) { r.dept = t.dept; r.deptText = v; }
    this.setData({ dayRows: rows, dirty: true });
  },

  onPickRole(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const t = this._templates[idx];
    if (!t) return;
    const v = this.data.roleOptions[Number(e.detail.value)] || NONE;
    t.role = v === NONE ? '' : v;

    const rows = this.data.dayRows;
    const r = rows.find((x) => x.idx === idx);
    if (r) { r.role = t.role; r.roleText = v; }
    this.setData({ dayRows: rows, dirty: true });
  },

  /** 人数 ±1（1~20，与后端白名单一致） */
  onStepCount(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const t = this._templates[idx];
    if (!t) return;
    const next = Math.max(1, Math.min(20, (Number(t.count) || 1) + delta));
    t.count = next;

    const rows = this.data.dayRows;
    const r = rows.find((x) => x.idx === idx);
    if (r) r.count = next;
    this.setData({ dayRows: rows, dirty: true });
  },

  onRemoveRow(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const t = this._templates[idx];
    if (!t) return;
    wx.showModal({
      title: '删除时段',
      content: `确定删除「${t.title || '未命名'}」吗？`,
      confirmText: '删除',
      confirmColor: '#B42318',
      success: (res) => {
        if (!res.confirm) return;
        this._templates.splice(idx, 1);
        this.rebuild();
      },
    });
  },

  /** 添加时段：默认接在该天最后一个时段之后，避免一上来就重叠 */
  onAddRow() {
    const day = this.data.dayIndex;
    const sameDay = this._templates
      .filter((t) => Number(t.day) === day)
      .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));

    let start = 480; // 08:00
    if (sameDay.length) {
      const last = sameDay[sameDay.length - 1];
      start = Math.min(1400, Number(last.end) || 480);
    }
    const end = Math.min(1440, start + 30);

    this._templates.push({
      day,
      title: `${DAY_NAMES[day]}新时段`,
      start,
      end,
      dept: '',
      role: '',
      count: 1,
    });
    this.rebuild();

    // 新增后滚到那一行（行数多时用户会找不到刚加的）
    wx.pageScrollTo({ selector: '.day-rows', duration: 200, offsetTop: -80 });
  },

  // ─────────── 保存 / 发布 ───────────

  /** 提交前本地先做一遍基本校验，把错误挡在网之前（文案与后端一致） */
  validate() {
    if (!this._templates.length) return '至少要配置一个时段';
    for (let i = 0; i < this._templates.length; i++) {
      const t = this._templates[i];
      const dn = DAY_NAMES[Number(t.day)] || `第 ${Number(t.day) + 1} 天`;
      const at = `${dn}的第 ${i + 1} 个时段`;
      if (!String(t.title || '').trim()) return `${at}还没填名称`;
      if (Number(t.end) <= Number(t.start)) return `${at}结束时间必须晚于开始`;
    }
    // 同一天重叠
    for (let i = 0; i < this._templates.length; i++) {
      for (let j = i + 1; j < this._templates.length; j++) {
        const a = this._templates[i];
        const b = this._templates[j];
        if (Number(a.day) !== Number(b.day)) continue;
        if (Number(a.start) < Number(b.end) && Number(b.start) < Number(a.end)) {
          return `「${a.title}」与「${b.title}」时间重叠`;
        }
      }
    }
    return '';
  },

  onSaveDraft() {
    if (this.data.saving || !this.data.canEdit) return;
    const err = this.validate();
    if (err) return wx.showToast({ title: err, icon: 'none' });

    this.setData({ saving: true });
    adminRequest('/partner/slots/draft', 'PUT', { templates: this._templates })
      .then((d) => {
        const v = (d && d.draft && d.draft.version) || this.data.draftVersion;
        this.setData({ saving: false, dirty: false, pendingDraft: true, draftVersion: v });
        wx.showToast({ title: '草稿已保存', icon: 'success' });
        this.fetch();
      })
      .catch((e) => {
        this.setData({ saving: false });
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      });
  },

  onPublish() {
    if (this.data.publishing || !this.data.canEdit) return;
    const err = this.validate();
    if (err) return wx.showToast({ title: err, icon: 'none' });

    wx.showModal({
      title: '发布值班时段',
      content: `发布后全体伙伴将按新时段填报可排时间（共 ${this._templates.length} 个时段）。`,
      confirmText: '发布',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ publishing: true });
        // 先存草稿再发布：发布只翻状态，不接收内容（内容以草稿为准）
        adminRequest('/partner/slots/draft', 'PUT', { templates: this._templates })
          .then(() => adminRequest('/partner/slots/publish', 'POST', {}))
          .then(() => {
            this.setData({ publishing: false, dirty: false, pendingDraft: false });
            wx.showToast({ title: '已发布', icon: 'success' });
            this.fetch();
          })
          .catch((e) => {
            this.setData({ publishing: false });
            wx.showToast({ title: (e && e.message) || '发布失败', icon: 'none' });
          });
      },
    });
  },
});
