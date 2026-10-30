const { adminRequest } = require('../../../utils/request');
const vm = require('../view-model');
Page({
  data: {
    ready: false, statusBarHeight: 20, loading: true, loadError: '', busy: false, isSuper: false, myId: 0,
    week: {}, state: 'empty', stateText: '', stateClass: 'none', slotReady: false, summary: { needed: 0, filled: 0, missing: 0, fixed: 0 },
    // 周切换（2026-10-30 新增）：工作台原来只能排「本周」，代录页却能翻到下一周，
    // 结果就是「替下一周代录完，回来点再次生成，一点变化都没有」——两边不是同一周。
    weekText: '', isThisWeek: true,
    slotHint: '', ruleHint: '', availabilityHint: '', preparationError: '', checked: false, checkText: '', issues: [], missing: [],
    sheetOpen: false, candidateLoading: false, candidateError: '', candidates: [], selectedCount: 0, edit: {}, editTitle: '', editTime: '', curText: '空缺', reason: '', fixed: true,
  },

  /** 正在查看的周（空串 = 本周，由云函数按北京时间决定，前端不自己算） */
  _week: '',
  /** 本周周一 —— 用来判断「现在看的是不是本周」 */
  _baseWeek: '',
  onLoad() {
    const app = getApp();
    if (!app.isAdminLoggedIn()) return wx.reLaunch({ url: '/pages-partner/login/login' });
    const info = app.globalData.adminInfo || {};
    if (Number(info.role) === 2) return wx.reLaunch({ url: '/pages-partner/schedule/index/index' });
    this.setData({ ready: true, isSuper: Number(info.role) === 0, myId: Number(info.id) || 0, statusBarHeight: app.globalData.statusBarHeight || 20 });
    this.load();
  },
  onShow() { if (this._loadedOnce && !this.data.loading && !this.data.busy) this.load(); },
  onUnload() { this._gone = true; this._request = (this._request || 0) + 1; },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()); },
  goBack() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: '/pages-partner/schedule/index/index' }); },
  load(opts) {
    if (!this.data.ready) return Promise.resolve();
    // silent = 后台悄悄重拉（发布/撤回之后对齐状态卡用），不把整页切回「正在加载……」
    const silent = !!(opts && opts.silent);
    const request = (this._request || 0) + 1;
    this._request = request;
    const patch = { loadError: '', checked: false, checkText: '', issues: [], missing: [], sheetOpen: false };
    if (!silent) patch.loading = true;
    this.setData(patch);
    // 已发布时段单独拉一份：空态句「时段已发布，可以生成草稿 / 值班时段还没发布」靠它
    const pubReq = adminRequest('/partner/slots/published', 'GET', {})
      .then((d) => ({ ready: !!d.ready, published: d.published || null }))
      .catch(() => ({ ready: false, published: null }));

    return Promise.all([adminRequest('/partner/schedule', 'GET', this._week ? { week: this._week } : {}), pubReq]).then(([week, pub]) => {
      if (this._gone || this._request !== request) return;
      this._slotReady = pub.ready;
      this.applyWeek(week);
      return Promise.allSettled([
        adminRequest('/partner/slots', 'GET', {}), adminRequest('/partner/rules', 'GET', {}),
        adminRequest('/partner/availability', 'GET', { week: week.weekStart }),
      ]).then(([sl, ru, av]) => {
        if (this._gone || this._request !== request) return;
        const slots = sl.status === 'fulfilled' ? sl.value : null;
        // ⚠️ 空态只显示「本周班表尚未生成」一句，**不**铺整周空表（陛下 2026-10-29 定）
        const rules = ru.status === 'fulfilled' ? ru.value.items || [] : [];
        const avail = av.status === 'fulfilled' ? av.value.summary || {} : null;
        // 四行副标题：原句照抄（原型 planning 四行 rows）
        const pubDoc = slots && slots.published;
        const pubAt = pubDoc && pubDoc.publishedAt
          ? String(pubDoc.publishedAt).slice(5, 10).replace('-', '/') + ' ' + String(pubDoc.publishedAt).slice(11, 16)
          : '';
        this.setData({
          slotHint: pubDoc ? `已发布 · ${pubAt} · ${(pubDoc.templates || []).length} 个时段` : '草稿未发布',
          ruleHint: rules.length
            ? `${rules.length} 条规则 · ${rules.map((r) => r.on ? `${r.key === 'day' ? '日' : '周'} ${r.value} 场` : '').filter(Boolean).join(' / ')}`
            : '排班规则',
          availabilityHint: avail ? `${avail.pending || 0} 人未确认 · 可代人填并记原因` : '可排时间',
        });
      });
    }).catch((e) => { if (!this._gone && this._request === request) this.onError(e, true); }).finally(() => { if (!this._gone && this._request === request) { this._loadedOnce = true; this.setData({ loading: false }); } });
  },
  applyWeek(week) {
    const sum = week.summary || { needed: 0, filled: 0, missing: 0, fixed: 0 };
    // 基准周 = 第一次（不带 week）拿到的 weekStart，云函数按北京时间给的周一周
    const ws = week.weekStart || '';
    if (!this._baseWeek && ws) this._baseWeek = ws;
    const isThis = !this._baseWeek || ws === this._baseWeek;
    // 状态条副句：原句照抄（原型 planning stBar 四态）
    const stateSub = week.state === 'published' ? (isThis ? '站员已能看到本周班表' : '站员也能看到这一周（正式版按周发布）')
      : week.state === 'draft' ? (sum.missing ? `还有 ${sum.missing} 个岗位空缺，补齐并校验后才能发布` : '已排齐，校验后可发布')
      : week.state === 'withdrawn' ? (this.data.isSuper ? '等待重新发布 · 历史版本在「发布与调整记录」里' : '等待重新发布')
      : (this._slotReady ? '时段已发布，可以生成草稿' : '值班时段还没发布');
    this.setData({
      slotReady: !!this._slotReady,
      week, state: week.state,
      weekText: ws ? vm.weekRange(ws) : '',
      isThisWeek: isThis,
      stateText: vm.stateLabel(week.state, week.version, false),
      stateClass: week.state === 'published' ? 'published' : (week.state === 'draft' ? 'draft' : (week.state === 'withdrawn' ? 'withdrawn' : 'none')),
      stateSub,
      summary: sum, checked: false, checkText: '', issues: [], missing: [],
    });
  },

  /** 翻周：±1 周，然后整页重拉（草稿/发布/记录全部按 weekStart 走，不用另开通道） */
  shiftWeek(n) {
    if (this.data.busy || this.data.loading) return;
    const from = this._week || this.data.week.weekStart || this._baseWeek;
    if (!from) return;
    this._week = vm.addDays(from, n * 7);
    this.load();
  },
  onPrevWeek() { this.shiftWeek(-1); },
  onNextWeek() { this.shiftWeek(1); },
  onError(e, pageError) {
    if (Number(e.code) === 40101) return wx.reLaunch({ url: '/pages-partner/login/login' });
    const text = e.message || '操作失败，请重试';
    if (pageError) this.setData({ loadError: text });
    else wx.showModal({ title: '操作未完成', content: text, showCancel: false });
    if (!pageError && (Number(e.code) === 40901 || Number(e.code) === 40902 || /刷新|版本|修订/.test(text))) this.load();
  },
  mutate(path, method, extra) {
    // ⚠️⚠️ 这里原来是「busy / loading / loadError → 直接 return null」，**一个字都不提示**。
    //    表现就是「点了再次生成，什么都没发生」：弹窗确认后请求根本没发出去。
    //    加载中（刚 onShow 回来、两条请求还在飞）时最容易撞上，已被陛下当成 bug 报过。
    if (this.data.loadError) {
      wx.showToast({ title: '页面没加载成功，先点「重试」', icon: 'none' });
      return Promise.resolve(null);
    }
    if (this.data.busy || this.data.loading) {
      wx.showToast({ title: '正在加载，稍等一下再点', icon: 'none' });
      return Promise.resolve(null);
    }
    this.setData({ busy: true });
    return adminRequest(path, method, Object.assign({ weekStart: this.data.week.weekStart, revision: this.data.week.revision }, extra || {}))
      .then((r) => { if (r.week) this.applyWeek(r.week); return r; })
      .catch((e) => { this.onError(e, false); return null; })
      .finally(() => this.setData({ busy: false }));
  },
  onGenerate() {
    if (this.data.busy || this.data.state === 'published') return;
    wx.showModal({ title: this.data.state === 'draft' ? '再次生成班表' : '生成班表草稿', content: '按已确认可排时间、岗位资格、请假与场次上限安排。已有固定人选保留，其余岗位重新生成。', confirmText: '生成草稿', success: (r) => {
      if (r.confirm) this.mutate('/partner/schedule/generate', 'PUT', { reason: '按时段与可排时间生成草稿' }).then((result) => { if (result) wx.showToast({ title: '草稿已生成', icon: 'success' }); });
    } });
  },
  async check() {
    const result = await adminRequest('/partner/schedule/check', 'GET', { week: this.data.week.weekStart });
    const issues = (result.issues || []).filter((x) => !x || x.code !== 'MISSING').map((x, i) => ({ key: i, text: typeof x === 'string' ? x : (x.message || x.reason || `${x.day || ''} ${x.slot || ''}：安排不符合条件`) }));
    const missing = (result.missing || []).map((x, i) => ({ key: i, text: typeof x === 'string' ? x : (x.message || `${vm.shortDate(x.day)} ${x.slot || ''} ${x.department || x.dept || ''}：缺 ${x.missing || Math.max(0, (x.need || x.count || 0) - (x.got || 0))} 人`) }));
    const publishable = issues.length === 0 && (result.valid || missing.length > 0);
    this.setData({ checked: true, checkText: !publishable ? '存在冲突，请先调整' : (missing.length ? '硬条件通过，仍有缺岗' : '班表检查通过'), issues, missing });
    return Object.assign({}, result, { valid: publishable });
  },
  onCheck() {
    if (this.data.busy || this.data.loading) return;
    this.setData({ busy: true });
    return this.check().catch((e) => this.onError(e, false)).finally(() => this.setData({ busy: false }));
  },
  async onPublish() {
    if (this.data.busy || this.data.state !== 'draft') return;
    this.setData({ busy: true });
    let check;
    try { check = await this.check(); } catch (e) { this.onError(e, false); }
    this.setData({ busy: false });
    if (!check || !check.valid) return;
    const hasMissing = (check.missing || []).length > 0;
    wx.showModal({ title: hasMissing ? '确认保留缺岗并发布' : '发布本周班表', content: hasMissing ? `仍有 ${check.missing.length} 处缺岗。发布后伙伴能看到空缺位置，后续需补齐安排。` : '发布后全体伙伴将看到这一版正式安排，修改需由超管先撤回。', confirmText: '确认发布', success: (r) => {
      if (r.confirm) this.mutate('/partner/schedule/publish', 'POST', { allowMissing: hasMissing, reason: hasMissing ? '已确认保留缺岗发布' : '检查通过，发布本周班表' }).then((result) => {
        if (!result) return;
        wx.showToast({ title: '班表已发布', icon: 'success' });
        // ⚠️ 发布是「整周状态」变了：状态卡、值班时段行、可排时间汇总都要跟着变。
        //    只 applyWeek 可能留下「大白卡还写草稿未发布」这种前后不一致（陛下 2026-10-30 报过）。
        this.load({ silent: true });
      });
    } });
  },
  onWithdraw() {
    if (!this.data.isSuper || this.data.busy || this.data.state !== 'published') return;
    wx.showModal({ title: '撤回并保留原安排', content: '伙伴端将显示「本周未发布」。所有人选保留为草稿，可在原基础修改后重新发布；旧版本保留记录。', confirmText: '撤回修改', success: (r) => {
      if (r.confirm) this.mutate('/partner/schedule/withdraw', 'POST', { reason: '撤回正式班表，在原安排基础修改' }).then((result) => {
        if (!result) return;
        wx.showToast({ title: '已转为修改草稿', icon: 'success' });
        this.load({ silent: true });   // 同上：状态卡与整页其它提示一起对齐
      });
    } });
  },
  onClear() {
    if (this.data.state === 'published' || this.data.busy) return;
    wx.showModal({ title: '清空草稿人员', content: '清除本周草稿的全部人选（包含固定人选），保留值班时段。此操作不会删除历史版本。', confirmText: '确认清空', confirmColor: '#B42318', success: (r) => { if (r.confirm) this.mutate('/partner/schedule/draft', 'DELETE', { reason: '清空本周草稿人员' }); } });
  },
  onEdit(e) {
    if (this.data.state !== 'draft' || this.data.busy) return;
    const edit = e.detail;
    // 标题照 v151 `.sw-hd`：「周一 10/27 日 · 午间播音」；
    // 副标题里的起止时间也来自格子（view-model 带下来的 timeText）。
    const d = String(edit.day || '');
    const md = (d.length >= 10 ? d.slice(5) : d).replace('-', '/');
    const head = [edit.dayName || '', md ? `${md} 日` : ''].filter(Boolean).join(' ');
    const editTitle = [head, edit.slot || ''].filter(Boolean).join(' · ');
    this.setData({
      sheetOpen: true, edit, editTitle, editTime: edit.time || '',
      reason: '', fixed: true, candidateLoading: true, candidateError: '',
      candidates: [], selectedCount: 0, curText: '空缺',
    });
    this.loadCandidates();
  },
  /** 「当前：陈舟、许桑旋」/「当前：空缺」——选中名单实时跟着候选人变 */
  composeCur() {
    const names = (this.data.candidates || []).filter((p) => p.selected).map((p) => p.name);
    this.setData({ curText: names.length ? names.join('、') : '空缺' });
  },
  loadCandidates() {
    const edit = this.data.edit;
    this.setData({ candidateLoading: true, candidateError: '' });
    return adminRequest('/partner/schedule/candidates', 'GET', { week: this.data.week.weekStart, day: edit.day, slotKey: edit.slotKey })
      .then((r) => {
        const candidates = (r.list || []).map((p) => Object.assign({}, p, { selected: !!p.selected, reasonText: (p.reasons || []).map((s) => typeof s === 'string' ? s : s.message || '').join('；') || (p.eligible ? '时间与资格符合' : '不符合排班条件') }));
        this.setData({ candidates, selectedCount: candidates.filter((p) => p.selected).length });
        this.composeCur();
      }).catch((e) => this.setData({ candidateError: e.message || '候选人加载失败' })).finally(() => this.setData({ candidateLoading: false }));
  },
  onPick(e) {
    const person = this.data.candidates.find((p) => Number(p.personId) === Number(e.currentTarget.dataset.id));
    if (!person || (!person.selected && !person.eligible)) return;
    if (!person.selected && this.data.selectedCount >= Number(this.data.edit.count || 1)) return wx.showToast({ title: '已达到该岗位人数', icon: 'none' });
    const candidates = this.data.candidates.map((p) => p === person ? Object.assign({}, p, { selected: !p.selected }) : p);
    this.setData({ candidates, selectedCount: candidates.filter((p) => p.selected).length });
    this.composeCur();
  },
  onReason(e) { this.setData({ reason: e.detail.value }); },
  /** 「固定当前人员 / 取消固定」按钮（v151 是 .sw-cur 里的按钮，不是 switch） */
  onToggleFixed() { this.setData({ fixed: !this.data.fixed }); },
  onSaveCell() {
    if (this.data.busy || this.data.candidateLoading || this.data.candidateError) return;
    const reason = this.data.reason.trim();
    if (reason.length < 2) return wx.showToast({ title: '请填写调整原因', icon: 'none' });
    const edit = this.data.edit;
    return this.mutate('/partner/schedule/cell', 'PUT', { day: edit.day, slotKey: edit.slotKey, personIds: this.data.candidates.filter((p) => p.selected).map((p) => p.personId), reason, fixed: this.data.fixed }).then((r) => { if (r) { this.setData({ sheetOpen: false }); wx.showToast({ title: '岗位已更新', icon: 'success' }); } });
  },
  closeSheet() { if (!this.data.busy) this.setData({ sheetOpen: false }); },
  stopTap() {},
  goSlots() { wx.navigateTo({ url: '/pages-partner/schedule/slots/slots' }); },
  // 原型社干按钮「查看时段准备情况」：同一页，进去就是只读
  goSlotsRo() { this.goSlots(); },
  goRules() { wx.navigateTo({ url: '/pages-partner/rules/rules' }); },
  // ⚠️ 把「正在看哪一周」和「本周是哪一周」一起带过去：
  //    不传的话代录页永远打开本周，在工作台翻到下一周再点进来又对不上了
  goProxy() {
    const w = (this.data.week && this.data.week.weekStart) || '';
    const b = this._baseWeek || '';
    wx.navigateTo({ url: `/pages-partner/availability/availability?week=${w}&base=${b}` });
  },

  goHistory() { wx.navigateTo({ url: '/pages-partner/schedule/history/history?week=' + this.data.week.weekStart }); },
  goFormal() { wx.reLaunch({ url: '/pages-partner/schedule/index/index' }); },
});
