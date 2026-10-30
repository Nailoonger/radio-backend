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
// admin.role：0 超管 / 1 社干 / 2 站员（2026-10-29 新增站员）
const ROLES = {
  super:   { tag: '超管', post: '超级管理员' },
  manager: { tag: '社干', post: '社干' },
  member:  { tag: '站员', post: '站员' }
};

// 管理员那套 5 项（站员那套先留着，等站员身份接入再用）。
// icon = v151 原型 navRow 的图标名（ic-star / ic-cal / ic-clock / ic-chk / ic-ppl，已提取成 PNG）
const ROWS = {
  member: [
    { id: 'people',   icon: 'cal',   label: '可排时间', state: '' },
    { id: 'my-att',   icon: 'chk',   label: '考勤',     state: '' },
    { id: 'leave',    icon: 'clock', label: '请假进度', state: '' },
    { id: 'feedback', icon: 'star',  label: '互评',     state: '' },
    { id: 'notices',  icon: 'mega',  label: '站内公告', state: '' },
    // 2026-10-31 账号密码统一：站员的密码就是他的学生密码，改这里学生端立刻同步
    { id: 'pwd',      icon: 'pen',   label: '修改密码', state: '' }
  ],
  admin: [
    { id: 'feedback', icon: 'star',  label: '互评',     state: '' },
    { id: 'people',   icon: 'cal',   label: '可排时间', state: '' },
    { id: 'leave',    icon: 'clock', label: '请假进度', state: '' },
    { id: 'my-att',   icon: 'chk',   label: '我的考勤', state: '' },
    { id: 'roster',   icon: 'ppl',   label: '伙伴名册', state: '' },
    { id: 'pwd',      icon: 'pen',   label: '修改密码', state: '' }
  ]
};

/** 建号到今天的天数（v151 joinedDays 口径：含当天，floor(diff)+1，最少 1） */
function daysSince(v) {
  if (!v) return 1;
  var d;
  if (typeof v === 'number') d = new Date(v);
  else d = new Date(String(v).replace(' ', 'T').replace(/-/g, '/'));
  if (isNaN(d.getTime())) return 1;
  return Math.max(1, Math.floor((Date.now() - d.getTime()) / 86400000) + 1);
}

Page({
  data: {
    statusBarHeight: 20,
    roleKey: 'manager',
    role: {},
    days: 0,
    rows: [],
    badges: {},
    // 修改密码弹窗（2026-10-31）
    pwdOpen: false,
    pwdOld: '',
    pwdNew: '',
    pwdNew2: '',
    pwdErr: '',
    pwdSaving: false
  },

  onLoad() {
    this.setData({
      statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20
    });
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
    this.refreshBadges();
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
  /** 底栏角标：审核 tab = 投稿待审 + 留言待审（与工作台同一口径） */
  refreshBadges() {
    var that = this;
    var one = function (url, q) {
      return adminRequest(url, 'GET', Object.assign({ page: 1, pageSize: 1 }, q))
        .then(function (d) { return Number((d && d.total) || 0); })
        .catch(function () { return 0; });
    };
    return Promise.all([
      one('/admin/submit/list', { reviewStatus: 0 }),
      one('/admin/message/list', { status: 0 })
    ]).then(function (r) {
      that.setData({
        badges: {
          desk: 0, home: 0, submissions: r[0] + r[1],
          'my-drafts': 0, scheduling: 0, schedule: 0, me: 0
        }
      });
    });
  },

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
    var r = Number(info.role);
    var roleKey = r === 0 ? 'super' : (r === 2 ? 'member' : 'manager');
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
      rows: roleKey === 'member' ? ROWS.member : ROWS.admin
    });
  },

  onNav(e) {
    var id = e.currentTarget.dataset.id;
    // 修改密码：不跳页，就地开弹窗
    if (id === 'pwd') {
      this.setData({ pwdOpen: true, pwdOld: '', pwdNew: '', pwdNew2: '', pwdErr: '' });
      return;
    }
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

  /* ─────────── 修改密码（2026-10-31 账号密码统一）───────────
   *
   * 改的是 **user 表的密码**，也就是他在学生端用的那个密码 ——
   * 一个学号一份密码，两个入口。所以这里的提示语必须讲清楚，
   * 否则站员会以为"伙伴端密码"和"学生端密码"是两个东西。
   *
   * ⚠️ 改密会让**所有端**的旧 token 立刻失效（后端的 pv 校验，不走 30 秒缓存）。
   *    所以接口会回一个新 token，必须当场替换掉 admin_token，
   *    否则这一页下一个请求就 40101，用户以为"改完密码就被踢了"。
   */
  onPwdInput(e) {
    var field = e.currentTarget.dataset.field;
    var patch = { pwdErr: '' };
    patch[field] = e.detail.value;
    this.setData(patch);
  },

  closePwd() {
    if (this.data.pwdSaving) return;
    this.setData({ pwdOpen: false, pwdOld: '', pwdNew: '', pwdNew2: '', pwdErr: '' });
  },

  submitPwd() {
    var that = this;
    if (this.data.pwdSaving) return;
    var oldP = String(this.data.pwdOld || '');
    var newP = String(this.data.pwdNew || '');
    var newP2 = String(this.data.pwdNew2 || '');

    if (!oldP) return wx.showToast({ title: '请输入当前密码', icon: 'none' });
    if (newP.length < 6) return wx.showToast({ title: '新密码至少 6 位', icon: 'none' });
    if (newP !== newP2) return wx.showToast({ title: '两次输入的新密码不一致', icon: 'none' });
    if (newP === oldP) return wx.showToast({ title: '新密码不能和当前密码一样', icon: 'none' });

    this.setData({ pwdSaving: true, pwdErr: '' });
    adminRequest('PUT', '/admin/change-password', { oldPassword: oldP, newPassword: newP })
      .then(function (res) {
        // 后端回的新 token：不换的话下一次请求直接 40101
        if (res && res.token) {
          wx.setStorageSync('admin_token', res.token);
          if (app && app.globalData) app.globalData.adminToken = res.token;
        }
        that.setData({ pwdOpen: false, pwdSaving: false, pwdOld: '', pwdNew: '', pwdNew2: '' });
        wx.showToast({ title: '密码已修改', icon: 'success' });
      })
      .catch(function (err) {
        var msg = (err && err.message) || '修改失败，请稍后再试';
        that.setData({ pwdSaving: false, pwdErr: msg });
      });
  },

  onTab(e) {
    var id = e.detail && e.detail.id;
    if (!id || id === 'me') return;
    var routes = {
      desk: '/pages-partner/desk/desk',
      home: '/pages-partner/desk/desk',
      submissions: '/pages-partner/review/review',
      schedule: '/pages-partner/schedule/index/index',
      scheduling: '/pages-partner/schedule/index/index',
      'my-drafts': '/pages-partner/work/work'
    };
    var url = routes[id];
    if (url) {
      // ⚠️ tab 之间一律 reLaunch：审核也是 tab 页，navigateTo 会带返回箭头、当成二级页
      wx.reLaunch({ url: url });
      return;
    }
    wx.showToast({ title: '这一页还没落地', icon: 'none' });
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
