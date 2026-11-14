// pages-partner/recruit/q · v1（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-q']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 这一屏是「批次配置 → 点某一题」的下级页，只做一件事：改这一道题。
//   ① 顶部一行小标签：「第 N 题 / 新题」+ 右端「保存后才写回批次」
//   ② 题干（右下角字数 / 60）
//   ③ 题型＝四颗小方角胶囊（单行 / 多行 / 单选 / 多选）
//   ④ 必填拨杆 + 一句解释
//   ⑤ 选择题才出现选项编辑（2～20 个，每行序号 + 输入 + 删）
//   ⑥ 底部「保存这道题」+ 居中红字「删除这道题 / 放弃这道题」
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 服务端没有「单独存一道题」的接口：题目是批次的一个字段。
//   所以这一页保存时**要把整份题目重拼一遍再 PUT 整批**：
//     · 其它题原样带回去（id / type / title / required / options 全带上）
//     · 改动的那一道按编辑结果重拼，**选项按 label 找回原 id**（丢了 id 旧答案就指空）
//     · 发布后 questions 是锁的：进来就只读，不给保存
//
// ⚠️ 版本冲突码 40910（招新专用），只认 40901 等于没接。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const { fmtIso } = require('../../../utils/format.js');

const TYPES = [
  { key: 'text', label: '单行' },
  { key: 'textarea', label: '多行' },
  { key: 'single', label: '单选' },
  { key: 'multiple', label: '多选' },
];

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    batchId: '',
    /* i >= 0 改第 i 题；i === -1 新题 */
    i: -1,
    isNew: true,
    label: '',
    locked: false,
    title: '',
    titleLen: 0,
    type: 'textarea',
    types: TYPES,
    required: false,
    opts: [],
    saving: false,
    /* 原批次的 version 与题目（保存时要整份回去） */
    version: 0,
    questions: [],
  },

  onLoad(q) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const i = q && q.i !== undefined ? Number(q.i) : -1;
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      batchId: (q && q.batchId) || '',
      i,
      isNew: i < 0,
    });
    this.load();
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    if (!this.data.batchId) return Promise.resolve();
    this.setData({ loading: true, err: '' });
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}`, 'GET')
      .then((b) => {
        const questions = (b.questions || []).map((x) => ({
          id: x.id, type: x.type, title: x.title, required: !!x.required,
          options: (x.options || []).map((o) => ({ id: o.id, label: o.label })),
        }));
        const locked = !!b.publishedAt || !!b.archivedAt;
        const cur = this.data.i >= 0 ? questions[this.data.i] : null;
        this.setData({
          loading: false,
          version: Number(b.version) || 0,
          questions,
          locked,
          label: this.data.i >= 0 ? `第 ${this.data.i + 1} 题` : '新题',
          title: cur ? cur.title : '',
          titleLen: cur ? String(cur.title || '').length : 0,
          type: cur ? cur.type : 'textarea',
          required: cur ? !!cur.required : false,
          opts: cur ? cur.options.map((o) => o.label) : ['', ''],
        });
        wx.setNavigationBarTitle && wx.setNavigationBarTitle({ title: this.data.i >= 0 ? '问题编辑' : '添加问题' });
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* ── 字段 ── */
  onTitle(e) { this.setData({ title: e.detail.value, titleLen: String(e.detail.value || '').length }); },
  onType(e) {
    if (this.data.locked) return;
    const type = e.currentTarget.dataset.t;
    /* 切成选择题型时给两个空选项占位（服务端要求 2～20 个） */
    const needOpts = type === 'single' || type === 'multiple';
    const opts = needOpts && this.data.opts.length < 2
      ? ['', '']
      : (needOpts ? this.data.opts : this.data.opts);
    this.setData({ type, opts });
  },
  onReq(e) { if (!this.data.locked) this.setData({ required: !!e.detail.value }); },

  /* ── 选项 ── */
  onOpt(e) {
    const i = Number(e.currentTarget.dataset.i);
    const opts = this.data.opts.slice();
    opts[i] = e.detail.value;
    this.setData({ opts });
  },
  onOptDel(e) {
    if (this.data.locked) return;
    const i = Number(e.currentTarget.dataset.i);
    if (this.data.opts.length <= 2) { wx.showToast({ title: '至少 2 个选项', icon: 'none' }); return; }
    const opts = this.data.opts.slice();
    opts.splice(i, 1);
    this.setData({ opts });
  },
  onOptAdd() {
    if (this.data.locked) return;
    if (this.data.opts.length >= 20) { wx.showToast({ title: '最多 20 个选项', icon: 'none' }); return; }
    this.setData({ opts: this.data.opts.concat(['']) });
  },

  /* ── 保存：重拼整份题目再 PUT 整批 ── */
  onSave() {
    if (this.data.locked || this.data.saving) return;
    const d = this.data;
    const title = String(d.title || '').trim();
    if (!title) { wx.showToast({ title: '题干不能空着', icon: 'none' }); return; }
    const isChoice = d.type === 'single' || d.type === 'multiple';
    let labels = [];
    if (isChoice) {
      labels = d.opts.map((x) => String(x || '').trim());
      if (labels.some((x) => !x)) { wx.showToast({ title: '选项不能空着', icon: 'none' }); return; }
      if (labels.length < 2) { wx.showToast({ title: '选择题至少 2 个选项', icon: 'none' }); return; }
      if (new Set(labels).size !== labels.length) { wx.showToast({ title: '选项不能重复', icon: 'none' }); return; }
    }

    /* 把这一道拼成服务端要的形状；选项按 label 找回原 id（旧答案存的是 id） */
    const oldOpts = (d.i >= 0 && d.questions[d.i] && d.questions[d.i].options) || [];
    const built = {
      id: (d.i >= 0 && d.questions[d.i] && d.questions[d.i].id) || undefined,
      type: d.type,
      title,
      required: !!d.required,
      options: isChoice
        ? labels.map((label) => {
          const hit = oldOpts.find((o) => o.label === label);
          return hit ? { id: hit.id, label } : { label };
        })
        : [],
    };

    const next = d.questions.slice();
    if (d.i >= 0) next[d.i] = built;
    else next.push(built);
    if (next.length > 20) { wx.showToast({ title: '最多 20 题', icon: 'none' }); return; }

    /* 别的题原样带回去（服务端是重建式校验，少一道就是删掉一道） */
    const questions = next.map((x) => ({
      id: x.id || undefined,
      type: x.type,
      title: x.title,
      required: !!x.required,
      options: (x.options || []).map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })),
    }));

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    /* ⚠️ 只提交 questions：发布后 title 锁、时间锁，随手带上会直接报「已锁定」 */
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.batchId)}`, 'PUT', {
      version: d.version,
      questions,
    })
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => this.goBack(), 320);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '批次刚被改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /* ── 删除这道题（新题＝放弃，不出接口） ── */
  onDel() {
    if (this.data.locked) return;
    const d = this.data;
    if (d.i < 0) { this.goBack(); return; }
    wx.showModal({
      title: '删除这道题',
      content: `「${d.questions[d.i] ? d.questions[d.i].title : ''}」删掉后，已报名的人这一题的回答也不再显示。`,
      confirmText: '删掉',
      success: (r) => {
        if (!r.confirm) return;
        const next = d.questions.slice();
        next.splice(d.i, 1);
        const questions = next.map((x) => ({
          id: x.id || undefined,
          type: x.type,
          title: x.title,
          required: !!x.required,
          options: (x.options || []).map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })),
        }));
        this.setData({ saving: true });
        wx.showLoading({ title: '删除中', mask: true });
        adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.batchId)}`, 'PUT', {
          version: d.version,
          questions,
        })
          .then(() => {
            wx.hideLoading();
            this.setData({ saving: false });
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => this.goBack(), 320);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ saving: false });
            if (isVersionConflict(err) || isConflict(err)) { this.load(); return; }
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      },
    });
  },
});
