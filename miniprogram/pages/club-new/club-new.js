// pages/club-new/club-new.js
// 提报一条通知 / 修改待审核的那条
//
// ⚠️ 原型里这一屏只有三栏（通知内容 / 希望播出 / 附言），**没有标题栏** ——
//    标题由后端从正文派生，伙伴端审核时可以改。这里不要自作主张加一个「标题」输入框：
//    加了就变成「学生要写两遍同一件事」。
//
// ⚠️ 编辑和新建是同一个页面（带 ?id= 就是编辑）：
//    两屏的字段完全一样，拆开只会让「改完的正文长度校验」这类规则写两遍、早晚不一致。

const { request } = require('../../utils/request.js');
const clubTicket = require('../../utils/clubTicket.js');

const MAX_BODY = 300;

Page({
  data: {
    statusBarHeight: 20,
    id: null,
    editing: false,
    body: '',
    hopeText: '',
    note: '',
    club: null,
    submitName: '',
    maxBody: MAX_BODY,
    charCount: 0,
    submitting: false,
    loading: false,
  },

  onLoad(q) {
    const id = q && q.id ? Number(q.id) : null;
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      id,
      editing: !!id,
    });

    const ticket = clubTicket.getTicket();
    if (!ticket) {
      wx.redirectTo({ url: '/pages/club-code/club-code?back=' + encodeURIComponent('/pages/club-desk/club-desk') });
      return;
    }

    const cached = clubTicket.getClub();
    if (cached) {
      this.setData({ club: cached, submitName: cached.ownerName || '社团负责人' });
    } else {
      // 缓存丢了（清过缓存 / 换设备）就现拉一次，落款要用
      request('/user/club-key/me', 'GET', { ticket })
        .then((d) => {
          if (!d.club) throw { code: 40101 };
          clubTicket.saveClub(d.club);
          this.setData({ club: d.club, submitName: d.club.ownerName || '社团负责人' });
        })
        .catch(() => {
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
        });
    }

    if (id) this.loadOne(id);
  },

  loadOne(id) {
    const ticket = clubTicket.getTicket();
    this.setData({ loading: true });
    request(`/user/club-notice/${id}`, 'GET', { ticket })
      .then((d) => {
        const r = d.record || {};
        this.setData({
          body: r.body || '',
          hopeText: r.hopeText || '',
          note: r.note || '',
          charCount: (r.body || '').length,
          submitName: r.submitByName || this.data.submitName,
        });
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '打不开这条', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  onBody(e) {
    const v = e.detail.value || '';
    this.setData({ body: v, charCount: v.length });
  },

  onHope(e) {
    this.setData({ hopeText: e.detail.value || '' });
  },

  onNote(e) {
    this.setData({ note: e.detail.value || '' });
  },

  /** 快速填「希望播出」——站里最常收的就是午间和傍晚两档 */
  pickHope(e) {
    this.setData({ hopeText: e.currentTarget.dataset.v });
  },

  submit() {
    if (this.data.submitting) return;
    const body = (this.data.body || '').trim();
    if (body.length < 8) {
      wx.showToast({ title: '内容太短了，多写两句', icon: 'none' });
      return;
    }
    if (body.length > MAX_BODY) {
      wx.showToast({ title: `最多 ${MAX_BODY} 字`, icon: 'none' });
      return;
    }

    const ticket = clubTicket.getTicket();
    if (!ticket) {
      wx.redirectTo({ url: '/pages/club-code/club-code' });
      return;
    }

    this.setData({ submitting: true });
    const payload = { ticket, body, hopeText: this.data.hopeText, note: this.data.note };
    const req = this.data.editing
      ? request(`/user/club-notice/${this.data.id}`, 'PUT', payload)
      : request('/user/club-notice', 'POST', payload);

    req
      .then(() => {
        wx.showToast({ title: this.data.editing ? '已保存' : '已提交' });
        setTimeout(() => this.back(), 500);
      })
      .catch((err) => {
        this.setData({ submitting: false });
        if (err && err.code === 40101) {
          clubTicket.clear();
          wx.redirectTo({ url: '/pages/club-code/club-code' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
      });
  },

  /** 回社团台：编辑是 navigateBack；新建也走 back（栈里上一屏就是社团台） */
  back() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages/club-desk/club-desk' });
  },

  goBack() {
    this.back();
  },
});
