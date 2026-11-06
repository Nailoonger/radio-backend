// pages-partner/club-keys/edit.js
// 伙伴端 · 编辑社团密钥
//
// ═══════════ 这一页的全部难点：明文只活一次 ═══════════
// 后端库里只有 sha256 和掩码，「明文」只在 `POST /partner/club-keys/:id/reset`
// 的响应里出现一次。所以本页有两个形态：
//   ① 平时（list → 这一页）      —— 只有 ····M7，看不到也取不到完整密钥
//   ② 刚点过「重置密钥」之后       —— 六格摊开显示新密钥 + 现成的分享文案
// 一旦离开页面 / 点「隐藏」/ 再重置，上一次的明文就**没了**（这是产品语义，
// 「弄丢找社干重新生成」——不是 bug，别为了"方便"把它存进 storage）。
//
// ⚠️ 所以这里**不缓存明文**、不写 wx.setStorage、不打 console。
//
// ⚠️ 头像是社团自己在「社团台」换的（学生侧 PUT /user/club-key/avatar），
//    伙伴端不提供换图入口 —— 这条线上只负责「钥匙」，两件事分开更不容易搞错。

const { adminRequest } = require('../../utils/request.js');

Page({
  data: {
    statusBarHeight: 20,
    id: null,
    record: null,
    initial: '社',
    subLine: '',
    cells: [],
    plain: '',
    shareText: '',
    stCls: 'rej',
    stText: '已作废',
    ownerName: '',
    teacherName: '',
    busy: false,
    loading: true,
    denied: false,
    denyText: '',
    resetText: '',
  },

  onLoad(q) {
    this.setData({
      statusBarHeight: getApp().globalData.statusBarHeight || 20,
      id: q && q.id ? Number(q.id) : null,
    });
    if (!this.data.id) { wx.showToast({ title: '参数不对', icon: 'none' }); return; }
    this.reload();
  },

  reload() {
    this.setData({ loading: !this.data.record });
    return adminRequest(`/partner/club-keys/${this.data.id}`, 'GET', {})
      .then((d) => {
        const r = d.record || {};
        this.setData({
          record: r,
          initial: (r.name || '社').charAt(0),
          subLine: `密钥 ${r.mask || '——'}${r.ownerName ? ' · 负责人 ' + r.ownerName : ''}`,
          ownerName: r.ownerName || '',
          teacherName: r.teacherName || '',
          stCls: r.status === 1 ? 'done' : 'rej',
          stText: r.status === 1 ? '有效' : '已作废',
          resetText: r.resetAt
            ? `${shortStamp(r.resetAt)}${r.resetBy ? ' · ' + r.resetBy : ''}`
            : '还没重置过',
        });
      })
      .catch((err) => {
        if (err && err.code === 40301) {
          this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '打不开这个社团', icon: 'none' });
      })
      .then(() => this.setData({ loading: false }));
  },

  /** 重置：唯一能看到明文的入口 */
  reset() {
    if (this.data.busy) return;
    wx.showModal({
      title: '重置密钥',
      content: '旧密钥当场作废，拿着旧钥匙的人立刻进不来。已经提报过的通知不受影响。',
      confirmText: '重置',
      confirmColor: '#B42318',
      success: ({ confirm }) => {
        if (!confirm) return;
        this.setData({ busy: true });
        adminRequest(`/partner/club-keys/${this.data.id}/reset`, 'POST', {})
          .then((d) => {
            const plain = d.plain || '';
            this.setData({
              plain,
              cells: plain.split(''),
              shareText: d.shareText || '',
              record: d.record || this.data.record,
              stCls: 'done',
              stText: '有效',
              resetText: `${shortStamp((d.record || {}).resetAt)}${(d.record || {}).resetBy ? ' · ' + d.record.resetBy : ''}`,
            });
            wx.showToast({ title: '新密钥已生成' });
          })
          .catch((err) => this.fail(err))
          .then(() => this.setData({ busy: false }));
      },
    });
  },

  /** 复制明文 */
  copyPlain() {
    if (!this.data.plain) {
      wx.showToast({ title: '密钥只在重置时显示，先点重置', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.plain,
      success: () => wx.showToast({ title: '密钥已复制' }),
    });
  },

  /** 复制整段（发给社长的那段话） */
  copyShare() {
    if (!this.data.shareText) return;
    wx.setClipboardData({
      data: this.data.shareText,
      success: () => wx.showToast({ title: '已复制，直接发群' }),
    });
  },

  /** 隐藏 = 把明文从内存里丢掉，之后要看得再重置一次 */
  hide() {
    this.setData({ plain: '', cells: [], shareText: '' });
    wx.showToast({ title: '已隐藏，要再看只能再重置', icon: 'none' });
  },

  onOwner(e) { this.setData({ ownerName: e.detail.value || '' }); },
  onTeacher(e) { this.setData({ teacherName: e.detail.value || '' }); },

  save() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    adminRequest(`/partner/club-keys/${this.data.id}`, 'PUT', {
      ownerName: this.data.ownerName,
      teacherName: this.data.teacherName,
    })
      .then((d) => {
        this.setData({ record: d.record || this.data.record });
        wx.showToast({ title: '已保存' });
      })
      .catch((err) => this.fail(err))
      .then(() => this.setData({ busy: false }));
  },

  /** 作废 / 启用 */
  toggle() {
    if (this.data.busy) return;
    const on = this.data.record && this.data.record.status === 1;
    wx.showModal({
      title: on ? '作废密钥' : '重新启用',
      content: on
        ? '作废后这把钥匙立刻失效，谁都进不来。要恢复只能重新重置一把。'
        : '启用后需要重新重置一把新密钥才能进（作废时钥匙已被销毁）。',
      confirmText: on ? '作废' : '启用',
      confirmColor: on ? '#B42318' : '#0066CC',
      success: ({ confirm }) => {
        if (!confirm) return;
        this.setData({ busy: true });
        adminRequest(`/partner/club-keys/${this.data.id}/status`, 'PUT', { status: on ? 0 : 1 })
          .then((d) => {
            const r = d.record || {};
            this.setData({
              record: r,
              stCls: r.status === 1 ? 'done' : 'rej',
              stText: r.status === 1 ? '有效' : '已作废',
              plain: '',
              cells: [],
              shareText: '',
            });
            wx.showToast({ title: on ? '已作废' : '已启用' });
          })
          .catch((err) => this.fail(err))
          .then(() => this.setData({ busy: false }));
      },
    });
  },

  fail(err) {
    if (err && err.code === 40301) {
      this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
      return;
    }
    wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/club-keys/keys' });
  },
});

function shortStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const b = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
}
