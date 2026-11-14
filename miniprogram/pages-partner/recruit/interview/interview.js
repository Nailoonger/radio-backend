// pages-partner/recruit/interview · v1（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-interview']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 这一屏一屏两段，不再拆成两个入口（v165 合并）：
//   ① 上段「批次统一安排」：面试时间 + 地点 + 说明。
//      **超管是表单，社干看到的是只读三行** —— 同一块、按权限换形态。
//   ② 下段「面试顺序 + 名单」：
//      · 一句状态（已固定 N 人 / 还没生成，洗牌生成于什么时候）
//      · 一行两枚 tag：统一时间 / 单人覆盖 N 人
//      · 名单按**面试序号**排，每行：序号 ｜ 姓名 + 状态 tag（+ 单独配置 tag）
//        ｜ 年级班级 · QQ ｜ 面试时间 · 地点（没安排写「面试时间待安排」）
//      · 超管点整行进「单人面试配置」；社干点行只读
//      · 页底两行操作：导出完整名单（.xlsx）／生成或重新生成面试顺序（超管）
// ═══════════════════════════════════════════════════════════════════════════
//
// 数据两个接口：
//   `GET batches/:id`                    → 统一安排 + 标题 + 版本 + 各状态位
//   `GET batches/:id/interview-order`    → 洗好的名单（按序号，服务端已排好）
//
// ⚠️ 生成面试顺序的四个前提（服务端 assertReview + asSuper）：
//   已发布 + 已到截止(windowState==='closed') + 未发布结果 + 未归档 + 超管。
//   少一条点了就报 40304「报名截止后才可审核和安排面试」，所以按钮不摆出来。
//
// ⚠️ 覆盖已有顺序要 `confirm:'REGENERATE'`（不带就 R.INVALID_STATE 拒绝），
//   而且**不可逆** —— 必须走一次确认弹窗。
//
// ⚠️ 导出返回 {filename, base64}：手机上要自己落盘再 openDocument 才看得到。
//   写文件失败（存储满 / 权限）时给一句人话，别只说「失败」。

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
    batchId: '',
    batch: null,
    canManage: false,
    /* 统一安排：超管表单 / 社干只读 */
    planAt: '',
    planDate: '',
    planTime: '',
    planPlace: '',
    planNote: '',
    savedPlan: false,
    savingPlan: false,
    /* 名单 */
    generated: false,
    generatedAt: '',
    total: 0,
    customCount: 0,
    list: [],
    page: 1,
    pageSize: 50,
    hasMore: false,
    generating: false,
    exporting: false,
    /* 能不能生成 */
    canGenerate: false,
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
      batchId: (q && q.batchId) || '',
      canManage: r === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((n) => {
        if (n === 0) { this.setData({ canManage: true }); this.markGenerate(); }
      });
    }
    this.load(1);
  },

  /* 从单人配置页回来：名单里的时间地点要跟着变 */
  onShow() { if (this._ready) this.load(1); },
  onPullDownRefresh() { this.load(1).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(this.data.page + 1, true); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  /* 生成前提：已发布 + 已截止 + 未出结果 + 未归档 + 超管 */
  markGenerate() {
    const b = this.data.batch;
    const ok = !!this.data.canManage && !!b
      && b.windowState === 'closed' && !b.resultPublishedAt && !b.archivedAt;
    if (ok !== this.data.canGenerate) this.setData({ canGenerate: ok });
  },

  load(page, append) {
    const id = this.data.batchId;
    if (!id) return Promise.resolve();
    const p = page || 1;
    this.setData({ loading: !append || !this._ready, err: '' });
    /* 名单与批次信息一起要：统一安排要按「这批的真实值」显示，不是上一批的 */
    return Promise.all([
      adminRequest(`/admin/recruitment/batches/${encodeURIComponent(id)}`, 'GET'),
      adminRequest(`/admin/recruitment/batches/${encodeURIComponent(id)}/interview-order`
        + `?page=${p}&pageSize=${this.data.pageSize}`, 'GET'),
    ])
      .then((res) => {
        const b = res[0] || {};
        const d = res[1] || {};
        const itv = b.interview || null;
        const at = itv && itv.at ? fmtIso(itv.at) : '';
        const items = (d.items || []).map((x) => {
          const n = Number(x.interviewSequence) || 0;
          return {
            id: x.id,
            seq: n ? pad(n) : '—',
            seqW: n > 99 ? 'w3' : (n > 9 ? 'w2' : ''),
            name: x.name || '',
            grade: x.grade || '',
            className: x.className || '',
            qq: x.qqNumber || '',
            status: x.status,
            statusText: STATUS_TEXT[x.status] || x.status,
            statusCls: STATUS_CLS[x.status] || 'gray',
            custom: !!x.interviewCustom,
            at: fmtIso(x.interview && x.interview.at),
            place: (x.interview && x.interview.location) || '',
          };
        });
        this._ready = true;
        const list = append ? this.data.list.concat(items) : items;
        this.setData({
          loading: false,
          batch: b,
          generated: !!b.orderGeneratedAt,
          generatedAt: b.orderGeneratedAt ? fmtIso(b.orderGeneratedAt) : '',
          total: Number(d.total) || 0,
          customCount: list.filter((x) => x.custom).length,
          list,
          page: p,
          hasMore: items.length >= this.data.pageSize,
          planAt: at,
          planPlace: (itv && itv.location) || '',
          planNote: (itv && itv.note) || '',
          savedPlan: !!at,
        });
        /* 时刻拆两截给 picker（'MM-DD HH:mm' → 补年 + 'HH:mm'） */
        if (at) {
          const y = new Date().getFullYear();
          this.setData({ planDate: `${y}-${at.slice(0, 5)}`, planTime: at.slice(6, 11) });
        } else {
          this.setData({ planDate: '', planTime: '' });
        }
        this.markGenerate();
      })
      .catch((err) => {
        this.setData({ loading: false });
        if (isVersionConflict(err) || isConflict(err)) { this.load(1); return; }
        this.setData({ err: (err && err.message) || '加载失败' });
      });
  },

  /* ══════════ 统一安排（超管）══════════ */
  onPlanDate(e) { this.setData({ planDate: e.detail.value }); },
  onPlanTime(e) { this.setData({ planTime: e.detail.value }); },
  onPlanPlace(e) { this.setData({ planPlace: e.detail.value }); },
  onPlanNote(e) { this.setData({ planNote: e.detail.value }); },

  onSavePlan() {
    if (!this.data.canManage || this.data.savingPlan) return;
    const d = this.data;
    if (!d.planDate || !d.planTime) { wx.showToast({ title: '先选面试日期和时刻', icon: 'none' }); return; }
    if (!String(d.planPlace || '').trim()) { wx.showToast({ title: '面试地点不能空着', icon: 'none' }); return; }
    this.setData({ savingPlan: true });
    wx.showLoading({ title: '保存中', mask: true });
    /* 批次级统一安排：`PUT batches/:id/interview`（asSuper），带 version */
    adminRequest(`/admin/recruitment/batches/${encodeURIComponent(d.batchId)}/interview`, 'PUT', {
      version: Number((d.batch && d.batch.version) || 0),
      at: `${d.planDate}T${d.planTime}:00+08:00`,
      location: d.planPlace,
      note: d.planNote,
    })
      .then(() => {
        wx.hideLoading();
        this.setData({ savingPlan: false });
        wx.showToast({ title: '统一安排已发布', icon: 'success' });
        this.load(1);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ savingPlan: false });
        if (isVersionConflict(err) || isConflict(err)) {
          wx.showToast({ title: '批次刚被改过，已刷新', icon: 'none' });
          this.load(1);
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  onClearPlan() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '清除统一安排',
      content: '清掉后，没单独配置过的报名会退回「已提交」，不会留下「待面试却没时间」的脏状态。',
      confirmText: '清除',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ savingPlan: true });
        adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}/interview`, 'PUT', {
          version: Number((this.data.batch && this.data.batch.version) || 0),
          at: null,
        })
          .then(() => {
            this.setData({ savingPlan: false });
            wx.showToast({ title: '已清除', icon: 'success' });
            this.load(1);
          })
          .catch((err) => {
            this.setData({ savingPlan: false });
            if (isVersionConflict(err) || isConflict(err)) { this.load(1); return; }
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },

  /* ══════════ 生成顺序（超管，覆盖要二次确认）══════════ */
  onGenerate() {
    if (!this.data.canGenerate || this.data.generating) return;
    const b = this.data.batch || {};
    const regen = !!b.orderGeneratedAt;
    wx.showModal({
      title: regen ? '覆盖面试顺序' : '生成随机面试顺序',
      content: regen
        ? '重新生成会整份替换已保存的顺序和面试序号，请在确认后改用新名单。已撤回、拟不录取的报名会排除。'
        : '把全部有效报名洗牌后保存，序号固定不变。已撤回、拟不录取的报名会排除。',
      confirmText: regen ? '覆盖并重新生成' : '确认生成',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ generating: true });
        wx.showLoading({ title: '生成中', mask: true });
        const body = { version: Number(b.version || 0) };
        if (regen) body.confirm = 'REGENERATE';
        adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}/interview-order`,
          'POST', body)
          .then(() => {
            wx.hideLoading();
            this.setData({ generating: false });
            wx.showToast({ title: '顺序已生成', icon: 'success' });
            this.load(1);
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ generating: false });
            if (isVersionConflict(err) || isConflict(err)) {
              wx.showToast({ title: '批次刚被改过，已刷新', icon: 'none' });
              this.load(1);
              return;
            }
            wx.showToast({ title: (err && err.message) || '生成失败', icon: 'none' });
          });
      },
    });
  },

  /* ══════════ 导出 xlsx：base64 → 落盘 → openDocument ══════════ */
  onExport() {
    if (this.data.exporting) return;
    if (!this.data.generated) { wx.showToast({ title: '先生成面试顺序', icon: 'none' }); return; }
    this.setData({ exporting: true });
    wx.showLoading({ title: '准备文件', mask: true });
    adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}/interview-order/export`, 'GET')
      .then((d) => {
        const name = (d && d.filename) || '面试名单.xlsx';
        const b64 = (d && d.base64) || '';
        if (!b64) throw new Error('导出内容为空');
        const filePath = `${wx.env.USER_DATA_PATH}/${name}`;
        wx.getFileSystemManager().writeFile({
          filePath,
          data: b64,
          encoding: 'base64',
          success: () => {
            wx.hideLoading();
            this.setData({ exporting: false });
            wx.openDocument({
              filePath,
              fileType: 'xlsx',
              showMenu: true,
              fail: () => wx.showToast({ title: '已保存，可在聊天里发给自己再打开', icon: 'none' }),
            });
          },
          fail: () => {
            wx.hideLoading();
            this.setData({ exporting: false });
            wx.showToast({ title: '写文件失败，请到电脑端导出', icon: 'none' });
          },
        });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ exporting: false });
        if (isVersionConflict(err) || isConflict(err)) { this.load(1); return; }
        wx.showToast({ title: (err && err.message) || '导出失败', icon: 'none' });
      });
  },

  /* 点行：超管进单人配置（v174 整行可点），社干只读 */
  onRow(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.data.canManage) {
      wx.showToast({ title: '单人配置只有超管能改', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages-partner/recruit/solo/solo?batchId=${this.data.batchId}&id=${id}` });
  },
});
