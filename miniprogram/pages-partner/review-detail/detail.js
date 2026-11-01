// pages-partner/review-detail/detail.js
//
// 审核处理台（2026-10-01；2026-11-01 扩到「内部稿件」）
//
// 视觉 = v6 的 L1「白卡大投影」：页面底退成羊皮纸灰，卡片浮起来（第 3 档投影），
// 描边全去；卡内的次级块（名额条、文本域）退回灰底 —— 白卡里嵌灰块。
// 不引入任何新颜色，投影全是纯黑透明（三通道极差 0，不是彩色投影）。
//
// 两种来源，同一套壳（`?kind=draft` 切内部稿件）：
//   学生投稿（点歌 / 文稿）→ GET /admin/submit/:id          · PUT /admin/submit/:id/approve|reject
//   内部稿件（伙伴自己写的）→ GET /partner/draft/:id        · PUT /partner/draft/:id/review
//
// ⚠️⚠️ 为什么内部稿件也要处理台（2026-11-01 陛下：「也要做审核处理台，不能马虎了」）：
//    原来只有列表里两个按钮 —— 通过是一键，驳回是 showModal 弹个输入框。
//    **审稿人根本看不到正文**：列表行只有标题/栏目/字数，凭什么判通过？
//    showModal 那个输入框还收不了长理由、看不到字数时长、看不到这是第几版。
//    所以并到这里：全文、字数/预计时长/版本、驳回理由预设 + 手写，和投稿走同一套。
//
// ⚠️ 两条硬约束决定这里的交互：
//   ① 驳回理由服务端硬校验必填（admin/submit.js、partner/draft.js）→「驳回」在理由为空时不可点
//   ② 审核通过会进排期 → 通过后 reload 才是最终态，这里以列表刷新为准（emit 给上一页）

const { adminRequest, isConflict } = require('../../utils/request.js');
const { fmtMd, fmtIso, fmtSlot } = require('../../utils/format.js');

/** 驳回理由预设 —— 与 admin-web SubmitList.vue 保持同一套，不新增语义 */
const PRESETS = [
  '内容不适合播出',
  '重复投稿',
  '信息不完整',
  '歌词内容不适宜',
  '该曲一周内已点过',
];

/**
 * 内部稿件的驳回理由。
 * ⚠️ 不能沿用上面那套：那是给学生投稿用的（重复投稿 / 该曲一周内已点过），
 *    对站内稿件完全不成立。审稿人驳回伙伴的稿，说的是「篇幅」「栏目」「表述」。
 */
const PRESETS_DRAFT = [
  '内容不适合播出',
  '信息不完整',
  '篇幅超时，需压缩',
  '与栏目定位不符',
  '表述需修改',
];

