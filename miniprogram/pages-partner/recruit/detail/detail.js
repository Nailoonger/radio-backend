// pages-partner/recruit/detail · v2（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-detail']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 这一屏（从报名列表点「去审核」进来）：
//   ① 返回条「‹ 报名列表」+ 队列导航「‹ 上一条 / 第 N / M 条待审 / 下一条 ›」
//   ② 报名人卡：姓名（首字头像）+ 年级班级 · 提交时间 + 右侧「新生报名」角标，
//      下段三格：QQ 号 / **面试序号** / **面试时间**（hairline 分隔）
//   ③ 报名内容：姓名 / QQ 号 / 年级班级 + 每道自定义题的题干与完整回答（不截断）
//   ④ 内部备注（学生看不到）
//   ⑤ 结果说明（统一发布后报名者可见）
//   ⑥ 处理结果＝三个分开的胶囊：安排面试 / 拟录取 / 拟不录取
//   ⑦ 撤销已拟定的结果
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️⚠️ 三个动作走两个接口，别混：
//   · 录取决定 + 内部备注 + 对外说明 → `PUT …/applications/:id/review`
//   · 面试时间                        → `PUT …/applications/:id/interview`
//   两个都要 `version`；成功必须重拉（写回 version），否则第二次保存必 40910。
//
// ⚠️ 服务端硬规则（前端只把话说清楚，不自造规则）：
//   · 只有「报名截止后」才能审核 / 安排面试
//   · 拟录取之前**必须先有面试安排**（批次统一安排或个人单独安排）
//   · 已撤回的报名不可审核
//
// ⚠️ 队列导航只收「待审核」（submitted）那一批的 id：
//   服务端没有「取下一条」的接口，前端拿一次 id 列表自己走。列表页数上限 100。
//
// ⚠️ 冲突码是 40910（招新专用），不是通用 40901。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const STATUS_TEXT = {
  submitted: '待审核', interview: '待面试', accepted: '拟录取', rejected: '拟不录取', withdrawn: '已撤回',
};
const STATUS_CLS = { submitted: 'warn', interview: 'ok', accepted: 'done', rejected: 'no', withdrawn: 'gray' };

