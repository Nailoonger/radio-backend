// v151 班表视图：只转换服务端日期与岗位，不推算手机所在时区的「本周」。
const DAYS = ['周一', '周二', '周三', '周四', '周五'];
function addDays(value, offset) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + offset));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function shortDate(value) { return String(value || '').slice(5).replace('-', '/'); }
function weekRange(week) { return `${shortDate(week)} – ${shortDate(addDays(week, 4))}`; }
function weekNo(week) {
  if (!week) return '';
  const d = new Date(week + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  first.setUTCDate(first.getUTCDate() + 3 - (first.getUTCDay() + 6) % 7);
  return `第 ${1 + Math.round((d - first) / 604800000)} 周`;
}
/* 原型四态（partner-design-spec-v1.md 二节）：published 已发布 vN / draft 草稿未发布 /
   withdrawn 班表页状态条=已撤回，工作台行=已撤回 · 待重发 / 其余=本周未排班 */
function stateLabel(state, version, formalOnly) {
  if (state === 'published') return `已发布 v${version || 1}`;
  if (state === 'draft') return '草稿未发布';
  if (state === 'withdrawn') return formalOnly ? '已撤回' : '已撤回 · 待重发';
  return '本周未排班';
}
function timetable(week, myId, visiblePeople, leaves) {
  const days = DAYS.map((name, i) => {
    const date = addDays(week.weekStart, i);
    const raw = (week.days || []).find((x) => x.day === date) || {};
    return { day: date, name, dateText: shortDate(date), slots: raw.slots || [] };
  });
  const all = {};
  days.forEach((day) => day.slots.forEach((slot) => {
    const key = slot.timeText || slot.slot;
    if (!all[key]) all[key] = { key, slot: slot.slot, timeText: slot.timeText || '', byDay: {} };
    if (!all[key].byDay[day.day]) all[key].byDay[day.day] = [];
    const groups = slot.groups && slot.groups.length ? slot.groups : [{
      slotKey: slot.slotKey || '', department: '', role: '', count: Math.max(1, (slot.people || []).length), people: slot.people || [],
    }];
    groups.forEach((group) => {
      const people = visiblePeople ? (group.people || []) : [];
      const chips = people.map((p, i) => {
        const leave = (leaves || []).find((x) => Number(x.personId) === Number(p.personId) && x.day === day.day && x.slot === slot.slot && Number(x.status) < 2);
        return {
          key: `${p.personId}-${i}`, name: p.personName || p.name || '伙伴',
          department: String(group.department || p.department || '').replace(/部$/, ''),
          cls: Number(p.personId) === Number(myId) ? 'me' : (leave ? (Number(leave.status) === 0 ? 'leave' : 'ok') : ''),
          fixed: !!p.fixed,
        };
      });
      const count = Math.max(1, Number(group.count) || 1);
      for (let i = people.length; i < count; i++) chips.push({ key: `empty-${i}`, name: '空缺', department: String(group.department || '').replace(/部$/, ''), cls: 'empty', fixed: false });
      all[key].byDay[day.day].push({
        key: group.slotKey || `${day.day}-${key}-${group.department || ''}`,
        day: day.day, slot: slot.slot, slotKey: group.slotKey || '',
        department: group.department || '', role: group.role || '', count, chips,
        // 换人弹层的标题要「周一 10/27 日 · 午间播音」+「12:10-12:40」，
        // 所以把周几和起止时间一起带到格子上（v151 `.sw-hd` 的两行）
        dayName: day.name || '', timeText: slot.timeText || '',
      });
    });
  }));
  const rows = Object.keys(all).map((key) => all[key]).sort((a, b) => a.timeText.localeCompare(b.timeText));
  const singles = [], matrix = [];
  rows.forEach((row) => {
    const dates = Object.keys(row.byDay);
    if (dates.length === 1) {
      const date = dates[0];
      singles.push({ key: row.key, slot: row.slot, timeText: row.timeText, dayName: days.find((x) => x.day === date).name, groups: row.byDay[date] });
    // ⚠️ 行头要显示**完整起止**（12:10-12:30），不能切成只留开始时间：
    //    班表这一行就是「值班时段」里那条，名字和时间都得跟时段配置对得上（陛下 2026-10-29）。
    } else matrix.push({ key: row.key, slot: row.slot, timeText: row.timeText, cells: days.map((day) => ({ day: day.day, groups: row.byDay[day.day] || [] })) });
  });
  // 早会恒定在表格上方，且**永远排第一**：一周只有周一有早会（06:50–07:30，主持部 1 + 播音部 2），
  // 它是全站例会，不是普通时段（陛下 2026-10-29）。数据里已有早会就用真实的；
  // 没有就补一条空壳，格子里是空缺胶囊 —— 但位置必须在顶部，不能因为别的单日时段存在就把早会挤掉。
  const hasEarly = singles.concat(matrix).some((x) => x.slot === '早会');
  if (!hasEarly) {
    const EARLY = [{ dept: '主持部', role: '主持', n: 1 }, { dept: '播音部', role: '播音', n: 2 }];
    singles.unshift({
      key: 'duty-early', slot: '早会', timeText: '06:50-07:30', dayName: '周一',
      groups: EARLY.map((d, gi) => ({
        key: `duty-early-${gi}`, day: '', slot: '早会', slotKey: '',
        department: d.dept, role: d.role, count: d.n,
        dayName: '周一', timeText: '06:50-07:30',
        chips: Array.from({ length: d.n }, (_, k) => ({
          key: `duty-early-${gi}-${k}`, name: '空缺',
          department: d.dept.replace(/部$/, ''), cls: 'empty', fixed: false,
        })),
      })),
    });
  }
  return { cols: days.map(({ day, name, dateText }) => ({ day, name, dateText })), singles, matrix };
}
/* 时段已发布、班表还没生成时的整周空表（原型 planning/scheduling 空态：
   表格按时段铺满一周，格子里全是「空缺」，不给一张空态卡把表删掉 —— v111） */
function emptyWeek(weekStart, slots) {
  const days = DAYS.map((name, i) => {
    const date = addDays(weekStart, i);
    const agg = {};
    (slots || []).filter((x) => Number(x.day) === i).forEach((x) => {
      const k = `${x.title}|${x.start}`;
      if (!agg[k]) agg[k] = { slot: x.title, slotKey: x.slotKey || '', timeText: x.timeText || '', count: 0, people: [] };
      agg[k].count += Number(x.count) || 1;      // 同一场的多部门合并成一格，人数求和
    });
    return { day: date, dayName: name, slots: Object.keys(agg).map((k) => agg[k]) };
  });
  return { weekStart, state: 'empty', version: 0, days };
}

function exportText(week) {
  const lines = [`本周 ${weekRange(week.weekStart)} 班表`];
  (week.days || []).forEach((day) => {
    (day.slots || []).forEach((slot) => {
      const groups = slot.groups && slot.groups.length ? slot.groups : [{ people: slot.people || [], count: 1 }];
      groups.forEach((g) => lines.push(`${day.dayName || day.day} ${slot.slot} ${slot.timeText || ''} ${g.department || ''}${g.role ? '·' + g.role : ''}：${(g.people || []).map((p) => p.personName).join('、') || '空缺'}`));
    });
  });
  return lines.join('\n');
}
module.exports = { DAYS, addDays, shortDate, weekRange, weekNo, stateLabel, timetable, emptyWeek, exportText };
