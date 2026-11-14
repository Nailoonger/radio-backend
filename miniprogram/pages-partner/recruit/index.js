// pages-partner/recruit/index · v2（2026-11-14 照 preview/partner-hub-gounucai-v174 V.recruit）
//
// ═══════════════════════════════════════════════════════════════════════════
// 逐条对齐 v174 的 `V.recruit`：
//   ① 一张批次卡 `.hero.lt`：名称 / 报名时间 + 介绍 / 两个 tag / **四格统计**
//      （报名 · 待审 · 待面试 · 已拟定），下段一条 hairline 与上段分隔——
//      v162 把原来「身份卡 + 计数卡」合成一张，不再叠两张白卡。
//   ② 三个入口行（报名列表 / 面试安排 / 批次管理），每行右端一句补充值。
//   ③ 页底一句 cp-note：批次由超管建，社干能看能审。
//   ④ **这页不放任何操作**（v170 把「批次操作」整块删掉，发布/截止/归档都不在这儿）。
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 四格数字怎么来（服务端没有「总计」接口）：
//   `GET /admin/recruitment/applications` 一次只认一个 status，返回体带 total。
//   所以并发拉 5 次 pageSize=1，只取 total —— 比「拉一页在前端数」准，报名超过一页时前者会少。
//   ⚠️ 批次设了统一面试安排后，status=submitted 服务端**故意返回空页**
//      （services/recruitment.js#applications 里那句注释）⇒ 待审显示 0 是对的，不是 bug。
//
// ⚠️ 社干看不到「新建批次」：createBatch 是 asSuper。入口不摆出来，免得点了才被 40301 拦。

const { adminRequest, isConflict, isVersionConflict } = require('../../utils/request.js');
const partnerRole = require('../../utils/partnerRole.js');
const { fmtIso } = require('../../utils/format.js');

const STATE_TEXT = { draft: '草稿', upcoming: '未开始', open: '报名中', closed: '已截止' };
/* 状态 → v174 的 tag 色调：报名中 ok（accent 浅底）/ 草稿 warn / 已截止 no / 未开始 gray */
const STATE_CLS = { draft: 'warn', upcoming: 'gray', open: 'ok', closed: 'no' };
/* 挑「当前批次」的顺序：正在报名 > 马上开 > 草稿 > 刚截止（服务端已按 createdAt desc 排好） */
const PICK = ['open', 'upcoming', 'draft', 'closed'];
const STATUSES = ['submitted', 'interview', 'accepted', 'rejected', 'withdrawn'];

function shortDay(iso) {
  const s = fmtIso(iso);                 // 'MM-DD HH:mm'
  return s ? s.slice(0, 5) : '';
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    err: '',
    roleKey: '',
    canManage: false,
    b: null,
    rows: [],
    batchCount: 0,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const r = partnerRole.known(partnerRole.role()) ? partnerRole.role() : Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      roleKey: partnerRole.roleKeyOf(r),
      canManage: r === 0,
    });
    if (!partnerRole.known(partnerRole.role())) {
      partnerRole.ensure().then((n) => {
        if (n === 0) this.setData({ canManage: true, roleKey: 'super' });
        else if (partnerRole.known(n)) this.setData({ roleKey: partnerRole.roleKeyOf(n) });
      });
    }
    this.load();
  },

  onShow() { if (this._ready) this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: !this._ready, err: '' });
    return adminRequest('/admin/recruitment/batches?archived=false&pageSize=50', 'GET')
      .then((d) => {
        const items = ((d && d.items) || []).map((x) => ({
          id: x.id,
          title: x.title || '未命名批次',
          state: x.windowState,
          published: !!x.publishedAt,
          archived: !!x.archivedAt,
          resultPublished: !!x.resultPublishedAt,
          orderGenerated: !!x.orderGeneratedAt,
          range: shortDay(x.opensAt) && shortDay(x.closesAt)
            ? `${shortDay(x.opensAt)} ~ ${shortDay(x.closesAt)}` : '时间未设置',
          intro: x.intro || '',
          version: x.version,
          interview: x.interview || null,
        }));
        let cur = null;
        for (let i = 0; i < PICK.length && !cur; i += 1) cur = items.find((x) => x.state === PICK[i]) || null;
        this.setData({ batchCount: items.length });
        if (!cur) {
          this._ready = true;
          this.setData({
            loading: false,
            b: null,
            rows: [{ key: 'batches', t: '批次管理', d: `共 ${items.length} 个批次` }],
          });
          return null;
        }
        return this.loadCounts(cur, items.length);
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  /* 四格数字：并发拉 5 个 status 的 total（pageSize=1，只要数） */
  loadCounts(cur, batchCount) {
    this._ready = true;
    const base = `/admin/recruitment/applications?batchId=${encodeURIComponent(cur.id)}&page=1&pageSize=1`;
    return Promise.all(STATUSES.map((s) => adminRequest(`${base}&status=${s}`, 'GET')
      .then((r) => Number((r && r.total) || 0))
      .catch(() => 0)))
      .then((n) => {
        const submitted = n[0];
        const interview = n[1];
        const accepted = n[2];
        const rejected = n[3];
        const withdrawn = n[4];
        const all = submitted + interview + accepted + rejected + withdrawn;
        const decided = accepted + rejected;
        const itv = cur.interview || null;
        const planText = itv && itv.at ? `统一 ${fmtIso(itv.at)}` : '统一未安排';
        this.setData({
          loading: false,
          b: {
            id: cur.id,
            title: cur.title,
            state: cur.state,
            stateText: STATE_TEXT[cur.state] || cur.state,
            stateCls: STATE_CLS[cur.state] || 'gray',
            range: cur.range,
            intro: cur.intro,
            resultText: cur.resultPublished ? '结果已发布' : '结果未发布',
            resultCls: cur.resultPublished ? 'done' : 'gray',
            numbers: [
              { l: '报名', n: String(all) },
              { l: '待审', n: String(submitted) },
              { l: '待面试', n: String(interview) },
              { l: '已拟定', n: String(decided) },
            ],
          },
          rows: [
            { key: 'list', t: '报名列表', d: `${all} 人 · 待审 ${submitted}` },
            { key: 'interview', t: '面试安排', d: `${planText} · ${cur.orderGenerated ? '序号已生成' : '序号未生成'}` },
            { key: 'batches', t: '批次管理', d: `共 ${batchCount} 个批次` },
          ],
        });
      })
      .catch((err) => {
        this.setData({ loading: false, err: (err && err.message) || '加载失败' });
      });
  },

  onRow(e) {
    const key = e.currentTarget.dataset.key;
    const b = this.data.b;
    if (key === 'batches') { wx.navigateTo({ url: '/pages-partner/recruit/batches/batches' }); return; }
    if (!b) return;
    if (key === 'list') {
      wx.navigateTo({ url: `/pages-partner/recruit/list/list?batchId=${b.id}` });
      return;
    }
    if (key === 'interview') {
      wx.navigateTo({ url: `/pages-partner/recruit/interview/interview?batchId=${b.id}` });
    }
  },
});