function pad(n) { return String(n).padStart(2, '0'); }

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    id: '',
    batchId: '',
    version: 0,
    canReview: false,
    a: null,
    fixedRows: [],
    answers: [],
    /* 队列 */
    queue: [],
    queueAt: -1,
    queuePos: '',       // 「第 3 / 12 条待审」；不在队列里时留空
    hasQueue: false,
    /* 面试 */
    itvAt: '',          // 'MM-DD HH:mm'（服务端生效值）
    itvPlace: '',
    itvNote: '',
    itvCustom: false,
    atDate: '',
    atTime: '',
    atPlace: '',
    atNote: '',
    /* 备注 */
    internalNote: '',
    publicNote: '',
    /* 状态 */
    saving: false,
    savingItv: false,
    now: '',
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
      id: (q && q.id) || '',
      batchId: (q && q.batchId) || '',
      /* 社干与超管都能审（服务端 asAdmin）；站员不该进来 */
      canReview: r === 0 || r === 1,
    });
    partnerRole.ensure();
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
        const batch = (d && d.batch) || {};
        const qs = batch.questions || [];
        /* answers 的 key 是问题 id —— 用批次题目表映射成「题干 / 答案」，
           映射不到的（题被删了）不渲染，别把随机 id 摆给老师看。 */
        const answers = [];
        qs.forEach((q, i) => {
          const raw = (d.answers || {})[q.id];
          if (raw === undefined || raw === null || raw === '') return;
          let val = raw;
          if (q.type === 'single' || q.type === 'multiple') {
            const label = (id) => {
              const o = (q.options || []).find((x) => x.id === id);
              return o ? o.label : '';
            };
            val = Array.isArray(raw) ? raw.map(label).filter(Boolean).join('、') : label(raw);
          }
          answers.push({ key: q.id, no: pad(i + 1), title: q.title, val: String(val) });
        });
        const itv = d.interview || null;
        const at = itv && itv.at ? fmtIso(itv.at) : '';
        const seq = d.interviewSequence;
        this._ready = true;
        this.setData({
          loading: false,
          batchId: d.batchId || this.data.batchId,
          version: Number(d.version) || 0,
          a: {
            id: d.id,
            initial: String(d.name || '?').charAt(0),
            name: d.name || '',
            grade: d.grade || '',
            className: d.className || '',
            qq: d.qqNumber || '',
            status: d.status,
            statusText: STATUS_TEXT[d.status] || d.status,
            statusCls: STATUS_CLS[d.status] || 'gray',
            created: fmtIso(d.createdAt),
            updated: fmtIso(d.updatedAt),
            seq: seq ? pad(seq) : '',
            seqText: seq ? pad(seq) : '未生成',
            atText: at ? at.replace(/^\d{2}-/, '') : '未安排',
            legacy: d.legacyStudentNo || '',
            decided: d.decision || '',
            batchTitle: batch.title || '',
            orderGenerated: !!batch.orderGeneratedAt,
            batchItv: !!(batch.interview && batch.interview.at),
          },
          fixedRows: [
            { k: '姓名', v: d.name || '' },
            { k: 'QQ 号', v: d.qqNumber || '—' },
            { k: '年级班级', v: `${d.grade || ''}${d.className ? ' · ' + d.className : ''}` },
          ],
          answers,
          itvAt: at,
          itvPlace: (itv && itv.location) || '',
          itvNote: (itv && itv.note) || '',
          itvCustom: !!d.interviewCustom,
          atPlace: (itv && itv.location) || '',
          atNote: (itv && itv.note) || '',
          internalNote: d.internalNote || '',
          publicNote: d.publicNote || '',
        });
        this.splitAt(at);
        this.loadQueue();
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* 队列：拉一次「待审核」的 id 列表，算出我在第几条 */
  loadQueue() {
    const batchId = this.data.batchId;
    if (!batchId) return Promise.resolve();
    return adminRequest(`/admin/recruitment/applications?batchId=${encodeURIComponent(batchId)}`
      + '&status=submitted&page=1&pageSize=100', 'GET')
      .then((p) => {
        const queue = ((p && p.items) || []).map((x) => x.id);
        const at = queue.indexOf(this.data.id);
        this.setData({
          queue,
          queueAt: at,
          hasQueue: at >= 0,
          /* ⚠️ indexOf 找不到是 -1：直接拿它 +1 会写出「第 0 / N 条」，
             所以先算好一句文案，模板只取值 */
          queuePos: at >= 0 ? `第 ${at + 1} / ${queue.length} 条待审` : '',
        });
      })
      .catch(() => { this.setData({ queue: [], queueAt: -1, hasQueue: false, queuePos: '' }); });
  },

  /* 面试时刻拆两截给 picker：'MM-DD HH:mm' → 'YYYY-MM-DD' + 'HH:mm'
     ⚠️ 补年份用当前年；直接取字符串，不经 Date 换算（跨时区设备才不歪） */
  splitAt(at) {
    if (!at) { this.setData({ atDate: '', atTime: '' }); return; }
    const y = new Date().getFullYear();
    this.setData({ atDate: `${y}-${String(at).slice(0, 5)}`, atTime: String(at).slice(6, 11) });
  },

  onPrev() {
    const i = this.data.queueAt - 1;
    if (i < 0) return;
    this.jump(this.data.queue[i]);
  },
  onNext() {
    const i = this.data.queueAt + 1;
    if (i >= this.data.queue.length) return;
    this.jump(this.data.queue[i]);
  },
  jump(id) {
    if (!id) return;
    this._ready = false;
    this.setData({ id, a: null, loading: true });
    this.load();
  },

  /* ── 备注 / 面试输入 ── */
  onIn(e) { this.setData({ internalNote: e.detail.value }); },
  onPub(e) { this.setData({ publicNote: e.detail.value }); },
  onPlace(e) { this.setData({ atPlace: e.detail.value }); },
  onNote(e) { this.setData({ atNote: e.detail.value }); },
  onDate(e) { this.setData({ atDate: e.detail.value }); },
  onTime(e) { this.setData({ atTime: e.detail.value }); },

  /* ── 录取决定：三颗胶囊（安排面试 / 拟录取 / 拟不录取）── */
  onPill(e) {
    if (!this.data.canReview || this.data.saving) return;
    const want = e.currentTarget.dataset.d;        // interview / accepted / rejected
    const cur = this.data.a.decided || '';
    if (want === 'interview') {
      /* 「安排面试」＝清掉录取决定回到待面试；顺带把面试时间填好（那是真正让它进待面试的东西） */
      if (!cur) { wx.showToast({ title: '先在上面填面试时间', icon: 'none' }); return; }
      wx.showModal({
        title: '撤销拟定结果',
        content: '把录取决定清掉，回到「待面试」。发布结果前都能改。',
        confirmText: '撤销',
        success: (r) => { if (r.confirm) this.review({ decision: null }); },
      });
      return;
    }
    if (cur === want) {
      wx.showModal({
        title: '撤销拟定结果',
        content: '把录取决定清掉，回到「待面试」。',
        confirmText: '撤销',
        success: (r) => { if (r.confirm) this.review({ decision: null }); },
      });
      return;
    }
    const label = want === 'accepted' ? '拟录取' : '拟不录取';
    wx.showModal({
      title: label,
      content: want === 'accepted'
        ? '定为「拟录取」？拟录取前必须已经安排过面试。发布结果前都能改。'
        : '定为「拟不录取」？建议在下面「结果说明」里写清原因。发布结果前都能改。',
      confirmText: label,
      success: (r) => { if (r.confirm) this.review({ decision: want }); },
    });
  },

  review(patch) {
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    return adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}/review`, 'PUT',
      Object.assign({ version: this.data.version }, patch))
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
          wx.showToast({ title: '这条刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  onSaveNotes() {
    if (!this.data.canReview) return;
    this.review({ internalNote: this.data.internalNote, publicNote: this.data.publicNote });
  },

  /* ── 面试：单人时间 / 地点 / 说明；清掉就回到跟批次统一安排 ── */
  onSaveItv() {
    if (!this.data.canReview || this.data.savingItv) return;
    const d = this.data.atDate;
    const t = this.data.atTime;
    if (!d || !t) { wx.showToast({ title: '先选面试日期和时刻', icon: 'none' }); return; }
    this.setData({ savingItv: true });
    wx.showLoading({ title: '保存中', mask: true });
    adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}/interview`, 'PUT', {
      version: this.data.version,
      at: `${d}T${t}:00+08:00`,
      location: this.data.atPlace,
      note: this.data.atNote,
    })
      .then(() => {
        wx.hideLoading();
        this.setData({ savingItv: false });
        wx.showToast({ title: '面试已安排', icon: 'success' });
        this.load();
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ savingItv: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '这条刚被别人改过，已刷新', icon: 'none' });
          this.load();
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  onClearItv() {
    if (!this.data.canReview) return;
    wx.showModal({
      title: '改回统一安排',
      content: '清掉这一个人的单独安排，改回跟随批次的统一安排（批次也没排就是「未安排」）。',
      confirmText: '清掉',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ savingItv: true });
        adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}/interview`, 'PUT',
          { version: this.data.version, at: null })
          .then(() => {
            this.setData({ savingItv: false });
            wx.showToast({ title: '已改回统一安排', icon: 'success' });
            this.load();
          })
          .catch((err) => {
            this.setData({ savingItv: false });
            if (isVersionConflict(err) || isConflict(err)) { this.load(); return; }
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },
});
