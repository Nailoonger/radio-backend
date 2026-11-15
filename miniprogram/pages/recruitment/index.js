const recruitment = require('../../utils/recruitment.js');
const skeleton = require('../../utils/skeleton.js');

Page({
  // 骨架（2026-11-16）：sk 初值 true —— 骨架从第一帧就在，内容层整块 wx:if 掉
  data: { statusBarHeight: 20, loading: true, error: '', batch: null, opensText: '', closesText: '', windowText: '', gradeText: '', pending: false, sk: true, skOut: false, enter: false },
  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.skGate = skeleton.create(this, { when: () => !this.data.loading });
    this.skGate.boot();
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
        gradeText: batch ? recruitment.gradeScopeText(batch.fixedFields) : '',
      });
    } catch (error) { this.setData({ error: recruitment.errorText(error) }); }
    finally { this.setData({ loading: false }, () => this.skGate.check()); }
  },
  apply() {
    if (!this.data.batch || this.data.batch.windowState !== 'open') return;
    recruitment.navigate('/pages/recruitment-form/index', { batch: this.data.batch, mode: 'apply' });
  },
  resume() { recruitment.navigate('/pages/recruitment-form/index', { mode: 'retry' }); },
  query() { recruitment.navigate('/pages/recruitment-result/index', null); },
  goBack: recruitment.goBack,
});
