// pages-partner/notices/edit/edit.js · v1（2026-11-01）
//
// 新建 / 编辑公告（社干 · 超管）。数据与管理端 web **同一张 notice 表、同一套接口**：
//   新建 POST /admin/notice/create   修改 PUT /admin/notice/:id
// 所以「发布」这件事只等于 `isShow = 1`，不存在两套数据要对齐。
//
// ⚠️ 没有单条详情接口，这里用列表接口（pageSize=200）取那一条 —— 公告是几十条的量级，
//    比为此加一条 `GET /admin/notice/:id` 划算（少一个要维护的接口和一处路由计数）。
//    ⚠️ 如果哪天公告过百，改成后端加 detail 接口，别把 pageSize 往上抬。
//
// ⚠️ 置顶 = `isTop: 1`，由服务端 `orderBy isTop desc` 生效；列表页不用自己排。
const { adminRequest } = require('../../../utils/request.js');

const MAX_TITLE = 60;
const MAX_CONTENT = 5000;

Page({
  data: {
    statusBarHeight: 20,
    id: 0,
    isNew: true,
    loading: false,
    saving: false,
    title: '',
    content: '',
    isTop: false,
    isShow: true,     // 新建默认「发布」——陛下要的是"新建然后发布"，不要二次开关
    saveText: '发布',
  },

  onLoad(options) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const role = Number(info.role);
    // 0 超管 / 1 社干 能写；站员即使从别处拿到链接进来，也只提示不给存
    const canEdit = role === 0 || role === 1;
    this.setData({ statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    if (!canEdit) {
      wx.showModal({
        title: '暂无权限',
        content: '公告由社干和超管发布。',
        showCancel: false,
        success: () => this.goBack(),
      });
      return;
    }

    const id = Number((options && options.id) || 0);
    if (!id) {
      this.setData({ isNew: true, saveText: '发布' });
      return;
    }
    this.setData({ id, isNew: false, loading: true, saveText: '保存修改' });
    this.loadOne(id);
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/notices/notices' });
  },

  loadOne(id) {
    return adminRequest('/admin/notice/list', 'GET', { page: 1, pageSize: 200 })
      .then((d) => {
        const row = ((d && d.list) || []).find((x) => Number(x.id) === id);
        if (!row) {
          this.setData({ loading: false });
          wx.showToast({ title: '这条公告不在了', icon: 'none' });
          setTimeout(() => this.goBack(), 600);
          return;
        }
        this.setData({
          loading: false,
          title: row.title || '',
          content: row.content || '',
          isTop: Number(row.isTop) === 1,
          isShow: Number(row.isShow) !== 0,
        });
        this.syncSaveText();
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /**
   * 按钮文案跟着「发布」开关走：
   * 关掉发布再点保存 = 存草稿，按钮上就得这么写，否则用户不知道自己按下去会发生什么。
   */
  syncSaveText() {
    const { isNew, isShow } = this.data;
    const text = isNew
      ? (isShow ? '发布' : '存为草稿')
      : (isShow ? '保存修改' : '保存（不展示）');
    this.setData({ saveText: text });
  },

  /* 标题 / 正文走模板里的 `model:value` 双向绑定，这里不再写 onTitle / onContent —— 
     手写 value + bindinput + setData 会和输入法 composition 抢（中文打成拼音就断）。 */
  onTop(e) { this.setData({ isTop: !!e.detail.value }); },
  /* ⚠️ 名字不能叫 onShow —— 那是页面生命周期，切回页面时框架会无参调用，
     这里读 e.detail.value 直接崩。叫 onShowSwitch。 */
  onShowSwitch(e) { this.setData({ isShow: !!e.detail.value }, () => this.syncSaveText()); },

  onSave() {
    if (this.data.saving) return;
    const title = String(this.data.title || '').trim();
    const content = String(this.data.content || '').trim();
    if (!title) return wx.showToast({ title: '写一下标题', icon: 'none' });
    if (!content) return wx.showToast({ title: '写一下正文', icon: 'none' });
    // ⚠️ 字数上限只在提交时校验（maxlength 给的是存储上限，不能当业务限制用：
    //    中文拼音输入时字母数远大于汉字数，卡太紧会让字"打不进去"）
    if (title.length > MAX_TITLE) return wx.showToast({ title: `标题最多 ${MAX_TITLE} 字`, icon: 'none' });
    if (content.length > MAX_CONTENT) return wx.showToast({ title: `正文最多 ${MAX_CONTENT} 字`, icon: 'none' });

    const body = {
      title,
      content,
      isTop: this.data.isTop ? 1 : 0,
      isShow: this.data.isShow ? 1 : 0,
    };
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    const req = this.data.isNew
      ? adminRequest('/admin/notice/create', 'POST', body)
      : adminRequest(`/admin/notice/${this.data.id}`, 'PUT', body);
    return req
      .then(() => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: this.data.isShow ? '已发布' : '已存草稿', icon: 'success' });
        setTimeout(() => this.goBack(), 500);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },
});
