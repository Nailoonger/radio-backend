// pages-partner/recruit/config · v1（2026-11-14 批次配置）
//
// 一个批次的全部可改项：名称 / 介绍 / 报名时间 / 固定信息 / 自定义问题 / 批次级面试统一安排，
// 外加四个生命周期动作（发布 · 截止 · 发布录取结果 · 归档）。
//
// ⚠️⚠️ 保存必须**全量**回传：服务端 `F.batch()` 是「没传就当空」的重建式校验，
//    只传改动的那一项会把其余字段清掉（名称变空、题目全没）。所以 save() 永远拼完整对象。
//
// ⚠️⚠️ 选项 id 不能丢：服务端给现有选项各有一个 id，学生答案存的就是这个 id。
//    重新拼选项时按 label 找回原 id，找不到才让服务端新生成 —— 丢了 id 等于把旧答案全指空。
//
// ⚠️ 时间口径：报名 `开始日 00:00 开、截止日 24 点关`。存 `T00:00:00+08:00` / `T23:59:59+08:00`，
//    截止不存次日 00:00（那会让每一处显示都多一天）。显示时只取墙钟日期，不做时区换算。
//
// ⚠️ 四个动作都要 `version`（乐观锁）：**每次成功都要用返回的 version 覆盖本地**，
//    否则第二次点必然 40901。40901 一律重拉，不能只弹 toast。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const TYPE_LIST = [
  { key: 'text', label: '单行' },
  { key: 'textarea', label: '多行' },
  { key: 'single', label: '单选' },
  { key: 'multiple', label: '多选' },
];
const TYPE_TEXT = { text: '单行', textarea: '多行', single: '单选', multiple: '多选' };
const STATE_TEXT = { draft: '草稿', upcoming: '未开始', open: '报名中', closed: '已截止' };
const FIXED = [
  { key: 'name', label: '姓名' },
  { key: 'qqNumber', label: 'QQ 号' },
  { key: 'grade', label: '年级', options: true },
  { key: 'className', label: '班级', options: true },
];

