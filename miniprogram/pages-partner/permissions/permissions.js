// pages-partner/permissions/permissions.js · v1（2026-10-31 权限管理，超管）
//
// 两件事，分开做：
//   ① 全局总闸    —— 社干能不能进排班工作台 / 审核模块
//   ② 按人分发    —— 某个社干单独开或单独关（三态：跟随全局 / 单独开 / 单独关）
//
// ⚠️ 生效值 = 按人那份设了就用它，没设就取全局。所以「全局关掉 + 单独开小王」
//    就是「只给小王开」—— 这才是陛下说的「分发」。
// ⚠️ 这里改完必须 `perm.load(true)` 强制刷新模块级缓存，否则超管自己跑去工作台
//    还会看到旧权限（缓存是 per-VM 的，不按页面清）。
// ⚠️ 每次写都**整页重拉**：一次 PUT 只回一个人/全局，前端自己拼容易和库里的不一致；
//    这张表就十来行，重拉一次比维护增量合并便宜得多。

const { adminRequest } = require('../../utils/request.js');
const perm = require('../../utils/perm.js');

Page({
  data: {
    statusBarHeight: 20,
    ready: false,
    loading: true,
    loadError: '',
    saving: false,
    /** 全局总闸（缺行 = 全开，服务端已经归一好） */
    global: { schedule: true, review: true },
    /** 权限位文案：{ key, name, desc, deny }，服务端给，页面不硬编码 */
    meta: [],
    /** 拒绝文案（页尾说明用，按 key 取好，别在 wxml 里写 meta[0] 这种下标 —— 顺序一变就错） */
    denySchedule: '暂无权限',
    denyReview: '暂无审核权限',
    denyProxy: '暂无代录权限',
    /** 社干名单 */
    people: [],
    count: { managers: 0, scheduleOn: 0, reviewOn: 0, overridden: 0 },
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    // 这一页只给超管；社干误入就退回去（后端 asSuperPartner 也会拦，这里是别让人白等）
    if (Number(info.role) !== 0) {
      wx.showToast({ title: '仅超管可操作', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages-partner/desk/desk' }), 600);
      return;
    }
    this.setData({
      ready: true,
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  onUnload() { this._gone = true; },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true, loadError: '' });
    return adminRequest('/partner/permissions', 'GET', {})
      .then((d) => {
        if (this._gone) return;
        const meta = (d && d.meta) || [];
        const denyOf = (k, fb) => {
          const hit = meta.find((m) => m && m.key === k);
          return (hit && hit.deny) || fb;
        };
        this.setData({
          loading: false,
          global: (d && d.global) || { schedule: true, review: true },
          meta,
          denySchedule: denyOf('schedule', '暂无权限'),
          denyReview: denyOf('review', '暂无审核权限'),
          denyProxy: denyOf('proxy', '暂无代录权限'),
          people: ((d && d.people) || []).map((x) => ({
            personId: x.personId,
            name: x.name,
            username: x.username,
            department: x.department || '',
            // over 原样透传（每位是 true / false / null），模板直接用它判「跟回全局」要不要露
            over: x.over || { schedule: null, review: null, proxy: null },
            eff: x.eff || { schedule: false, review: false, proxy: false },
            overridden: !!x.overridden,
          })),
          count: (d && d.count) || { managers: 0, scheduleOn: 0, reviewOn: 0, overridden: 0 },
        });
      })
      .catch((err) => {
        if (this._gone) return;
        this.setData({ loading: false, loadError: (err && err.message) || '加载失败' });
      });
  },

  /** 全局总闸：一个开关就是一发 PUT，立刻落库（不做「先改后存」，权限不该有草稿态） */
  onGlobal(e) {
    const key = e.currentTarget.dataset.key;
    const val = !!e.detail.value;
    if (!key || this.data.saving) return;
    // 先动界面：开关组件已经把位置换了，这里回滚会让手指觉得卡
    const global = { ...this.data.global, [key]: val };
    this.setData({ saving: true, global });
    adminRequest('/partner/permissions', 'PUT', { [key]: val })
      .then(() => {
        if (this._gone) return;
        perm.load(true);          // 本机缓存作废
        return this.load();
      })
      .then(() => { if (!this._gone) this.setData({ saving: false }); })
      .catch((err) => {
        if (this._gone) return;
        // 失败必须把开关拨回去，否则界面在骗人
        this.setData({ saving: false, global: { ...this.data.global, [key]: !val } });
        wx.showToast({ title: (err && err.message) || '没保存成功', icon: 'none' });
      });
  },

  /**
   * 按人拨一位
   * - 没覆盖过 ⇒ 显式设成「和当前生效值相反」
   * - 已经覆盖过 ⇒ 也还是设成相反值（用户看到的就是「我现在能不能进」）
   * 想恢复全局要单独点「跟随全局」，不靠连点两下 —— 连点能不能回到原点是玄学。
   */
  onPerson(e) {
    const { id, key } = e.currentTarget.dataset;
    const personId = Number(id);
    if (!personId || !key || this.data.saving) return;
    const row = this.data.people.find((x) => x.personId === personId);
    if (!row) return;
    const next = !row.eff[key];
    this.savePerson(personId, { [key]: next });
  },

  /** 撤销这一位上「单独设置」的状态，跟回全局 */
  onFollow(e) {
    const { id, key } = e.currentTarget.dataset;
    const personId = Number(id);
    if (!personId || !key || this.data.saving) return;
    this.savePerson(personId, { [key]: null });
  },

  savePerson(personId, patch) {
    this.setData({ saving: true });
    adminRequest(`/partner/permissions/person/${personId}`, 'PUT', patch)
      .then(() => {
        if (this._gone) return;
        perm.load(true);
        return this.load();
      })
      .then(() => { if (!this._gone) this.setData({ saving: false }); })
      .catch((err) => {
        if (this._gone) return;
        this.setData({ saving: false });
        wx.showToast({ title: (err && err.message) || '没保存成功', icon: 'none' });
      });
  },
});
