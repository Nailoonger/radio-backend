// pages-partner/recruit/detail · v1（2026-11-14 报名处理台）
//
// 一条报名：基本信息 + 固定信息 + 自定义问题答案 + 三件事（面试安排 / 录取决定 / 备注）。
//
// ⚠️⚠️ 三个动作走两个接口，别混：
//   · 录取决定 + 内部备注 + 对外说明 → `PUT /admin/recruitment/applications/:id/review`
//   · 面试时间                          → `PUT /admin/recruitment/applications/:id/interview`
//   两个接口都要 `version`（乐观锁）。**每次成功都要把返回的 version 写回 data**，
//   否则第二次保存必然 40901（"数据已更新"），而用户什么都没改。
//
// ⚠️ 服务端硬规则（前端只负责把话说清楚，别自己造规则）：
//   · 只有「报名截止后」才能审核 / 安排面试（窗口还开着时按钮点了会被拒）
//   · 拟录取之前**必须先有面试安排**（批次统一安排或个人单独安排），否则报「请先安排面试时间」
//   · 已撤回的报名不可审核
//
// ⚠️ 40901 = 这条刚被别人改过：必须**重拉**，只弹提示不够（屏幕上那行已经是旧的了）。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const STATUS_TEXT = {
  submitted: '待审核', interview: '待面试', accepted: '拟录取', rejected: '拟不录取', withdrawn: '已撤回',
};
const TYPE_TEXT = { text: '单行', textarea: '多行', single: '单选', multiple: '多选' };

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    id: '',
    version: 0,
    canReview: false,
    a: null,
    questions: [],
    answers: [],
    decided: '',
    interview: null,
    atDate: '',
    atTime: '',
    atPlace: '',
    atNote: '',
    internalNote: '',
    publicNote: '',
    saving: false,
    savingItv: false,
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
      id: (q && q.id) || '',
      /* 站员（role 2）不该进来；社干与超管都能审（服务端 asAdmin） */
      canReview: roleNum === 0 || roleNum === 1,
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
    this.setData({ loading: true });
    return adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}`, 'GET')
      .then((d) => {
        const batch = (d && d.batch) || {};
        const qs = (batch.questions || []);
        /* answers 的 key 是问题 id —— 用批次题目表映射成「题干 / 答案」，
           映射不到的（题被删了）不渲染，别把一串随机 id 摆给老师看。 */
        const answers = qs
          .map((q, i) => {
            const raw = (d.answers || {})[q.id];
            if (raw === undefined || raw === null || raw === '') return null;
            let val = raw;
            if (q.type === 'single' || q.type === 'multiple') {
              const pick = (id) => {
                const o = (q.options || []).find((x) => x.id === id);
                return o ? o.text : '';
              };
              val = Array.isArray(raw) ? raw.map(pick).filter(Boolean).join('、') : pick(raw);
            }
            return { key: q.id, no: String(i + 1).padStart(2, '0'), title: q.title, type: TYPE_TEXT[q.type] || '', val };
          })
          .filter(Boolean);
        const itv = d.interview || null;
        const at = itv && itv.at ? fmtIso(itv.at) : '';   // 'MM-DD HH:mm'
        this.setData({
          loading: false,
          version: Number(d.version) || 0,
          a: {
            id: d.id,
            name: d.name,
            grade: d.grade || '',
            className: d.className || '',
            qq: d.qqNumber || '',
            status: d.status,
            statusText: STATUS_TEXT[d.status] || d.status,
            legacy: d.legacyStudentNo || '',
            created: fmtIso(d.createdAt),
            seq: d.interviewSequence,
            batchTitle: batch.title || '',
            orderGenerated: !!batch.orderGeneratedAt,
          },
          questions: qs,
          answers,
          decided: d.decision || '',
          interview: itv ? { at, location: itv.location || '', note: itv.note || '', custom: !!d.interviewCustom } : null,
          /* 日期/时刻两截下面 refreshDateParts() 再算（要补年份、要拆 HH:mm） */
          atDate: '',
          atTime: '',
          atPlace: (itv && itv.location) || '',
          atNote: (itv && itv.note) || '',
          internalNote: d.internalNote || '',
          publicNote: d.publicNote || '',
        });
        this.refreshDateParts();
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /* 面试时间是绝对时刻，picker 要 'YYYY-MM-DD' 与 'HH:mm' 两截；
     服务端给的是北京时间墙钟，这里直接取字符串，不经 Date 换算（跨时区设备才对） */
  refreshDateParts() {
    const itv = this.data.interview;
    if (!itv || !itv.at) { this.setData({ atDate: '', atTime: '' }); return; }
    const s = String(itv.at);                     // 'MM-DD HH:mm'
    const now = new Date();
    const year = now.getFullYear();
    this.setData({ atDate: `${year}-${s.slice(0, 5)}`, atTime: s.slice(6, 11) });
  },

  /* ── 备注输入 ── */
  onIn(e) { this.setData({ internalNote: e.detail.value }); },
  onPub(e) { this.setData({ publicNote: e.detail.value }); },
  onPlace(e) { this.setData({ atPlace: e.detail.value }); },
  onItvNote(e) { this.setData({ atNote: e.detail.value }); },
  onDate(e) { this.setData({ atDate: e.detail.value }); },
  onTime(e) { this.setData({ atTime: e.detail.value }); },

  /* ── 录取决定（三个分开的胶囊，立即生效） ── */
  onDecide(e) {
    if (!this.data.canReview || this.data.saving) return;
    const want = e.currentTarget.dataset.d;       // accepted / rejected / ''（撤销）
    const cur = this.data.decided || '';
    const next = cur === want ? '' : want;        // 再点一次＝取消（跟原型一致）
    const label = next === 'accepted' ? '拟录取' : (next === 'rejected' ? '拟不录取' : '撤销决定');
    wx.showModal({
      title: label,
      content: next === '' ? '把这条的录取决定清掉，回到待面试。' : `确定标为「${label}」？发布结果前还能改。`,
      confirmText: label,
      success: (r) => {
        if (!r.confirm) return;
        this.review({ decision: next || null });
      },
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
        /* ⚠️ 招新的版本冲突是 40910（不是通用 40901），两个都得认 */
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

  /* ── 面试安排：单人时间/地点/说明；清掉就回到跟随批次统一安排 ── */
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
        /* ⚠️ 招新的版本冲突是 40910（不是通用 40901），两个都得认 */
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
      title: '清掉面试安排',
      content: '清掉后这条跟随批次的统一安排（批次也没排就是「未安排」）。',
      confirmText: '清掉',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ savingItv: true });
        adminRequest(`/admin/recruitment/applications/${encodeURIComponent(this.data.id)}/interview`, 'PUT',
          { version: this.data.version, at: null })
          .then(() => {
            this.setData({ savingItv: false });
            wx.showToast({ title: '已清掉', icon: 'success' });
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
