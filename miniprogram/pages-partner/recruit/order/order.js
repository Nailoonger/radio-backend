// pages-partner/recruit/order/order · v1（2026-11-14 面试顺序）
//
// 面试当天叫号用的名单。与电脑端 admin-web/Recruitment.vue 的「面试顺序」抽屉同口径。
//
// ⚠️ 一次请求拿全：`GET /admin/recruitment/batches/:id/interview-order`
//    返回 `{ batch, items, total, page, pageSize, orderGeneratedAt }` —— 批次信息自带，
//    不用再单独拉一次详情（少一次往返，也少一次版本不一致的机会）。
//
// ⚠️ 生成的前提是**服务端定的**，前端只负责别把按不动的按钮露出来：
//    已发布 + 已到截止（windowState==='closed'）+ 未发布结果 + 未归档 + 超管。
//    条件不满足还点，服务端报 40304「报名截止后才可审核和安排面试」。
//    （`assertReview` 三条一起卡：未发布 / 不是 closed / 结果已发布）
//
// ⚠️ 覆盖是**不可逆**的：重新生成会把已保存的顺序和序号整个换掉，并重新洗牌。
//    所以 orderGeneratedAt 不为空时必须走弹窗确认，body 带 `confirm:'REGENERATE'`
//    —— 不带这个字段服务端会拒绝覆盖（R.INVALID_STATE「请确认覆盖已有面试顺序」）。
//
// ⚠️ 名单按**面试序号**读，不是按报名时间：服务端存的是洗好的 id 数组，
//    `items` 已经按数组顺序排好并带 interviewSequence，前端不要再排。
//
// ⚠️ 导出是 xlsx：云函数把 buffer 转成 base64 返回，手机上要**自己落盘**再
//    wx.openDocument 才能看。文件名服务端给（`招新面试名单_<批次>_<日期>.xlsx`）。

const { adminRequest, isConflict, isVersionConflict } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const STATUS_TEXT = {
  submitted: '待审核', interview: '待面试', accepted: '拟录取', rejected: '拟不录取', withdrawn: '已撤回',
};
const STATUS_TAG = {
  accepted: 'tag-pass', rejected: 'tag-reject', interview: 'tag-pending', withdrawn: 'tag-mute',
};

Page({
  data: {
    statusBarHeight: 20,
    batchId: '',
    title: '',
    loading: true,
    generating: false,
    exporting: false,

    canManage: false,
    canGenerate: false,
    generated: false,
    generatedText: '',
    total: 0,

    list: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
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
      batchId: (q && q.batchId) || '',
      canManage: roleNum === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((r) => {
        if (r === 0) {
          const d = { canManage: true };
          if (this._batch) d.canGenerate = this.canGen(this._batch, true);
          this.setData(d);
        }
      });
    }
    this.load(1);
  },

  /* 从处理台改完面试安排回来，名单里的「面试时间 / 地点」要跟着变 */
  onShow() { if (this._ready) this.load(1); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  onPullDownRefresh() { this.load(1).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(this.data.page + 1); },

  /* 能不能生成：五条一起满足（与电脑端 canGenerateOrder 一致） */
  canGen(b, isSuper) {
    return !!isSuper && !!b && b.windowState === 'closed'
      && !b.resultPublishedAt && !b.archivedAt;
  },

  load(page) {
    if (!this.data.batchId) return Promise.resolve();
    const p = page || 1;
    this.setData({ loading: true });
    return adminRequest(
      `/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}/interview-order`
      + `?page=${p}&pageSize=${this.data.pageSize}`, 'GET')
      .then((d) => {
        const b = (d && d.batch) || {};
        this._batch = b;
        const items = ((d && d.items) || []).map((x) => ({
          id: x.id,
          seq: x.interviewSequence,
          name: x.name,
          grade: x.grade || '',
          className: x.className || '',
          qq: x.qqNumber || '',
          status: x.status,
          statusText: STATUS_TEXT[x.status] || x.status,
          tag: STATUS_TAG[x.status] || 'tag-mute',
          at: fmtIso(x.interview && x.interview.at),
          place: (x.interview && x.interview.location) || '',
          custom: !!x.interviewCustom,
        }));
        const list = p === 1 ? items : this.data.list.concat(items);
        this._ready = true;
        this.setData({
          loading: false,
          title: b.title || '面试顺序',
          page: p,
          list,
          total: Number(d && d.total) || 0,
          generated: !!b.orderGeneratedAt,
          generatedText: b.orderGeneratedAt ? fmtIso(b.orderGeneratedAt) : '',
          canGenerate: this.canGen(b, this.data.canManage),
          hasMore: items.length >= this.data.pageSize,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        if (isVersionConflict(err) || isConflict(err)) { this.load(1); return; }
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /* ── 生成 / 重新生成 ── */
  onGenerate() {
    const b = this._batch;
    if (!this.data.canGenerate || this.data.generating || !b) return;
    const regen = !!b.orderGeneratedAt;
    wx.showModal({
      title: regen ? '覆盖面试顺序' : '生成随机面试顺序',
      content: regen
        ? `重新生成「${b.title}」的顺序？已保存的名单和面试序号会被整个换掉，请在确认后改用新名单。已撤回、拟不录取的报名会排除。`
        : `为「${b.title}」生成随机顺序？会把全部有效报名洗牌后保存，已撤回、拟不录取的报名会排除。`,
      confirmText: regen ? '覆盖并重新生成' : '确认生成',
      success: (r) => {
        if (!r.confirm) return;
        this.doGenerate(regen);
      },
    });
  },

  doGenerate(regen) {
    const b = this._batch;
    this.setData({ generating: true });
    wx.showLoading({ title: '生成中', mask: true });
    const body = { version: b.version };
    if (regen) body.confirm = 'REGENERATE';
    adminRequest(`/admin/recruitment/batches/${encodeURIComponent(b.id)}/interview-order`, 'POST', body)
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

  /* ── 导出 xlsx：云函数回 base64 → 落盘 → openDocument ── */
  onExport() {
    if (!this.data.generated || this.data.exporting) return;
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

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/recruit/detail/detail?id=${id}` });
  },
});
