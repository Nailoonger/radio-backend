const recruitment = require('../../utils/recruitment.js');
const STATUS = { submitted: '已提交', interview: '待面试', accepted: '已录取', rejected: '未录取', withdrawn: '已撤回' };
const TAGS = { submitted: 'tag-pending', interview: 'tag-acc', accepted: 'tag-pass', rejected: 'tag-reject', withdrawn: 'tag-outline' };

Page({
  data: {
    statusBarHeight: 20, queryInput: '', querying: false, busy: false, error: '', application: null,
    receiptCode: '', questions: [], statusText: '', statusClass: '', interviewText: '', closesText: '', createdText: '',
  },
  onLoad() {
    this._alive = true;
    this._queryCode = '';
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    const context = recruitment.takeContext();
    if (context && context.queryCode && context.application) {
      this._queryCode = context.queryCode;
      this.setData({ receiptCode: context.receipt ? context.queryCode : '' });
      this.showApplication(context.application);
      if (context.receipt) recruitment.clearPending();
    }
  },
  onUnload() {
    this._alive = false;
    this._queryCode = '';
    recruitment.clearContext();
    this.setData({ queryInput: '', receiptCode: '', application: null, questions: [] });
  },
  inputCode(event) { this.setData({ queryInput: event.detail.value, error: '' }); },
  async query() {
    if (this.data.querying || this.data.busy) return;
    const code = String(this.data.queryInput || this._queryCode || '').trim().toUpperCase();
    if (!code) { this.setData({ error: '请输入报名时保存的查询码' }); return; }
    this.setData({ querying: true, error: '' });
    try {
      const application = await recruitment.query(code);
      if (!this._alive) return;
      this._queryCode = code;
      this.setData({ queryInput: '' });
      this.showApplication(application);
    } catch (error) { if (this._alive) this.setData({ error: recruitment.errorText(error) }); }
    finally { if (this._alive) this.setData({ querying: false }); }
  },
  showApplication(application) {
    if (!this._alive) return;
    const batch = application.batch || {};
    this.setData({
      application,
      questions: recruitment.decorateQuestions(batch.questions, application.answers),
      statusText: STATUS[application.progress] || '已提交',
      statusClass: TAGS[application.progress] || 'tag-pending',
      interviewText: recruitment.timeText(application.interview && application.interview.at),
      closesText: recruitment.timeText(batch.closedAt || batch.closesAt),
      createdText: recruitment.timeText(application.createdAt),
    });
  },
  copyCode() {
    if (this.data.receiptCode) wx.setClipboardData({ data: this.data.receiptCode });
  },
  another() {
    if (this.data.busy || this.data.querying) return;
    this._queryCode = '';
    this.setData({ application: null, receiptCode: '', questions: [], queryInput: '', error: '' });
  },
  edit() {
    const application = this.data.application;
    if (!application || !application.canEdit || !this._queryCode || this.data.busy || this.data.querying) return;
    recruitment.navigate('/pages/recruitment-form/index', {
      queryCode: this._queryCode, application, mode: application.progress === 'withdrawn' ? 'resubmit' : 'edit',
    }, {
      events: { recruitmentUpdated: (updated) => { if (this._alive) { this.showApplication(updated); this.setData({ error: '' }); } } },
    });
  },
  async withdraw() {
    const application = this.data.application;
    if (!application || !application.canEdit || application.progress === 'withdrawn' || this.data.busy || !this._queryCode) return;
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '撤回报名',
      content: '撤回后不参与招新审核。报名截止前可凭原查询码重新提交，是否撤回？',
      confirmText: '撤回报名',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (!confirmed || !this._alive || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const updated = await recruitment.withdraw(this._queryCode, application.version);
      if (!this._alive) return;
      this.showApplication(updated);
      wx.showToast({ title: '报名已撤回', icon: 'none' });
    } catch (error) {
      if (!this._alive) return;
      if ([40910, 40912, 40304].indexOf(Number(error && error.code)) >= 0) {
        try { this.showApplication(await recruitment.query(this._queryCode)); } catch (ignored) {}
      }
      if (this._alive) this.setData({ error: recruitment.errorText(error) });
    } finally { if (this._alive) this.setData({ busy: false }); }
  },
  goBack: recruitment.goBack,
});
