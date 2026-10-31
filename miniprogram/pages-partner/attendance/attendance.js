// pages-partner/attendance/attendance.js · v2（2026-10-30 按 v151 v72 重做「考勤录入」）
//
// 社干：五个日期方块挑一天 → 看那天几场 → 每场每人三个按钮（到岗 / 请假 / 缺勤）→ 底部「保存这天的考勤」
// 站员：我的本周 / 本月场次与到岗情况（只读）
//
// 接口：GET /partner/attendance/week · /overview · /mine · PUT /partner/attendance
//
// ⚠️⚠️ 保存是**手动**的（v151 同款）：改动只落内存里的 this.data.days，点底部按钮才提交。
//    提交按场次逐场 PUT（一天通常 2–4 场），只发「有改动 且 至少点了一个人」的场次。
//    某几场失败时只保留那几场的 dirty 标记，用户再点一次保存即可补上，不会把已成功的重发一遍。
//
// ⚠️ 三态是「点哪个是哪个」，不再循环切换。点已选中的那一格 = 取消回「未点」——
//    v151 没写这条，但没了循环就必须给一个反悔路径，否则点错只能顺着点一圈。
//
// ⚠️ 「未点」（null）永远不提交：服务端的 records 只收 0/1/2，整场都没点就整场不发请求。
//    所以「保存」不会把没点到的人默认成到岗（上一版会，属于脏数据）。
//
// ⚠️ 点名只在**当周已发布班表里存在的人**上生效（服务端二次校验 assignment），前端点错也写不进去。
// ⚠️ 天的键是日期字符串，周几只在展示层补（与后端一致）。

