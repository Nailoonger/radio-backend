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

  /** 换本社团头像 */
  changeAvatar() {
    if (this.data.uploading) return;
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
        // ⚠️ 2MB 是后端兜底上界（HTTP 通道的实际上界只有 100KB）；
        //    小程序走 callFunction 宽松些，但仍应在客户端先挡一次，别白传
        if (file.size > 2 * 1024 * 1024) {
          wx.showToast({ title: '图片太大，换一张小点的', icon: 'none' });
          return;
        }
        this.setData({ uploading: true });
        wx.showLoading({ title: '上传中…', mask: true });
        let base64 = '';
        try {
          base64 = wx.getFileSystemManager().readFileSync(file.tempFilePath, 'base64');
        } catch (e) {
          wx.hideLoading();
          this.setData({ uploading: false });
          wx.showToast({ title: '读不到这张图', icon: 'none' });
          return;
        }
        request('/user/club-key/avatar', 'PUT', { ticket, fileBase64: base64 })
          .then((d) => {
            clubTicket.saveClub(d.club);
            this.setData({ club: d.club, initial: (d.club.name || '社').charAt(0) });
            wx.showToast({ title: '已更换' });
          })
          .catch((err) => {
            if (err && (err.code === 40102 || err.code === 40101)) {   // 40102 = 社团票据过期（会用 40101 是旧部署）
              clubTicket.clear();
              wx.redirectTo({ url: '/pages/club-code/club-code' });
              return;
            }
            wx.showToast({ title: (err && err.message) || '上传失败', icon: 'none' });
          })
          .then(() => {
            wx.hideLoading();
            this.setData({ uploading: false });
          });
      },
    });
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
