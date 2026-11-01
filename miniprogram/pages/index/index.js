const tabMotion = require('../../utils/tabMotion.js');
// pages/index/index.js
const { request } = require('../../utils/request.js');
const { fmtDate, orDash } = require('../../utils/format.js');

// 启动动画最短停留时长：入场 1.7s 播完再淡出，避免闪一下就没了
const LAUNCH_MIN_MS = 1700;
// 兜底：接口一直不回来也不能把用户关在启动页里
const LAUNCH_MAX_MS = 4000;

Page({
  data: {
    tabMotion: '',
    statusBarHeight: 20,
    currentProgram: null,  // 正在直播（不直接渲染，只用来算欢迎卡副行）
    weekly: [],            // 本周节目单
    notices: [],           // 公告
    schedule: { visible: false, rangeText: '', days: [], hasAny: false },  // 本周点歌排期
    loading: true,
    // 欢迎卡（2026-11-01）：问候语 + 「下一次什么时候见」
    welcomeHi: '',
    welcomeLine: '',
  },

  /** 自定义 tabBar 渲染在页面内容之上，遮罩盖不住它，所以启动期间
   *  让胶囊退到屏幕外（容器无底色，不会有任何"多出来一块"的感觉）。 */
  setTabBar(state) {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData(state);
    }
  },

  onLoad() {
    console.log('[index] onLoad, baseURL =', getApp().globalData.baseURL);
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      navBarHeight: getApp().globalData.navBarHeight || 44,
      // 问候语不依赖网络，先渲染出来，别让欢迎卡空着等接口
      welcomeHi: this.greeting(),
    });
    this._launchedAt = Date.now();
    this._launchDismissed = false;
    this.setTabBar({ hidden: true });
    // 接口超时兜底
    setTimeout(() => this.dismissLaunch(), LAUNCH_MAX_MS);
    this.loadAll();
  },

  onHide() { tabMotion.hide(this); },

  onShow() {
    // 目标页播放胶囊与内容入场动效。
    tabMotion.show(this, 0);
    // 启动动画还没放完：胶囊继续留在屏幕外；放完了就滑上来
    if (this._launchDismissed) this.setTabBar({ hidden: false });
    else this.setTabBar({ hidden: true });
    // 从「我的」页登录回来 / 跨了时段，问候语和名字都要重算
    this.setData({ welcomeHi: this.greeting() });
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    this.setData({ loading: true });
    return Promise.all([
      request('/user/program/current').catch(() => null),
      request('/user/program/weekly').catch(() => null),
      request('/user/notice/list?pageSize=5').catch(() => ({ list: [] })),
      request('/user/submit/week').catch(() => null),
      // 未来 7 天节目预告。weekly 是按服务器时间算 isoWeek 的（容器 UTC，
      // 北京时间周一 8 点前会退回上周），这一份用来补那个缺口，只为算"下一场"。
      request('/user/program/schedule').catch(() => null),
    ]).then(([current, weekly, noticePage, sched, upcoming]) => {
      const weeklyList = weekly ? (weekly.list || []) : null;
      const upcomingList = upcoming ? (upcoming.list || []) : null;
      this.setData({
        currentProgram: current,
        weekly: weeklyList || [],
        notices: noticePage.list || [],
        schedule: this.fmtSchedule(sched),
        loading: false,
        welcomeHi: this.greeting(),
        welcomeLine: this.nextLine(current, weeklyList, upcomingList),
      });
      // 数据就绪：启动动画可以退场了（里面会补足最短停留时长）
      this.dismissLaunch();
    });
  },

  /* ══════════ 欢迎卡（2026-11-01） ══════════
   * 卡片只显示"问候语 + 下一次什么时候见"，不显示直播状态。
   * ⚠️ 时间一律用设备本地日历（校园场景设备就是北京时间）算，不看服务器给的 weekRange。 */

  /** 问候语：时段词 + 昵称。昵称取 userInfo.nickname，兜底 name，都没有就只留时段词。 */
  greeting() {
    const app = getApp();
    const info = app.globalData.userInfo || wx.getStorageSync('userInfo') || {};
    const name = String(info.nickname || info.name || '').trim();
    const h = new Date().getHours();
    let word = '晚上好';
    if (h < 5) word = '夜深了';
    else if (h < 11) word = '早上好';
    else if (h < 13) word = '午安';
    else if (h < 18) word = '下午好';
    return name ? `${word}，${name}` : word;
  },

  /** 副行：四种情形
   *   ① 有节目在播   → 「正在播，12:30 开始。」
   *   ② 今天还有一场 → 「今天 17:30 见。」
   *   ③ 今天没了、本周还有 → 「今天没有节目，明天 12:30 见。」
   *   ④ 本周排期播完 → 「本周节目播完了，下周见。」
   * ④ 不用写死"周五"：本周（周一–周日）内筛不到未来的场次，自然就是下周见；
   *    周末不排节目时，周五 24 点一过就自动落到这一支。 */
  nextLine(current, weeklyList, upcomingList) {
    // ① 在播只看 is_live，与日期无关，优先级最高
    if (current && current.id) {
      const t = String(current.broadcastTime || '').slice(0, 5);
      return t ? `正在播，${t} 开始。` : '正在播。';
    }
    // 两份节目数据都没拿到 ⇒ 不猜，副行留空
    if (!weeklyList && !upcomingList) return '';

    const now = new Date();
    const range = this.weekRange(now);
    const seen = {};
    let best = null;
    [].concat(weeklyList || [], upcomingList || []).forEach((p) => {
      if (!p || !p.id || seen[p.id]) return;
      seen[p.id] = 1;
      const day = String(p.broadcastDate || '').slice(0, 10);
      if (!day || day < range.from || day > range.to) return;   // 只看本周
      const at = this.broadcastAt(p);
      if (!at || at <= now) return;                             // 只看此刻之后
      if (!best || at < best.at) best = { at, p };
    });
    if (!best) return '本周节目播完了，下周见。';

    const hm = String(best.p.broadcastTime || '').slice(0, 5);
    const diff = this.dayDiff(now, best.p.broadcastDate);
    if (diff <= 0) return `今天 ${hm} 见。`;
    if (diff === 1) return `今天没有节目，明天 ${hm} 见。`;
    const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const d = new Date(String(best.p.broadcastDate).slice(0, 10) + 'T00:00:00');
    return `今天没有节目，${WD[d.getDay()]} ${hm} 见。`;
  },

  /** 本地日历日 YYYY-MM-DD */
  ymd(d) {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  /** 本周区间（周一–周日） */
  weekRange(now) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (d.getDay() + 6) % 7;            // 周一 = 0
    const mon = new Date(d); mon.setDate(d.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: this.ymd(mon), to: this.ymd(sun) };
  },

  /** 节目播出的真实时刻。⚠️ iOS 只认 "YYYY-MM-DDTHH:mm:ss"，写成空格分隔会 Invalid Date */
  broadcastAt(p) {
    const day = String(p.broadcastDate || '').slice(0, 10);
    const hm = String(p.broadcastTime || '').slice(0, 5);
    if (!day || !/^\d{2}:\d{2}$/.test(hm)) return null;
    const v = new Date(`${day}T${hm}:00`);
    return isNaN(v.getTime()) ? null : v;
  },

  /** 目标日期距今天几天（0=今天，1=明天…） */
  dayDiff(now, dateStr) {
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  },

  /** 本周点歌排期：只显示有歌的日子（今天保留，哪怕是空的）；
   *  visible=false（后台关了开关）→ 整个区块不渲染 */
  fmtSchedule(sched) {
    const none = { visible: false, rangeText: '', days: [], hasAny: false };
    if (!sched || !sched.visible) return none;
    const days = (sched.days || [])
      .filter((d) => (d.songs && d.songs.length) || d.isToday)
      .map((d) => ({ ...d, empty: !d.songs || !d.songs.length }));
    return {
      visible: true,
      rangeText: sched.rangeText || '',
      days,
      hasAny: days.some((d) => !d.empty),
    };
  },

  /** 数据先到就立刻退场，数据后到就停在声波律动态（本身是加载态） */
  dismissLaunch() {
    if (this._launchDismissed) return;
    const mask = this.selectComponent('#launch');
    if (!mask) { this._launchDismissed = true; return; }
    const elapsed = Date.now() - (this._launchedAt || Date.now());
    const wait = Math.max(0, LAUNCH_MIN_MS - elapsed);
    setTimeout(() => {
      if (this._launchDismissed) return;
      this._launchDismissed = true;
      const m = this.selectComponent('#launch');
      if (m) m.dismiss();
      // 胶囊自下而上滑入（480ms），与遮罩 420ms 淡出同步
      this.setTabBar({ hidden: false, enter: true });
    }, wait);
  },

  goSubmit() {
    // 记录来源格：投稿页的指示器从「首页」滑过去
    getApp().globalData.tabFrom = 0;
    wx.switchTab({ url: '/pages/submit/submit' });
  },

  goCurrent() {
    const p = this.data.currentProgram;
    if (!p || !p.id) return;
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${p.id}` });
  },

  goNoticeDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/noticeDetail/noticeDetail?id=${id}` });
  },

  goProgramDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/programDetail/programDetail?id=${id}` });
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  /** 本周节目单 → 查看全部 */
  goPrograms() {
    wx.navigateTo({ url: '/pages/programs/programs' });
  },

  /** 校园公告 → 全部公告 */
  goNotices() {
    wx.navigateTo({ url: '/pages/notices/notices' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },
});
