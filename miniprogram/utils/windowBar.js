// utils/windowBar.js
//
// 点歌时间窗口状态条（规则 v2）的公共逻辑 —— 投稿页与我的投稿页都要常驻展示同一条。
//
// 三条不许破的约定（docs/song-queue-v2.md §6.6）：
//   ① 文案一律服务端下发（GET /user/submit/window 的 windowText / opensAt / closesAt），
//      前端不硬编码星期与时刻 —— 管理员一改配置，学生端立刻跟着变；
//   ② 倒计时用 serverNow 校准设备时钟（设备时钟可能不准），校准后本地按秒自算；
//   ③ 本地倒计时跨过边界（开放→关闭 / 未开放→开放）时，不自己下结论，重新拉一次服务端。
//
// 用法：
//   onLoad() { this.wb = windowBar.create(this); }
//   onShow() { if (app.globalData.token) this.wb.load(); }
//   onHide()/onUnload() { this.wb.stopTimer(); }
// 页面可实现 onWindowChange(v) 钩子（v = 本次 setData 的窗口字段）做联动。

const { request } = require('./request.js');
const { fmtIso, fmtDur } = require('./format.js');

function create(page) {
  return {
    win: null,          // 服务端原样返回的窗口状态
    skew: 0,            // 设备时钟相对服务端的偏移（ms）
    timer: null,
    refreshing: false,
    stale: false,       // 本地倒计时已跨过边界，等重拉

    load() {
      return request('/user/submit/window')
        .then((d) => this.apply(d))
        .catch(() => { /* 拉不到就不展示状态条，服务端仍会硬拦，不打扰用户 */ });
    },

    apply(win) {
      if (!win) return;
      this.win = win;
      const serverMs = win.serverNow ? Date.parse(win.serverNow) : NaN;
      this.skew = isNaN(serverMs) ? 0 : serverMs - Date.now();
      this.render();
      this.startTimer();
    },

    /** 纯计算：返回要 setData 的窗口字段（不在这里 setData，页面好顺带加自己的字段） */
    view() {
      const win = this.win;
      if (!win) return null;
      const now = Date.now() + (this.skew || 0);
      const opens = win.opensAt ? Date.parse(win.opensAt) : NaN;
      const closes = win.closesAt ? Date.parse(win.closesAt) : NaN;
      const enabled = !!win.enabled;
      const open = enabled ? !!win.open : true;

      let line2 = '随时可提交';
      if (enabled) {
        if (open && !isNaN(closes)) line2 = '开放中 · 距截止 ' + fmtDur(closes - now);
        else if (!open && !isNaN(opens)) line2 = '未开放 · 距开放 ' + fmtDur(opens - now);
        else line2 = open ? '开放中' : '未开放';
      }
      // 该盯哪个边界：开放中盯截止，未开放盯开放
      const edge = open ? closes : opens;
      this.stale = enabled && !isNaN(edge) && edge - now <= 0;

      return {
        winEnabled: enabled,
        winOpen: open,
        winLine1: win.windowText || '',
        winLine2: line2,
        winClosesAt: isNaN(closes) ? '' : fmtIso(win.closesAt),
        // 审核截止：2026-09-25 起与「收歌截止」分开配置，回执屏要报的是这个时刻
        winReviewAt: win.reviewAt ? fmtIso(win.reviewAt) : '',
      };
    },

    render() {
      const v = this.view();
      if (!v) return;
      const d = page.data || {};
      if (d.winLine1 === v.winLine1 && d.winLine2 === v.winLine2 && d.winOpen === v.winOpen
        && d.winEnabled === v.winEnabled && d.winClosesAt === v.winClosesAt
        && d.winReviewAt === v.winReviewAt) return;   // 秒级去抖：文案没变不 setData
      page.setData(v);
      if (typeof page.onWindowChange === 'function') page.onWindowChange(v);
    },

    startTimer() {
      if (!this.win || !this.win.enabled || this.timer) return;   // 窗口关掉（不限时间）就不用走秒
      this.timer = setInterval(() => {
        if (this.stale) {
          if (!this.refreshing) {
            this.refreshing = true;
            this.load().then(() => { this.refreshing = false; });
          }
          return;
        }
        this.render();
      }, 1000);
    },

    stopTimer() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.refreshing = false;
    },
  };
}

module.exports = { create };
