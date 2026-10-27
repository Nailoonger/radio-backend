// pages-partner/availability/availability.js
//
// 伙伴端 · 可排时间填报（P1）
//
// 这一页吃两件事：
//   ① 自己填：按天分组的方块，点一下在「能来 / 不能来 / 未选」之间切换
//   ② 代录（社干）：顶部选人，替某个成员填，必须写原因
//
// ⚠️ 周锚点不从手机算。首次加载**不传 week**，由云函数按北京时间返回本周周一，
//    之后翻页才 ±7 天。小程序端自己 `new Date().getDay()` 算周一，
//    在跨时区 / 跨月 / 系统时间被改过的手机上会和后端差一周，而班表错一周是无声的。
//
// ⚠️ 规则「有不能来的时段必须填说明」在前端只是提示，真正的拦截在云函数
//    （见 handlers/partner/availability.js）。绕过前端也写不进空说明。
const { adminRequest } = require('../../utils/request.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const MAX_REASON = 200;

/** '2026-11-02' ± n 天（纯日期运算，走 UTC 避免夏令时/时区干扰） */
function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return ymd;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000;
  const d = new Date(t);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** '2026-11-02' → '11-02' */
function shortDate(ymd) {
  return String(ymd || '').slice(5);
}

/**
 * 三态 → 展示文案与样式类
 *
 * ⚠️ 在 JS 里算好，不写成 WXML 里的嵌套三元（`{{a===1?'x':a===0?'y':'z'}}`）：
 *    嵌套三元在 WXML 里能跑，但一旦要加第四态（比如「待定」）就得改模板字符串，
 *    而这里改一行就够。模板只负责渲染，不负责判断。
 */
function stateOf(can) {
  if (can === 1) return { stateText: '能来', cls: 'on' };
  if (can === 0) return { stateText: '不能', cls: 'off' };
  return { stateText: '待选', cls: '' };
}

/** 把云函数返回的扁平 slots 按天分组，并把已选状态贴回每个格子上 */
function groupByDay(slots, weekDates, pickMap) {
  const days = [];
  for (let i = 0; i < 5; i++) {
    const date = (weekDates && weekDates[i]) || '';
    const mine = (slots || []).filter((s) => Number(s.day) === i);
    days.push({
      day: i,
      name: DAY_NAMES[i],
      date,
      dateText: shortDate(date),
      slots: mine.map((s) => {
        // null = 未表态；1 = 能来；0 = 不能来
        const can = pickMap[s.slotKey] === undefined ? null : pickMap[s.slotKey];
        return Object.assign({
          slotKey: s.slotKey,
          title: s.title,
          timeText: s.timeText,
          dept: s.dept || '',
          role: s.role || '',
          count: s.count || 1,
          can,
        }, stateOf(can));
      }),
    });
  }
  return days.filter((d) => d.slots.length > 0);
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    ready: false,          // 本周时段是否已发布
    weekStart: '',
    weekLabel: '',
    days: [],
    reason: '',
    reasonLen: 0,
    // 代录
    people: [],
    personNames: [],
    personIndex: 0,
    targetId: 0,
    targetName: '',
    isProxy: false,
    // 汇总
    summary: { total: 0, confirmed: 0, pending: 0, rows: [] },
    pickedCount: 0,
    canCount: 0,
    cannotCount: 0,
    submitting: false,
    dirty: false,
    slotVersion: 0,
    stale: false,
  },

  /** 内部状态：slotKey → 0/1，不直接放 setData 以外的地方 */
  _pickMap: {},
  /** 当前查看/代录的对象（0 = 自己） */
  _targetId: 0,

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.fetch({});
  },

  onPullDownRefresh() {
    this.fetch({ week: this.data.weekStart || undefined })
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh());
  },

  /**
   * 拉数据
   * @param {{week?:string, personId?:number}} opt
   *   week 为空 → 云函数给「本周」，前端不自己算
   */
  fetch(opt) {
    const o = opt || {};
    this.setData({ loading: true });

    const body = {};
    if (o.week) body.week = o.week;
    if (o.personId) body.personId = o.personId;

    return adminRequest('/partner/availability', 'GET', body)
      .then((d) => {
        const data = d || {};
        // 展示谁的数据：代录对象优先，否则自己
        const shown = data.target || data.me;
        const pickMap = {};
        ((shown && shown.picks) || []).forEach((p) => {
          pickMap[p.slotKey] = p.can ? 1 : 0;
        });
        this._pickMap = pickMap;

        const targetId = data.targetId || 0;
        const meId = this._myId(data);
        this._targetId = targetId;

        const people = data.people || [];
        const personIndex = Math.max(0, people.findIndex((p) => Number(p.personId) === Number(targetId || meId)));
        const targetName = targetId
          ? ((people.find((p) => Number(p.personId) === Number(targetId)) || {}).name || '该成员')
          : '';

        const days = groupByDay(data.slots, data.weekDates, pickMap);

        this.setData({
          loading: false,
          ready: !!data.ready,
          weekStart: data.weekStart || '',
          weekLabel: this.labelOf(data.weekStart, data.weekDates),
          days,
          people,
          personNames: people.map((p) => p.name + (p.department ? ' · ' + p.department : '')),
          personIndex: personIndex < 0 ? 0 : personIndex,
          targetId,
          targetName,
          isProxy: !!targetId,
          reason: (shown && shown.reason) || '',
          reasonLen: ((shown && shown.reason) || '').length,
          summary: data.summary || { total: 0, confirmed: 0, pending: 0, rows: [] },
          slotVersion: data.slotVersion || 0,
          stale: !!(shown && shown.stale),
          dirty: false,
        });
        this.recount();
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  /** 从人员池里找出「我」的 personId（用于判断是否处于代录态） */
  _myId(data) {
    const app = getApp();
    const info = (app && app.globalData && app.globalData.adminInfo) || wx.getStorageSync('adminInfo') || {};
    return Number(info.id) || 0;
  },

  labelOf(weekStart, dates) {
    if (!weekStart) return '';
    const a = shortDate(weekStart);
    const b = shortDate((dates && dates[4]) || addDays(weekStart, 4));
    return `${a} — ${b}`;
  },

  /** 重算已选 / 能来 / 不能来 */
  recount() {
    let picked = 0;
    let can = 0;
    let cannot = 0;
    this.data.days.forEach((d) => {
      d.slots.forEach((s) => {
        if (s.can === 1) { picked++; can++; }
        else if (s.can === 0) { picked++; cannot++; }
      });
    });
    this.setData({ pickedCount: picked, canCount: can, cannotCount: cannot });
  },

  /** 点方块：未选 → 能来 → 不能来 → 未选 */
  onTapSlot(e) {
    const { i, j } = e.currentTarget.dataset;
    const days = this.data.days;
    const slot = days[i] && days[i].slots[j];
    if (!slot) return;

    const next = slot.can === null ? 1 : (slot.can === 1 ? 0 : null);
    slot.can = next;
    if (next === null) delete this._pickMap[slot.slotKey];
    else this._pickMap[slot.slotKey] = next;

    const st = stateOf(next);
    // 只更新这一格的路径，避免整页 days 重渲染（方块多时会有明显卡顿）
    const patch = {};
    patch[`days[${i}].slots[${j}].can`] = next;
    patch[`days[${i}].slots[${j}].stateText`] = st.stateText;
    patch[`days[${i}].slots[${j}].cls`] = st.cls;
    patch.dirty = true;
    this.setData(patch);
    this.recount();
  },

  onReasonInput(e) {
    const v = e.detail.value || '';
    this.setData({ reason: v, reasonLen: v.length, dirty: true });
  },

  /** 切换代录对象 */
  onPickPerson(e) {
    const idx = Number(e.detail.value) || 0;
    const p = this.data.people[idx];
    if (!p) return;
    const sameAsMe = Number(p.personId) === Number(this._myId());
    this.setData({ personIndex: idx });
    this.fetch({ week: this.data.weekStart, personId: sameAsMe ? 0 : Number(p.personId) });
  },

  /** 翻周 */
  onPrevWeek() {
    this.fetch({ week: addDays(this.data.weekStart, -7), personId: this.data.targetId || undefined });
  },
  onNextWeek() {
    this.fetch({ week: addDays(this.data.weekStart, 7), personId: this.data.targetId || undefined });
  },

  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.ready) {
      return wx.showToast({ title: '本周值班时段尚未发布', icon: 'none' });
    }

    const picks = [];
    this.data.days.forEach((d) => {
      d.slots.forEach((s) => {
        if (s.can === 1 || s.can === 0) picks.push({ slotKey: s.slotKey, can: s.can === 1 });
      });
    });

    if (!picks.length) {
      return wx.showToast({ title: '还没有选择任何时段', icon: 'none' });
    }

    const reason = String(this.data.reason || '').trim();
    const hasCannot = picks.some((p) => !p.can);
    if (!this.data.isProxy && hasCannot && reason.length < 2) {
      return wx.showToast({ title: '有不能来的时段，请填写说明', icon: 'none' });
    }
    if (this.data.isProxy && reason.length < 2) {
      return wx.showToast({ title: '代录必须填写原因', icon: 'none' });
    }

    this.setData({ submitting: true });

    const body = { week: this.data.weekStart, picks, reason };
    if (this.data.targetId) body.personId = this.data.targetId;

    adminRequest('/partner/availability', 'PUT', body)
      .then(() => {
        this.setData({ submitting: false, dirty: false });
        wx.showToast({ title: this.data.isProxy ? '已代录' : '已提交', icon: 'success' });
        // 提交后重新拉一次：汇总里的「已确认 x/y」要立刻反映出来
        this.fetch({ week: this.data.weekStart, personId: this.data.targetId || undefined });
      })
      .catch((err) => {
        this.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' });
      });
  },

  /** 清空本周填报（填错了重来） */
  onReset() {
    wx.showModal({
      title: '清空填报',
      content: '清空后需要重新选择，确定吗？',
      confirmText: '清空',
      confirmColor: '#B42318',
      success: (res) => {
        if (!res.confirm) return;
        const body = { week: this.data.weekStart };
        if (this.data.targetId) body.personId = this.data.targetId;
        adminRequest('/partner/availability', 'DELETE', body)
          .then(() => {
            wx.showToast({ title: '已清空', icon: 'success' });
            this.fetch({ week: this.data.weekStart, personId: this.data.targetId || undefined });
          })
          .catch((err) => wx.showToast({ title: (err && err.message) || '清空失败', icon: 'none' }));
      },
    });
  },

  /** 未确认名单（社干看谁还没填） */
  onShowPending() {
    const rows = (this.data.summary.rows || []).filter((r) => !r.confirmed || r.stale);
    if (!rows.length) return wx.showToast({ title: '所有人都已确认', icon: 'none' });
    wx.showModal({
      title: `还有 ${rows.length} 人未确认`,
      content: rows.map((r) => r.name + (r.stale ? '（时段已变，需重填）' : '')).join('、'),
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