Page({
  data: {
    statusBarHeight: 20,
    id: 0,
    loading: true,
    submitting: false,
    notFound: false,

    // 'submit' | 'draft'（内部稿件）
    isDraft: false,

    // 待审队列定位（「第 N / M 条待处理」与上一条 / 下一条）
    pos: 0,
    queueTotal: 0,
    ids: [],

    isSong: true,
    kindText: '点歌',

    person: null,     // 投稿人卡
    stats: [],        // 投稿人卡下面那三格（投稿看历史通过/驳回，稿件看版本/字数/时长）
    rows: [],         // 内容 kv 行（学生投稿）
    doc: null,        // 内容整块（内部稿件：{ title, body }）
    docCol: '',       // 内部稿件的栏目（放在「内容」标题右侧）
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
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const id = Number((options && options.id) || 0);
    const focus = (options && options.focus) || '';
    const isDraft = (options && options.kind) === 'draft';

    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      id,
      isDraft,
      presets: isDraft ? PRESETS_DRAFT : PRESETS,
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
    // ⚠️ 内部稿件走自己的审稿队列（/partner/draft/review，status=1 是待审；
    //    它和 submit 的 reviewStatus 不是同一套数字，别混）
    const req = this.data.isDraft
      ? adminRequest('/partner/draft/review', 'GET', { status: 1, page: 1, pageSize: 100 })
      : adminRequest('/admin/submit/list', 'GET', { reviewStatus: 0, page: 1, pageSize: 100 });
    return req
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

    const req = this.data.isDraft
      ? adminRequest(`/partner/draft/${id}`, 'GET')
      : adminRequest(`/admin/submit/${id}`, 'GET');

    return req
      .then((d) => {
        if (!d || !d.id) {
          this.setData({ loading: false, notFound: true });
          return;
        }
        const view = decorate(d, this.data.isDraft);
        const idx = this.data.ids.indexOf(id);
        this.setData({
          id: d.id,
          loading: false,
          pos: idx >= 0 ? idx + 1 : 0,
          isSong: view.isSong,
          kindText: view.kindText,
          person: view.person,
          stats: view.stats,
          rows: view.rows,
          doc: view.doc,
          docCol: view.docCol,
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

    // 内部稿件走自己那条审稿接口（没有 approve/reject 两个路由，是一个 review 带 approve 布尔）
    const req = this.data.isDraft
      ? adminRequest(`/partner/draft/${this.data.id}/review`, 'PUT', { approve: true })
      : adminRequest(`/admin/submit/${this.data.id}/approve`, 'PUT');

    req
      .then(() => this.afterDone('已通过'))
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        if (isConflict(err)) return this.onConflict(err);
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

    const req = this.data.isDraft
      ? adminRequest(`/partner/draft/${this.data.id}/review`, 'PUT', { approve: false, reason })
      : adminRequest(`/admin/submit/${this.data.id}/reject`, 'PUT', { reason });

    req
      .then(() => this.afterDone('已驳回'))
      .catch((err) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        if (isConflict(err)) return this.onConflict(err);
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /**
   * 乐观锁冲突：这条刚被别人处理过。
   * 处理台停在**单条**上，所以不能只弹提示 —— 页面还显示着旧的「待审核」，
   * 用户会以为是自己没点成功。重新拉这一条，让他看到真实结论。
   */
  onConflict(err) {
    wx.showToast({ title: (err && err.message) || '这条刚被处理过', icon: 'none' });
    this.loadDetail(this.data.id);
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
      wx.reLaunch({ url: '/pages-partner/review/review' });
    }
  },

  goBack() {
    this.backToList();
  },
});

/* ---------------------------------------------------------------- *
 * 接口 → 视图
 * ---------------------------------------------------------------- */

/** 秒 → m:ss（稿件卡上「预计时长」，与稿件页同一口径） */
function mmssOf(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * 内部稿件（伙伴自己写的稿）：没有投稿人统计，但有版本 / 字数 / 预计时长。
 * ⚠️ 正文必须整段给出来 —— 审稿人要看的就是它，截断就等于回到「看不到正文」的老问题。
 *
 * ⚠️⚠️ 正文不走 kv 行（2026-11-01 陛下：「正文那一块白色空区太大你把它利用上，
 *    正文在第一行粗体第二行开始显示是内容」）：
 *    kv 行是「160rpx 左标签列 + 右内容列」，正文越长、左边那条白条就越刺眼，
 *    右边内容列也被挤窄。所以稿件的正文单独一块 `doc` —— 整块占满卡宽，
 *    第一行标题（粗体），第二行起是正文。
 */
function decorateDraft(d) {
  const name = d.authorName || '站内作者';
  const words = Number(d.wordCount) || 0;
  const column = d.columnName || '未选栏目';

  const doc = {
    title: d.title || '（无标题）',
    body: d.body || '（空）',
  };

  const person = {
    initial: String(name).slice(0, 1),
    name,
    // 栏目已经挪到「内容」那一行标题右侧，这里不再重复
    sub: [`${words} 字`, mmssOf(d.seconds)].join(' · '),
    chip: '内部稿件',
  };
  const stats = [
    { l: '版本', n: `第 ${Number(d.version) || 1} 版` },
    { l: '字数', n: String(words) },
    { l: '预计时长', n: mmssOf(d.seconds) },
  ];

  // 审核记录：草稿表没有 statusHistory，就用 submittedAt / reviewedAt / reviewedByName 说清楚
  // 行结构统一成 { name, role, tx, tm }：name/role 是「谁」，tx 是「干了什么」，tm 靠右对齐
  const recordLines = [];
  const st = Number(d.status) || 0;
  const draftState = ['还没提交', '待审核', '已通过', '已驳回'][st] || '还没提交';
  recordLines.push({ name: '', role: '', tx: `当前${draftState}`, tm: '' });
  if (st === 1) {
    recordLines.push({ name: '作者', role: '', tx: '提交，等待审核', tm: d.submittedAt ? fmtIso(d.submittedAt) : '' });
  } else if (st === 2) {
    recordLines.push({ name: d.reviewedByName || '管理员', role: '', tx: '通过', tm: d.reviewedAt ? fmtIso(d.reviewedAt) : '' });
  } else if (st === 3) {
    recordLines.push({ name: d.reviewedByName || '管理员', role: '', tx: '驳回', tm: d.reviewedAt ? fmtIso(d.reviewedAt) : '' });
    if (d.rejectReason) recordLines.push({ name: '', role: '', tx: `驳回原因：${d.rejectReason}`, tm: '' });
  }

  return { isSong: false, kindText: '内部稿件', person, stats, doc, docCol: column, rows: [], quota: null, recordLines };
}

function decorate(d, isDraft) {
  if (isDraft) return decorateDraft(d);

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

  // 审核记录（2026-11-02 陛下要「谁通过的谁撤回的清楚一点」）
  //
  // ⚠️⚠️ 以前这里干的事是错的：拿 `statusHistory[].reason` 当人话直接上屏，而后端存的是
  //    动作代号（REVIEW_APPROVED / REVOKED / INITIAL_ALLOCATION）⇒ 审核记录里全是英文，
  //    而且一次「通过」会连带分配时段写两条，看着像重复。
  //     现在：**翻译和合并都在后端**（services/songStatus.js#describeHistory，措辞只有一份），
  //    这里只排版 —— { name, role, text, time } → 一行「谁（岗位） 干了什么 …… 时间」。
  //     老数据没有 opId 的仍然一条一组，不猜；查不到操作人的退回「管理员」，不瞎编名字。
  const recordLines = [];
  const stText = d.statusText || '待审核';
  recordLines.push({ name: '', role: '', tx: `当前${stText}`, tm: '' });
  (d.history || []).forEach((h) => {
    recordLines.push({
      name: h.name || '',
      role: h.role || '',
      tx: h.text || '状态变更',
      tm: h.time ? fmtIso(h.time) : '',
    });
  });

  return {
    isSong,
    kindText: isSong ? '点歌' : '文稿',
    person,
    // doc 只给内部稿件用；学生投稿继续走 kv 行（歌曲 / 时段 / 想说的话都是短字段，左标签列不吃亏）
    doc: null,
    docCol: '',
    // 投稿看「历史通过 / 历史驳回 / 首次投稿」（与上面 person 里的三个字段同一份数据）
    stats: [
      { l: '历史通过', n: String(person.approved) },
      { l: '历史驳回', n: String(person.rejected) },
      { l: '首次投稿', n: person.firstAt },
    ],
    rows,
    quota,
    recordLines,
  };
}
