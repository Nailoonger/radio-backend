// pages-partner/recruit/list · v2（2026-11-14 照 preview/partner-hub-gounucai-v174 V['recruit-list']）
//
// ═══════════════════════════════════════════════════════════════════════════
// v174 那一屏的样子：
//   ① 顶部**搜姓名**（输入即筛，右边 ✕ 一键清空）
//   ② 年级＝一排小方角胶囊（全部 / 高一 / 初一…，选项来自批次自己的固定信息配置）
//   ③ 状态只三段**下划线标签**：待审核 / 待面试 / 录取状态，每段带人数
//   ④ 点「录取状态」后，下面多出一排小胶囊：「拟录取 / 拟不录取」，各带人数
//   ⑤ 每行：姓名 + 状态 tag ／ 年级班级 · QQ 号 ／ 提交时间；点行进处理台
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 服务端 `GET /admin/recruitment/applications` 只认 batchId / status / grade / page / pageSize，
//   **没有关键字参数**。所以搜索框只能筛「已经拉下来的这一批行」。
//   为了不让它骗人：一页拉 100 条（服务端上限），到底了才标「共 N 条」，
//   还有下一页时提示上拉。典型批次（几十人）一次就拉完了。
//
// ⚠️ 「录取状态」= 拟录取 + 拟不录取：服务端一次只收一个 status ⇒ 逐段拉（accTab 决定哪个）。
//
// ⚠️ 批次设了统一面试安排后，status=submitted 服务端**故意返回空页**
//   （services/recruitment.js#applications 里那句注释）⇒ 待审核 0 是真实口径，不是 bug。

const { adminRequest } = require('../../../utils/request.js');
const { fmtIso } = require('../../../utils/format.js');

const STATUS_TEXT = {
  submitted: '待审核', interview: '待面试', accepted: '拟录取', rejected: '拟不录取', withdrawn: '已撤回',
};
/* 状态 → v174 的 tag 色调（待审 warn / 待面试 ok / 拟录取 done / 拟不录取 no） */
const STATUS_CLS = { submitted: 'warn', interview: 'ok', accepted: 'done', rejected: 'no', withdrawn: 'gray' };

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    batchId: '',
    batchTitle: '',
    stabs: [],
    tab: 'submitted',            // submitted | interview | acc
    accTab: 'accepted',
    accStabs: [],
    grade: '',
    gradeTags: [],
    kw: '',
    all: [],
    rows: [],
    page: 1,
    pageSize: 100,
    hasMore: false,
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
    });
    this.loadBatch().then(() => this.reload());
  },

  onShow() { if (this._ready) this.reload(); },
  onPullDownRefresh() { this.reload().then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(this.data.page + 1, true); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  loadBatch() {
    if (!this.data.batchId) return Promise.resolve();
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}`, 'GET')
      .then((b) => {
        const g = (b && b.fixedFields && b.fixedFields.grade && b.fixedFields.grade.options) || [];
        this.setData({
          batchTitle: (b && b.title) || '报名列表',
          /* 第一个恒为「全部」（值 ''）；胶囊显示 label，取数用 v，不拿索引糊人 */
          gradeTags: [{ v: '', label: '全部' }].concat(g.map((x) => ({ v: x, label: x }))),
        });
      })
      .catch(() => {});
  },

  /* 当前 tab 对应服务端的 status */
  statusesOf(tab) {
    if (tab === 'acc') return [this.data.accTab];
    return [tab];
  },

  /* 重拉：四段人数 + 主列表 */
  reload() {
    this._ready = true;
    const id = this.data.batchId;
    if (!id) return Promise.resolve();
    const base = `/admin/recruitment/applications?batchId=${encodeURIComponent(id)}&page=1&pageSize=1`
      + (this.data.grade ? `&grade=${encodeURIComponent(this.data.grade)}` : '');
    return Promise.all(['submitted', 'interview', 'accepted', 'rejected'].map((s) => adminRequest(`${base}&status=${s}`, 'GET')
      .then((r) => Number((r && r.total) || 0))
      .catch(() => 0)))
      .then((n) => {
        this.setData({
          stabs: [
            { key: 'submitted', label: '待审核', n: String(n[0]) },
            { key: 'interview', label: '待面试', n: String(n[1]) },
            { key: 'acc', label: '录取状态', n: String(n[2] + n[3]) },
          ],
          accStabs: [
            { key: 'accepted', label: '拟录取', n: String(n[2]) },
            { key: 'rejected', label: '拟不录取', n: String(n[3]) },
          ],
        });
        return this.load(1, false);
      });
  },

  load(page, append) {
    const d = this.data;
    const base = `/admin/recruitment/applications?batchId=${encodeURIComponent(d.batchId)}`
      + `&page=${page}&pageSize=${d.pageSize}`
      + (d.grade ? `&grade=${encodeURIComponent(d.grade)}` : '');
    this.setData({ loading: !append, err: '' });
    return Promise.all(this.statusesOf(d.tab).map((s) => adminRequest(`${base}&status=${s}`, 'GET')))
      .then((pages) => {
        const merged = [];
        pages.forEach((p) => ((p && p.items) || []).forEach((x) => merged.push(x)));
        const rows = merged
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map((x) => ({
            id: x.id,
            name: x.name || '',
            grade: x.grade || '',
            className: x.className || '',
            qq: x.qqNumber || '',
            status: x.status,
            statusText: STATUS_TEXT[x.status] || x.status,
            statusCls: STATUS_CLS[x.status] || 'gray',
            created: fmtIso(x.createdAt),
            at: fmtIso(x.interview && x.interview.at),
          }));
        this.setData({
          loading: false,
          all: append ? d.all.concat(rows) : rows,
          page,
          hasMore: pages.some((p) => ((p && p.items) || []).length >= d.pageSize),
        });
        this.applyFilter();
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* 搜索只筛「已拉下来的行」——服务端不收关键字，这一点明说在页脚 */
  applyFilter() {
    const kw = String(this.data.kw || '').trim();
    this.setData({ rows: kw ? this.data.all.filter((x) => x.name.indexOf(kw) >= 0) : this.data.all });
  },

  onKw(e) { this.setData({ kw: e.detail.value }); this.applyFilter(); },
  onKwClear() { this.setData({ kw: '' }); this.applyFilter(); },

  onStab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab, all: [], rows: [] });
    this.reload();
  },
  onAccTab(e) {
    const accTab = e.currentTarget.dataset.acc;
    if (accTab === this.data.accTab) return;
    this.setData({ accTab, all: [], rows: [] });
    this.load(1, false);
  },
  onGrade(e) {
    const v = e.currentTarget.dataset.v || '';
    if (v === this.data.grade) return;
    this.setData({ grade: v, all: [], rows: [] });
    this.reload();
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/recruit/detail/detail?id=${id}` });
  },
});
