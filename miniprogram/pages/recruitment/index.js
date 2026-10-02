const recruitment = require('../../utils/recruitment.js');

Page({
  data: { statusBarHeight: 20, loading: true, error: '', batch: null, opensText: '', closesText: '', windowText: '', pending: false },
  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.load();
  },
  onShow() { this.setData({ pending: !!recruitment.pendingSubmission() }); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await recruitment.current();
      const batch = result && result.batch;
      this.setData({
        batch: batch || null,
        opensText: batch ? recruitment.timeText(batch.opensAt) : '',
        closesText: batch ? recruitment.timeText(batch.closedAt || batch.closesAt) : '',
        windowText: batch ? (batch.closedAt ? '报名已手动截止'
          : ({ upcoming: '报名尚未开始', open: '正在报名', closed: '报名已截止' }[batch.windowState] || '报名暂未开放')) : '',
      });
    } catch (error) { this.setData({ error: recruitment.errorText(error) }); }
    finally { this.setData({ loading: false }); }
  },
  apply() {
    if (!this.data.batch || this.data.batch.windowState !== 'open') return;
    recruitment.navigate('/pages/recruitment-form/index', { batch: this.data.batch, mode: 'apply' });
  },
  resume() { recruitment.navigate('/pages/recruitment-form/index', { mode: 'retry' }); },
  query() { recruitment.navigate('/pages/recruitment-result/index', null); },
  goBack: recruitment.goBack,
});
