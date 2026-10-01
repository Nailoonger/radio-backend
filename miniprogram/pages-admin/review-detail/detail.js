// pages-admin/review-detail/detail.js
//
// 审核处理台（2026-10-01）
//
// 视觉 = v6 的 L1「白卡大投影」：页面底退成羊皮纸灰，卡片浮起来（第 3 档投影），
// 描边全去；卡内的次级块（名额条、文本域）退回灰底 —— 白卡里嵌灰块。
// 不引入任何新颜色，投影全是纯黑透明（三通道极差 0，不是彩色投影）。
//
// 数据全部来自 GET /admin/submit/:id（含 submitter 统计、statusHistory、card）。
//
// ⚠️ 两条硬约束决定这里的交互：
//   ① 驳回理由服务端硬校验必填（admin/submit.js）→ 「驳回」在理由为空时不可点
//   ② 审核通过会进排期 → 通过后 reload 才是最终态，这里以列表刷新为准（emit 给上一页）

const { adminRequest } = require('../../utils/request.js');
const { fmtMd, fmtIso, fmtSlot } = require('../../utils/format.js');

/** 驳回理由预设 —— 与 admin-web SubmitList.vue 保持同一套，不新增语义 */
const PRESETS = [
  '内容不适合播出',
  '重复投稿',
  '信息不完整',
  '歌词内容不适宜',
  '该曲一周内已点过',
];

Page({
  data: {
    statusBarHeight: 20,
    id: 0,
    loading: true,
    submitting: false,
    notFound: false,

    // 待审队列定位（「第 N / M 条待处理」与上一条 / 下一条）
    pos: 0,
    queueTotal: 0,
    ids: [],

    isSong: true,
    kindText: '点歌',

    person: null,     // 投稿人卡
    rows: [],         // 投稿内容 kv 行
    quota: null,      // 本周名额（仅点歌）
    recordLines: [],  // 审核记录

    presets: PRESETS,
    presetIndex: -1,
    reason: '',
    canReject: false,
  },

  onLoad(options) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-admin/login/login' });
      return;
    }
    const id = Number((options && options.id) || 0);
    const focus = (options && options.focus) || '';

    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      id,
    });

    // 先拿待审队列（用于「第 N / M 条」和翻页），再拉详情
    this.loadQueue()
      .then(() => this.loadDetail(id))
      .then(() => {
        if (focus === 'reject') {
          // 从列表页点「驳回」进来的：直接滚到理由箱
          setTimeout(() => {
            wx.pageScrollTo({ selector: '#rejectBox', duration: 240, offsetTop: 90 });
          }, 260);
        }
      });
  },

  /** 待审队列的 id 列表（只用于定位与翻页，不进 UI 数据） */
  loadQueue() {
    return adminRequest('/admin/submit/list', 'GET', { reviewStatus: 0, page: 1, pageSize: 100 })
      .then((d) => {
        const ids = ((d && d.list) || []).map((x) => x.id);
        this.setData({ ids, queueTotal: ids.length });
        return ids;
      })
      .catch(() => {
        this.setData({ ids: [], queueTotal: 0 });
        return [];
      });
  },

  loadDetail(id) {
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return Promise.resolve();
    }
    this.setData({ loading: true, notFound: false, presetIndex: -1, reason: '', canReject: false });

    return adminRequest(`/admin/submit/${id}`, 'GET')
      .then((d) => {
        if (!d || !d.id) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        const view = decorate(d);
        const idx = this.data.ids.indexOf(id);
        this.setData({
          id: d.id,
          loading: false,
          pos: idx >= 0 ? idx + 1 : 0,
          isSong: view.isSong,
          kindText: view.kindText,
          person: view.person,
          rows: view.rows,
          quota: view.quota,
          recordLines: view.recordLines,
        });
      })
      .catch((err) => {
        this.setData({ loading: false, notFound: true });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  // ── 驳回理由 ────────────────────────────────────────────────
  tapPreset(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const on = this.data.presetIndex === i;
    const reason = on ? '' : PRESETS[i];
    this.setData({ presetIndex: on ? -1 : i, reason, canReject: !!reason });
  },

  inputReason(e) {
    const reason = e.detail.value || '';
    this.setData({ reason, canReject: reason.trim().length > 0, presetIndex: -1 });
  },

  // ── 上一条 / 下一条 ────────────────────────────────────────
  prevOne() {
    const cur = this.data.ids.indexOf(this.data.id);
    if (cur <= 0) return;
    this.loadDetail(this.data.ids[cur - 1]);
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },

  nextOne() {
    const cur = this.data.ids.indexOf(this.data.id);
    if (cur < 0 || cur >= this.data.ids.length - 1) return;
    this.loadDetail(this.data.ids[cur + 1]);
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },

  // ── 通过 / 驳回 ────────────────────────────────────────────
  doApprove() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    wx.showLoading({ title: '处理中', mask: true });

    adminRequest(`/admin/submit/${this.data.id}/approve`, 'PUT')
      .then(() => this.afterDone('已通过'))
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  doReject() {
    if (this.data.submitting) return;
    const reason = String(this.data.reason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请先填写驳回原因', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '处理中', mask: true });

    adminRequest(`/admin/submit/${this.data.id}/reject`, 'PUT', { reason })
      .then(() => this.afterDone('已驳回'))
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /** 处理完一条：通知列表刷新 → 队列里取下一条；没了就退回列表 */
  afterDone(msg) {
    wx.hideLoading();

    // 列表页是通过 navigateTo + events 打开的才有通道；直接进来的（reLaunch）没有上游
    try {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (channel && channel.emit) channel.emit('reviewed');
    } catch (e) { /* 没有上游页面，忽略 */ }

    const cur = this.data.ids.indexOf(this.data.id);
    const ids = this.data.ids.slice();
    if (cur >= 0) ids.splice(cur, 1);

    if (!ids.length) {
      wx.showToast({ title: msg, icon: 'success' });
      setTimeout(() => this.backToList(), 620);
      return;
    }

    const nextIdx = Math.min(Math.max(cur, 0), ids.length - 1);
    this.setData({ ids, queueTotal: ids.length, submitting: false });
    wx.showToast({ title: `${msg}，取下一条`, icon: 'success' });
    this.loadDetail(ids[nextIdx]);
  },

  backToList() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
    } else {
      wx.reLaunch({ url: '/pages-admin/review/review' });
    }
  },

  goBack() {
    this.backToList();
  },
});

