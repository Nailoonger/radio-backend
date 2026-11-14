// pages-partner/recruit/list · v1（2026-11-14 报名列表）
//
// 一段批次里的报名清单。服务端 `GET /admin/recruitment/applications` 只认
// `batchId / status / grade / page / pageSize` 五个参数：
//   · **没有关键字搜索** ⇒ 这一页不做搜索框（原型里的「搜姓名」是纯前端演示；
//     真做只能筛当前这一页，那是骗人的，宁可不给）。
//   · 年级选项来自批次自己的 fixedFields.grade.options，不是写死的高一/初一。
//
// ⚠️ 「已定」= 拟录取 + 拟不录取。服务端一次只收一个 status，所以这一次拉两页再合并；
//    两页各取 pageSize，翻页时也两边一起翻 —— 别只翻一边，否则行数会跳。
//
// ⚠️ 待面试 / 待审核的口径由服务端按「有没有生效的面试安排」派生（status 字段），
//    前端不要自己拿 progress 猜。

const { adminRequest } = require('../../../utils/request.js');
const partnerRole = require('../../../utils/partnerRole.js');
const { fmtIso } = require('../../../utils/format.js');

const TABS = [
  { key: 'submitted', label: '待审核' },
  { key: 'interview', label: '待面试' },
  { key: 'decided', label: '已定' },
];
const STATUS_TEXT = {
  submitted: '待审核', interview: '待面试', accepted: '拟录取', rejected: '拟不录取', withdrawn: '已撤回',
};

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    batchId: '',
    title: '',
    tabs: TABS,
    tab: 'submitted',
    grades: [],
    gradeLabels: [],
    grade: '',
    gradeLabel: '全部年级',
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
    total: 0,
    empty: false,
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
    partnerRole.ensure();
    this.loadBatch().then(() => this.load(1));
  },

  /* 从处理台回来：那一行的状态可能已经变了，重拉第 1 页。
     ⚠️ 首次进页面也会走 onShow，那时 _ready 还是 false（load 没回来）⇒ 不会重复请求。 */
  onShow() { if (this._ready) this.load(1); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  onPullDownRefresh() { this.load(1).then(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(this.data.page + 1); },

  loadBatch() {
    if (!this.data.batchId) return Promise.resolve();
    return adminRequest(`/admin/recruitment/batches/${encodeURIComponent(this.data.batchId)}`, 'GET')
      .then((b) => {
        const g = (b && b.fixedFields && b.fixedFields.grade && b.fixedFields.grade.options) || [];
        /* 第一个永远是「全部年级」（值 ''），picker 用 gradeLabels 显示，不拿索引糊人 */
        this.setData({
          title: (b && b.title) || '报名列表',
          grades: ['', ...g],
          gradeLabels: ['全部年级', ...g],
        });
      })
      .catch(() => {});
  },

  /* 一个 tab 对应请求里的 status（'decided' 是两次请求，见文件头注释） */
  statuses() {
    return this.data.tab === 'decided' ? ['accepted', 'rejected'] : [this.data.tab];
  },

  load(page) {
    if (!this.data.batchId) return Promise.resolve();
    this.setData({ loading: true });
    const p = page || 1;
    const base = `/admin/recruitment/applications?batchId=${encodeURIComponent(this.data.batchId)}`
      + `&page=${p}&pageSize=${this.data.pageSize}`
      + (this.data.grade ? `&grade=${encodeURIComponent(this.data.grade)}` : '');
    return Promise.all(this.statuses().map((s) => adminRequest(`${base}&status=${s}`, 'GET')))
      .then((pages) => {
        const merged = [];
        pages.forEach((d) => ((d && d.items) || []).forEach((x) => merged.push(x)));
        const rows = merged
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map((x) => ({
            id: x.id,
            name: x.name,
            grade: x.grade || '',
            className: x.className || '',
            qq: x.qqNumber || '',
            status: x.status,
            statusText: STATUS_TEXT[x.status] || x.status,
            at: fmtIso(x.interview && x.interview.at),
            seq: x.interviewSequence,
            created: fmtIso(x.createdAt),
          }));
        const total = pages.reduce((n, d) => n + (Number(d && d.total) || 0), 0);
        const list = p === 1 ? rows : this.data.list.concat(rows);
        this._ready = true;
        this.setData({
          loading: false,
          list,
          page: p,
          total,
          empty: list.length === 0,
          /* 两页都没装满一页 ⇒ 到底了；已定的两页合起来可能超过 pageSize，按「有没有拿到满页」判 */
          hasMore: pages.some((d) => ((d && d.items) || []).length >= this.data.pageSize),
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab, list: [], page: 1 });
    this.load(1);
  },

  onGrade(e) {
    const i = Number(e.detail.value) || 0;
    const grade = this.data.grades[i] || '';
    this.setData({ grade, gradeLabel: grade || '全部年级', list: [], page: 1 });
    this.load(1);
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages-partner/recruit/detail/detail?id=${id}` });
  },
});
