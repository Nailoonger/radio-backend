// pages/programDetail/programDetail.js
const { request } = require('../../utils/request.js');
const { fmtDate } = require('../../utils/format.js');
const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    program: null,
    messages: [],
    loading: true,

    // 留言
    inputContent: '',
    sending: false,
    loggedIn: false,
    canMessage: true,     // 模块开关 message
  },

  onLoad(options) {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      loggedIn: !!app.globalData.token,
    });

    request(`/user/program/${options.id}`)
      .then((data) => {
        this.setData({
          program: data.program,
          messages: (data.messages || []).map(m => ({
            ...m,
            createTimeFmt: fmtDate(m.createTime),
            // 头像兜底用昵称首字（WXML 里不能对表达式取下标，这里先算好）
            initial: (m.nickname || '').trim().charAt(0) || '同',
          })),
          loading: false,
        });
      })
      .catch(() => this.setData({ loading: false }));

    // 留言模块开关（读取接口不受开关影响，这里只是提前把输入框置灰）
    app.fetchSwitches().then((sw) => {
      this.setData({ canMessage: app.isModuleEnabled('message') });
    });
  },

  onShow() {
    this.setData({ loggedIn: !!app.globalData.token });
  },

  onInput(e) {
    this.setData({ inputContent: e.detail.value });
  },

  async sendMessage() {
    const { inputContent, sending, canMessage, program } = this.data;
    if (!canMessage) return app.toast('留言通道已关闭');
    if (!inputContent || !inputContent.trim()) return;
    if (sending) return;

    this.setData({ sending: true });
    try {
      await request('/user/message', 'POST', {
        programId: program ? program.id : undefined,
        content: inputContent.trim(),
      });
      // 新留言要过审才会出现在列表里，这里不往列表里塞
      this.setData({ inputContent: '' });
      wx.showToast({ title: '留言成功，等待审核', icon: 'none' });
    } catch (e) {
      if (e && e.code === 40302) {
        wx.showToast({ title: '留言通道已关闭', icon: 'none' });
      } else if (e && e.code === 40101) {
        wx.showToast({ title: '请先登录', icon: 'none' });
      } else {
        wx.showToast({ title: (e && e.message) || '留言失败', icon: 'none' });
      }
    } finally {
      this.setData({ sending: false });
    }
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/index/index' });
  },

  goSubmit() {
    wx.switchTab({ url: '/pages/submit/submit' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' });
  },
});
