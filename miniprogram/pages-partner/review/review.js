// pages-partner/review/review.js · v2（2026-10-28 审核线对齐 v151）
//
// 统一审核台：状态（待审核 / 已通过 / 已驳回）× 类型（点歌 / 文稿 / 留言）。
// 结构与筛选样式照 v151 的 `submissions` 屏；数据分两张表：
//   点歌 / 文稿 → /admin/submit/list?type=&reviewStatus=
//   留言       → /admin/message/list?status=（文案第三档叫「已屏蔽」）
// 原型里的「内部稿件 / 加油稿」后端没有对应表 ⇒ 不做假入口。
//
// 动作：
//   通过 —— 提交表 PUT /admin/submit/:id/approve；留言表 PUT /admin/message/:id/approve
//   驳回 —— 提交表**跳处理台**（服务端硬校验 reason 必填，列表页没地方写）；
//           留言表没有处理台 ⇒ 就地用可输入的 modal 收理由
//
// ⚠️ 并发：电脑端也在审同一条。40901 = 这条刚被处理过 ⇒ 必须重拉列表，不能只弹 toast。

const { adminRequest, isConflict } = require('../../utils/request.js');
const { fmtMd } = require('../../utils/format.js');
const perm = require('../../utils/perm.js');

/* 类型顺序照 v151 .ftags。
   ⚠️ 各类型的三档状态值不一样：
      submit  —— reviewStatus 0/1/2
      message —— status       0/1/2
      draft   —— status       1/2/3（0 是草稿，不进审核队列）
   统一用 states 数组表达，pending 永远是 states[0]。 */
const KINDS = [
  { key: 'song',    type: 1,  label: '点歌',     tagCls: 'warn', states: [0, 1, 2] },
  { key: 'article', type: 2,  label: '文稿',     tagCls: 'ok',   states: [0, 1, 2] },
  { key: 'message', type: 0,  label: '留言',     tagCls: 'ok',   states: [0, 1, 2] },
  { key: 'draft',   type: 0,  label: '内部稿件', tagCls: 'ok',   states: [1, 2, 3] },
];

const STATE_SUBMIT  = ['待审核', '已通过', '已驳回'];
const STATE_MESSAGE = ['待审核', '已通过', '已屏蔽'];

