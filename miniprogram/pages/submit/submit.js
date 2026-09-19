// pages/submit/submit.js
//
// 点歌前置三件事（2026-09 v8 方案落地）：
//   ① 注意事项闸门：进点歌先弹「点歌注意事项」，滑到页底才能点「我已知晓」，
//      确认调 POST /user/submit/notice/ack；服务端在提交时会再校验一次（40303 = 没确认）。
//      注意：内容一屏放得下时按钮直接可点（服务不了「滚不动」的死角），这里用高度测量兜底。
//   ② 播出时段只可选不手输：GET /user/submit/timeslots 下发下一周一 ~ 周五的可选时段，
//      值是规范串「2026-09-21 午间 12:20」；自由文本后端直接拒（40001）。
//   ③ 次数 / 名额提示：GET /user/submit/quota 给「本周还可点 N 次」与名额是否已满。
const { request } = require('../../utils/request.js');
const app = getApp();

/** 滑到页底后按钮上方的提示（不写「30 天」——ack 是按内容版本记的，不是按时间） */
const ACK_HINT = '确认后不会重复弹出；内容更新后会再提醒一次';

Page({
  data: {
    statusBarHeight: 20,
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

    // ── 次数 / 名额 ──
    quotaText: '',          // 「本周还可点 2 次」/「本周名额已满」
    quotaBlocked: false,
  },

  onLoad() {
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

  /** 点歌侧的前置数据：次数提示 + 可选时段（不阻塞表单，静默失败） */
  prepareSong() {
    if (!app.globalData.token) return;
    // v8 方案 ⑤：表单骨架 —— 超过 300ms 才显示，短于 300ms 宁可空白
    if (!this._skTimer) {
      this._skTimer = setTimeout(() => {
        if (!this.data.formReady) this.setData({ skForm: true });
      }, 300);
    }
    Promise.allSettled([this.loadQuota(), this.loadSlots()]).then(() => {
      clearTimeout(this._skTimer);
      this._skTimer = null;
      this.setData({ formReady: true, skForm: false });
    });
    this.ensureNotice();
  },

  loadQuota() {
    return request('/user/submit/quota').then((d) => {
      const uw = d.userWeekly || {};
      let text = '';
      let blocked = false;
      if (uw.limit > 0) {
        text = uw.remaining > 0 ? '本周还可点 ' + uw.remaining + ' 次' : '本周点歌次数已用完';
      }
      if (d.song && d.song.exhausted) {
        text = '本期点歌名额已满，提交将被自动驳回';
        blocked = true;
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
        }
      });
    }
  },

  checkLogin() {
    this.setData({ loggedIn: !!app.globalData.token });
  },

  switchType(e) {
    const t = parseInt(e.currentTarget.dataset.type, 10);
    const key = t === 1 ? 'submit_song' : 'submit_article';
    if (this.data.switches[key] === 'off') {
      wx.showToast({ title: '该模块暂时关闭', icon: 'none' });
      return;
    }
    this.setData({ type: t });
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
    // v8 方案 ④：已排满的场次不可选
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

  async doSubmit() {
    const { type, songName, singer, wishContent, articleTitle, articleContent, wantBroadcastTime } = this.data;

    if (type === 1) {
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
    };

    this.setData({ submitting: true });
    try {
      await request('/user/submit', 'POST', payload);
      wx.showToast({ title: '提交成功，等待审核' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
      }, 800);
    } catch (e) {
      // 40303 = 注意事项未确认：当场把闸门弹出来
      if (e && e.code === 40303) {
        const d = await request('/user/submit/notice?type=song').catch(() => null);
        if (d && d.configured && d.needAck) this.openNotice(d);
        else wx.showToast({ title: '请先确认点歌注意事项', icon: 'none' });
        return;
      }
      // 40302 = 模块已关闭；40902 = 名额满；40903 = 规则拦截（同曲 / 次数用完）
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
      if (e && (e.code === 40902 || e.code === 40903)) this.loadQuota();
    } finally {
      this.setData({ submitting: false });
    }
  },
});