const { adminRequest } = require('../../utils/request.js');
const { addDays, md, rangeText } = require('../../utils/dates.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];

/** 默认落在今天那一格（周末不在周一到周五里，就落周一） */
function todayIndex() {
  const dow = new Date().getDay();   // 0 = 周日
  return dow >= 1 && dow <= 5 ? dow - 1 : 0;
}

/**
 * 重算一天的总数 / 已点 / 未点。
 * 天方块角标、卡头「已点名 x / N」、每场「x / N」全读这里的字段，**只在这一处算**。
 */
function syncDayCounts(d) {
  let marked = 0;
  let total = 0;
  (d.slots || []).forEach((s) => {
    s.count = s.people.length;
    s.done = s.people.filter((p) => p.status !== null).length;
    marked += s.done;
    total += s.count;
  });
  d.marked = marked;
  d.total = total;
  d.left = total - marked;
  return d;
}

Page({
  data: {
    statusBarHeight: 20,
    isManager: true,
    offset: 0,
    weekStart: '',
    weekText: '',
    isThisWeek: true,
    loading: true,

    // 社干
    days: [],
    attDay: 0,          // 选中的第几天（0 = 周一）
    dayView: null,      // 选中那天的派生视图（统计 + 场次）
    dirty: {},          // 'day|slot' → true：哪些场次改过还没保存
    saving: false,
    overview: [],

    // 站员
    mine: [],
    mineWeek: 0,
    monthShifts: 0,
    minePresent: 0,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      // 站员（role=2）只能看自己的：请假页是「申请 + 我的」，考勤页是「我的考勤」
      isManager: Number(((app.globalData || {}).adminInfo || {}).role) === 0
        || Number(((app.globalData || {}).adminInfo || {}).role) === 1,
    });
    this.load();
  },

  onPullDownRefresh() { this.load(true).then(() => wx.stopPullDownRefresh()); },

  prevWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset - 1, attDay: 0 }, () => this.load()); },
  nextWeek() { if (!this._baseWeek) return; this.setData({ offset: this.data.offset + 1, attDay: 0 }, () => this.load()); },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  /**
   * 当前查看的周（offset=0 不传 week，让云函数按北京时间给「本周」）。
   *
   * ⚠️⚠️ 2026-10-31 改：原来前端用 `new Date().getDay()` 自己算周一（mondayOf），
   *    与后端「周日 0 点就算下一周」的新口径对不上 —— 周日打开这一页会看到一周前那一周，
   *    而标签还写着「本周」。现在 offset=0 一律不传 week，其它周以服务端回的 weekStart 为基准 ±7 天。
   */
  _baseWeek: '',

  load(keepDay) {
    const offset = Number(this.data.offset) || 0;
    const known = this._baseWeek || '';
    const week = offset === 0 ? '' : (known ? addDays(known, offset * 7) : '');
    this.setData({
      loading: true,
      isThisWeek: offset === 0,
      // 翻到旧周时先用本地推算的日期顶着，服务端回来后以它的 weekStart 为准
      weekStart: week || this.data.weekStart,
      weekText: week ? rangeText(week, 5) : this.data.weekText,
    });

    if (!this.data.isManager) {
      return adminRequest('/partner/attendance/mine', 'GET', week ? { week } : {})
        .then((r) => {
          const rows = (r && r.list) || [];
          const list = rows.map((x, i) => ({
            k: i,
            dayName: DAY_NAMES[i] || '',
            slot: x.slot,
            department: x.department,
            statusText: x.statusText,
            tagCls: x.status === 1 ? 'done' : (x.status === 0 ? 'no' : (x.status === 2 ? 'warn' : '')),
          }));
          this.setData({
            loading: false,
            mine: list,
            mineWeek: Number(r && r.weekShifts) || 0,
            monthShifts: Number(r && r.monthShifts) || 0,
            minePresent: list.filter((x) => x.statusText === '到岗').length,
          });
        })
        .catch((err) => {
          this.setData({ loading: false });
          wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
        });
    }

    return Promise.all([
      adminRequest('/partner/attendance/week', 'GET', week ? { week } : {}),
      adminRequest('/partner/attendance/overview', 'GET', week ? { week } : {}).catch(() => ({ people: [] })),
    ]).then(([w, o]) => {
      // 服务端回的才是权威周一（offset=0 时顺便记成翻周基准）
      const ws = (w && w.weekStart) || week;
      if (offset === 0 && ws) this._baseWeek = ws;
      const days = this.decorateDays(w);
      // 切周时落到周一；同一周刷新（保存后复核）保留当前选中的那天
      const fallback = offset === 0 ? todayIndex() : 0;
      const attDay = keepDay && days.length
        ? Math.min(this.data.attDay, days.length - 1)
        : Math.min(fallback, Math.max(0, days.length - 1));
      this.setData({
        loading: false,
        weekStart: ws,
        weekText: rangeText(ws, 5),
        days,
        attDay,
        dirty: {},                       // 服务端结果回来了，之前攒的改动已经落库/作废
        overview: ((o && o.people) || []).slice(0, 20),
      }, () => this.rebuild());
    }).catch((err) => {
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
    });
  },

  decorateDays(w) {
    return ((w && w.days) || []).map((d) => {
      const slots = (d.slots || []).map((sl) => ({
        slot: sl.slot,
        timeText: sl.timeText || '',
        people: (sl.people || []).map((x) => ({
          personId: x.personId,
          personName: x.personName,
          department: x.department,
          status: (x.status === undefined || x.status === null) ? null : Number(x.status),
        })),
        count: 0,
        done: 0,
      }));
      return syncDayCounts({
        day: d.day,
        dayName: d.dayName || '',
        dateText: md(d.day),
        slots,
        marked: 0,
        total: 0,
        left: 0,
      });
    });
  },

  /** 用当前选中的那天重算 dayView（统计条 + 场次列表都读它） */
  rebuild() {
    const d = this.data.days[this.data.attDay];
    if (!d) { this.setData({ dayView: null }); return; }
    const all = [];
    (d.slots || []).forEach((s) => s.people.forEach((p) => all.push(p)));
    this.setData({
      dayView: {
        title: `${d.dayName} ${d.dateText}`,
        total: all.length,
        marked: all.filter((p) => p.status !== null).length,
        present: all.filter((p) => p.status === 1).length,
        leave: all.filter((p) => p.status === 2).length,
        absent: all.filter((p) => p.status === 0).length,
        slots: d.slots,
      },
    });
  },

  onPickDay(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (i === this.data.attDay) return;
    this.setData({ attDay: i }, () => this.rebuild());
  },

  /** 点三态：点哪个是哪个；再点同一格 = 取消回「未点」 */
  onMark(e) {
    const ds = e.currentTarget.dataset;
    const pid = Number(ds.pid);
    const st = Number(ds.st);
    const days = this.data.days;
    const d = days[this.data.attDay];
    if (!d) return;
    const sl = (d.slots || []).find((x) => x.slot === ds.slot);
    if (!sl) return;
    const person = sl.people.find((x) => x.personId === pid);
    if (!person) return;

    person.status = person.status === st ? null : st;
    syncDayCounts(d);
    const dirty = Object.assign({}, this.data.dirty);
    dirty[`${d.day}|${sl.slot}`] = true;
    this.setData({ days, dirty }, () => this.rebuild());
  },

  /** 保存这一天：按场次逐场 PUT，只发改过且点了人的场次 */
  onSave() {
    if (this.data.saving) return;
    const d = this.data.days[this.data.attDay];
    if (!d) return;

    const dirty = this.data.dirty || {};
    const targets = (d.slots || []).filter((s) =>
      dirty[`${d.day}|${s.slot}`] && s.people.some((p) => p.status !== null));

    if (!targets.length) {
      wx.showToast({ title: '这天没有要保存的改动', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });

    const jobs = targets.map((s) => {
      const records = s.people
        .filter((p) => p.status !== null)
        .map((p) => ({ personId: p.personId, status: p.status }));
      return adminRequest('/partner/attendance', 'PUT', {
        weekStart: this.data.weekStart, day: d.day, slot: s.slot, records,
      })
        .then(() => ({ ok: true, slot: s.slot }))
        .catch((err) => ({ ok: false, slot: s.slot, msg: (err && err.message) || '保存失败' }));
    });

    Promise.all(jobs).then((rs) => {
      wx.hideLoading();
      this.setData({ saving: false });
      const bad = rs.filter((x) => !x.ok);
      if (bad.length) {
        // 成功的场次已经落库；失败的留住 dirty，让用户再点一次保存补上
        const keep = {};
        bad.forEach((b) => { keep[`${d.day}|${b.slot}`] = true; });
        this.setData({ dirty: keep });
        wx.showToast({ title: bad[0].msg, icon: 'none' });
        return;
      }
      wx.showToast({ title: '已保存', icon: 'success' });
      this.load(true);   // 用服务端结果复核（含已批请假自动记的「请假」）
    });
  },
});
