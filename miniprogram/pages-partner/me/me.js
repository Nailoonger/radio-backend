// 伙伴端 · 我的（v151 定稿）
// ⚠️ 登录入口＝小程序的管理员登录（pages-partner/login，admin 表账号）：
//    伙伴端只读 admin_token（storage 名，下划线）与 adminInfo，不走学生端 token 与 /user/profile。
//
// ⚠️⚠️ 身份**不能只信缓存**（2026-10-27 补）：
//    伙伴端和电脑端共用同一张 admin 表。老师可能刚在电脑端把某人从「社干」降成普通账号、
//    或改了昵称，而小程序 storage 里的 adminInfo 还是上次登录时写下的旧值 ——
//    这一页的菜单是按 `info.role` 分档的，用旧值就会**继续显示社干入口**，
//    点进去后端报 40301，用户看到的是「按钮在但点不动」，比直接不显示更困惑。
//    所以：缓存只用来**首屏不白屏**，随后一律以 `/partner/me` 为准纠正。
const { adminRequest } = require('../../utils/request.js');

const app = getApp();

// admin.role：0 = 超管，1 = 社员（社干）。伙伴端按这两档取身份。
const ROLES = {
  super:   { tag: '超管', post: '超级管理员' },
  manager: { tag: '社干', post: '社干' }
};

// 管理员那套 5 项（站员那套先留着，等站员身份接入再用）
const ROWS = {
  member: [
    { id: 'people',   label: '可排时间', state: '' },
    { id: 'my-att',   label: '考勤',     state: '' },
    { id: 'leave',    label: '请假进度', state: '' },
    { id: 'feedback', label: '互评',     state: '' },
    { id: 'notices',  label: '站内公告', state: '' }
  ],
  admin: [
    { id: 'feedback', label: '互评',     state: '' },
    { id: 'people',   label: '可排时间', state: '' },
    { id: 'leave',    label: '请假进度', state: '' },
    { id: 'my-att',   label: '我的考勤', state: '' },
    { id: 'roster',   label: '伙伴名册', state: '' }
  ]
};

/** 建号到今天的天数（按自然日） */
function daysSince(v) {
  if (!v) return 0;
  var d;
  if (typeof v === 'number') d = v;
  else d = new Date(String(v).replace(/-/g, '/')).getTime();
  if (isNaN(d)) return 0;
  return Math.max(0, Math.floor((Date.now() - d) / 86400000));
}

Page({
  data: {
    roleKey: 'manager',
    role: {},
    days: 0,
    rows: []
  },

  onLoad() {
    var token = wx.getStorageSync('admin_token');
    var info = wx.getStorageSync('adminInfo') || (app && app.globalData && app.globalData.adminInfo);
    if (!token) {
      // 没登录：去管理员登录入口（伙伴端与它是同一个入口）
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.applyAdmin(info || {});
    // 先用缓存把首屏画出来（不白屏），再用服务端数据纠正角色与昵称
    this.fetchMe();
  },

  onShow() {
    // 每次回到这一页都重新确认身份：电脑端刚改过角色时，回来就能看到正确的菜单
    if (this.data.role && this.data.role.account) this.fetchMe();
  },

  /**
   * 以 `/partner/me` 为准纠正身份
   *
   * ⚠️ 为什么不让后端返回 adminInfo 全量：这一页只需要 role / 昵称 / 账号 / 建号时间。
   *    多传的字段（dutyRoles、abilities）在这里没用，反而会让「谁在读什么」变模糊。
   */
  fetchMe() {
    var that = this;
    return adminRequest('/partner/me', 'GET', {})
      .then(function (me) {
        if (!me) return;
        // 用服务端值覆盖缓存，下次冷启动首屏也是对的
        try {
          var cached = wx.getStorageSync('adminInfo') || {};
          var merged = Object.assign({}, cached, {
            id: me.id,
            username: me.username,
            nickname: me.nickname,
            role: me.role,
            createTime: me.createTime
          });
          wx.setStorageSync('adminInfo', merged);
          if (app && app.globalData) app.globalData.adminInfo = merged;
        } catch (e) { /* 存储失败不影响展示 */ }

        that.applyAdmin({
          id: me.id,
          username: me.username,
          nickname: me.nickname,
          role: me.role,
          createTime: me.createTime
        });
      })
      .catch(function (err) {
        if (err && err.code === 40101) {
          wx.reLaunch({ url: '/pages-partner/login/login' });
        }
        // 其它错误保持缓存渲染：断网时这一页仍可读，只是可能不是最新角色
      });
  },

  /** 用 admin 登录态填这一页 */
  applyAdmin(info) {
    var isSuper = Number(info.role) === 0;
    var roleKey = isSuper ? 'super' : 'manager';
    var base = ROLES[roleKey];

    this.setData({
      roleKey: roleKey,
      role: {
        tag: base.tag,
        name: info.nickname || info.username || '伙伴',
        post: base.post,
        grade: '',
        account: info.username || ''
      },
      days: daysSince(info.created_at || info.createdAt),
      rows: ROWS.admin
    });
  },

  onNav(e) {
    var id = e.currentTarget.dataset.id;
    // 已做：people → availability（P1 落地）
    // 未做：my-att / leave / feedback / roster 属于 P3~P5，这里保留路径，
    //       navigateTo 失败时由下面的 fail 兜底提示，不会白屏
    var map = {
      people:   '/pages-partner/availability/availability',
      'my-att': '/pages-partner/attendance/attendance',
      leave:    '/pages-partner/leave/leave',
      feedback: '/pages-partner/feedback/feedback',
      notices:  '/pages/notices/notices',
      roster:   '/pages-partner/roster/roster'
    };
    var url = map[id];
    if (!url) return;
    wx.navigateTo({
      url: url,
      fail: function () {
        wx.showToast({ title: '这一页还没做', icon: 'none' });
      }
    });
  },

  onLogout() {
    var that = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新用管理员账号登录。',
      confirmText: '退出',
      confirmColor: '#FF453A',
      success: function (res) {
        if (!res.confirm) return;
        try {
          wx.removeStorageSync('admin_token');
          wx.removeStorageSync('adminInfo');
          if (app && app.globalData) {
            app.globalData.adminToken = '';
            app.globalData.adminInfo = null;
          }
        } catch (err) { /* 忽略清理异常 */ }
        wx.reLaunch({ url: '/pages-partner/login/login' });
      }
    });
  }
});
