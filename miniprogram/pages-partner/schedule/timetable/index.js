const { timetable, emptyWeek, weekRange, weekNo } = require('../view-model');
Component({
  properties: {
    week: { type: Object, value: {} }, myId: Number,
    visiblePeople: { type: Boolean, value: true }, editable: Boolean,
    // 已发布时段（班表未生成时用它铺整周空表）；工作台恒显示「固定」图例
    slots: { type: Array, value: [] }, showFixed: { type: Boolean, value: false },
    // 标题的「本周 / 该周」：工作台能翻周，恒写「本周」会误导（2026-10-30）
    isThisWeek: { type: Boolean, value: true },
  },
  data: { cols: [], singles: [], matrix: [], range: '', weekLabel: '' },
  observers: { 'week,myId,visiblePeople,slots': function (week, myId, visiblePeople, slots) {
    if (!week || !week.weekStart) return;
    // 班表还没生成但有已发布时段 → 按时段铺整周空表（原型空态，不删表）
    let w = week;
    if (!(w.days || []).length && (slots || []).length) {
      w = Object.assign({}, w, emptyWeek(w.weekStart, slots));
    }
    this.setData(Object.assign(timetable(w, myId, visiblePeople, w.leaves), { range: weekRange(week.weekStart), weekLabel: weekNo(week.weekStart) }));
  } },
  methods: { edit(e) { if (this.data.editable) this.triggerEvent('edit', e.currentTarget.dataset); } },
});