Page({
  data: {
    statusBarHeight: 20,
    ready: false,
    roleKey: 'manager',
    badges: {},
    kindLabels: KINDS.map((k) => k.label),
    kindIdx: 0,
    stateLabels: STATE_SUBMIT,
    stateIdx: 0,
    counts: [0, 0, 0],
    loading: true,
    list: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    /* 2026-10-31：社干被超管关掉「审核权限」时整页置灰态（只说这一句，不给假列表） */
    denied: false,
    denyReview: '暂无审核权限',
  },

  onLoad(query) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    // 从工作台「留言审核」卡进来时带 type=message，直接落到留言档
    let kindIdx = 0;
    if (query && query.type) {
      const i = KINDS.findIndex((k) => k.key === query.type);
      if (i >= 0) kindIdx = i;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      ready: true,
      roleKey: Number(info.role) === 0 ? 'super' : 'manager',
      kindIdx,
      stateLabels: KINDS[kindIdx].key === 'message' ? STATE_MESSAGE : STATE_SUBMIT,
    });

    /**
     * 2026-10-31：社干被关掉「审核权限」⇒ 整页就一句「暂无审核权限」，**一个请求都不发**。
     * 只靠列表接口返回空是骗人的（看着像「今天没人投稿」），所以做成显式的拒绝态。
     * 超管恒放行；站员本来就不看这一页。
     */
    if (Number(info.role) === 1) {
      return perm.load().then((pm) => {
        if (this._gone) return;
        if (pm && pm.review === false) {
          this.setData({
            loading: false,
            denied: true,
            denyReview: (pm.text && pm.text.review) || '暂无审核权限',
          });
          return;
        }
        this.fetchCounts();
        this.fetchList(true);
        this.refreshBadges();
      });
    }

    this.fetchCounts();
    this.fetchList(true);
    this.refreshBadges();
  },

  onUnload() { this._gone = true; },

  onShow() {
    // 回到这一页（从处理台审完回来 / 切 tab 回来）底栏数字要跟着变
    if (this.data.ready) this.refreshBadges();
  },

  onPullDownRefresh() {
    Promise.all([this.fetchCounts(), this.fetchList(true)])
      .then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchList(false);
  },

  /** 当前类型（不可放 data，函数里现取） */
  currentKind() {
    return KINDS[this.data.kindIdx] || KINDS[0];
  },

  /** 审核 tab 的角标 = 投稿待审 + 留言待审（与工作台同一口径，唯一事实源 TODO） */
  refreshBadges() {
    /* 被关掉审核权限时不要留角标：一个数字在勾着人来点，点进来只有一句「暂无审核权限」 */
    if (this.data.denied) {
      this.setData({ badges: { desk: 0, home: 0, submissions: 0, 'my-drafts': 0, scheduling: 0, schedule: 0, me: 0 } });
      return Promise.resolve();
    }
    const one = (url, q) =>
      adminRequest(url, 'GET', Object.assign({ page: 1, pageSize: 1 }, q))
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0);
    return Promise.all([
      one('/admin/submit/list', { reviewStatus: 0 }),
      one('/admin/message/list', { status: 0 }),
    ]).then(([a, b]) => this.setData({
      badges: {
        desk: 0, home: 0, submissions: a + b,
        'my-drafts': 0, scheduling: 0, schedule: 0, me: 0,
      },
    }));
  },

  /** 底部导航切换：tab 之间一律 reLaunch，不留栈 */
  onTab(e) {
    const id = e.detail && e.detail.id;
    if (!id || id === 'submissions') return;
    const map = {
      desk: '/pages-partner/desk/desk',
      home: '/pages-partner/desk/desk',
      'my-drafts': '/pages-partner/work/work',
      schedule: '/pages-partner/schedule/index/index',
      scheduling: '/pages-partner/schedule/index/index',
      me: '/pages-partner/me/me',
    };
    const url = map[id];
    if (url) {
      wx.reLaunch({ url });
      return;
    }
    wx.showToast({ title: '这一页还没落地', icon: 'none' });
  },

  switchState(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (idx === this.data.stateIdx) return;
    this.setData({ stateIdx: idx, list: [], page: 1, hasMore: false, loading: true });
    this.fetchList(true);
  },

  switchKind(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (idx === this.data.kindIdx) return;
    const kind = KINDS[idx];
    this.setData({
      kindIdx: idx,
      stateIdx: 0,
      stateLabels: kind.key === 'message' ? STATE_MESSAGE : STATE_SUBMIT,
      list: [],
      page: 1,
      hasMore: false,
      loading: true,
      counts: [0, 0, 0],
    });
    this.fetchCounts();
    this.fetchList(true);
  },

  /** 三个状态的条数（只取 total，不拉数据） */
  fetchCounts() {
    if (this.data.denied) return Promise.resolve();
    const kind = this.currentKind();
    const one = (state) => {
      let url;
      let q;
      if (kind.key === 'message') {
        url = '/admin/message/list';
        q = { status: state, page: 1, pageSize: 1 };
      } else if (kind.key === 'draft') {
        url = '/partner/draft/review';
        q = { status: state, page: 1, pageSize: 1 };
      } else {
        url = '/admin/submit/list';
        q = { type: kind.type, reviewStatus: state, page: 1, pageSize: 1 };
      }
      return adminRequest(url, 'GET', q)
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0);
    };
    return Promise.all(kind.states.map(one))
      .then((counts) => this.setData({ counts }));
  },

  fetchList(reset) {
    if (this.data.denied) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    const kind = this.currentKind();
    const state = kind.states[this.data.stateIdx];
    if (reset) this.setData({ loading: true });

    let url;
    let q;
    if (kind.key === 'message') {
      url = '/admin/message/list';
      q = { status: state, page, pageSize: this.data.pageSize };
    } else if (kind.key === 'draft') {
      url = '/partner/draft/review';
      q = { status: state, page, pageSize: this.data.pageSize };
    } else {
      url = '/admin/submit/list';
      q = { type: kind.type, reviewStatus: state, page, pageSize: this.data.pageSize };
    }

    return adminRequest(url, 'GET', q)
      .then((d) => {
        const rows = (d && d.list) || [];
        const mapped = rows.map((r) => decorate(r, kind, state));
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

  onApprove(e) {
    const id = e.currentTarget.dataset.id;
    const kind = this.currentKind();
    let req;
    if (kind.key === 'message') {
      req = adminRequest(`/admin/message/${id}/approve`, 'PUT');
    } else if (kind.key === 'draft') {
      req = adminRequest(`/partner/draft/${id}/review`, 'PUT', { approve: true });
    } else {
      req = adminRequest(`/admin/submit/${id}/approve`, 'PUT');
    }
    wx.showLoading({ title: '处理中', mask: true });
    req
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
        if (isConflict(err)) {
          wx.showToast({ title: (err && err.message) || '这条刚被处理过，已刷新', icon: 'none' });
          this.fetchList(true);
          this.fetchCounts();
          return;
        }
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /**
   * 驳回：提交表跳处理台（理由必填，列表页放不下）；
   * 留言表 / 内部稿件没有处理台 ⇒ 就地用可输入的 modal 收理由。
   */
  onReject(e) {
    const id = e.currentTarget.dataset.id;
    const kind = this.currentKind();
    if (kind.key === 'song' || kind.key === 'article') {
      this.openDetail(id, 'reject');
      return;
    }
    const isDraft = kind.key === 'draft';
    wx.showModal({
      title: isDraft ? '驳回稿件' : '屏蔽留言',
      editable: true,
      placeholderText: '请填写驳回理由（作者能看到）',
      confirmText: '驳回',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写理由', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '处理中', mask: true });
        const req = isDraft
          ? adminRequest(`/partner/draft/${id}/review`, 'PUT', { approve: false, reason })
          : adminRequest(`/admin/message/${id}/reject`, 'PUT', { reason });
        req
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: isDraft ? '已驳回' : '已屏蔽', icon: 'success' });
            this.setData({
              list: this.data.list.filter((x) => x.id !== id),
              total: Math.max(0, this.data.total - 1),
            });
            this.fetchCounts();
          })
          .catch((err) => {
            wx.hideLoading();
            if (isConflict(err)) {
              wx.showToast({ title: (err && err.message) || '这条刚被处理过，已刷新', icon: 'none' });
              this.fetchList(true);
              this.fetchCounts();
              return;
            }
            wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
          });
      },
    });
  },

  openDetail(idOrEvent, focus) {
    const id = typeof idOrEvent === 'object' ? idOrEvent.currentTarget.dataset.id : idOrEvent;
    const url = `/pages-partner/review-detail/detail?id=${id}${focus ? `&focus=${focus}` : ''}`;
    wx.navigateTo({
      url,
      // 处理台里审完一条 → 回来时列表与计数都要最新
      events: {
        reviewed: () => {
          this.fetchList(true);
          this.fetchCounts();
        },
      },
    });
  },

  /** 点整行进详情：内部稿件没有处理台 ⇒ 去版本页看全文；其余进审核处理台 */
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.currentKind().key === 'draft') {
      wx.navigateTo({ url: `/pages-partner/work/versions/versions?id=${id}` });
      return;
    }
    this.openDetail(id);
  },
});

