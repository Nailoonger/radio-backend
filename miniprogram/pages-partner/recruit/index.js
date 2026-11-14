// pages-partner/recruit/index · v1（2026-11-14 招新总览）
//
// 招新这条线的入口页：一张「当前批次」卡 + 三个下级入口。
//
// ⚠️ 数据只有一处：`GET /admin/recruitment/batches?archived=false`。
//    服务端**没有**按状态分段的口径（query 只认 archived），所以「当前批次」是前端从
//    未归档列表里挑出来的 —— 优先 报名中 > 未开始 > 草稿 > 已截止，同档取 createdAt 最新
//    （服务端已按 createdAt desc 排好，取第一条即可）。
//
// ⚠️ 名额/报名人数：服务端 admin 侧只给 `unresolvedCount`（还没定结果的条数），
//    **没有总报名数**。所以卡片上只写「待定 N 人」，不写「共 N 人」——不编数据。
//
// ⚠️ 社干能进这一页（asAdmin 放行列表与详情），但新建/发布/截止/删除全是 asSuper。
//    所以「新建批次」只给超管，其余人看到的是一句「等超管开批次」。

const { adminRequest } = require('../../utils/request.js');
const partnerRole = require('../../utils/partnerRole.js');
const { fmtIso } = require('../../utils/format.js');

const WINDOW_TEXT = { draft: '草稿', upcoming: '未开始', open: '报名中', closed: '已截止' };
/* 挑「当前批次」的顺序：正在报名的最要紧，其次马上要开的，再次草稿，最后刚截止的 */
const PICK_ORDER = ['open', 'upcoming', 'draft', 'closed'];

function shortDay(iso) {
  const s = fmtIso(iso);            // 'MM-DD HH:mm'（取墙钟字段，不做时区换算）
  return s ? s.slice(0, 5) : '未设置';
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    ready: false,
    canManage: false,
    batch: null,
    entries: [],
    hasAny: false,
    err: '',
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const roleNum = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      canManage: roleNum === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((r) => {
        if (r === 0 && !this.data.canManage) this.setData({ canManage: true });
      });
    }
    this.load();
  },

  onShow() {
    /* 从配置页返回时批次可能已经改了（发布/截止），回来重拉一次 */
    if (this.data.ready) this.load();
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true, err: '' });
    return adminRequest('/admin/recruitment/batches?archived=false&pageSize=20', 'GET')
      .then((d) => {
        const items = ((d && d.items) || []).map((x) => ({
          id: x.id,
          title: x.title || '未命名批次',
          state: x.windowState,
          stateText: WINDOW_TEXT[x.windowState] || x.windowState,
          range: shortDay(x.opensAt) + ' — ' + shortDay(x.closesAt),
          unresolved: Number(x.unresolvedCount) || 0,
          archived: !!x.archivedAt,
          resultPublished: !!x.resultPublishedAt,
          published: !!x.publishedAt,
          orderGenerated: !!x.orderGeneratedAt,
          orderCount: Number(x.interviewOrderCount) || 0,
        }));
        let batch = null;
        for (let i = 0; i < PICK_ORDER.length && !batch; i += 1) {
          batch = items.find((x) => x.state === PICK_ORDER[i]) || null;
        }
        this.setData({
          loading: false,
          ready: true,
          hasAny: items.length > 0,
          batch,
          entries: this.buildEntries(batch),
        });
      })
      .catch((err) => {
        this.setData({ loading: false, ready: true, err: (err && err.message) || '加载失败' });
      });
  },

  /* 入口行：没有当前批次时只留「批次管理」，不做点进去空转的假入口。
     ⚠️ 「面试顺序」只在批次**发布过**之后出现 —— 草稿/未开始时打开只会是空名单，
        跟电脑端一致（Recruitment.vue: `v-if="selectedBatch.publishedAt"`）。 */
  buildEntries(batch) {
    const rows = [];
    if (batch) {
      rows.push({ key: 'list', t: '报名列表', d: '待审 · 待面试 · 拟录取', n: batch.unresolved, u: '待定' });
      if (batch.published) {
        rows.push({
          key: 'order',
          t: '面试顺序',
          d: batch.orderGenerated ? '叫号名单 · 可导出' : '截止后生成随机顺序',
          n: batch.orderGenerated ? batch.orderCount : null,
          u: '人',
        });
      }
      rows.push({ key: 'config', t: '批次配置', d: '报名时间 · 固定信息 · 题目', n: null, u: '' });
    }
    rows.push({ key: 'batches', t: '批次管理', d: '进行中 · 已截止 · 已归档', n: null, u: '' });
    return rows;
  },

  onEntry(e) {
    const key = e.currentTarget.dataset.key;
    const batch = this.data.batch;
    if (key === 'batches') { wx.navigateTo({ url: '/pages-partner/recruit/batches/batches' }); return; }
    if (!batch) return;
    if (key === 'list') {
      wx.navigateTo({ url: `/pages-partner/recruit/list/list?batchId=${batch.id}` });
      return;
    }
    if (key === 'config') {
      wx.navigateTo({ url: `/pages-partner/recruit/config/config?batchId=${batch.id}` });
      return;
    }
    if (key === 'order') {
      wx.navigateTo({ url: `/pages-partner/recruit/order/order?batchId=${batch.id}` });
    }
  },

  onNew() {
    if (!this.data.canManage) return;
    wx.navigateTo({ url: '/pages-partner/recruit/batches/batches?create=1' });
  },
});
