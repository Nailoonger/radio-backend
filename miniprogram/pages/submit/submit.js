// pages/submit/submit.js
//
// 点歌前置四件事（v8 方案落地 / 2026-09-20 点歌规则 v2）：
//   ① 注意事项闸门：进点歌先弹「点歌注意事项」，滑到页底才能点「我已知晓」，
//      确认调 POST /user/submit/notice/ack；服务端在提交时会再校验一次（40303 = 没确认）。
//   ② 播出时段只可选不手输：GET /user/submit/timeslots 下发下一周一 ~ 周五的可选时段；
//      v2 起每格带容量（capacity / seated / left / full），满了划掉不可选、还能进候补。
//   ③ 点歌时间窗口（v2 新增）：GET /user/submit/window。状态条常驻在标题下
//      （两行：规则 + 此刻状态与倒计时），未开放时提交按钮置灰。
//      文案一律服务端下发，前端不硬编码星期与时刻；窗口结束 = 审核截止。
//   ④ 次数提示：GET /user/submit/quota 给「本周还能点 N 次」（v2 无日/周名额，容量按格子算）。
const { request } = require('../../utils/request.js');
const { fmtIso, fmtDate } = require('../../utils/format.js');
const windowBar = require('../../utils/windowBar.js');
const app = getApp();

