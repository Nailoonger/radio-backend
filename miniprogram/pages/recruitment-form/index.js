const recruitment = require('../../utils/recruitment.js');

Page({
  data: {
    statusBarHeight: 20, loading: true, error: '', submitting: false, mode: 'apply', batch: null,
    fields: { name: '', studentNo: '', grade: '', className: '' }, questions: [], locked: false, retrying: false,
    canSubmit: false, closesText: '', fieldError: '',
  },
  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
    this.answers = {};
    this._queryCode = '';
    this._version = null;
    const context = recruitment.takeContext();
    this.initialize(context);
  },
  onUnload() {
    this._queryCode = '';
    this.answers = {};
    this._pending = null;
    this._receipt = null;
    this._alive = false;
  },
  async initialize(context) {
    this._alive = true;
    this.setData({ loading: true, error: '' });
    try {
      const mode = context && context.mode || 'apply';
      if (mode === 'edit' || mode === 'resubmit') {
        if (!context.application || !context.queryCode) throw { message: '请先凭查询码查询报名' };
        const application = context.application;
        this._queryCode = context.queryCode;
        this._version = application.version;
        this.answers = { ...(application.answers || {}) };
        this.setData({ mode, canSubmit: application.canEdit === true, locked: application.canEdit !== true });
        this.showForm(application.batch, application);
      } else {
        const pending = recruitment.pendingSubmission();
        if (pending) {
          this._pending = pending;
          this.answers = { ...(pending.payload.answers || {}) };
          this.setData({ mode: 'apply', retrying: true, locked: true, canSubmit: true });
          this.showForm(pending.batch, pending.payload);
        } else {
          const batch = context && context.batch || (await recruitment.current()).batch;
          if (!batch) throw { message: '暂无开放的招新报名' };
          this.setData({ mode: 'apply', canSubmit: batch.windowState === 'open' });
          this.showForm(batch, this.data.fields);
        }
      }
    } catch (error) { if (this._alive) this.setData({ error: recruitment.errorText(error) }); }
    finally { if (this._alive) this.setData({ loading: false }); }
  },
  showForm(batch, fields) {
    if (!this._alive) return;
    this.setData({
      batch,
      fields: { name: fields.name || '', studentNo: fields.studentNo || '', grade: fields.grade || '', className: fields.className || '' },
      questions: recruitment.decorateQuestions(batch && batch.questions, this.answers),
      closesText: recruitment.timeText(batch && batch.closesAt),
    });
  },
  inputField(event) {
    if (this.data.locked || this.data.submitting) return;
    this.setData({ ['fields.' + event.currentTarget.dataset.field]: event.detail.value, fieldError: '' });
  },
  inputAnswer(event) {
    if (this.data.locked || this.data.submitting) return;
    const index = Number(event.currentTarget.dataset.index);
    const question = this.data.questions[index];
    this.answers[question.id] = event.detail.value;
    this.setData({ ['questions[' + index + '].value']: event.detail.value, fieldError: '' });
  },
  selectAnswer(event) {
    if (this.data.locked || this.data.submitting) return;
    const index = Number(event.currentTarget.dataset.index);
    const question = this.data.questions[index];
    this.answers[question.id] = event.detail.value;
    this.setData({ questions: recruitment.decorateQuestions(this.data.batch.questions, this.answers), fieldError: '' });
  },
  clearAnswer(event) {
    if (this.data.locked || this.data.submitting) return;
    const question = this.data.questions[Number(event.currentTarget.dataset.index)];
    delete this.answers[question.id];
    this.setData({ questions: recruitment.decorateQuestions(this.data.batch.questions, this.answers), fieldError: '' });
  },
  async submit() {
    if (this.data.submitting || !this.data.canSubmit) return;
    this.setData({ submitting: true, fieldError: '' });
    try {
      if (this.data.mode === 'apply') {
        let pending = this._pending;
        if (!pending) {
          const payload = { batchId: this.data.batch.id, ...recruitment.normalizeForm(this.data.fields, this.data.batch.questions, this.answers) };
          const key = await recruitment.submissionKey();
          pending = recruitment.savePending(key, payload, this.data.batch);
          this._pending = pending;
          if (this._alive) this.setData({ locked: true });
        }
        const result = await recruitment.apply({ ...pending.payload, submissionKey: pending.submissionKey });
        // 页面已退出时继续保留重试凭证，下次按原请求取回同一查询码。
        if (!this._alive) return;
        this._pending = null;
        this.setData({ canSubmit: false });
        recruitment.setContext({ queryCode: result.queryCode, application: result.application, receipt: true });
        wx.redirectTo({
          url: '/pages/recruitment-result/index',
          fail: () => {
            // 跳转失败时仍显示完整回执，不丢失唯一查询码。
            recruitment.clearContext();
            this._receipt = result;
            this.setData({ receiptCode: result.queryCode, locked: true, canSubmit: false });
            recruitment.clearPending();
          },
        });
      } else {
        const form = recruitment.normalizeForm(this.data.fields, this.data.batch.questions, this.answers);
        const body = { queryCode: this._queryCode, version: this._version, ...form };
        const application = await (this.data.mode === 'resubmit' ? recruitment.resubmit(body) : recruitment.update(body));
        if (!this._alive) return;
        const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
        if (channel && channel.emit) channel.emit('recruitmentUpdated', application);
        wx.showToast({ title: this.data.mode === 'resubmit' ? '已重新提交' : '修改已保存' });
        recruitment.goBack();
      }
    } catch (error) {
      // 明确校验/窗口/重复拒绝代表此次未创建，可修改；网络及未知失败保持原凭证原内容重试。
      if (this.data.mode === 'apply' && [40001, 40304, 40911].indexOf(Number(error && error.code)) >= 0) {
        recruitment.clearPending();
        this._pending = null;
        if (this._alive) this.setData({ locked: false, retrying: false, canSubmit: Number(error.code) !== 40304 });
      } else if (this._pending && this._alive) this.setData({ retrying: true, locked: true });
      if (this._alive) this.setData({ fieldError: recruitment.errorText(error) });
    } finally { if (this._alive) this.setData({ submitting: false }); }
  },
  copyCode() {
    if (this.data.receiptCode) wx.setClipboardData({ data: this.data.receiptCode });
  },
  goBack: recruitment.goBack,
});
