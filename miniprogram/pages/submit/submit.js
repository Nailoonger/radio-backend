// pages/submit/submit.js
const { request } = require('../../utils/request.js');
const app = getApp();

Page({
  data: {
    type: 1,                // 1=点歌 2=文稿
    songName: '',
    singer: '',
    wishContent: '',
    articleTitle: '',
    articleContent: '',
    wantBroadcastTime: '',
    submitting: false,
    loggedIn: false,
    switches: {},          // 模块开关缓存
  },

  onLoad() {
    this.checkLogin();
    this.loadSwitches();
  },

  onShow() {
    this.checkLogin();
    this.loadSwitches();
  },

  loadSwitches() {
    // 拉最新开关状态
    const app = getApp();
    if (app.fetchSwitches) {
      app.fetchSwitches().then((sw) => {
        this.setData({ switches: sw || {} });
        // 当前 tab 被关闭：自动切到另一个
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
  },

  inputSongName(e) { this.setData({ songName: e.detail.value }); },
  inputSinger(e) { this.setData({ singer: e.detail.value }); },
  inputWish(e) { this.setData({ wishContent: e.detail.value }); },
  inputArticleTitle(e) { this.setData({ articleTitle: e.detail.value }); },
  inputArticleContent(e) { this.setData({ articleContent: e.detail.value }); },
  inputTime(e) { this.setData({ wantBroadcastTime: e.detail.value }); },

  async ensureLogin() {
    if (app.globalData.token) return true;
    try {
      await app.login();
      this.setData({ loggedIn: true });
      return true;
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      return false;
    }
  },

  async doSubmit() {
    const { type, songName, singer, wishContent, articleTitle, articleContent, wantBroadcastTime } = this.data;

    if (type === 1) {
      if (!songName.trim() || !singer.trim()) {
        return wx.showToast({ title: '请填写歌名和歌手', icon: 'none' });
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
      // 40302 = 模块已关闭
      if (e && e.code === 40302) {
        wx.showToast({ title: '该模块暂时关闭，请稍后再试', icon: 'none' });
      } else {
        wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },
});