/** 滑到页底后按钮上方的提示（不写「30 天」——ack 是按内容版本记的，不是按时间） */
const ACK_HINT = '确认后不会重复弹出；内容更新后会再提醒一次';

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    type: 1,                // 1=点歌 2=文稿
    songName: '',
    singer: '',
    wishContent: '',
    articleTitle: '',
    articleContent: '',
    wantBroadcastTime: '',
    slotLabel: '',          // 选中时段的展示文案
    submitting: false,
    loggedIn: false,
    switches: {},           // 模块开关缓存

    // ── 注意事项闸门 ──
    noticeShow: false,
    noticeLines: [],        // 按行拆开渲染（wxml 不能 split）
    noticeVersion: 0,
    noticeReadDone: false,  // 滑到页底（或内容不足一屏）才可点确认
    noticeAcking: false,
    noticeHint: '',         // 底部提示：继续向下滑动到页底
    noticeProgress: 0,      // v1 方案①：顶部阅读进度条（初始 = 首屏可见比例）

    // ── 播出时段选择 ──
    slotShow: false,
    slotSheetH: 72,         // 弹层高度（vh），按天数自适应
    slotRangeText: '',
    slotDays: [],           // [{date, weekday, monthDay, items:[{key,label,value,selected,picked,full}]}]
    slotCapacity: 0,        // 每场名额上限（0 = 不限）

    // ── 表单骨架（v8 方案 ⑤：>300ms 才显示） ──
    formReady: false,
    skForm: false,

    // ── 点歌时间窗口（v2，常驻展示） ──
    winEnabled: false,      // 服务端是否限制了时间窗口（false = 一直开放）
    winOpen: true,          // 此刻是否开放（默认 true：拉不到数据时不把用户锁死，服务端仍会拦）
    winLine1: '',           // 规则行：每周六 18:00 – 周日 18:00
    winLine2: '',           // 状态行：开放中 · 距截止 2 小时 15 分
    winClosesAt: '',        // 本次收歌截止（MM-DD HH:mm）
    ctaClosed: false,       // 未开放 → 提交按钮置灰
    hintText: '',           // 按钮上方提示

    // ── 次数提示 ──
    quotaText: '',          // 「本周还能点 2 次（上限 2 次）」
    quotaBlocked: false,

    // ── 协议版新增（docs/song-protocol.md）──
    // 提交不再「即占住时段」：首选排满时能不能被调到别的时段，由学生自己勾这一项决定
    allowReschedule: true,  // 服务端字段 allow_reschedule，默认开
    receipt: null,          // 提交成功回执；非空 = 整页切到回执视图
  },

  onLoad() {
    this.wb = windowBar.create(this);
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      navBarHeight: getApp().globalData.navBarHeight || 44,
    });
    this.checkLogin();
    this.loadSwitches();
    this.prepareSong();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(1);
    }
    this.checkLogin();
    this.loadSwitches();
    this.prepareSong();
  },

  onHide() { if (this.wb) this.wb.stopTimer(); },
  onUnload() { if (this.wb) this.wb.stopTimer(); },

  /** 点歌侧的前置数据：次数提示 + 可选时段 + 时间窗口（不阻塞表单，静默失败） */
  prepareSong() {
    if (!app.globalData.token) return;
    // v8 方案 ⑤：表单骨架 —— 超过 300ms 才显示，短于 300ms 宁可空白
    if (!this._skTimer) {
      this._skTimer = setTimeout(() => {
        if (!this.data.formReady) this.setData({ skForm: true });
      }, 300);
    }
    Promise.allSettled([this.loadQuota(), this.loadSlots(), this.wb.load()]).then(() => {
      clearTimeout(this._skTimer);
      this._skTimer = null;
      this.setData({ formReady: true, skForm: false });
    });
    this.ensureNotice();
  },

  /** 窗口字段更新后联动底部按钮（windowBar 的钩子） */
  onWindowChange() {
    this.refreshCta();
  },

  loadQuota() {
    return request('/user/submit/quota').then((d) => {
      // v2：没有日/周名额了，只剩「每人每周 N 次」这一条个人限制
      const uw = d.userWeekly || {};
      const limit = Number(uw.limit) || 0;
      const remaining = Number(uw.remaining) || 0;
      let text = '';
      let blocked = false;
      if (limit > 0) {
        if (remaining > 0) {
          text = '本周还能点 ' + remaining + ' 次（上限 ' + limit + ' 次）';
        } else {
          text = '本周 ' + limit + ' 次已用完，下周再来';
          blocked = true;
        }
      } else if (uw.used > 0) {
        text = '本周已点 ' + uw.used + ' 次（不限次数）';
      }
      this.setData({ quotaText: text, quotaBlocked: blocked });
    }).catch(() => {});
  },

  loadSlots() {
    return request('/user/submit/timeslots').then((d) => {
      const days = [];
      const map = {};
      (d.list || []).forEach((s) => {
        if (!map[s.date]) {
          map[s.date] = { date: s.date, weekday: s.weekday, monthDay: s.monthDay, items: [] };
          days.push(map[s.date]);
        }
        map[s.date].items.push({
          key: s.key,
          label: s.period + ' ' + s.time,
          value: s.value,
          selected: false,
          // v8 方案 ④：已排满的场次划掉、不可选；picked 用于显示「已点 N」
          picked: s.picked || 0,
          full: !!s.full,
        });
      });
      this.setData({
        slotDays: days,
        slotRangeText: d.rangeText || '',
        slotCapacity: d.capacity || 0,
        _slotList: d.list || [],
      });
    }).catch((e) => {
      // 401 = token 失效（request 已把 token 清掉）：同步登录态，让用户能被引导去登录
      if (e && e.code === 40101) this.setData({ loggedIn: false });
      // 其余失败静默——打开弹层时有「拉不到数据」的兜底提示，不在这里打扰
    });
  },

  /* ══════════════ 注意事项闸门 ══════════════ */

  ensureNotice() {
    request('/user/submit/notice?type=song').then((d) => {
      // 没配置内容不拦人；已确认当前版本也不拦
      if (!d.configured || !d.needAck) return;
      this.openNotice(d);
    }).catch(() => {});
  },

  openNotice(d) {
    this.tabbar(true);
    this.setData({
      noticeShow: true,
      noticeLines: String(d.content || '').split('\n').filter((s) => s.trim() !== ''),
      noticeVersion: d.version,
      noticeReadDone: false,
      noticeHint: '继续向下滑动到页底',
      noticeProgress: 0,
    });
    // 兜底：内容不足一屏时 scrolltolower 永远不触发 → 渲染后量一次高度
    wx.nextTick(() => {
      const q = wx.createSelectorQuery();
      q.select('.ntc-scroll').boundingClientRect();
      q.select('.ntc-inner').boundingClientRect();
      q.exec((res) => {
        const box = res && res[0];
        const inner = res && res[1];
        if (box && inner) {
          // 缓存高度给进度条用：进度 =（已滚过 + 视口）/ 内容总高
          this._ntcBoxH = box.height;
          this._ntcInnerH = inner.height;
        }
        if (box && inner && inner.height <= box.height + 4) {
          this.setData({ noticeReadDone: true, noticeHint: ACK_HINT, noticeProgress: 100 });
        } else if (box && inner && inner.height > 0) {
          this.setData({ noticeProgress: Math.round((box.height / inner.height) * 100) });
        }
      });
    });
  },

  onNoticeScroll(e) {
    const d = e.detail || {};
    // v1 方案①：阅读进度条（进度到 100 即页底）
    if (this._ntcInnerH && this._ntcBoxH) {
      const pct = Math.min(100, Math.round(((d.scrollTop || 0) + this._ntcBoxH) / this._ntcInnerH * 100));
      if (pct !== this.data.noticeProgress) this.setData({ noticeProgress: pct });
    }
    if (this.data.noticeReadDone) return;
    this.setData({ noticeReadDone: true, noticeHint: ACK_HINT });
    if (this.data.noticeProgress < 100) this.setData({ noticeProgress: 100 });
  },

  closeNotice() {
    // 没读完允许关闭（不强制读完，提交时服务端会再拦），进度不保留
    this.setData({ noticeShow: false });
    this.tabbar(false);
  },

  stopBubble() { /* catchtouchmove 用，锁住背景滚动 */ },

  async ackNotice() {
    if (!this.data.noticeReadDone || this.data.noticeAcking) return;
    this.setData({ noticeAcking: true });
    try {
      await request('/user/submit/notice/ack', 'POST', { version: this.data.noticeVersion, type: 'song' });
      this.setData({ noticeShow: false });
      this.tabbar(false);
      wx.showToast({ title: '已确认，开始点歌吧' });
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '确认失败', icon: 'none' });
    } finally {
      this.setData({ noticeAcking: false });
    }
  },

  /* ══════════════ 基础 ══════════════ */

  loadSwitches() {
    if (app.fetchSwitches) {
      app.fetchSwitches().then((sw) => {
        this.setData({ switches: sw || {} });
        const cur = this.data.type === 1 ? 'submit_song' : 'submit_article';
        if (sw && sw[cur] === 'off') {
          if (this.data.type === 1 && sw.submit_article !== 'off') {
            this.setData({ type: 2 });
            wx.showToast({ title: '点歌已关闭，已切换到文稿', icon: 'none' });
          } else if (this.data.type === 2 && sw.submit_song !== 'off') {
            this.setData({ type: 1 });
            wx.showToast({ title: '文稿已关闭，已切换到点歌', icon: 'none' });
          }
          this.refreshCta();
        }
      });
    }
  },

  checkLogin() {
    this.setData({ loggedIn: !!app.globalData.token });
    this.refreshCta();
  },

  /** 底部按钮区：未开放就置灰 + 换文案，同时把截止时刻讲清楚（服务端 40907 才是最终权威） */
  refreshCta(over) {
    const d = Object.assign({}, this.data, over || {});
    const closed = d.type === 1 && d.winEnabled && !d.winOpen;
    let hint = '';
    if (!d.loggedIn) hint = '首次提交将自动登录，不收集手机号';
    else if (closed) hint = '现在不在点歌时间段';
    // ⚠️ 协议版口径：提交只进审核队列，**不占位**。
    //    v2 那句「提交后即占住该时段」会让学生以为已经排上了，是最容易误解的一处。
    else if (d.type === 1 && d.winEnabled && d.winClosesAt) hint = '提交后进入审核，通过后统一排期';
    if (this.data.hintText === hint && this.data.ctaClosed === closed) return;
    this.setData({ ctaClosed: closed, hintText: hint });
  },

  switchType(e) {
    const t = parseInt(e.currentTarget.dataset.type, 10);
    const key = t === 1 ? 'submit_song' : 'submit_article';
    if (this.data.switches[key] === 'off') {
      wx.showToast({ title: '该模块暂时关闭', icon: 'none' });
      return;
    }
    this.setData({ type: t });
    this.refreshCta({ type: t });
    if (t === 1) this.prepareSong();
  },

  inputSongName(e) { this.setData({ songName: e.detail.value }); },
  inputSinger(e) { this.setData({ singer: e.detail.value }); },
  inputWish(e) { this.setData({ wishContent: e.detail.value }); },
  inputArticleTitle(e) { this.setData({ articleTitle: e.detail.value }); },
  inputArticleContent(e) { this.setData({ articleContent: e.detail.value }); },

  /* ══════════════ 播出时段选择（只选不输） ══════════════ */

  /** 弹层是模态：浮动胶囊 tabBar 会盖在弹层上面（框架层级，z-index 压不住），打开时收走、关闭时放回 */
  tabbar(hidden) {
    const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tb) tb.setData({ hidden });
  },

  async openSlots() {
    // 时段接口要登录：没登录先走引导（账号门禁开着时会弹「需要学号登录」）
    if (!app.globalData.token && !(await this.ensureLogin())) return;

    // 进页时没拉到（或上次拉取失败 / token 刚失效被清）→ 打开前补拉一次
    if (!this.data.slotDays.length) await this.loadSlots();

    // 补拉后还是空：token 刚被 401 清掉 → 引导登录再试；真没数据 → 明确提示，不开空弹层
    if (!this.data.slotDays.length) {
      if (!app.globalData.token) {
        if (!(await this.ensureLogin())) return;
        await this.loadSlots();
      }
      if (!this.data.slotDays.length) {
        return wx.showToast({ title: '暂时没有可选的播出时段，请稍后再试', icon: 'none' });
      }
    }

    // 弹层高度自适应：按天数估内容高（头 7vh + 每天约 6.5vh + 底 7vh），封顶 72vh、保底 34vh
    const dayCount = this.data.slotDays.length || 1;
    const sheetH = Math.min(72, Math.max(34, Math.round(14 + dayCount * 6.5)));

    this.tabbar(true);
    const days = this.data.slotDays.map((d) => ({
      ...d,
      items: d.items.map((it) => ({ ...it, selected: it.value === this.data.wantBroadcastTime })),
    }));
    this.setData({ slotShow: true, slotDays: days, slotSheetH: sheetH, loggedIn: true });
  },

  closeSlots() {
    this.setData({ slotShow: false });
    this.tabbar(false);
  },

  pickSlot(e) {
    const value = e.currentTarget.dataset.value;
    const item = (this.data._slotList || []).find((s) => s.value === value);
    // v8 方案 ④：已排满的场次不可选（但提交仍可进候补，见下方 doSubmit 的 queued 分支）
    if (item && item.full) {
      return wx.showToast({ title: '该场已排满，换一个时段吧', icon: 'none' });
    }
    this.setData({
      wantBroadcastTime: value,
      slotLabel: item ? item.label : value,
      slotShow: false,
    });
    this.tabbar(false);
  },

  async ensureLogin() {
    if (app.globalData.token) return true;
    // 账号体系上线后微信静默登录会被 40302 拒，引导去登录页
    try {
      await app.login();
      this.setData({ loggedIn: true });
      this.refreshCta({ loggedIn: true });
      return true;
    } catch (e) {
      if (e && e.code === 40302) {
        wx.showModal({
          title: '需要学号登录',
          content: '请使用学校分发的学号账号登录后再投稿',
          confirmText: '去登录',
          success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/login/login' }); },
        });
      } else {
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      }
      return false;
    }
  },

  /** 进候补的反馈：把服务端下发的候补卡摊开讲清楚（§7.1 候补中形态） */
  showQueuedModal(card) {
    const lines = ['该时段名额已满，你已进入候补队列' + (card.queuePos ? '（第 ' + card.queuePos + ' 位）' : '')];
    if (card.queuePos) {
      lines.push('前面还有 ' + (card.aheadCount || 0) + ' 人'
        + (card.queueLimit > 0 ? ' · 候补上限 ' + card.queueLimit + ' 人' : ''));
    }
    if (card.finalizeAt) lines.push(card.hint || '下周任意时段有空位时按提交先后自动补位');
    if (card.finalizeAt) lines.push('收歌截止 ' + fmtIso(card.finalizeAt) + '，没补上会自动告诉你');
    return new Promise((resolve) => {
      wx.showModal({
        title: '已进入候补队列',
        content: lines.join('\n'),
        showCancel: false,
        confirmText: '知道了',
        success: () => resolve(),
        fail: () => resolve(),
      });
    });
  },

  async doSubmit() {
    const { type, songName, singer, wishContent, articleTitle, articleContent, wantBroadcastTime } = this.data;

    if (type === 1) {
      if (this.data.ctaClosed) {
        return wx.showToast({ title: '现在不在点歌时间段', icon: 'none' });
      }
      if (!songName.trim() || !singer.trim()) {
        return wx.showToast({ title: '请填写歌名和歌手', icon: 'none' });
      }
      if (!wantBroadcastTime) {
        return wx.showToast({ title: '请选择希望播出的时段', icon: 'none' });
      }
    } else if (!articleTitle.trim() || !articleContent.trim()) {
      return wx.showToast({ title: '请填写文稿标题和内容', icon: 'none' });
    }

    if (!(await this.ensureLogin())) return;

    const payload = {
      type,
      songName: type === 1 ? songName : undefined,
      singer: type === 1 ? singer : undefined,
      wishContent: type === 1 ? wishContent : undefined,
      articleTitle: type === 2 ? articleTitle : undefined,
      articleContent: type === 2 ? articleContent : undefined,
      wantBroadcastTime,
      // 协议版：点歌才带这一项（服务端 allow_reschedule，缺省视为 1）
      ...(type === 1 ? { allowReschedule: this.data.allowReschedule ? 1 : 0 } : {}),
    };

    this.setData({ submitting: true });
    try {
      const r = await request('/user/submit', 'POST', payload);
      // v2 遗留：正式位满了会直接落库成候补（status=3）。协议版提交时不判容量、
      // 一律进审核队列，这条分支不会再走到 —— 保留只为兜住旧服务端。
      if (r && r.outcome === 'queued') {
        await this.showQueuedModal(r.card || {});
        setTimeout(() => {
          wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
        }, 800);
      } else if (type === 1) {
        // 协议版：提交只进审核队列，不给回执的话学生会反复刷新等「已排期」
        this.showReceipt(r);
      } else {
        wx.showToast({ title: '提交成功，等待审核' });
        setTimeout(() => {
          wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
        }, 800);
      }
    } catch (e) {
      // 40303 = 注意事项未确认：当场把闸门弹出来
      if (e && e.code === 40303) {
        const d = await request('/user/submit/notice?type=song').catch(() => null);
        if (d && d.configured && d.needAck) this.openNotice(d);
        else wx.showToast({ title: '请先确认点歌注意事项', icon: 'none' });
        return;
      }
      // 40907 = 窗口外（服务端最终权威，前端被绕过也拦得住）：顺手把状态条刷到最新
      if (e && e.code === 40907) {
        wx.showToast({ title: '现在不在点歌时间段', icon: 'none' });
        this.wb.load();
        return;
      }
      // 40302 = 模块已关闭；40903 = 规则拦截（同曲 / 次数用完）
      // 40904 = 时段与候补队列都满；40906 = 该格已满（旧码，仍兜住）
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
      if (e && [40902, 40903, 40904, 40906].indexOf(e.code) >= 0) {
        this.loadQuota();
        this.loadSlots();      // 容量变了，弹层里的「已排满」要跟着更新
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 接受调剂开关（协议版 allow_reschedule，默认开） */
  toggleReschedule() {
    this.setData({ allowReschedule: !this.data.allowReschedule });
  },

  /**
   * 提交成功回执（协议版新增）
   * 讲清三步：已提交 → 等待审核 → 统一排期，并点明「最晚什么时候有结果」。
   * ⚠️ 2026-09-25 起「收歌截止 ≠ 审核截止」：回执里的审核截止取 win.reviewAt（服务端下发），
   *    不再拿收歌截止顶替；锁定时刻取这条投稿的 card.lockAt（= 审核截止），
   *    取不到就退回相对说法，不编一个假时刻给学生。
   */
  showReceipt(r) {
    const card = (r && r.card) || {};
    // 提交前的 quotaText 形如「本周还能点 2 次（上限 2 次）」，本地 -1 即提交后的剩余
    const m = String(this.data.quotaText || '').match(/还能点\s*(\d+)/);
    const left = m ? Number(m[1]) - 1 : null;
    const lockAt = card.lockAt ? fmtIso(card.lockAt) : '';
    this.setData({
      receipt: {
        song: [this.data.songName, this.data.singer].filter(Boolean).join(' — '),
        at: fmtDate(Date.now()).slice(5, 16), // MM-DD HH:mm
        leftText: left !== null && left >= 0 ? '本周还剩 ' + left + ' 次点歌机会' : '',
        auditAt: this.data.winReviewAt || this.data.winClosesAt || '',
        lockText: (lockAt ? '排期结果最晚在 ' + lockAt + '（审核截止）' : '排期结果最晚在审核截止')
          + '确定，届时可在「我的投稿」看到。',
        allowReschedule: this.data.allowReschedule,
      },
    });
    this.loadQuota(); // 顺手把剩余次数刷到最新，回「表单」时看到的也是准的
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  goMySubmit() {
    wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
  },
});