/* ---------------------------------------------------------------- *
 * 接口 → 视图
 * ---------------------------------------------------------------- */
function decorate(d) {
  const isSong = Number(d.type) === 1;
  const sub = d.submitter || {};

  const person = {
    initial: String(sub.nickname || '匿').slice(0, 1),
    name: sub.nickname || '匿名',
    sub: [
      sub.className || '',
      `本次第 ${Number(sub.total) || 1} 次投稿`,
    ].filter(Boolean).join(' · '),
    // ⚠️ 按真实来源渲染，不写死：有学号 = 学生账号登录，否则是微信通道
    chip: sub.isAccount ? '学生账号' : '微信用户',
    approved: Number(sub.approved) || 0,
    rejected: Number(sub.rejected) || 0,
    firstAt: sub.firstAt ? fmtMd(sub.firstAt) : '—',
  };

  const rows = [];
  if (isSong) {
    rows.push({
      k: '歌曲',
      v: [d.songName, d.singer].filter(Boolean).join(' · ') || '—',
      strong: true,
    });
    const slot = d.scheduledSlot || d.wantBroadcastTime;
    if (slot) rows.push({ k: '希望播出时段', v: fmtSlot(slot) });
    if (d.wishContent) rows.push({ k: '想说的话', v: d.wishContent });
  } else {
    rows.push({ k: '标题', v: d.articleTitle || '（无标题）', strong: true });
    if (d.wantBroadcastTime) rows.push({ k: '希望播出时段', v: fmtSlot(d.wantBroadcastTime) });
    if (d.articleContent) rows.push({ k: '正文', v: d.articleContent });
  }

  // 名额条：只对点歌有意义（文稿不占名额）；上限 0 = 不限，不画进度条
  let quota = null;
  const limit = Number(sub.weekLimit);
  if (isSong && limit > 0) {
    const used = Number(sub.weekUsed) || 0;
    quota = {
      used,
      limit,
      remain: Number(sub.weekRemaining) || 0,
      pct: Math.min(100, Math.round((used / limit) * 100)),
    };
  }

  // 审核记录：用真实 statusHistory；没有就直说“尚未处理”，不编造
  const recordLines = [];
  if (Number(d.reviewStatus) === 0) {
    recordLines.push('本条目尚未处理。');
  } else {
    const when = d.reviewTime ? fmtIso(d.reviewTime) : '';
    const who = d.reviewerName || (d.autoRejected ? '系统自动驳回' : '—');
    const what = Number(d.reviewStatus) === 1 ? '通过' : '驳回';
    recordLines.push(`${when ? when + ' ' : ''}由 ${who} ${what}。`);
    if (Number(d.reviewStatus) === 2 && d.rejectReason) {
      recordLines.push(`驳回原因：${d.rejectReason}`);
    }
  }
  // ⚠️ 只渲染 h.reason（人写的"为什么"）—— toStatus/fromStatus 是常量名
  //    （PENDING_REVIEW / WAITING…），翻中文就得在前端维护一份和后端同步的映射表，
  //    后端一改这里就静默漂移。为这点信息量不值得，只取可读的那部分。
  (d.statusHistory || []).slice(-4).forEach((h) => {
    if (!h.reason) return;
    const when = fmtIso(h.createTime || '');
    const who = h.operatorName === 'SYSTEM' ? '系统'
      : (h.operatorName === 'USER' ? '学生' : '管理员');
    recordLines.push(`${when ? when + ' ' : ''}${h.reason}（${who}）`);
  });

  return {
    isSong,
    kindText: isSong ? '点歌' : '文稿',
    person,
    rows,
    quota,
    recordLines,
  };
}
