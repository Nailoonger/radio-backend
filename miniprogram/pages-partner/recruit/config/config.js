// pages-partner/recruit/config · v2（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-config']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 逐条：
//   ① 顶部返回条「‹ 批次管理」+ 右端当前状态。
//   ② 批次信息卡：名称 / 招新介绍 / **报名时间＝一个字段装整段区间**
//      （点开在字段下方原地展开日历：先点开始那天、再点截止那天，区间中间浅蓝连续、
//        两端深蓝；只按天——开始日 00:00 起、截止日 24:00 止，不选时刻）。
//      已发布时名称锁、已开始/已截止时时间锁，锁住的行给一条「新建 ›」的出路。
//   ③ 固定信息：四项各有必填拨杆；年级＝一排胶囊（单选）、班级＝字段下方展开的下拉
//      （单选，每行右侧小叉叉删班，面板底行「＋ 添加班级」）。
//   ④ 自定义问题：**点整行进「问题编辑」页**（题号 / 题干 / 题型+必填+选项数），
//      行右「编辑」「删除」是纯文字（不是胶囊）；「添加问题」是 ghost 按钮。
//   ⑤ 底部「保存配置」。已发布时文案变「保存允许修改的配置」。
//   ⑥ 批次操作（发布报名 / 截止报名 / 生成顺序 / 统一发布录取结果 / 归档批次）
//      按状态位显示 —— v174 里这块 UI 被 v170 从总览页删掉后没接回去，
//      但它必须有个家，就放在这一屏底部（v164/v165 原本就在批次详情页底部）。
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 保存只把「此刻还能改的」放进 body：
//   服务端 updateBatch 用 `F.own(body,'title')` 判断「你有没有提交这个字段」，
//   发布后提交 title/questions 会**直接报错**（不是静默忽略）。所以锁住的整项不出现。
//
// ⚠️⚠️ 选项 id 不能丢：学生答案存的是选项 id。重新拼时按 label 找回原 id，
//   找不到才让服务端新生成 —— 丢 id 等于把旧答案全指空。
//
// ⚠️ 年级 / 班级是**单选**（v168 定）：fixedPick 里是字符串，不是数组。
//   存盘时 options = 选中项 ? [选中项] : []（空＝学生自己填，服务端同口径）。

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
const STATE_CLS = { draft: 'warn', upcoming: 'gray', open: 'ok', closed: 'no' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/* 固定信息的四行；opts 由 buildFixed() 按 key 摊好（WXML 只取值、不取属性） */
const FIXED = [
  { key: 'name', label: '姓名' },
  { key: 'qqNumber', label: 'QQ 号' },
  { key: 'grade', label: '年级', hasOpts: true },
  { key: 'className', label: '班级', hasOpts: true },
];

function pad(n) { return String(n).padStart(2, '0'); }
/** ISO → 'YYYY-MM-DD'（取墙钟，不经 Date，设备时区一变就跳日） */
function dayOf(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function mdOf(day) { return day ? `${day.slice(5, 7)}-${day.slice(8, 10)}` : ''; }
function dayNum(d) { return d.getDate(); }
function cmpDay(a, b) { return String(a).localeCompare(String(b)); }

/** 固定信息行：把该行的候选摊到 opts 上（模板只写 item.opts） */
function buildFixed(fixed, gradeList, classList) {
  return FIXED.map((f) => {
    const row = {
      key: f.key,
      label: f.label,
      hasOpts: !!f.hasOpts,
      required: !fixed || !fixed[f.key] || fixed[f.key].required !== false,
      opts: f.key === 'grade' ? (gradeList || []) : (f.key === 'className' ? (classList || []) : []),
      pick: '',
    };
    return row;
  });
}

/** 日历格子：一整个月的 {d, cls}；cls ∈ '' / 'blank' / 'mid' / 'cap' / 'a' / 'b' / 'solo' */
function monthCells(y, m, a, b) {
  const first = new Date(y, m - 1, 1).getDay();      // 0=周日
  const days = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 0; i < first; i += 1) out.push({ d: '', cls: 'blank' });
  for (let d = 1; d <= days; d += 1) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    let cls = '';
    if (a && b && cmpDay(key, a) >= 0 && cmpDay(key, b) <= 0) {
      const isA = key === a;
      const isB = key === b;
      if (isA && isB) cls = 'cap solo';
      else if (isA) cls = 'cap a';
      else if (isB) cls = 'cap b';
      else cls = 'mid';
    }
    out.push({ d: String(d), cls });
  }
  return out;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    id: '',
    roleKey: '',
    canManage: false,
    /* 状态位 */
    state: 'draft',
    stateText: '',
    stateCls: 'warn',
    archived: false,
    published: false,
    resultPublished: false,
    lockedTitle: false,
    lockedTime: false,
    lockedQuestions: false,
    version: 0,
    /* 批次信息 */
    title: '',
    intro: '',
    openDay: '',
    closeDay: '',
    rangeText: '未设置',
    /* 报名时间区间：open 展开 / y,m 当前月 / a,b 两端（'YYYY-MM-DD'） */
    rng: { open: false, y: 0, m: 0, a: '', b: '' },
    rngWeeks: ['日', '一', '二', '三', '四', '五', '六'],
    cells: [],
    rngMonth: '',
    rngHint: '',
    /* 固定信息 */
    fixedList: buildFixed(null, [], []),
    gradeList: [],
    classList: [],
    clsOpen: false,
    /* 题目 */
    questions: [],
    /* 面试统一安排 */
    itvAt: '',
    itvPlace: '',
    itvNote: '',
    /* 其它 */
    saving: false,
    acting: false,
    orderGenerated: false,
  },

  onLoad(q) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const r = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      id: (q && q.batchId) || '',
      roleKey: partnerRole.roleKeyOf(r),
      canManage: r === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((n) => {
        if (n === 0) this.setData({ canManage: true, roleKey: 'super' });
        else if (partnerRole.known(n)) this.setData({ roleKey: partnerRole.roleKeyOf(n) });
      });
    }
    this.load();
  },

  /* 从「问题编辑」页回来：题目可能改了，重拉一次 */
  onShow() { if (this._ready) this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },
  /* 顶部返回条那一行：回批次管理（不是返回上一页——可能是从总览点进来的） */
  goBatches() {
    const pages = getCurrentPages();
    const prev = pages.length > 1 ? pages[pages.length - 2] : null;
    if (prev && String(prev.route || '').indexOf('recruit/batches') >= 0) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: '/pages-partner/recruit/batches/batches' });
  },
  /* 已发布那条警示条里的「新建 ›」：去批次管理开草稿 */
  goNew() {
    wx.navigateTo({ url: '/pages-partner/recruit/batches/batches?create=1' });
  },

  load() {
    if (!this.data.id) return Promise.resolve();
    this.setData({ loading: !this._ready, err: '' });
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}`, 'GET')
      .then((b) => {
        const fixed = b.fixedFields || {};
        const itv = b.interview || null;
        const openDay = dayOf(b.opensAt);
        const closeDay = dayOf(b.closesAt);
        /* 三个锁位（照 updateBatch 的真实规则，别猜）：
           已发布 → title / questions 锁；已发布且（手动截止 或 已到开始时刻）→ 时间也锁。 */
        const published = !!b.publishedAt;
        const started = b.closedAt !== null
          || (!!b.opensAt && Date.parse(b.opensAt) <= Date.now());
        const gradeList = ((fixed.grade && fixed.grade.options) || []).slice();
        const classList = ((fixed.className && fixed.className.options) || []).slice();
        /* 单选口径：options 里只可能有一个（原型核过的），有就当作已选 */
        const fixedList = buildFixed(fixed, gradeList, classList);
        fixedList.forEach((row) => {
          if (row.key === 'grade') row.pick = gradeList[0] || '';
          if (row.key === 'className') row.pick = classList[0] || '';
        });
        const now = new Date();
        const baseDay = openDay || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(dayNum(now))}`;
        this._ready = true;
        this.setData({
          loading: false,
          version: Number(b.version) || 0,
          archived: !!b.archivedAt,
          published,
          resultPublished: !!b.resultPublishedAt,
          orderGenerated: !!b.orderGeneratedAt,
          lockedTitle: published,
          lockedQuestions: published,
          lockedTime: published && started,
          state: b.windowState,
          stateText: STATE_TEXT[b.windowState] || b.windowState,
          stateCls: STATE_CLS[b.windowState] || 'gray',
          title: b.title || '',
          intro: b.intro || '',
          openDay,
          closeDay,
          rangeText: openDay && closeDay ? `${mdOf(openDay)} — ${mdOf(closeDay)}` : '未设置',
          rng: { open: false, y: Number(baseDay.slice(0, 4)), m: Number(baseDay.slice(5, 7)), a: openDay, b: closeDay },
          gradeList,
          classList,
          fixedList,
          questions: (b.questions || []).map((x, i) => ({
            id: x.id,
            no: pad(i + 1),
            title: x.title,
            type: x.type,
            typeText: TYPE_TEXT[x.type] || x.type,
            required: !!x.required,
            optCount: (x.options || []).length,
            options: x.options || [],
          })),
          itvAt: itv && itv.at ? fmtIso(itv.at) : '',
          itvPlace: (itv && itv.location) || '',
          itvNote: (itv && itv.note) || '',
        });
        this.refreshRng();
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* ══════════ 批次信息 ══════════ */
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onIntro(e) { this.setData({ intro: e.detail.value }); },

  /* ── 报名时间区间：字段下方原地展开日历，先点开始再点结束 ── */
  onRngOpen() {
    if (this.data.lockedTime || !this.data.canManage) {
      if (this.data.lockedTime) wx.showToast({ title: '报名已开始或批次已截止，时间锁定', icon: 'none' });
      return;
    }
    const r = this.data.rng;
    this.setData({ rng: Object.assign({}, r, { open: !r.open }) });
    this.refreshRng();
  },
  onRngClose() {
    const r = this.data.rng;
    this.setData({ rng: Object.assign({}, r, { open: false }) });
  },
  /* 翻月：只在日历内部移动，不动已选的两端 */
  onRngNav(e) {
    const step = Number(e.currentTarget.dataset.step) || 0;
    const r = this.data.rng;
    let m = r.m + step;
    let y = r.y;
    if (m > 12) { m = 1; y += 1; }
    if (m < 1) { m = 12; y -= 1; }
    this.setData({ rng: Object.assign({}, r, { y, m }) });
    this.refreshRng();
  },
  /* 点某一天：第一下定 a（清 b），第二下定 b，第三下重开一段 */
  onRngDay(e) {
    const d = String(e.currentTarget.dataset.d || '');
    if (!d) return;
    const r = this.data.rng;
    const key = `${r.y}-${pad(r.m)}-${pad(Number(d))}`;
    let a = r.a;
    let b = r.b;
    if (a && b) { a = key; b = ''; }               // 已经有整段 → 重新开一段
    else if (a && !b) { if (cmpDay(key, a) < 0) { b = a; a = key; } else b = key; }  // 点早了自动对调
    else { a = key; b = ''; }
    this.setData({ rng: Object.assign({}, r, { a, b }) });
    this.refreshRng();
  },
  onRngClear() {
    const r = this.data.rng;
    this.setData({ rng: Object.assign({}, r, { a: '', b: '' }) });
    this.refreshRng();
  },
  /* 确定：写回 openDay / closeDay（按天，零点起 / 24 点止） */
  onRngOk() {
    const r = this.data.rng;
    if (!r.a || !r.b) { wx.showToast({ title: '先点开始那天，再点截止那天', icon: 'none' }); return; }
    this.setData({
      openDay: r.a,
      closeDay: r.b,
      rangeText: `${mdOf(r.a)} — ${mdOf(r.b)}`,
      rng: Object.assign({}, r, { open: false }),
    });
  },

  /* 重算日历格子 + 那一句提示（模板不做计算，全在 JS 里摊好） */
  refreshRng() {
    const r = this.data.rng;
    if (!r.y || !r.m) return;
    const cells = monthCells(r.y, r.m, r.a, r.b);
    const month = `${r.y} 年 ${r.m} 月`;
    const hint = (r.a && r.b)
      ? `${mdOf(r.a)} 00:00 起 — ${mdOf(r.b)} 24:00 止`
      : '点开始那天，再点截止那天；当天零点起、截止日 24 点止';
    this.setData({ cells, rngMonth: month, rngHint: hint });
  },

  /* ══════════ 固定信息 ══════════ */
  /* 必填拨杆：<view> 自己画的开关，点一下翻（v174 是 button.sw，小程序里用 view 更稳） */
  onReqToggle(e) {
    if (!this.data.canManage || this.data.published) {
      if (this.data.published) wx.showToast({ title: '已发布批次固定信息锁定', icon: 'none' });
      return;
    }
    const key = e.currentTarget.dataset.key;
    const list = this.data.fixedList.map((x) => (x.key === key ? Object.assign({}, x, { required: !x.required }) : x));
    this.setData({ fixedList: list });
  },
  /* 年级胶囊：单选，再点已选的那个＝取消（学生自己填） */
  onGradePick(e) {
    if (!this.data.canManage || this.data.published) { if (this.data.published) wx.showToast({ title: '已发布批次固定信息锁定', icon: 'none' }); return; }
    const v = e.currentTarget.dataset.v;
    const cur = this.data.gradeList[0] || '';
    const next = cur === v ? '' : v;
    const gradeList = next ? [next] : [];
    const fixedList = this.data.fixedList.map((x) => (x.key === 'grade' ? Object.assign({}, x, { pick: next, opts: gradeList }) : x));
    this.setData({ gradeList, fixedList });
  },
  /* 班级下拉：开 / 关 */
  onClsOpen() {
    if (!this.data.canManage || this.data.published) { if (this.data.published) wx.showToast({ title: '已发布批次固定信息锁定', icon: 'none' }); return; }
    this.setData({ clsOpen: !this.data.clsOpen });
  },
  /* 选一个班：回填并收起（不能把「全部候选」当选项存 —— 只能选一个） */
  onClsPick(e) {
    const v = e.currentTarget.dataset.v;
    const fixedList = this.data.fixedList.map((x) => (x.key === 'className' ? Object.assign({}, x, { pick: v, opts: [v] }) : x));
    this.setData({ classList: [v], fixedList, clsOpen: false });
  },
  /* 行右侧小叉叉：把这个班从候选里删掉；删的正好是选中的就顺手清掉选择 */
  onClsDel(e) {
    if (!this.data.canManage || this.data.published) return;
    const v = e.currentTarget.dataset.v;
    const pool = this.data.classList;
    if (pool.length <= 1) { wx.showToast({ title: '至少留一个班', icon: 'none' }); return; }
    const next = pool.filter((x) => x !== v);
    const cur = this.data.fixedList.find((x) => x.key === 'className').pick;
    const pick = cur === v ? '' : cur;
    const fixedList = this.data.fixedList.map((x) => (x.key === 'className'
      ? Object.assign({}, x, { pick, opts: pick ? [pick] : next }) : x));
    this.setData({ classList: next, fixedList });
  },
  /* ＋ 添加班级：编号按「现有最大号 + 1」（删过班以后按个数会重复） */
  onClsAdd() {
    if (!this.data.canManage || this.data.published) return;
    wx.showModal({
      title: '添加班级',
      editable: true,
      placeholderText: '例如：16班',
      success: (r) => {
        if (!r.confirm) return;
        const v = String(r.content || '').trim();
        if (!v) return;
        if (this.data.classList.indexOf(v) >= 0) { wx.showToast({ title: '已经有这个班了', icon: 'none' }); return; }
        this.setData({ classList: this.data.classList.concat([v]) });
      },
    });
  },
  /* 添加年级：候选池就是服务端默认那两项，允许加（超管自定） */
  onGradeAdd() {
    if (!this.data.canManage || this.data.published) return;
    wx.showModal({
      title: '添加年级',
      editable: true,
      placeholderText: '例如：高二',
      success: (r) => {
        if (!r.confirm) return;
        const v = String(r.content || '').trim();
        if (!v) return;
        if (this.data.gradeList.indexOf(v) >= 0) { wx.showToast({ title: '已经有这个年级了', icon: 'none' }); return; }
        const list = this.data.gradeList.concat([v]);
        const fixedList = this.data.fixedList.map((x) => (x.key === 'grade' ? Object.assign({}, x, { opts: list }) : x));
        this.setData({ gradeList: list, fixedList });
      },
    });
  },

  /* ══════════ 题目 ══════════ */
  onQNew() {
    if (!this.data.canManage) return;
    if (this.data.lockedQuestions) {
      wx.showToast({ title: '已发布：题目结构锁定，先新建一份草稿', icon: 'none' });
      return;
    }
    if (this.data.questions.length >= 20) { wx.showToast({ title: '最多 20 题', icon: 'none' }); return; }
    wx.navigateTo({ url: `/pages-partner/recruit/q/q?batchId=${this.data.id}&i=-1` });
  },
  onQEdit(e) {
    const i = Number(e.currentTarget.dataset.i);
    this._qIndex = i;
    wx.navigateTo({ url: `/pages-partner/recruit/q/q?batchId=${this.data.id}&i=${i}` });
  },
  /* 行右「删除」：纯文字红字，锁定后点了给提示 */
  onQDel(e) {
    if (!this.data.canManage) return;
    if (this.data.lockedQuestions) { wx.showToast({ title: '已发布：题目结构锁定', icon: 'none' }); return; }
    const i = Number(e.currentTarget.dataset.i);
    const q = this.data.questions[i];
    if (!q) return;
    wx.showModal({
      title: '删掉这道题',
      content: `「${q.title}」删掉后，已报名的人这一题的回答也不再显示。要保存才生效。`,
      confirmText: '删掉',
      success: (r) => {
        if (!r.confirm) return;
        const next = this.data.questions.slice();
        next.splice(i, 1);
        /* 重新编号 */
        next.forEach((x, k) => { x.no = pad(k + 1); });
        this.setData({ questions: next });
      },
    });
  },

  /* ══════════ 保存 ══════════ */
  onSave() {
    if (!this.data.canManage || this.data.saving) return;
    const d = this.data;
    if (!String(d.title || '').trim()) { wx.showToast({ title: '批次名称不能空', icon: 'none' }); return; }
    if (!d.openDay || !d.closeDay) { wx.showToast({ title: '要选报名开始日与截止日', icon: 'none' }); return; }
    if (cmpDay(d.openDay, d.closeDay) > 0) { wx.showToast({ title: '截止日不能早于开始日', icon: 'none' }); return; }
    const pickOf = (k) => (d.fixedList.find((x) => x.key === k) || {}).pick || '';
    const reqOf = (k) => !!(d.fixedList.find((x) => x.key === k) || {}).required;

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    /* 锁住的那几项**整个不出现**在 body 里（服务端按「有没有提交」判断） */
    const body = {
      version: d.version,
      intro: d.intro,
      fixedFields: {
        name: { required: reqOf('name'), options: [] },
        qqNumber: { required: reqOf('qqNumber'), options: [] },
        grade: { required: reqOf('grade'), options: pickOf('grade') ? [pickOf('grade')] : [] },
        className: { required: reqOf('className'), options: pickOf('className') ? [pickOf('className')] : [] },
      },
    };
    if (!d.lockedTitle) body.title = d.title.trim();
    if (!d.lockedTime) {
      body.opensAt = `${d.openDay}T00:00:00+08:00`;
      body.closesAt = `${d.closeDay}T23:59:59+08:00`;
    }
    if (!d.lockedQuestions) {
      body.questions = d.questions.map((x) => ({
        id: x.id || undefined,
        type: x.type,
        title: x.title,
        required: !!x.required,
        options: (x.options || []).map((o) => (o.id ? { id: o.id, label: o.label } : { label: o.label })),
      }));
    }
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.id)}`, 'PUT', body)
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: '已保存', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /* ══════════ 批次操作（超管）══════════ */
  /* 统一出口：成功后写回 version 再重拉；40910/40901 都重拉 */
  act(url, body, okText) {
    if (this.data.acting) return;
    this.setData({ acting: true });
    wx.showLoading({ title: '处理中', mask: true });
    return adminRequest(url, 'POST', body)
      .then(() => {
        wx.hideLoading();
        this.setData({ acting: false });
        wx.showToast({ title: okText, icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ acting: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '批次刚被改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  onPublish() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '发布报名',
      content: `发布「${this.data.title}」？发布后开始按报名时间收报名，题目和名称随之锁定。`,
      confirmText: '发布',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/publish`, { version: this.data.version }, '已发布'); },
    });
  },
  onClose() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '提前截止报名',
      content: '提前结束收报名？到期会自动截止，这里手动截止后就不能再改报名时间了。',
      confirmText: '截止',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/close`, { version: this.data.version }, '已截止'); },
    });
  },
  onResults() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '统一发布录取结果',
      content: '发布后报名者凭查询码可见自己的结果。还有没决定的人会拦住发布。',
      confirmText: '发布结果',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/results`, { version: this.data.version }, '结果已发布'); },
    });
  },
  onArchive() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '归档批次',
      content: '归档后整批只读：名字、题目、报名记录都不能再改，只能看。',
      confirmText: '归档',
      success: (r) => { if (r.confirm) this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/archive`, { version: this.data.version }, '已归档'); },
    });
  },
  /* 生成随机面试顺序：v174 把这一个动作留在「面试安排」页，这里放一份同样的入口 */
  onGenerate() {
    if (!this.data.canManage) return;
    const regen = this.data.orderGenerated;
    wx.showModal({
      title: regen ? '覆盖面试顺序' : '生成随机面试顺序',
      content: regen
        ? '重新生成会整份替换已保存的顺序和面试序号，请在确认后改用新名单。已撤回、拟不录取的报名会排除。'
        : '把全部有效报名洗牌后保存，序号固定不变。已撤回、拟不录取的报名会排除。',
      confirmText: regen ? '覆盖并重新生成' : '确认生成',
      success: (r) => {
        if (!r.confirm) return;
        const body = { version: this.data.version };
        if (regen) body.confirm = 'REGENERATE';
        this.act(`/admin/recruitment/batches/${encodeURIComponent(this.data.id)}/interview-order`, body, '顺序已生成');
      },
    });
  },

  /* ══════════ 面试统一安排（超管可改，社干只读）═════════ */
  onItvOpen() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: this.data.itvAt ? '改统一面试安排' : '设统一面试安排',
      editable: true,
      placeholderText: '时间写「11-04 16:30」；地点在下一屏改',
      success: (r) => {
        if (!r.confirm) return;
        const v = String(r.content || '').trim();
        if (!v) return;
        /* 只在本地留一份草稿，跟其它字段一起保存 */
        this.setData({ itvAt: v });
      },
    });
  },
});
