// pages/club-desk/club-desk.js
// 社团通知台（二级页，不挂底部导航）—— 输对密钥之后的落地页
//
// 一屏三件事：
//   ① 我是哪家社团（头像可换，换的是**自己这一家**，后端只认票据里的 clubId）
//   ② 我的提交（全部状态，最新在前）
//   ③ 再提一条
//
// ⚠️ 票据失效（2 小时到期 / 社团被作废）统一由 40102 兜住 → 清票据 → 回输码页。
//    40102 而不是 40101：后者会让 utils/request.js 清掉学生登录态（这模块不要求登录）。
//    不在这里猜原因：到期和被作废对用户是同一句话「重新输一次」。

const { request } = require('../../utils/request.js');
const clubTicket = require('../../utils/clubTicket.js');
const clubTime = require('../../utils/clubTime.js');

const ST_CLS = { 0: 'wait', 1: 'air', 2: 'rej', 3: 'done', 9: 'mute' };

Page({
  data: {
    statusBarHeight: 20,
    club: null,
    initial: '社',
    list: [],
    count: { total: 0, wait: 0, air: 0, done: 0, reject: 0 },
    loading: true,
    uploading: false,

    // ══ 调整头像全屏层（不进页面栈，关掉就回到本页） ══
    cropOn: false,
    cropSrc: '',
    cropStyle: '',
    cropHoleStyle: '',
    cropD: 0,
    cropBusy: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
  },

  onShow() {
    const ticket = clubTicket.getTicket();
    if (!ticket) {
      // 没票（或本地已判过期）→ 回输码页，别让页面停在空壳上
      wx.redirectTo({ url: '/pages/club-code/club-code' });
      return;
    }
    // 先用缓存里的社团信息占位，避免每次进来都白屏一下
    const cached = clubTicket.getClub();
    if (cached) this.setData({ club: cached, initial: (cached.name || '社').charAt(0) });
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  /** 社团信息 + 我的提交，并行拉 */
  reload() {
    const ticket = clubTicket.getTicket();
    if (!ticket) return Promise.resolve();
    this.setData({ loading: !this.data.list.length });
    return Promise.all([
      request('/user/club-key/me', 'GET', { ticket }).then((d) => {
        if (!d.club) {
          // 票据在服务端已失效（换手机后时钟差、社团被作废等）→ 清掉重输
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
          return;
        }
        clubTicket.saveClub(d.club);
        this.setData({ club: d.club, initial: (d.club.name || '社').charAt(0) });
      }),
      request('/user/club-notice/my', 'GET', { ticket }).then((d) => {
        this.setData({
          list: (d.list || []).map((x) => this.decorate(x)),
          count: d.count || this.data.count,
        });
      }),
    ])
      .catch((err) => {
        if (err && (err.code === 40102 || err.code === 40101)) {   // 40102 = 社团票据过期（会用 40101 是旧部署）
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  decorate(x) {
    return {
      ...x,
      stCls: ST_CLS[Number(x.status)] || 'mute',
      timeText: clubTime.rel(x.createTime),
      // 列表里只露一行标题；正文两行截断由 .qbody 的 clamp 负责
    };
  },

  /**
   * 换本社团头像
   *
   * ⚠️⚠️ 手机上拍的照片不能直接 base64 塞进 callFunction：
   *    `wx.cloud.callFunction` 的 data 有上限（约 1MB），而 base64 还要再涨 33%。
   *    2~5MB 的直出照片一变 base64 就是 3~7MB ⇒ 平台侧直接回
   *    `cloud.callFunction:fail Error: data exceed max…`，**请求根本没到云函数**，
   *    所以后端那句「超过 2MB」的判断一辈子都触发不到（2026-11-07 真机上就是这么卡的）。
   *    正解只有一条：客户端先压。现在改成「先进调整层 → canvas 真裁 720×720 方图（quality 0.86）」，
   *    通常 80~150KB，base64 约 110~200KB，离上限很远；`_shrink` 只当极端情况的兜底。
   */
  changeAvatar() {
    if (this.data.uploading || this.data.cropOn) return;
    const ticket = clubTicket.getTicket();
    if (!ticket) { wx.redirectTo({ url: '/pages/club-code/club-code' }); return; }

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (!file) return;
        // 只挡「大得离谱」的，免得读图卡住；真正的大小判据在 _shrink 里按 base64 长度算
        if (file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: '图片太大，换一张小点的', icon: 'none' });
          return;
        }
        // 选完不直接上传：先进调整层，圆里看中的那一块才是头像
        this._openCrop(file.tempFilePath);
      },
    });
  },

  /* ══════ 调整头像（全屏层，不新开页面） ══════ */
  //
  // 口径与 preview/club-avatar-crop-v3 同源：
  //   圆洞直径 D = 舞台宽 × 0.78；进页把图缩到「刚好铺满圆」（base = D / min(源宽,源高)）；
  //   拖动范围 = 图的四条边都不许进圆（clamp 到 dw/2 - R），跟微信换头像一个手感；
  //   缩放以圆心为锚（tx/ty 按同一比例放大，手一松不会飘）；
  //   输出 720×720 方图，圆由各处自己削角。
  // ⚠️ 导航栏右上永远是微信胶囊，这一层不往那儿放任何东西 —— 关闭用左边的 ✕。

  _openCrop(src) {
    this._k = 1; this._tx = 0; this._ty = 0;
    this._pinch = null; this._drag = null;
    this._w0 = 0; this._h0 = 0;
    this.setData({ cropOn: true, cropSrc: src, cropBusy: false }, () => {
      wx.nextTick(() => this._measure());
    });
    wx.getImageInfo({
      src,
      success: (r) => { this._w0 = r.width || 0; this._h0 = r.height || 0; this._measure(); },
      fail: () => {
        this.setData({ cropOn: false, cropSrc: '' });
        wx.showToast({ title: '读不到这张图，换一张', icon: 'none' });
      },
    });
  },

  /** 量舞台（px）→ 定圆洞 → 定初始缩放。图还没读到或还没布局好就先返回，谁后到谁再调一次 */
  _measure() {
    wx.createSelectorQuery().in(this).select('#cropStage').boundingClientRect((rect) => {
      if (!rect || !rect.width) return;
      if (!this._w0 || !this._h0) return;
      this._D = Math.round(rect.width * 0.78);
      this._base = this._D / Math.min(this._w0, this._h0);   // 刚好铺满圆：短边 = 圆直径
      this._dw = this._w0 * this._base * this._k;
      this._dh = this._h0 * this._base * this._k;
      this.setData({
        cropD: this._D,
        cropHoleStyle: 'width:' + this._D + 'px;height:' + this._D + 'px;' +
          'margin-left:' + (-this._D / 2) + 'px;margin-top:' + (-this._D / 2) + 'px',
      });
      this._clamp();
      this._apply();
    }).exec();
  },

  /** 图的四条边都不许进圆，拖到头就停住 */
  _clamp() {
    const R = this._D / 2;
    const mx = Math.max(0, this._dw / 2 - R);
    const my = Math.max(0, this._dh / 2 - R);
    this._tx = Math.min(mx, Math.max(-mx, this._tx));
    this._ty = Math.min(my, Math.max(-my, this._ty));
  },

  _apply() {
    const dw = this._dw, dh = this._dh;
    this.setData({
      cropStyle: 'width:' + dw.toFixed(1) + 'px;height:' + dh.toFixed(1) + 'px;' +
        'margin-left:' + (-dw / 2).toFixed(1) + 'px;margin-top:' + (-dh / 2).toFixed(1) + 'px;' +
        'transform:translate(' + this._tx.toFixed(1) + 'px,' + this._ty.toFixed(1) + 'px)',
    });
  },

  _setZoom(nk) {
    nk = Math.min(3, Math.max(1, nk));
    if (!this._base) return;
    const ratio = nk / this._k;
    this._k = nk;
    this._dw = this._w0 * this._base * nk;
    this._dh = this._h0 * this._base * nk;
    this._tx *= ratio; this._ty *= ratio;   // 以圆心为锚点缩放
    this._clamp();
    this._apply();
  },

  _dist(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy) || 0;
  },

  onCropStart(e) {
    const ts = e.touches || [];
    if (ts.length >= 2) {
      this._pinch = { d: this._dist(ts[0], ts[1]), k: this._k };
      this._drag = null;
      return;
    }
    if (ts.length === 1) {
      this._pinch = null;
      this._drag = { x: ts[0].clientX, y: ts[0].clientY, tx: this._tx, ty: this._ty };
    }
  },

  onCropMove(e) {
    const ts = e.touches || [];
    if (ts.length >= 2 && this._pinch) {
      const d = this._dist(ts[0], ts[1]);
      if (this._pinch.d > 0) this._setZoom(this._pinch.k * d / this._pinch.d);
      return;
    }
    if (ts.length === 1 && this._drag) {
      this._tx = this._drag.tx + (ts[0].clientX - this._drag.x);
      this._ty = this._drag.ty + (ts[0].clientY - this._drag.y);
      this._clamp();
      this._apply();
    }
  },

  /** 双指松开一根不能断：无缝转成单指拖，否则剩下的那根手指要从头再按一次 */
  onCropEnd(e) {
    const ts = e.touches || [];
    if (ts.length === 1) {
      this._pinch = null;
      this._drag = { x: ts[0].clientX, y: ts[0].clientY, tx: this._tx, ty: this._ty };
      return;
    }
    if (!ts.length) { this._drag = null; this._pinch = null; }
  },

  resetCrop() {
    if (!this._base) return;
    this._k = 1;
    this._dw = this._w0 * this._base;
    this._dh = this._h0 * this._base;
    this._tx = 0; this._ty = 0;
    this._clamp();
    this._apply();
  },

  closeCrop() {
    this._drag = null; this._pinch = null;
    this.setData({ cropOn: false, cropSrc: '' });
  },

  /**
   * 完成：canvas 2d 按同一套公式真裁 → 720×720 JPEG
   * ⚠️ 公式必须跟屏幕上看到的那一套完全一致（base/k/tx/ty 直接用），
   *    否则「圆里看中的」和「真正上传的」会错位，而且错得不明显。
   */
  confirmCrop() {
    if (this.data.cropBusy || !this._base) return;
    this.setData({ cropBusy: true });
    wx.createSelectorQuery().in(this).select('#cropCanvas').fields({ node: true }).exec((res) => {
      const canvas = res && res[0] && res[0].node;
      if (!canvas) { this.setData({ cropBusy: false }); wx.showToast({ title: '出错了，再试一次', icon: 'none' }); return; }
      const OUT = 720;
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, OUT, OUT);
      const img = canvas.createImage();
      img.onload = () => {
        const scale = this._base * this._k;          // 屏幕 px / 源图 px
        const side = this._D / scale;                // 圆洞对应的源图边长
        const cx = this._w0 / 2 - this._tx / scale;
        const cy = this._h0 / 2 - this._ty / scale;
        ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, OUT, OUT);
        // 等一帧再导：canvas 2d 的 drawImage 是同步的，但个别机型导出的第一帧是空白的
        setTimeout(() => wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: OUT, height: OUT,
          destWidth: OUT, destHeight: OUT,
          fileType: 'jpg', quality: 0.86,
          success: (r) => this._uploadCrop(r.tempFilePath),
          fail: () => { this.setData({ cropBusy: false }); wx.showToast({ title: '裁图失败，再试一次', icon: 'none' }); },
        }), 60);
      };
      img.onerror = () => { this.setData({ cropBusy: false }); wx.showToast({ title: '读不到这张图', icon: 'none' }); };
      img.src = this.data.cropSrc;
    });
  },

  /** 裁好的 720 方图 → base64（≤700KB）→ PUT */
  _uploadCrop(path) {
    const ticket = clubTicket.getTicket();
    if (!ticket) { wx.redirectTo({ url: '/pages/club-code/club-code' }); return; }
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    this._shrink(path)
      .then((base64) => {
        if (!base64) {
          wx.hideLoading();
          this.setData({ uploading: false, cropBusy: false });
          wx.showToast({ title: '这张图压不小，换一张或先截屏', icon: 'none' });
          return null;
        }
        return request('/user/club-key/avatar', 'PUT', { ticket, fileBase64: base64 })
          .then((d) => {
            clubTicket.saveClub(d.club);
            this.setData({ club: d.club, initial: (d.club.name || '社').charAt(0), cropOn: false, cropSrc: '' });
            wx.showToast({ title: '已更换' });
          });
      })
      .catch((err) => {
        if (err && (err.code === 40102 || err.code === 40101)) {   // 40102 = 社团票据过期（会用 40101 是旧部署）
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
          return;
        }
        // 压过了还超限（极端的全景长图）：给一句人话，别把平台的英文原文甩给人
        if (/data exceed|exceed max/i.test((err && err.message) || '')) {
          wx.showToast({ title: '图片还是太大，换一张', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '上传失败', icon: 'none' });
      })
      .then(() => {
        wx.hideLoading();
        this.setData({ uploading: false, cropBusy: false });
      });
  },

  /**
   * 图片 → 能塞进 callFunction 的 base64（≤ 700KB 字符）
   *
   * 逐级压：720/80 → 720/55 → 480/50 → 360/40。每级都从**原图**压（不是在上一次结果上再压，
   * 那样会累积失真），压完重新读长度，够了就停。全都压不下来返回 ''，由调用方给提示。
   * ⚠️ `compressedWidth` 要基础库 2.26.0+；老版本不认就退回「只降 quality」再试一次。
   */
  _shrink(path) {
    const LIMIT = 700 * 1024;
    const read = (p) => {
      try { return wx.getFileSystemManager().readFileSync(p, 'base64'); } catch (e) { return ''; }
    };
    const compress = (width, quality) => new Promise((resolve) => {
      if (!wx.compressImage) { resolve(''); return; }   // 基础库 < 2.4.0
      const once = (opt, fallback) => wx.compressImage({
        src: path,
        ...opt,
        success: (r) => resolve((r && r.tempFilePath) || ''),
        fail: () => (fallback ? once(fallback, null) : resolve('')),
      });
      once({ quality, compressedWidth: width }, { quality });
    });

    const first = read(path);
    if (!first) return Promise.resolve('');
    if (first.length <= LIMIT) return Promise.resolve(first);

    const steps = [[720, 80], [720, 55], [480, 50], [360, 40]];
    return steps
      .reduce((p, [w, q]) => p.then((b64) => {
        if (b64 && b64.length <= LIMIT) return b64;
        return compress(w, q).then((p2) => (p2 ? read(p2) : ''));
      }), Promise.resolve(first))
      .then((b64) => (b64 && b64.length <= LIMIT ? b64 : ''));
  },

  goNew() {
    wx.navigateTo({ url: '/pages/club-new/club-new' });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/club-notice/club-notice?id=${id}` });
  },

  goEdit(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/club-new/club-new?id=${id}` });
  },

  withdraw(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '撤回这条',
      content: '撤回后这条不会播出，也不能恢复。确定撤回？',
      confirmText: '撤回',
      confirmColor: '#B42318',
      success: ({ confirm }) => {
        if (!confirm) return;
        const ticket = clubTicket.getTicket();
        request(`/user/club-notice/${id}/withdraw`, 'POST', { ticket })
          .then(() => {
            wx.showToast({ title: '已撤回' });
            this.reload();
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '撤回失败', icon: 'none' });
            this.reload();
          });
      },
    });
  },

  switchClub() {
    // 换一个社团：清掉当前票据再进输码页，否则会被 ensure 直接放行
    wx.showModal({
      title: '换一个社团',
      content: '需要用另一家社团的密钥重新进入，当前社团不会退出登录。',
      confirmText: '重新输入',
      success: ({ confirm }) => {
        if (!confirm) return;
        clubTicket.clear();
        wx.redirectTo({ url: '/pages/club-code/club-code' });
      },
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mySubmit/mySubmit' });
  },

  /** 空处理器：卡片整体可点进详情，卡内的「修改 / 撤回」要 catchtap 掉冒泡 */
  noop() {},
});
