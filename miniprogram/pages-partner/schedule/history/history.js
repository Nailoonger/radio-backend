// v151 发布与调整记录。快照权限由服务端控制，本页不会从当前草稿拼造旧版本。
const { adminRequest } = require('../../../utils/request.js');
const { addDays, weekRange } = require('../view-model');
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const ACTIONS = {
  generate: '生成班表草稿', publish: '发布本周班表', withdraw: '撤回已发布班表',
  clear: '清空草稿人员', cell: '调整岗位人员', setCell: '调整岗位人员',
  revise: '建立修订草稿', check: '检查班表',
};
function timeText(value) {
  if (!value) return '时间未记录';
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return '时间未记录';
  const day = new Date(stamp + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${day.getUTCMonth() + 1}/${pad(day.getUTCDate())} ${pad(day.getUTCHours())}:${pad(day.getUTCMinutes())}`;
}
function snapshotWeek(value, fallbackWeek) {
  if (!value) return null;
  const raw = value.week || value;
  const weekStart = raw.weekStart || fallbackWeek;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '')) return null;
  if (Array.isArray(raw.days)) return Object.assign({}, raw, { weekStart });
  const assignments = Array.isArray(raw) ? raw : raw.assignments;
  if (!Array.isArray(assignments)) return null;
  const days = DAY_NAMES.map((dayName, i) => ({ day: addDays(weekStart, i), dayName, slots: [] }));
  // 快照中未分配到人的岗位没有 assignment，必须先以冻结的时段模板铺满格子。
  // slotKey 按该版本模板原有顺序逐天编号，与服务端 templatesToSlots 一致。
  const seqByDay = {};
  const hhmm = (minutes) => {
    const n = Math.max(0, Math.min(1439, Number(minutes) || 0));
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };
  (raw.templates || []).forEach((template) => {
    const index = Number(template.day);
    const day = days[index];
    if (!day) return;
    seqByDay[index] = (seqByDay[index] || 0) + 1;
    const slotName = template.title || '';
    const time = `${hhmm(template.start)}-${hhmm(template.end)}`;
    let slot = day.slots.find((s) => s.slot === slotName && s.timeText === time);
    if (!slot) {
      slot = { slot: slotName, timeText: time, start: template.start, end: template.end, groups: [], people: [] };
      day.slots.push(slot);
    }
    slot.groups.push({ slotKey: template.slotKey || `${index}-${seqByDay[index]}`,
      department: template.dept || '', role: template.role || '',
      count: Math.max(1, Number(template.count) || 1), people: [] });
  });
  assignments.forEach((row) => {
    const day = days.find((d) => d.day === row.day);
    if (!day) return;
    let slot = day.slots.find((s) => s.slot === row.slot && s.timeText === (row.timeText || ''));
    if (!slot) {
      slot = { slot: row.slot || '', timeText: row.timeText || '', groups: [], people: [] };
      day.slots.push(slot);
    }
    let group = row.slotKey ? slot.groups.find((g) => g.slotKey === row.slotKey) : null;
    if (!group) {
      const matches = slot.groups.filter((g) => g.department === (row.department || '') && (!row.role || g.role === row.role));
      if (matches.length === 1) group = matches[0];
    }
    if (!group) {
      group = { slotKey: row.slotKey || '', department: row.department || '', role: row.role || '', count: 0, people: [] };
      slot.groups.push(group);
    }
    if (row.personId) {
      group.people.push({ personId: row.personId, personName: row.personName || row.name || '伙伴', department: row.department || '' });
      slot.people.push(group.people[group.people.length - 1]);
    }
    group.count = Math.max(Number(row.count) || 0, group.people.length, 1);
  });
  return { weekStart, days, state: 'published', version: Number(raw.version) || 0 };
}

Page({
  data: {
    statusBarHeight: 20, ready: false, loading: true, loadError: '', weekStart: '', range: '',
    version: 0, publishedText: '', list: [], versions: [], hasSnapshots: false,
    snapshotOpen: false, snapshot: null, snapshotTitle: '', snapshotMeta: '', myId: 0,
  },

  onLoad(options) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    if (![0, 1].includes(Number(info.role))) {
      wx.reLaunch({ url: '/pages-partner/schedule/index/index' });
      return;
    }
    const weekStart = options && /^\d{4}-\d{2}-\d{2}$/.test(options.week || '') ? options.week : '';
    this.setData({ ready: true, weekStart, myId: Number(info.id) || 0,
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20 });
    return this.load();
  },
  onShow() { if (this.data.ready && !this.data.loading) this.load(); },
  onUnload() { this._gone = true; },
  onPullDownRefresh() { return this.load().then(() => wx.stopPullDownRefresh()); },
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 });
    else wx.reLaunch({ url: '/pages-partner/schedule/index/index' });
  },

  load() {
    if (!this.data.ready) return Promise.resolve();
    const request = (this._request || 0) + 1;
    this._request = request;
    this.setData({ loading: true, loadError: '' });
    const query = this.data.weekStart ? { week: this.data.weekStart } : {};
    return adminRequest('/partner/schedule/history', 'GET', query).then((res) => {
      if (this._gone || this._request !== request) return;
      const weekStart = res.weekStart || this.data.weekStart;
      const list = (res.list || []).map((row, i) => ({
        id: row.id || `record-${i}`, action: row.action || '',
        actionText: row.actionText || ACTIONS[row.action] || '班表调整',
        actor: row.actorName || row.operatorName || '操作者未记录',
        timeText: timeText(row.createTime || row.createdAt),
        reason: row.reason || '未填写原因',
        version: Number(row.version) || 0,
        summaryText: typeof row.summary === 'string' ? row.summary : (row.summary && Number.isFinite(Number(row.summary.needed))
          ? `已安排 ${Number(row.summary.filled) || 0}/${Number(row.summary.needed) || 0} 个岗位·缺岗 ${Number(row.summary.missing) || 0}` : ''),
        snapshot: snapshotWeek(row.snapshot, weekStart),
        tagText: row.action === 'publish' ? '发布' : (row.action === 'withdraw' ? '撤回' : '调整'),
        tagClass: row.action === 'publish' ? 'ok' : (row.action === 'withdraw' ? 'warn' : 'gray'),
      }));
      const versions = (res.versions || []).map((row, i) => ({
        id: `version-${row.version}-${i}`, version: Number(row.version) || 0,
        timeText: timeText(row.publishedAt), actor: row.publishedByName || '操作者未记录',
        total: Number(row.total) || 0, snapshot: snapshotWeek(row.snapshot, weekStart),
      }));
      const latest = versions[0];
      this.setData({ loading: false, weekStart, range: weekRange(weekStart),
        version: Number(res.version) || 0,
        publishedText: res.publishedAt ? `${timeText(res.publishedAt)} 发布` : (latest ? `${latest.timeText} 发布` : ''),
        list, versions,
        hasSnapshots: list.some((row) => row.snapshot) || versions.some((row) => row.snapshot),
        snapshotOpen: false, snapshot: null,
      });
    }).catch((err) => {
      if (this._gone || this._request !== request) return;
      this.setData({ loading: false, loadError: (err && err.message) || '调整记录加载失败，请重试' });
      if (err && Number(err.code) === 40101) wx.reLaunch({ url: '/pages-partner/login/login' });
    });
  },

  openSnapshot(e) {
    const source = e.currentTarget.dataset.source === 'versions' ? this.data.versions : this.data.list;
    const row = source[Number(e.currentTarget.dataset.index)];
    if (!row || !row.snapshot) return;
    this.setData({ snapshotOpen: true, snapshot: row.snapshot,
      snapshotTitle: row.version ? `第 ${row.version} 版完整快照` : '班表完整快照',
      snapshotMeta: `${row.timeText}·${row.actor}` });
  },
  openLatestSnapshot() {
    const versionIndex = this.data.versions.findIndex((row) => row.snapshot);
    if (versionIndex >= 0) {
      this.openSnapshot({ currentTarget: { dataset: { source: 'versions', index: versionIndex } } });
      return;
    }
    const index = this.data.list.findIndex((row) => row.snapshot);
    if (index >= 0) this.openSnapshot({ currentTarget: { dataset: { index } } });
  },
  closeSnapshot() { this.setData({ snapshotOpen: false }); },
  swallow() {},
});
