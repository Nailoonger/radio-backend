// pages/club-code/club-code.js
// 输入社团密钥 —— 广播通知线的门
//
// 三件事：
//   ① 轮播告诉用户「这个入口对应哪些社团」（名称是唯一指示，与原型一致）
//   ② 六格输入（真实 input 藏在格子上，视觉靠 6 个 view 拼）
//   ③ 输对 → 换一张 2 小时票据 → 进社团台
//
// ⚠️ 输入框用 `maxlength=6`：这里的 6 是**存储上限**，不是业务字数限制
//    （密钥是 6 位大写字母+数字，没有拼音候选，所以不受「中文打不进去」那个坑影响）。
// ⚠️ bindinput 里**直接 return 过滤后的字符串**，不用 setData 回写 value：
//    回写会跟输入法的 composition 抢，表现为「打一个字跳两下」。

const { request } = require('../../utils/request.js');
const clubTicket = require('../../utils/clubTicket.js');

/** 与后端 services/clubKey 的 ALPHABET 同源：去掉 0/O/1/I/L 这五个易认错的字符 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_LEN = 6;

Page({
  data: {
    statusBarHeight: 20,
    clubs: [],
    cur: 0,
    curName: '',
    cells: [0, 1, 2, 3, 4, 5],
    code: '',
    focused: false,
    submitting: false,
    hint: '',
    back: '',
  },

  onLoad(q) {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      back: (q && q.back) ? decodeURIComponent(q.back) : '',
    });
    this.loadClubs();
  },

  /**
   * 社团清单（免登录接口）
   * ⚠️ 接口失败**不能挡路**：轮播只是「说明这是哪些社团」，输码才是正事。
   *    拿不到就留空，页面照样能输码。
   */
  loadClubs() {
    // scope='public'：这条接口免登录，不带 token（签名见 utils/request.js: request(url, method, data, scope, options)）
    return request('/user/club-key/clubs', 'GET', {}, 'public')
      .then((data) => {
        const list = (data.list || []).map((c) => ({
          ...c,
          initial: (c.name || '社').charAt(0),
        }));
        this.setData({ clubs: list, curName: list.length ? list[0].name : '' });
      })
      .catch(() => { /* 静默：见上 */ });
  },

  onCar(e) {
    const cur = e.detail.current;
    const clubs = this.data.clubs;
    this.setData({ cur, curName: clubs[cur] ? clubs[cur].name : '' });
  },

  focusInput() {
    this.setData({ focused: true });
  },

  onBlur() {
    this.setData({ focused: false });
  },

  /** 只留合法字符、转大写、截 6 位 */
  onInput(e) {
    const raw = String(e.detail.value || '')
      .toUpperCase()
      .split('')
      .filter((ch) => ALPHABET.indexOf(ch) >= 0)
      .join('')
      .slice(0, KEY_LEN);
    this.setData({ code: raw, hint: '' });
    // 直接改输入框的值（不等 setData），避免输入法 composition 抢光标
    return raw;
  },

  paste() {
    wx.getClipboardData({
      success: (res) => {
        const raw = String(res.data || '')
          .toUpperCase()
          .split('')
          .filter((ch) => ALPHABET.indexOf(ch) >= 0)
          .join('')
          .slice(0, KEY_LEN);
        if (!raw) {
          this.setData({ hint: '剪贴板里没有可用的密钥' });
          return;
        }
        this.setData({ code: raw, hint: '' });
      },
      fail: () => this.setData({ hint: '读不到剪贴板，手动输入吧' }),
    });
  },

  submit() {
    if (this.data.submitting) return;
    const code = this.data.code;
    if (code.length !== KEY_LEN) {
      this.setData({ hint: `密钥是 ${KEY_LEN} 位，还差 ${KEY_LEN - code.length} 位` });
      return;
    }
    this.setData({ submitting: true, hint: '' });
    request('/user/club-key/verify', 'POST', { key: code })
      .then((data) => {
        clubTicket.save(data.ticket, data.club, data.expireAt);
        const back = this.data.back || '/pages/club-desk/club-desk';
        wx.redirectTo({ url: back });
      })
      .catch((err) => {
        this.setData({
          submitting: false,
          // 后端已经把「不对」和「太频繁」分开说了，原样透出，别在页面里再猜一遍
          hint: (err && err.message) || '进不去，请稍后再试',
          code: '',
        });
      });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
  },
});
