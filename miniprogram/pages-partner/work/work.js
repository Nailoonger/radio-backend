// pages-partner/work/work.js · v1（2026-10-28 稿件模块）
//
// 我的稿件：状态 3 档（待审核 / 已通过 / 已驳回）× 列表 + 顶部「继续写」+ 沉底导出。
// 数据：GET /partner/draft/list?status=&page=   （服务端按 personId 只给本人的稿）
// 计数：同一个接口顺带返回 counts（不让前端再打 4 次）
//
// ⚠️ 状态是**服务端权威**（0 草稿 / 1 待审 / 2 通过 / 3 驳回），前端只做文案与配色映射。
// ⚠️⚠️ tab 只有 3 档，**没有「草稿」**（陛下 2026-10-30：「151 方案没有草稿啊删掉」）。
//    原型里草稿由顶部那张卡承接（「继续写今天这篇」= 最近一篇草稿）；
//    之前多给的「草稿」tab 是自创，已删。草稿仍可续写，只是不占一个状态位。
// ⚠️ AI 找稿 / AI 续写没有服务端能力 ⇒ 不做入口，不编假功能。

const { adminRequest } = require('../../utils/request.js');

const TABS = [
  { key: 'pending',  status: 1, label: '待审核', cntKey: 'pending' },
  { key: 'approved', status: 2, label: '已通过', cntKey: 'approved' },
  { key: 'rejected', status: 3, label: '已驳回', cntKey: 'rejected' },
];

const TARGET_SECONDS = 180;   // 默认目标 3:00（原型「2:11 / 3:00」）

