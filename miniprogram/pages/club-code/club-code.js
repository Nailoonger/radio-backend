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

/**
 * 弧形旋转木马的位次表 —— 与 preview/notice-hub-v5 · s-code 屏同源，只把 px 换成 rpx（×1.923）。
 * 下标 = 离中心几格：0 正中 / 1 左右一档 / 2 左右二档；更远的落屏外待命（见 CAR_PARK_*）。
 */
const CAR_X = [0, 181, 273];          // translateX  94px / 142px
const CAR_S = [1.18, 0.76, 0.54];     // scale
const CAR_R = [0, 26, 38];            // rotateY 后仰角
const CAR_O = [1, 0.95, 0.5];         // opacity
const CAR_PARK_X = 377;               // 196px 屏外待命
const CAR_PARK_S = 0.42;
const CAR_PARK_R = 46;
const CAR_STEP_MS = 2600;             // 自动走一格的间隔
const CAR_WALK_MS = 150;              // 点某一枚时逐格走的速度

Page({
  data: {
    statusBarHeight: 20,
    clubs: [],
    curName: '',
    // 首帧必须关过渡：徽标从「全叠在中心」的状态落位，不关就会补间成一次从中间散开的乱飞
    carOn: false,
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

  /** 切后台就停：页面看不见还在跑定时器，白烧电 */
  onHide() { this._carStop(); },
  onShow() { if (this.data.clubs.length > 1) this._carPlay(); },
  onUnload() { this._carStop(); },

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
        this._carStart();
      })
      .catch(() => { /* 静默：见上 */ });
  },

  /**
   * 头像加载完，按**源图比例**定宽高（基准 142rpx，最长边给满）。
   * 比例跟源图一致，aspectFill 就一点内容都不裁，圆形由白圆盘自己削角。
   * 最扁/最窄兜 56rpx，否则 1:5 的图会变成一条线。
   */
  onAvLoad(e) {
    const i = Number(e.currentTarget.dataset.i);
    const w = Number(e.detail && e.detail.width) || 0;
    const h = Number(e.detail && e.detail.height) || 0;
    if (!w || !h) return;
    const M = 142, MIN = 56;
    const iw = w >= h ? M : Math.max(MIN, Math.round(M * w / h));
    const ih = w >= h ? Math.max(MIN, Math.round(M * h / w)) : M;
    const cur = this.data.clubs[i] || {};
    if (cur.iw === iw && cur.ih === ih) return;
    this.setData({ ['clubs[' + i + '].iw']: iw, ['clubs[' + i + '].ih']: ih });
  },

  /* ══════ 弧形旋转木马 ══════ */

  _carStop() {
    if (this._carTimer) { clearInterval(this._carTimer); this._carTimer = null; }
    if (this._carWalk) { clearInterval(this._carWalk); this._carWalk = null; }
  },

  /** 起步：算每枚的环形初始位 → 落位 → 开始自动转 */
  _carStart() {
    const N = this.data.clubs.length;
    this._carStop();
    this._carStep = 0;
    this._carPos = [];
    if (!N) return;
    const half = N / 2;
    for (let q = 0; q < N; q++) this._carPos.push(q > half ? q - N : q);
    this._carVis = this._carPos.map((d) => Math.abs(d) <= 2);   // 位次表只有 0/±1/±2
    this.setData({ carOn: false });   // 与下面那次 setData 合批，首帧不带过渡
    this._carLayout(0);
    this._carPlay();
  },

  _carPlay() {
    this._carStop();
    if (this.data.clubs.length < 2) return;
    this._carTimer = setInterval(() => {
      this._carStep += 1;
      this._carLayout(1);
    }, CAR_STEP_MS);
  },

  /**
   * 按 ds（相对上一帧走了几格）重排一次。
   * ⚠️ 位置靠「上一帧的位置减 ds」连续推，不用模运算现场归一：
   *    模运算在 N/2 折返点上分不清「从左侧退场」还是「从右侧入列」，
   *    那一次符号算错，就会让徽标横穿整个屏幕。
   */
  _carLayout(ds) {
    const clubs = this.data.clubs;
    const N = clubs.length;
    if (!N) return;
    const half = N / 2;
    // 扇形只有 0/±1/±2 五个位子。
    // N > 5：永远有余量，绕到背面的那一枚藏到屏外，再滑进来（最好看）；
    // N = 5：一个萝卜一个坑，藏了就必然空出一个位子 ⇒ 不能藏，改成「瞬移到对侧 + 淡入」。
    const hasSpare = N > 5;
    const parkIdxs = [];
    const fadeIdxs = [];
    const fadeSt = {};
    const next = [];

    for (let k = 0; k < N; k++) {
      const dr = this._carPos[k] - ds;      // 折叠前的连续位置
      const wasVis = this._carVis[k] !== false;
      const crossed = N >= 3 && ((dr > half) || (dr < -half));
      let d = dr;
      while (d > half) d -= N;              // 转过半个圆就折回另一侧，位置永远落在 ±half 内
      while (d < -half) d += N;
      this._carPos[k] = d;

      // 只有「上一帧还看得见」才算绕到背面去了；否则它是刚从背面绕回来，正要入场
      const wrapped = crossed && wasVis;
      const parked = hasSpare && (Math.abs(d) > 2 || wrapped);
      this._carVis[k] = !parked;

      if (parked) {
        // 退到屏外，且要落在它「下一次入场的那一侧」，否则下一帧会横穿整屏
        const side = ds > 0 ? 1 : -1;
        parkIdxs.push(k);
        next.push({
          ...clubs[k],
          nt: true,
          st: 'transform:translateX(' + (side > 0 ? CAR_PARK_X : -CAR_PARK_X) + 'rpx) scale(' + CAR_PARK_S +
              ') rotateY(' + (side > 0 ? -CAR_PARK_R : CAR_PARK_R) + 'deg);opacity:0;z-index:0',
        });
        continue;
      }

      const a = Math.abs(d);
      const sg = d > 0 ? 1 : -1;
      const tx = d ? sg * CAR_X[a] : 0;
      const ry = d ? -sg * CAR_R[a] : 0;
      const finalSt = 'transform:translateX(' + tx + 'rpx) scale(' + CAR_S[a] + ') rotateY(' + ry + 'deg);opacity:' +
                      CAR_O[a] + ';z-index:' + (5 - a);

      if (wrapped) {
        // 5 家时绕到背面的这一枚：先不加过渡地落到对侧位子、透明度 0，
        // 下一拍再放开过渡淡进来 —— 不做这一步它就会从 -273 滑到 +273 横穿正面。
        fadeIdxs.push(k);
        fadeSt[k] = finalSt;
        next.push({ ...clubs[k], nt: true, st: finalSt.replace(/opacity:[^;]*/, 'opacity:0') });
        continue;
      }

      next.push({ ...clubs[k], nt: false, st: finalSt });
    }

    this.setData({
      clubs: next,
      curName: clubs[((this._carStep % N) + N) % N].name,
    }, () => {
      const patch = {};
      // 瞬移那一帧只关这几枚的过渡，下一帧立刻放开；不放开它下次入场也不会补间
      parkIdxs.forEach((i) => { patch['clubs[' + i + '].nt'] = false; });
      // 淡入的这几枚：位子不动，只把透明度补上，由 .62s 过渡自己淡进来
      fadeIdxs.forEach((i) => {
        patch['clubs[' + i + '].nt'] = false;
        patch['clubs[' + i + '].st'] = fadeSt[i];
      });
      // ⚠️ 首帧的「放开过渡」必须放到回调里：和落位样式同一次 setData 提交的话，
      //    合并后 carOn 直接就是 true，等于没关过 —— 六枚会从中心散开乱飞一次
      if (!this.data.carOn) patch.carOn = true;
      if (Object.keys(patch).length) this.setData(patch);
    });
  },

  /** 点某一枚：走最近的一侧**逐格**过去（一次只走一格，跳太远会让绕到背面的那枚没有中间帧，像凭空闪现） */
  tapClub(e) {
    const i = Number(e.currentTarget.dataset.i);
    const N = this.data.clubs.length;
    if (N < 2) return;
    const c = ((this._carStep % N) + N) % N;
    let d = (((i - c) % N) + N) % N;
    if (!d) return;
    if (d > N / 2) d -= N;
    const dir = d > 0 ? 1 : -1;
    let left = Math.abs(d);
    this._carStop();
    this._carWalk = setInterval(() => {
      this._carStep += dir;
      this._carLayout(dir);
      left -= 1;
      if (left <= 0) {
        clearInterval(this._carWalk);
        this._carWalk = null;
        this._carPlay();
      }
    }, CAR_WALK_MS);
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
