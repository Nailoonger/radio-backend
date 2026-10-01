// pages-admin/review/review.js
//
// 投稿 & 点歌审核列表（2026-10-01）
//
// 只留「待审 / 已通过 / 已驳回」三段筛选，条目上只有两个动作：
//   · 通过 —— 直接调 PUT /admin/submit/:id/approve（requireAdmin，普通管理员可做）
//   · 驳回 —— **跳处理台**（PUT /admin/submit/:id/reject 服务端硬校验 reason 必填，
//             列表页没地方写理由，所以不在这一层做）
// 批量、撤销、改时段、指派排期全在电脑端 —— 一期范围就这两件事。
//
// 筛选用的是 **reviewStatus**（审核维度），不是派生镜像列 status：
//   0 待审 / 1 已通过 / 2 已驳回

const { adminRequest } = require('../../utils/request.js');
const { fmtMd } = require('../../utils/format.js');

const TABS = [0, 1, 2];          // reviewStatus
const TAB_LABELS = ['待审核', '已通过', '已驳回'];

Page({
  data: {
    statusBarHeight: 20,
    tabs: TAB_LABELS,
    tabIndex: 0,
    counts: [0, 0, 0],
    loading: true,
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-admin/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.fetchCounts();
    this.fetchList(true);
  },

  onPullDownRefresh() {
    Promise.all([this.fetchCounts(), this.fetchList(true)])
      .then(() => wx.stopPullDownRefresh());
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages-admin/todo/todo' });
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchList(false);
  },

  switchTab(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (idx === this.data.tabIndex) return;
    this.setData({ tabIndex: idx, list: [], page: 1, hasMore: false, loading: true });
    this.fetchList(true);
  },

  /** 三个分段的条数（只要 total，不拉数据） */
  fetchCounts() {
    const one = (reviewStatus) =>
      adminRequest('/admin/submit/list', 'GET', { reviewStatus, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0);
    return Promise.all(TABS.map(one)).then((counts) => this.setData({ counts }));
  },

  fetchList(reset) {
    const page = reset ? 1 : this.data.page + 1;
    const reviewStatus = TABS[this.data.tabIndex];
    if (reset) this.setData({ loading: true });

    return adminRequest('/admin/submit/list', 'GET', {
      reviewStatus,
      page,
      pageSize: this.data.pageSize,
    })
      .then((d) => {
        const rows = (d && d.list) || [];
        const mapped = rows.map(decorate);
        const merged = reset ? mapped : this.data.list.concat(mapped);
        const total = Number((d && d.total) || 0);
        this.setData({
          list: merged,
          page,
          total,
          hasMore: merged.length < total,
          loading: false,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /** 通过：直接审掉，条目从当前「待审核」列表移除 */
  onApprove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showLoading({ title: '处理中', mask: true });
    adminRequest(`/admin/submit/${id}/approve`, 'PUT')
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: '已通过', icon: 'success' });
        this.setData({
          list: this.data.list.filter((x) => x.id !== id),
          total: Math.max(0, this.data.total - 1),
        });
        this.fetchCounts();
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /** 驳回：进处理台，那一页才有理由输入 */
  onReject(e) {
    this.openDetail(e.currentTarget.dataset.id, 'reject');
  },

  openDetail(idOrEvent, focus) {
    const id = typeof idOrEvent === 'object' ? idOrEvent.currentTarget.dataset.id : idOrEvent;
    const url = `/pages-admin/review-detail/detail?id=${id}${focus ? `&focus=${focus}` : ''}`;
    wx.navigateTo({
      url,
      // 处理台里审完一条 → 回来时列表与计数都要是最新的
      events: {
        reviewed: () => {
          this.fetchList(true);
          this.fetchCounts();
        },
      },
    });
  },

  onItemTap(e) {
    this.openDetail(e.currentTarget.dataset.id);
  },
});

/** 接口行 → 视图行（列表里不写业务表达式，全在这里算好） */
function decorate(r) {
  const isSong = Number(r.type) === 1;
  const st = Number(r.reviewStatus);
  return {
    id: r.id,
    reviewStatus: st,
    typeText: isSong ? '点歌' : '文稿',
    isArticle: !isSong,
    title: isSong
      ? ([r.songName, r.singer].filter(Boolean).join(' · ') || '（未填歌曲）')
      : (r.articleTitle || '（无标题）'),
    note: isSong ? (r.wishContent || '') : (r.articleContent || ''),
    meta: [r.nickname || '匿名', fmtMd(r.createTime)].filter(Boolean).join(' · '),
    statusText: r.statusText || '',
    // ⚠️⚠️ 状态胶囊的文案必须在 JS 里拼好、**在 wxml 里一行写完**。
    //    WXML 的 <text> 会保留换行（不做 HTML 那种空白折叠），把 {{三元}} 拆到
    //    三行写就会渲染成「一个空行 + 一行字」——胶囊被撑高、字掉到底部。
    //    参考证：同页 .fl 筛选胶囊写在一行，渲染完全正常。
    tagClass: st === 1 ? 'tag-pass' : (st === 2 ? 'tag-reject' : 'tag-pending'),
    tagText: st === 1 ? '已通过' : (st === 2 ? '已驳回' : '待审核'),
  };
}