function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(typeof v === 'number' ? v : String(v).replace(/-/g, '/'));
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: {
    statusBarHeight: 20,
    ready: false,
    roleKey: 'manager',
    badges: {},
    tabs: TABS.map((t) => ({ key: t.key, label: t.label, count: 0 })),
    tabIdx: 0,
    counts: { draft: 0, pending: 0, approved: 0, rejected: 0 },
    list: [],
    latest: null,
    loading: true,
    page: 1,
    pageSize: 20,
    hasMore: false,
    emptyText: '还没有稿件，点上面新建一篇',
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      ready: true,
      roleKey: Number(info.role) === 0 ? 'super' : 'manager',
    });
    this.fetchList(true);
    this.refreshBadges();
  },

  onShow() {
    // 从编辑器 / 版本页回来要刷新（状态可能变了）
    if (this.data.ready) {
      this.fetchList(true);
      this.refreshBadges();
    }
  },

  onPullDownRefresh() {
    Promise.all([this.fetchList(true), this.refreshBadges()])
      .then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.fetchList(false);
  },

  switchTab(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (idx === this.data.tabIdx) return;
    this.setData({ tabIdx: idx, list: [], page: 1, hasMore: false, loading: true });
    this.fetchList(true);
  },

  fetchList(reset) {
    const page = reset ? 1 : this.data.page + 1;
    const tab = TABS[this.data.tabIdx];
    if (reset) this.setData({ loading: true });

    return adminRequest('/partner/draft/list', 'GET', {
      status: tab.status, page, pageSize: this.data.pageSize,
    })
      .then((d) => {
        const rows = (d && d.list) || [];
        const mapped = rows.map((r) => {
          const st = Number(r.status) || 0;
          return {
            id: r.id,
            title: r.title || '未命名稿件',
            meta: [r.columnName || '未选栏目', `${r.wordCount} 字`, mmss(r.seconds), fmtTime(r.updateTime)]
              .filter(Boolean).join(' · '),
            statusText: r.statusText || '',
            tagCls: st === 2 ? 'done' : (st === 3 ? 'no' : (st === 1 ? 'warn' : 'gray')),
            rejectReason: r.rejectReason || '',
          };
        });
        const merged = reset ? mapped : this.data.list.concat(mapped);
        const total = Number((d && d.total) || 0);
        const counts = (d && d.counts) || this.data.counts;
        const tabs = TABS.map((t) => ({ key: t.key, label: t.label, count: Number(counts[t.cntKey]) || 0 }));
        this.setData({
          list: merged,
          page,
          hasMore: merged.length < total,
          loading: false,
          counts,
          tabs,
          emptyText: ['没有在审的稿', '还没有通过的稿', '没有被驳的稿'][this.data.tabIdx] || '还没有稿件，点上面新建一篇',
        });
        return d;
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /** 顶部卡：最近一篇草稿（没有就显示「写新稿」） */
  fetchLatest() {
    return adminRequest('/partner/draft/list', 'GET', { status: 0, page: 1, pageSize: 1 })
      .then((d) => {
        const r = (d && d.list && d.list[0]) || null;
        this.setData({
          latest: r ? {
            id: r.id,
            columnName: r.columnName,
            timeText: mmss(r.seconds),
            targetText: mmss(TARGET_SECONDS),
          } : null,
        });
      })
      .catch(() => this.setData({ latest: null }));
  },

  /** 底栏角标：审核 = 投稿待审 + 留言待审；稿件 tab 给「自己待审 + 被驳」的数量提示 */
  refreshBadges() {
    const one = (url, q) =>
      adminRequest(url, 'GET', Object.assign({ page: 1, pageSize: 1 }, q))
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0);
    return Promise.all([
      one('/admin/submit/list', { reviewStatus: 0 }),
      one('/admin/message/list', { status: 0 }),
      this.fetchLatest(),
    ]).then(([a, b]) => this.setData({
      badges: {
        desk: 0, home: 0, submissions: a + b,
        'my-drafts': 0, scheduling: 0, schedule: 0, me: 0,
      },
    }));
  },

  /** AI 找稿：服务未接入，按钮照方案摆着，点了如实告知 */
  onAiFind() {
    wx.showModal({
      title: 'AI 找稿',
      content: '该功能暂未开放，敬请期待。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onNew() {
    wx.navigateTo({ url: '/pages-partner/work/editor/editor' });
  },

  onContinue() {
    const id = this.data.latest && this.data.latest.id;
    if (!id) {
      this.onNew();
      return;
    }
    wx.navigateTo({ url: `/pages-partner/work/editor/editor?id=${id}` });
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    // 列表里只会有待审/通过/驳回三种，统一进版本记录（正文只读在版本页里看）。
    // 草稿不占 tab，从顶部「继续写今天这篇」卡进编辑器。
    wx.navigateTo({ url: `/pages-partner/work/versions/versions?id=${id}` });
  },

  /**
   * 导出已通过的稿：拉全量 → 拼成纯文本 → 复制到剪贴板。
   * 不做「生成文件 / 分享」——那需要后端出 xlsx 或文档，不在这里造。
   */
  onExport() {
    wx.showLoading({ title: '整理中', mask: true });
    adminRequest('/partner/draft/list', 'GET', { status: 2, page: 1, pageSize: 50 })
      .then((d) => {
        const rows = (d && d.list) || [];
        if (!rows.length) {
          wx.hideLoading();
          wx.showToast({ title: '还没有通过的稿', icon: 'none' });
          return null;
        }
        return Promise.all(rows.map((r) =>
          adminRequest(`/partner/draft/${r.id}`, 'GET', {}).catch(() => null)))
          .then((full) => {
            const text = full.filter(Boolean).map((x) =>
              `${x.title}\n${x.columnName || ''} · ${x.wordCount} 字 · ${mmss(x.seconds)}\n\n${x.body || ''}`
            ).join('\n\n──────────\n\n');
            wx.hideLoading();
            wx.setClipboardData({
              data: text,
              success: () => wx.showToast({ title: `已复制 ${full.filter(Boolean).length} 篇`, icon: 'success' }),
            });
            return null;
          });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '导出失败', icon: 'none' });
      });
  },

  onTab(e) {
    const id = e.detail && e.detail.id;
    if (!id || id === 'my-drafts') return;
    const map = {
      desk: '/pages-partner/desk/desk',
      home: '/pages-partner/desk/desk',
      submissions: '/pages-partner/review/review',
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
});
