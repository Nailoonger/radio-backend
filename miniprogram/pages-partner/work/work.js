// pages-partner/work/work.js · v2（2026-11-01 加回草稿箱）
//
// 我的稿件：状态 4 档（草稿箱 / 待审核 / 已通过 / 已驳回）× 列表 + 顶部「继续写」+ 沉底导出。
// 数据：GET /partner/draft/list?status=&page=   （服务端按 personId 只给本人的稿）
// 计数：同一个接口顺带返回 counts（不让前端再打 4 次）
//
// ⚠️ 状态是**服务端权威**（0 草稿 / 1 待审 / 2 通过 / 3 驳回），前端只做文案与配色映射。
// ⚠️⚠️ tab 的历史（别再来回改）：
//    2026-10-30 陛下让删掉「草稿」tab（当时的依据是 v151 里草稿由顶部卡承接）；
//    2026-11-01 陛下又要回来 —— 顶部那张「继续写」只给最近一篇，草稿多了就没法找。
//    现在 4 档，草稿箱排第一（自己还没交的东西最先看见），点行直接进编辑器续写。
// ⚠️ AI 找稿 / AI 续写没有服务端能力 ⇒ 不做入口，不编假功能。

const { adminRequest } = require('../../utils/request.js');
const partnerTodo = require('../../utils/partnerTodo.js');
const partnerRole = require('../../utils/partnerRole.js');

const TABS = [
  { key: 'draft',    status: 0, label: '草稿箱', cntKey: 'draft' },
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
      // ⚠️⚠️ admin.role 三档：0 超管 / 1 社干 / 2 站员，**三档都要写**。
      //    这里原来只有 `=== 0 ? 'super' : 'manager'`，站员（2）被当成社干 ⇒
      //    底栏按 manager 渲染出「审核」那格，点进去才被拦「暂无审核权限」（2026-10-31 陛下报的）。
      //    口径与 me.js / schedule/index.js / desk.js#roleKeyOf 一致，别在这里另发明一套。
      roleKey: Number(info.role) === 0 ? 'super' : (Number(info.role) === 2 ? 'member' : 'manager'),
    });
    this.fetchList(true);
    this.refreshBadges();
  },

  onShow() {
    // 从编辑器 / 版本页回来要刷新（状态可能变了）
    if (this.data.ready) {
      this.syncRole();
      this.fetchList(true);
      this.refreshBadges();
    }
  },

  /**
   * 角色对账（2026-11-02）：电脑端改完角色，切回来底栏就跟着变
   * ⚠️ 这一页三档都能进（站员也叫「稿件」），所以只重排不跳转。
   */
  syncRole() {
    return partnerRole.sync()
      .then((r) => {
        if (this._gone || !r || !r.changed) return;
        const roleKey = partnerRole.roleKeyOf(r.next);
        if (!roleKey) return;
        partnerRole.toastChanged();
        this.setData({ roleKey });
      })
      .catch(() => null);
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
          // ⚠️ 顺序与 TABS 一一对应（草稿箱在最前）；漏一项就会串到下一档的文案
          emptyText: ['草稿箱是空的，点上面「写新稿」起一篇', '没有在审的稿', '还没有通过的稿', '没有被驳的稿'][this.data.tabIdx] || '还没有稿件',
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

  /**
   * 底栏角标（2026-11-01 统一）：走 utils/partnerTodo.js，五张 tab 页同一个函数。
   * ⚠️ 原来这里 desk/home 写死 0 —— 停在稿件页时工作台的红点是灭的，跟工作台页对不上。
   */
  refreshBadges() {
    return Promise.all([
      partnerTodo.fetchBadges(this.data.roleKey),
      this.fetchLatest(),
    ]).then(([b]) => this.setData({ badges: b }))
      .catch(() => this.setData({ badges: partnerTodo.emptyBadges() }));
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
    // 草稿箱那档点进去 = 接着写（编辑器）；其余三档是只读的结论，进版本记录页看正文与历史
    if (TABS[this.data.tabIdx] && TABS[this.data.tabIdx].status === 0) {
      wx.navigateTo({ url: `/pages-partner/work/editor/editor?id=${id}` });
      return;
    }
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