/** 接口行 → 视图行（业务表达式全在这里算好，wxml 里不写） */
function decorate(r, kind, state) {
  const pending = state === kind.states[0];
  const approved = state === kind.states[1];
  const isSong = kind.key === 'song';
  const isMessage = kind.key === 'message';
  const isDraft = kind.key === 'draft';

  let title = '';
  let note = '';
  let meta = '';
  if (isDraft) {
    title = r.title || '未命名稿件';
    note = [r.columnName || '未选栏目', `${r.wordCount || 0} 字`, mmss(r.seconds)].join(' · ');
    meta = [r.authorName || '伙伴', fmtMd(r.submittedAt || r.updateTime)].filter(Boolean).join(' · ');
  } else if (isMessage) {
    title = r.content || '（空留言）';
    note = '';
    meta = [r.nickname || '匿名', r.programName || ''].filter(Boolean).join(' · ');
  } else if (isSong) {
    // 原型里点歌标题带书名号（《夜空中最亮的星》），文稿标题不带
    const nm = r.songName ? `《${r.songName}》` : '';
    title = [nm, r.singer].filter(Boolean).join(' · ') || '（未填歌曲）';
    note = r.wishContent || '';
    meta = [r.nickname || '匿名', r.wantBroadcastTime ? '期望 ' + r.wantBroadcastTime : '']
      .filter(Boolean).join(' · ');
  } else {
    title = r.articleTitle || '（无标题）';
    note = r.articleContent || '';
    meta = r.nickname || '匿名';
  }

  return {
    id: r.id,
    pending,
    kindText: kind.label,
    tagCls: pending ? kind.tagCls : (approved ? 'done' : 'no'),
    stateText: approved ? '已通过' : (isMessage ? '已屏蔽' : '已驳回'),
    title,
    note,
    meta,
    timeText: fmtMd(isDraft ? (r.submittedAt || r.updateTime) : r.createTime),
  };
}

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
