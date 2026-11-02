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
const partnerTodo = require('../../utils/partnerTodo.js');
const partnerRole = require('../../utils/partnerRole.js');

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
    /**
     * 拒绝态**只有这一句**：后端三档权限的 deny 统一是「暂无权限」四个字（2026-11-01 陛下定）。
     * ⚠️ 别再往上加「找超管开通」之类的副文案 —— 被关掉的人不需要被指点去找谁。
     */
    denyReview: '暂无权限',
    /**
     * 是不是 role=1 的社干 —— **只有他吃「审核权限」这道开关**。
     * ⚠️ 不能用 roleKey 判：roleKey 是给底栏用的呈现值（super / manager / member），
     *    权限开关只认角色码 role===1，两件事别混。
     */
    roleManager: false,
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
      // ⚠️ 三档都要写：0 超管 / 1 社干 / 2 站员。原来只判 0，站员会被当成社干渲染出底栏
      //    「审核」格（自己高亮自己），点进去才被拦 —— 口径见 work.js 同一处注释。
      roleKey: Number(info.role) === 0 ? 'super' : (Number(info.role) === 2 ? 'member' : 'manager'),
      roleManager: Number(info.role) === 1,
      kindIdx,
      stateLabels: KINDS[kindIdx].key === 'message' ? STATE_MESSAGE : STATE_SUBMIT,
    });

    /**
     * 2026-10-31：社干被关掉「审核权限」⇒ 整页就一句「暂无权限」，**一个请求都不发**。
     * 只靠列表接口返回空是骗人的（看着像「今天没人投稿」），所以做成显式的拒绝态。
     * 超管恒放行。
     *
     * ⚠️ 站员（role=2）同样不发请求：审核是社干的活，站员底栏里根本没有这一格
     *    （原来 roleKey 只判 0，站员会被当成社干渲染出「审核」tab，点进来才被拦 —— 已修）。
     *    这里兜的是「绕过底栏直接进这页」的情况：给同样一句话，不额外解释谁该找谁。
     */
    if (Number(info.role) === 2) {
      this.setData({ loading: false, denied: true, denyReview: '暂无权限' });
      return;
    }
    if (Number(info.role) === 1) {
      return perm.load().then((pm) => {
        if (this._gone) return;
        if (pm && pm.review === false) {
          this.setData({
            loading: false,
            denied: true,
            denyReview: (pm.text && pm.text.review) || '暂无权限',
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

  onUnload() {
    perm.stopPolling('review');
    this._gone = true;
  },

  onShow() {
    /* 角色可能刚被超管在电脑端改过（2026-11-02）：先用服务端把 roleKey 对一遍，
       站员根本没有「审核」这一格 —— 留在原地只会在点每个按钮时被 40301。
       ⚠️ 放在权限位刷新之前：角色变了，下面那套 perm 判定整体就不成立。 */
    this.syncRole();
    /* 权限可能刚被超管改过：切回来先对一次，再决定要不要刷角标
       （2026-10-31：原来只在 onLoad 判一次，改完不重新登录就一直是旧状态） */
    this.refreshPermState().then(() => {
      if (this.data.ready) this.refreshBadges();
    });
    /* 停在审核页不动时也要收到权限变化（10 秒一轮）：
       这一页最需要它 —— 整页「能审 / 不能审」两态，靠切页面才能变太迟钝。 */
    if (this.data.roleManager) {
      perm.startPolling('review', (pm) => this.refreshPermState(pm));
    }
  },

  /**
   * 角色对账（2026-11-02）：站员被降权 / 社干升超管，都把界面按新角色重排
   * ⚠️ 降到站员时**必须离开这一页**：底栏 5 格变 4 格，页面本身也不属于站员，
   *    留在原地等于给了一个每点都 40301 的空壳。
   */
  syncRole() {
    return partnerRole.sync()
      .then((r) => {
        if (this._gone || !r || !r.changed) return null;
        const roleKey = partnerRole.roleKeyOf(r.next);
        if (!roleKey) return null;
        partnerRole.toastChanged();
        if (roleKey === 'member') {
          perm.stopPolling('review');
          wx.reLaunch({ url: '/pages-partner/desk/desk' });
          return null;
        }
        this.setData({ roleKey, roleManager: Number(r.next) === 1 });
        return this.refreshPermState(null, true);
      })
      .catch(() => null);
  },

  onHide() { perm.stopPolling('review'); },

  /**
   * 重新对一次「审核权限」，变了就当场切换整页形态
   *
   * ⚠️ 只在这一页做：它整页就是「能审 / 不能审」两态，
   *    不像班表页那样可以「入口拦住但页面照看」。
   * @param {object} [known] 轮询已经拿到的权限位（传了就不再问一次）
   * @param {boolean} [force] 忽略缓存（下拉刷新用）
   */
  refreshPermState(known, force) {
    if (!this.data.ready || !this.data.roleManager) return Promise.resolve();
    const get = known ? Promise.resolve(known) : perm.load(force === true);
    return get.then((pm) => {
      if (this._gone || !pm) return;
      const deniedNow = pm.review === false;
      if (deniedNow === this.data.denied) return;
      this.setData({
        denied: deniedNow,
        denyReview: (pm.text && pm.text.review) || '暂无权限',
      });
      // 从只读恢复成可用：把数据补上（之前一个请求都没发）
      if (!deniedNow) {
        this.fetchCounts();
        this.fetchList(true);
      }
      this.refreshBadges();
    });
  },

  /**
   * 下拉刷新（2026-10-31 陛下指定为主路径）
   * ⚠️ 权限必须一起强制重取：不然「审核权限刚被关掉」时拉一下还是旧列表。
   */
  onPullDownRefresh() {
    Promise.all([
      this.refreshPermState(null, true),
      this.fetchCounts(),
      this.fetchList(true),
    ]).then(
      () => wx.stopPullDownRefresh(),
      () => wx.stopPullDownRefresh()
    );
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchList(false);
  },

  /** 当前类型（不可放 data，函数里现取） */
  currentKind() {
    return KINDS[this.data.kindIdx] || KINDS[0];
  },

  /**
   * 角标：一律走 utils/partnerTodo.js（2026-11-01 统一，五张 tab 页同一个函数）
   *
   * ⚠️ 原来这里把 `desk/home` 写死 0 —— 停在「审核」页时工作台那个红点是灭的，
   *    和「工作台」页对不上，看着就像计数器坏了。
   */
  refreshBadges() {
    /* 被关掉审核权限时不要留角标：一个数字在勾着人来点，点进来只有一句「暂无审核权限」 */
    if (this.data.denied) {
      this.setData({ badges: partnerTodo.emptyBadges() });
      return Promise.resolve();
    }
    return partnerTodo.fetchBadges(this.data.roleKey)
      .then((b) => this.setData({ badges: b }))
      .catch(() => this.setData({ badges: partnerTodo.emptyBadges() }));
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
    /**
     * 内部稿件**不许在列表里一键通过**（2026-11-01 陛下：「也要做审核处理台，不能马虎了」）。
     * 列表行只有标题/栏目/字数，看不到正文 —— 从这个位置点「通过」等于闭着眼睛批稿。
     * 所以稿件统一进处理台，在那儿看全文、写理由、再决定。
     */
    if (kind.key === 'draft') {
      this.openDetail(id, '', 'draft');
      return;
    }
    let req;
    if (kind.key === 'message') {
      req = adminRequest(`/admin/message/${id}/approve`, 'PUT');
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
   * 驳回：点歌 / 文稿 / **内部稿件** 一律跳处理台（理由必填 + 要能看着正文写）；
   * 只有留言表没有处理台 ⇒ 就地用可输入的 modal 收理由（留言本身就在列表里看全了）。
   */
  onReject(e) {
    const id = e.currentTarget.dataset.id;
    const kind = this.currentKind();
    if (kind.key !== 'message') {
      this.openDetail(id, 'reject', kind.key);
      return;
    }
    wx.showModal({
      title: '屏蔽留言',
      editable: true,
      placeholderText: '请填写屏蔽理由',
      confirmText: '屏蔽',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return;
        const reason = (res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写理由', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '处理中', mask: true });
        const req = adminRequest(`/admin/message/${id}/reject`, 'PUT', { reason });
        req
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已屏蔽', icon: 'success' });
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

  /**
   * 打开审核处理台
   * @param {number|Event} idOrEvent
   * @param {string} [focus] 'reject' = 进去直接滚到理由箱
   * @param {string} [kindKey] 'draft' = 内部稿件（处理台按它换接口与文案）
   */
  openDetail(idOrEvent, focus, kindKey) {
    const id = typeof idOrEvent === 'object' ? idOrEvent.currentTarget.dataset.id : idOrEvent;
    const url = `/pages-partner/review-detail/detail?id=${id}`
      + (focus ? `&focus=${focus}` : '')
      + (kindKey === 'draft' ? '&kind=draft' : '');
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
    // 内部稿件也进处理台（看全文再批）；版本/原稿留给作者自己的「稿件」页去看
    const kind = this.currentKind();
    this.openDetail(id, '', kind.key);
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
    /**
     * 这一行的「通过/驳回」是不是要先进处理台看一眼。
     * 内部稿件必须看全文（列表只有标题/栏目/字数），所以它不出两个按钮，只出一个「处理」。
     */
    byDetail: isDraft,
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
