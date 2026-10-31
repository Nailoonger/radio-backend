// pages-partner/song-schedule/song-schedule.js · v1（2026-10-29 歌曲排期与候补）
//
// 只读排期表。数据源：GET /admin/submit/list?type=1&reviewStatus=1（已通过的点歌）
//   scheduleStatus：0 未排 / 1 已排 / 2 候补 / 3 自动驳回
//   scheduledSlot 有值 = 排到了哪一格；没值 = 还在候补或未排
//
// ⚠️ 只读：排期/调剂/名额都在电脑端（超管）做，手机端不放操作 —— 半套操作比没有更坑。
// ⚠️ playStatus：0 未播 / 1 已播（已排的再分这两态）。

const { adminRequest } = require('../../utils/request.js');

const SCHEDULE = { UNASSIGNED: 0, APPROVED: 1, WAITING: 2, AUTO_REJECTED: 3 };

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    seated: [],
    waiting: [],
    seatedCount: 0,
    waitingCount: 0,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    if (Number(info.role) === 2) {
      // 站员不看全站排期
      wx.showToast({ title: '站员看不到排期', icon: 'none' });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
      return;
    }
    this.setData({ statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  load() {
    this.setData({ loading: true });
    return adminRequest('/admin/submit/list', 'GET', {
      type: 1, reviewStatus: 1, page: 1, pageSize: 100,
    })
      .then((d) => {
        const rows = (d && d.list) || [];
        const seated = [];
        const waiting = [];
        rows.forEach((r) => {
          const sc = Number(r.scheduleStatus);
          const item = {
            id: r.id,
            songName: r.songName || '（未填歌名）',
            singer: r.singer || '',
            nickname: r.nickname || '',
            slotText: r.scheduledSlot || r.wantBroadcastTime || '未定时段',
            playText: Number(r.playStatus) === 1 ? '已播' : '待播',
          };
          if (sc === SCHEDULE.APPROVED) seated.push(item);
          else if (sc === SCHEDULE.WAITING) waiting.push(item);
          // UNASSIGNED / AUTO_REJECTED 不算「排上」，也不进候补（自动驳回是名额满被刷下的）
        });
        this.setData({
          loading: false,
          seated,
          waiting,
          seatedCount: seated.length,
          waitingCount: waiting.length,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },
});
