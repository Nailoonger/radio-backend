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
const skeleton = require('../../utils/skeleton.js');
// 长文案不能塞 showToast（> 两行截断，2026-11-16 陛下截图退回）
const { tip } = require('../../utils/tip.js');

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

    // 骨架（2026-11-16）：sk 初值 true —— 骨架从第一帧就在，内容层整块 wx:if 掉
    sk: true,
    skOut: false,
    enter: false,

    // 'submit' | 'draft'（内部稿件）
    isDraft: false,

    // 待审队列定位（「第 N / M 条待处理」与上一条 / 下一条）
    pos: 0,
    queueTotal: 0,
    ids: [],
    // 顶部中间那行文案在 JS 里拼好（WXML 只取值 —— 模板嵌套三元容易翻车）
    navText: '',
    // 这条的首选时段是否已排满（满了就在顶部标红，别让人点通过去撞 40906）
    slotFull: false,
    // 时段矩阵：值 → { i, seated, cap, full, label }（只给取件顺序用，不进 UI）
    slotMap: null,

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

    this.skGate = skeleton.create(this, { when: () => !this.data.loading });
    this.skGate.boot();

    // 先拿时段矩阵（取件顺序要靠它判断「这格满没满」），再拿队列，最后拉详情
    this.loadSlots()
      .then(() => this.loadQueue())
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

  /**
   * 本周时段矩阵：每格已占几个 / 上限 / 是否满。
   *
   * ⚠️⚠️ 取件顺序要靠它（2026-11-16 陛下：「伙伴端的审核处理台也得改一下」）：
   *    原来只按 reviewStatus=0 拉一页、按后端给的 createTime 顺序逐条审 ⇒
   *    「周一这格满了」之后还一直取周一的，每次都撞 40906「该时段已排满（2/2），
   *    请先审别的时段」，得人手跳到另一个时段。
   *    现在按矩阵顺序排 + 满格跳过，与电脑端 admin-web 处理台同一套口径。
   */
  loadSlots() {
    if (this.data.isDraft) { this.setData({ slotMap: null }); return Promise.resolve(null); }
    return adminRequest('/admin/submit/schedule', 'GET')
      .then((d) => {
        const map = {};
        const fallback = Number((d && d.capacity) || 0);
        let i = 0;
        ((d && d.days) || []).forEach((day) => {
          (day.slots || []).forEach((s) => {
            const cap = Number(s.capacity || fallback || 0);
            const seated = Number(s.seated || 0);
            map[s.value] = {
              i: i++,
              seated,
              cap,
              full: cap > 0 && seated >= cap,
              label: `${day.weekday} · ${s.period} ${s.time}`,
              // 短名给 toast 用（「周三 12:10」），完整名给正文用
              short: `${day.weekday} ${s.time}`,
            };
          });
        });
        this.setData({ slotMap: map });
        return map;
      })
      .catch(() => { this.setData({ slotMap: null }); return null; });
  },

  /**
   * 待审队列：按「时段顺序 → 提交时间 → id」排好（只用于定位与翻页，不进 UI 数据）。
   * ⚠️ 排序规则必须和电脑端 admin-web 处理台逐字一致，否则手机和电脑的「下一条」不是同一条。
   */
  loadQueue() {
    // ⚠️ 内部稿件走自己的审稿队列（/partner/draft/review，status=1 是待审；
    //    它和 submit 的 reviewStatus 不是同一套数字，别混）
    const req = this.data.isDraft
      ? adminRequest('/partner/draft/review', 'GET', { status: 1, page: 1, pageSize: 100 })
      : adminRequest('/admin/submit/list', 'GET', { reviewStatus: 0, page: 1, pageSize: 100 });
    return req
      .then((d) => {
        const rows = (d && d.list) || [];
        const map = this.data.slotMap;
        const keyed = rows.map((x) => {
          const want = x.wantBroadcastTime || '';
          let si = 9999;                                   // 首选不在本周矩阵里 → 排最后
          if (!this.data.isDraft && map && want && map[want]) si = map[want].i;
          return { id: x.id, want, si, t: tsOf(x.createTime), n: Number(x.id) || 0 };
        });
        keyed.sort((a, b) => (a.si - b.si) || (a.t - b.t) || (a.n - b.n));
        this._queue = keyed;
        this.setData({ ids: keyed.map((k) => k.id), queueTotal: keyed.length });
        return keyed;
      })
      .catch(() => {
        this._queue = [];
        this.setData({ ids: [], queueTotal: 0 });
        return [];
      });
  },

  /**
   * 取下一条该审的：跳过已经排满的格子。
   * 队列已经按时段排好，所以「跳过满格」天然等于「进入下一个时段」。
   * @returns {{item: object|null, skipped: number, nextLabel: string}}
   */
  pickNext() {
    const q = this._queue || [];
    const map = this.data.slotMap;
    let skipped = 0;
    let nextLabel = '';
    for (let k = 0; k < q.length; k++) {
      const x = q[k];
      const cell = (!this.data.isDraft && map && x.want) ? map[x.want] : null;
      if (cell && cell.full) { skipped++; continue; }
      if (cell) nextLabel = cell.short || cell.label;
      return { item: x, skipped, nextLabel };
    }
    return { item: null, skipped, nextLabel: '' };
  },

  loadDetail(id) {
    if (!id) {
      this.setData({ loading: false, notFound: true }, () => this.skGate.check());
      return Promise.resolve();
    }
    this.setData({ loading: true, notFound: false, presetIndex: -1, reason: '', canReject: false });

    const req = this.data.isDraft
      ? adminRequest(`/partner/draft/${id}`, 'GET')
      : adminRequest(`/admin/submit/${id}`, 'GET');

    return req
      .then((d) => {
        if (!d || !d.id) {
          this.setData({ loading: false, notFound: true }, () => this.skGate.check());
          return;
        }
        const view = decorate(d, this.data.isDraft);
        const idx = this.data.ids.indexOf(id);
        const pos = idx >= 0 ? idx + 1 : 0;
        const total = this.data.queueTotal;
        // 这条的首选时段满没满（满了点上通过只会换来 40906，先在顶部说清楚）
        const cell = (!this.data.isDraft && this.data.slotMap && d.wantBroadcastTime)
          ? this.data.slotMap[d.wantBroadcastTime]
          : null;
        const full = !!(cell && cell.full);
        this.setData({
          id: d.id,
          loading: false,
          pos,
          slotFull: full,
          navText: pos > 0
            ? (full
              ? '第 ' + pos + ' / ' + total + ' 条 · 该时段已满'
              : '第 ' + pos + ' / ' + total + ' 条待处理')
            : '不在待处理队列',
          isSong: view.isSong,
          kindText: view.kindText,
          person: view.person,
          stats: view.stats,
          rows: view.rows,
          doc: view.doc,
          docCol: view.docCol,
          quota: view.quota,
          recordLines: view.recordLines,
        }, () => this.skGate.check());
      })
      .catch((err) => {
        this.setData({ loading: false, notFound: true }, () => this.skGate.check());
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
    // 首选时段已经排满：点通过必被服务端拒（40906「该时段已排满」，人还得自己找别的时段）
    // ⇒ 直接跳到下一条「还有空位」的（陛下：一个时段满了自动跳到下一个时段）
    if (this.data.slotFull) return this.skipFullSlot();
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
        tip((err && err.message) || '操作失败');
      });
  },

  /**
   * 当前这条的首选时段已经排满 ⇒ 跳过它，直接审下一条还有空位的。
   *
   * 为什么不在按钮上禁用：驳回仍然有效（这条确实该驳就驳），
   * 只是「通过」没有意义 —— 服务端一定回 40906。所以按钮文案同步变成「跳过满格 · 审下一条」。
   */
  skipFullSlot() {
    const pick = this.pickNext();     // 满格的（含当前这条）会被自动跳过
    if (!pick.item) {
      wx.showModal({
        title: '本周排满了',
        content: '所有时段都已排满，没有格子能放。锁定排期时系统会统一驳回这些没位子的。',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#0066CC',
        success: () => this.backToList(),
      });
      return;
    }
    wx.showToast({ title: `跳过满格 · 接着审${pick.nextLabel}`, icon: 'none' });
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
    this.loadDetail(pick.item.id);
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
        tip((err && err.message) || '操作失败');
      });
  },

  /**
   * 乐观锁冲突：这条刚被别人处理过。
   * 处理台停在**单条**上，所以不能只弹提示 —— 页面还显示着旧的「待审核」，
   * 用户会以为是自己没点成功。重新拉这一条，让他看到真实结论。
   */
  onConflict(err) {
    tip((err && err.message) || '这条刚被处理过');
    this.loadDetail(this.data.id);
  },

  /**
   * 处理完一条：通知列表刷新 → 重新拉矩阵 → 取下一条「还有位」的。
   *
   * ⚠️ 必须**先重拉矩阵**再取件：刚通过的这条已经占掉一个位，
   *    拿旧矩阵算「满没满」会把刚排满的格子当成还有空，又会取到它。
   */
  afterDone(msg) {
    wx.hideLoading();

    // 列表页是通过 navigateTo + events 打开的才有通道；直接进来的（reLaunch）没有上游
    try {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (channel && channel.emit) channel.emit('reviewed');
    } catch (e) { /* 没有上游页面，忽略 */ }

    // 从队列里摘掉刚处理完的这条
    this._queue = (this._queue || []).filter((x) => Number(x.id) !== Number(this.data.id));

    return this.loadSlots().then(() => {
      const pick = this.pickNext();

      if (!pick.item) {
        this.setData({ submitting: false });
        if (!this._queue.length) {
          tip(msg, { success: true });
          setTimeout(() => this.backToList(), 620);
          return;
        }
        // 还有待审但一格都放不下 —— 留在处理台只会反复撞 40906，直接退回列表
        const left = this._queue.length;
        wx.showModal({
          title: '本周排满了',
          content: `还剩 ${left} 条待审，但所有时段都已排满，没有格子能放。`
            + '锁定排期时系统会统一驳回这些没位子的。',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#0066CC',
          success: () => this.backToList(),
        });
        return;
      }

      const ids = this._queue.map((x) => x.id);
      this.setData({ ids, queueTotal: ids.length, submitting: false });

      // 跳过了别的时段 ⇒ 明确告诉审稿人，否则他会以为漏审了。
      // ⚠️ 这里报的 N 是「为了找到这条、跳过了多少条满格条目」，会随着审下去变大
      //    （满格的条目一直留在队列里，等锁定统一驳回）—— 所以措辞写「满格」而不是「跳过」，
      //    别让人以为是重复跳同一批。
      if (pick.skipped > 0 && pick.nextLabel) {
        wx.showToast({ title: `跳过 ${pick.skipped} 条满格 · 接着审${pick.nextLabel}`, icon: 'none' });
      } else {
        wx.showToast({ title: `${msg}，取下一条`, icon: 'success' });
      }
      this.loadDetail(pick.item.id);
    });
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

/**
 * 时间戳 → 毫秒（排候选用）。
 *
 * ⚠️ **不要直接 `new Date('2026-11-16 00:39:00')`** —— iOS 解析不了「- 分隔 + 空格」
 *    这种格式，得到 NaN ⇒ 排序退化成全靠 id，看起来"偶尔顺序不对"。
 *    统一把 `-` 换成 `/`、去掉 `T` 和毫秒小数，iOS / 安卓都能解析。
 */
function tsOf(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/-/g, '/').replace('T', ' ').replace(/\.\d+.*$/, '');
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

/** 秒 → m:ss（稿件卡上「预计时长」，与稿件页同一口径） */
function mmssOf(sec) {  const s = Math.max(0, Math.round(Number(sec) || 0));
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