function pad(n) { return String(n).padStart(2, '0'); }
/* ISO -> 'YYYY-MM-DD'：取字符串里的墙钟日期，别用 Date（设备时区一变就跳日） */
function dayOf(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function shortDay(iso) {
  const s = fmtIso(iso);
  return s ? s.slice(0, 5) : '';
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    id: '',
    canManage: false,
    state: 'draft',
    stateText: '',
    archived: false,
    published: false,
    resultPublished: false,
    lockedTitle: false,
    lockedQuestions: false,
    lockedTime: false,
    version: 0,
    title: '',
    intro: '',
    openDay: '',
    closeDay: '',
    fixed: {},
    fixedList: FIXED,
    gradeOpts: [],
    classOpts: [],
    questions: [],
    /* 批次级统一面试安排 */
    itvAt: '',
    itvDate: '',
    itvTime: '',
    itvPlace: '',
    itvNote: '',
    /* 问题编辑弹层 */
    qSheet: false,
    qEdit: -1,
    qTitle: '',
    qType: 'textarea',
    qReq: false,
    qOpts: '',
    types: TYPE_LIST,
    saving: false,
    acting: false,
  },

  onLoad(q) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const roleNum = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      id: (q && q.batchId) || '',
      canManage: roleNum === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((r) => {
        if (r === 0 && !this.data.canManage) this.setData({ canManage: true });
      });
    }
    this.load();
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  load() {
    if (!this.data.id) return Promise.resolve();
    this.setData({ loading: true, err: '' });
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}`, 'GET')
      .then((b) => {
        const fixed = b.fixedFields || {};
        const itv = b.interview || null;
        const at = itv && itv.at ? fmtIso(itv.at) : '';
        const year = new Date().getFullYear();
        /* 三个锁位（服务端 updateBatch 的真实规则，别看 UI 猜）：
           · 发布后：title / questions 一律不许再提交（提交即报错，不是静默忽略）
           · 发布后且「已手动截止 或 已到开始时间」：时间也不许再提交
           · 归档后：整份都改不了 */
        const published = !!b.publishedAt;
        const started = b.closedAt !== null || (!!b.opensAt && Date.parse(b.opensAt) <= Date.now());
        this.setData({
          loading: false,
          version: Number(b.version) || 0,
          archived: !!b.archivedAt,
          resultPublished: !!b.resultPublishedAt,
          published,
          lockedTitle: published,
          lockedQuestions: published,
          lockedTime: published && started,
          state: b.windowState,
          stateText: STATE_TEXT[b.windowState] || b.windowState,
          title: b.title || '',
          intro: b.intro || '',
          openDay: dayOf(b.opensAt),
          closeDay: dayOf(b.closesAt),
          fixed: {
            name: !fixed.name || fixed.name.required !== false,
            qqNumber: !fixed.qqNumber || fixed.qqNumber.required !== false,
            grade: !fixed.grade || fixed.grade.required !== false,
            className: !fixed.className || fixed.className.required !== false,
          },
          gradeOpts: ((fixed.grade && fixed.grade.options) || []).map((x) => ({ id: x.id, label: x.label })),
          classOpts: ((fixed.className && fixed.className.options) || []).map((x) => ({ id: x.id, label: x.label })),
          questions: (b.questions || []).map((x) => ({
            id: x.id, type: x.type, title: x.title, required: !!x.required,
            typeText: TYPE_TEXT[x.type] || x.type,
            optionText: (x.options || []).map((o) => o.label).join(' / '),
            options: x.options || [],
          })),
          itvAt: at,
          itvDate: at ? `${year}-${at.slice(0, 5)}` : '',
          itvTime: at ? at.slice(6, 11) : '',
          itvPlace: (itv && itv.location) || '',
          itvNote: (itv && itv.note) || '',
        });
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* ── 基本信息 ── */
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onIntro(e) { this.setData({ intro: e.detail.value }); },
  onOpenDay(e) { this.setData({ openDay: e.detail.value }); },
  onCloseDay(e) { this.setData({ closeDay: e.detail.value }); },
  onReq(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ ['fixed.' + key]: !!e.detail.value });
  },

  /* 年级 / 班级选项：点叉删，点「+ 添加」输一个（原生可输入弹窗，省一层自制层） */
  onOptDel(e) {
    if (!this.data.canManage) return;
    const { key, label } = e.currentTarget.dataset;
    const prop = key === 'grade' ? 'gradeOpts' : 'classOpts';
    const next = this.data[prop].filter((x) => x.label !== label);
    this.setData({ [prop]: next });
  },
  onOptAdd(e) {
    if (!this.data.canManage) return;
    const key = e.currentTarget.dataset.key;
    const prop = key === 'grade' ? 'gradeOpts' : 'classOpts';
    wx.showModal({
      title: key === 'grade' ? '添加年级选项' : '添加班级选项',
      editable: true,
      placeholderText: key === 'grade' ? '例如：高二' : '例如：16班',
      success: (r) => {
        if (!r.confirm) return;
        const label = String(r.content || '').trim();
        if (!label) return;
        const list = this.data[prop];
        if (list.some((x) => x.label === label)) { wx.showToast({ title: '已经有这个选项了', icon: 'none' }); return; }
        if (list.length >= 50) { wx.showToast({ title: '最多 50 个选项', icon: 'none' }); return; }
        this.setData({ [prop]: list.concat([{ id: '', label }]) });   // id 留空＝保存时让服务端生成
      },
    });
  },

  /* ── 保存 ── */
  save() {
    if (!this.data.canManage || this.data.saving) return Promise.resolve(false);
    const d = this.data;
    if (!String(d.title || '').trim()) { wx.showToast({ title: '批次名称不能空', icon: 'none' }); return Promise.resolve(false); }
    if (!d.openDay || !d.closeDay) { wx.showToast({ title: '要选报名开始日与截止日', icon: 'none' }); return Promise.resolve(false); }
    if (d.openDay >= d.closeDay) { wx.showToast({ title: '截止日要晚于开始日', icon: 'none' }); return Promise.resolve(false); }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    /* ⚠️⚠️ 只把「此刻还能改的」放进 body：
       服务端用 `F.own(body, 'title')` 判断"你有没有提交这个字段"，
       发布后提交 title/questions 会直接报「已锁定」，而不是悄悄忽略。
       所以锁住的那几项**必须整个不出现**在 body 里。 */
    const body = {
      version: d.version,
      intro: d.intro,
      fixedFields: {
        name: { required: !!d.fixed.name, options: [] },
        qqNumber: { required: !!d.fixed.qqNumber, options: [] },
        grade: { required: !!d.fixed.grade, options: d.gradeOpts.map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })) },
        className: { required: !!d.fixed.className, options: d.classOpts.map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })) },
      },
    };
    if (!d.lockedTitle) body.title = d.title.trim();
    if (!d.lockedTime) {
      body.opensAt = `${d.openDay}T00:00:00+08:00`;
      body.closesAt = `${d.closeDay}T23:59:59+08:00`;
    }
    if (!d.lockedQuestions) {
      body.questions = d.questions.map((x) => ({
        id: x.id, type: x.type, title: x.title, required: !!x.required,
        options: (x.options || []).map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })),
      }));
    }
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.id)}`, 'PUT', body)
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        this.load();
        return true;
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        /* ⚠️ 招新的版本冲突是 40910（不是通用 40901），两个都得认 */
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return false;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
        return false;
      });
  },
  onSave() { this.save(); },

  /* ── 问题 ── */
  onQAdd() {
    if (!this.data.canManage) return;
    if (this.data.lockedQuestions) { wx.showToast({ title: '已发布：题目结构锁定', icon: 'none' }); return; }
    if (this.data.questions.length >= 20) { wx.showToast({ title: '最多 20 题', icon: 'none' }); return; }
    this.setData({ qSheet: true, qEdit: -1, qTitle: '', qType: 'textarea', qReq: false, qOpts: '' });
  },
  onQEdit(e) {
    if (!this.data.canManage) return;
    if (this.data.lockedQuestions) { wx.showToast({ title: '已发布：题目结构锁定', icon: 'none' }); return; }
    const i = Number(e.currentTarget.dataset.i);
    const q = this.data.questions[i];
    if (!q) return;
    this.setData({
      qSheet: true, qEdit: i, qTitle: q.title, qType: q.type, qReq: !!q.required,
      qOpts: (q.options || []).map((o) => o.label).join('\n'),
    });
  },
  onQDel(e) {
    if (!this.data.canManage) return;
    if (this.data.lockedQuestions) { wx.showToast({ title: '已发布：题目结构锁定', icon: 'none' }); return; }
    const i = Number(e.currentTarget.dataset.i);
    const q = this.data.questions[i];
    if (!q) return;
    wx.showModal({
      title: '删掉这道题',
      content: `「${q.title}」删掉后，已报名的人这一题的回答也不会再显示。`,
      confirmText: '删掉',
      success: (r) => {
        if (!r.confirm) return;
        const next = this.data.questions.slice();
        next.splice(i, 1);
        this.setData({ questions: next });
      },
    });
  },
  onQClose() { this.setData({ qSheet: false }); },
  onQTitle(e) { this.setData({ qTitle: e.detail.value }); },
  onQType(e) { this.setData({ qType: e.currentTarget.dataset.t }); },
  onQReq(e) { this.setData({ qReq: !!e.detail.value }); },
  onQOpts(e) { this.setData({ qOpts: e.detail.value }); },

  onQOk() {
    const d = this.data;
    const title = String(d.qTitle || '').trim();
    if (!title) { wx.showToast({ title: '题干不能空着', icon: 'none' }); return; }
    const isChoice = d.qType === 'single' || d.qType === 'multiple';
    let options = [];
    if (isChoice) {
      const labels = String(d.qOpts || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (labels.length < 2) { wx.showToast({ title: '选择题至少 2 个选项', icon: 'none' }); return; }
      if (labels.length > 20) { wx.showToast({ title: '最多 20 个选项', icon: 'none' }); return; }
      /* ⚠️ 按 label 找回原 id：旧答案存的是 id，丢了就等于把回答指空 */
      const old = (d.qEdit >= 0 && d.questions[d.qEdit] && d.questions[d.qEdit].options) || [];
      options = labels.map((label) => {
        const hit = old.find((o) => o.label === label);
        return hit ? { id: hit.id, label } : { label };
      });
    }
    const item = {
      id: (d.qEdit >= 0 && d.questions[d.qEdit] && d.questions[d.qEdit].id) || '',
      type: d.qType, title, required: !!d.qReq,
      typeText: TYPE_TEXT[d.qType] || d.qType,
      optionText: options.map((o) => o.label).join(' / '),
      options,
    };
    const next = d.questions.slice();
    if (d.qEdit >= 0) next[d.qEdit] = item; else next.push(item);
    this.setData({ questions: next, qSheet: false });
  },

  /* ── 批次级面试统一安排 ── */
  onItvDate(e) { this.setData({ itvDate: e.detail.value }); },
  onItvTime(e) { this.setData({ itvTime: e.detail.value }); },
  onItvPlace(e) { this.setData({ itvPlace: e.detail.value }); },
  onItvNote(e) { this.setData({ itvNote: e.detail.value }); },

  onSaveItv() {
    if (!this.data.canManage || this.data.acting) return;
    const d = this.data;
    if (!d.itvDate || !d.itvTime) { wx.showToast({ title: '先选面试日期和时刻', icon: 'none' }); return; }
    this.act(`/admin/recruitment/batches/${encodeURIComponent(d.id)}/interview`, 'PUT', {
      version: d.version,
      at: `${d.itvDate}T${d.itvTime}:00+08:00`,
      location: d.itvPlace,
      note: d.itvNote,
    }, '统一安排已保存');
  },
  onClearItv() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '清掉统一安排',
      content: '清掉后，没单独配置过的报名都变回「未安排面试」。',
      confirmText: '清掉',
      success: (r) => {
        if (!r.confirm) return;
        this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/interview`, 'PUT',
          { version: this.data.version, at: null }, '已清掉');
      },
    });
  },

  /* ── 四个生命周期动作 ── */
  onPublish() {
    const d = this.data;
    if (!d.canManage) return;
    if (!d.openDay || !d.closeDay) { wx.showToast({ title: '先设报名时间再发布', icon: 'none' }); return; }
    wx.showModal({
      title: '发布这个批次',
      content: '发布后学生就能看到并报名；名称与题目锁定，报名开始后时间也锁定。',
      confirmText: '发布',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(d.id)}/publish`, 'POST', { version: d.version }, '已发布'); },
    });
  },
  onClose() {
    const d = this.data;
    wx.showModal({
      title: '提前截止报名',
      content: '截止后不再收新报名，才能开始审核和安排面试。',
      confirmText: '截止',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(d.id)}/close`, 'POST', { version: d.version }, '已截止'); },
    });
  },
  onResults() {
    const d = this.data;
    wx.showModal({
      title: '发布录取结果',
      content: '发布后学生凭查询码就能看到自己的结果；再改要走归档流程。',
      confirmText: '发布',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(d.id)}/results`, 'POST', { version: d.version }, '结果已发布'); },
    });
  },
  onArchive() {
    const d = this.data;
    wx.showModal({
      title: '归档这个批次',
      content: '归档后整份批次只读，报名与题目都不能再改。',
      confirmText: '归档',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(d.id)}/archive`, 'POST', { version: d.version }, '已归档'); },
    });
  },

  /* 动作统一出口：成功 → 用返回的 version 覆盖并重拉；40901 → 重拉 */
  act(url, method, body, okText) {
    this.setData({ acting: true });
    wx.showLoading({ title: '处理中', mask: true });
    return adminRequest(url, method, body)
      .then((b) => {
        wx.hideLoading();
        this.setData({ acting: false });
        if (b && b.version) this.setData({ version: Number(b.version) });
        wx.showToast({ title: okText, icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ acting: false });
        /* ⚠️ 招新的版本冲突是 40910（不是通用 40901），两个都得认 */
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },
});
