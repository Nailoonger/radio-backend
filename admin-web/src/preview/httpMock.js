/* ============================================================
   伙伴端管理 · 预览用假接口
   ------------------------------------------------------------
   ⚠️ 只在 `vite.partner-preview.config.js` 里被 alias 成 '@/utils/http'，
      生产构建（vite.config.js）走的是真的 src/utils/http.js —— 这个文件不进包。
   ============================================================ */

const DAY = ['周一', '周二', '周三', '周四', '周五'];
const PEOPLE = [
  { personId: 2, name: '林小满', department: '播音部', dutyRoles: ['播音'], isSuper: false },
  { personId: 3, name: '周予安', department: '播音部', dutyRoles: ['播音', '主持'], isSuper: false },
  { personId: 4, name: '许听白', department: '主持部', dutyRoles: ['主持'], isSuper: false },
  { personId: 5, name: '沈亦声', department: '编辑部', dutyRoles: ['编辑'], isSuper: false },
  { personId: 6, name: '苏晚笛', department: '编辑部', dutyRoles: ['编辑', '记者'], isSuper: false },
  { personId: 7, name: '陈知遥', department: '技术组', dutyRoles: ['技术'], isSuper: false },
];

const TEMPLATES = [
  { day: 0, title: '早会', start: 450, end: 470, dept: '', role: '', count: 2 },
  { day: 0, title: '午间', start: 720, end: 750, dept: '播音部', role: '播音', count: 2 },
  { day: 1, title: '午间', start: 720, end: 750, dept: '播音部', role: '播音', count: 2 },
  { day: 2, title: '午间', start: 720, end: 750, dept: '播音部', role: '播音', count: 2 },
  { day: 3, title: '午间', start: 720, end: 750, dept: '播音部', role: '播音', count: 2 },
  { day: 4, title: '午间', start: 720, end: 750, dept: '播音部', role: '播音', count: 2 },
  { day: 2, title: '傍晚', start: 1020, end: 1050, dept: '主持部', role: '主持', count: 1 },
  { day: 4, title: '傍晚', start: 1020, end: 1050, dept: '主持部', role: '主持', count: 1 },
];

function hhmm(min) {
  const n = Math.max(0, Number(min) || 0);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function slotsOf(templates) {
  const seq = {};
  return templates.map((t) => {
    const day = Number(t.day);
    seq[day] = (seq[day] || 0) + 1;
    return {
      slotKey: `${day}-${seq[day]}`, day, seq: seq[day], title: t.title,
      start: t.start, end: t.end, dept: t.dept, role: t.role, count: t.count,
      timeText: `${hhmm(t.start)}-${hhmm(t.end)}`,
    };
  });
}

const WEEK = '2026-10-26';
const DATES = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
const SLOTS = slotsOf(TEMPLATES);

/** 造一份班表：每天午间 2 人，周一早会 2 人，周三/周五傍晚 1 人；周三傍晚留一个缺岗 */
const ASSIGN = [];
let aid = 1;
const put = (dayIdx, slotTitle, personId, source) => {
  const p = PEOPLE.find((x) => x.personId === personId);
  const sd = SLOTS.find((s) => s.day === dayIdx && s.title === slotTitle);
  ASSIGN.push({
    weekStart: WEEK, day: DATES[dayIdx], slot: slotTitle,
    slotKey: sd ? sd.slotKey : '', timeText: sd ? sd.timeText : '',
    department: sd ? sd.dept : '', personId, personName: p ? p.name : '', source: source || 'auto',
  });
};
put(0, '早会', 2); put(0, '早会', 3);
put(0, '午间', 5); put(0, '午间', 6);
put(1, '午间', 2); put(1, '午间', 4);
put(2, '午间', 3); put(2, '午间', 7);
put(2, '傍晚', 4);                       // 应到 1 → 已满
put(3, '午间', 6); put(3, '午间', 7);
put(4, '午间', 2); put(4, '午间', 5);
// 周五傍晚：故意留空 → 缺岗
put(3, '早会', 4, 'manual');             // 手改示例

function readWeek() {
  const days = DATES.map((date, i) => {
    const rows = ASSIGN.filter((a) => a.day === date);
    const map = {};
    rows.forEach((r) => {
      if (!map[r.slot]) map[r.slot] = { slot: r.slot, timeText: r.timeText, people: [] };
      map[r.slot].people.push(r);
    });
    return { day: date, dayName: DAY[i], slots: Object.keys(map).map((k) => map[k]), total: rows.length };
  });
  const order = [];
  ASSIGN.forEach((a) => { if (!order.includes(a.slot)) order.push(a.slot); });
  return { weekStart: WEEK, state: 'draft', version: 0, publishedAt: null, slotOrder: order, days, total: ASSIGN.length };
}

const AV_ROWS = PEOPLE.map((p, i) => ({
  personId: p.personId, name: p.name, department: p.department, dutyRoles: p.dutyRoles,
  isSuper: false,
  confirmed: i !== 5,
  canCount: [4, 5, 3, 4, 2, 0][i],
  source: i === 3 ? 'proxy' : 'self',
  confirmedAt: i !== 5 ? new Date('2026-10-24T20:11:00') : null,
  stale: false,
}));

const LEAVES = [
  { id: 11, personId: 7, personName: '陈知遥', weekStart: WEEK, day: DATES[2], slot: '午间', reason: '周四下午有数学竞赛培训，赶不回来', status: 0, statusText: '待批', rejectReason: '', reviewedByName: '', createTime: new Date('2026-10-25T21:03:00') },
  { id: 12, personId: 5, personName: '苏晚笛', weekStart: WEEK, day: DATES[4], slot: '午间', reason: '周五请假半天（家长已和班主任说）', status: 0, statusText: '待批', rejectReason: '', reviewedByName: '', createTime: new Date('2026-10-26T08:40:00') },
];

const DRAFTS = [
  { id: 21, title: '秋分那天，风把桂花香送进了播音室', columnName: '午间·散文', status: 1, statusText: '待审核', wordCount: 862, seconds: 215, version: 3, authorId: 2, authorName: '林小满', submittedAt: new Date('2026-10-27T12:20:00') },
  { id: 22, title: '运动会特别节目：跑道边的十句话', columnName: '特别节目', status: 1, statusText: '待审核', wordCount: 1240, seconds: 310, version: 2, authorId: 5, authorName: '苏晚笛', submittedAt: new Date('2026-10-27T18:02:00') },
  { id: 23, title: '关于午间音乐单的一次小调整', columnName: '站内通知', status: 2, statusText: '已通过', wordCount: 410, seconds: 102, version: 1, authorId: 4, authorName: '许听白', submittedAt: new Date('2026-10-20T09:15:00') },
];
const DRAFT_BODY = `（预览用正文）

秋分前后的那几天，风里忽然就有了甜味。
广播站的窗正对着操场边那排桂花树，午后两点，播音室的门一开，
香味就跟着人一起挤进来，混着机器预热时那点温热的味道。

我们把话筒推上去一点点，怕太亮；
把伴奏压下去一点点，怕盖住风。
这一期就这样开始。`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms || 120));

function pick(path, params) {
  const p = String(path || '');

  /* 账号管理（超管）—— 预览壳里也能看到四档分段、站员行、待激活/已停用
     ⚠️ 这里的站员学号刻意避开 candidates 那三个人：候选池的定义是「还没进伙伴端的人」，
        两边撞号就自相矛盾了。 */
  if (p === '/admin/admin/list') {
    const list = [
      { id: 1, username: 'chenlaoshi', nickname: '陈老师', role: 0, status: 1, lastLoginAt: new Date('2026-10-30T08:12:00'), createTime: new Date('2026-02-10T09:00:00'), userId: null, department: '指导教师', dutyRoles: [] },
      { id: 2, username: 'suwan', nickname: '苏晚笛', role: 0, status: 1, lastLoginAt: new Date('2026-10-29T19:40:00'), createTime: new Date('2026-03-02T09:00:00'), userId: null, department: '', dutyRoles: [] },
      { id: 3, username: 'zhouyuan', nickname: '周予安', role: 1, status: 1, lastLoginAt: new Date('2026-10-28T12:05:00'), createTime: new Date('2026-09-01T09:00:00'), userId: null, department: '播音部', dutyRoles: ['播音'] },
      { id: 4, username: 'xutingbai', nickname: '许听白', role: 1, status: 1, lastLoginAt: new Date('2026-10-27T16:20:00'), createTime: new Date('2026-09-01T09:00:00'), userId: null, department: '主持部', dutyRoles: ['主持'] },
      { id: 5, username: '20240201', nickname: '沈方', role: 2, status: 1, lastLoginAt: new Date('2026-10-29T12:30:00'), createTime: new Date('2026-09-12T09:00:00'), userId: 201, department: '播音部', dutyRoles: ['播音'] },
      { id: 6, username: '20240202', nickname: '江砚', role: 2, status: 1, lastLoginAt: new Date('2026-10-28T18:10:00'), createTime: new Date('2026-09-12T09:00:00'), userId: 202, department: '编辑部', dutyRoles: ['编辑'] },
      { id: 7, username: '20240203', nickname: '温以宁', role: 2, status: 1, lastLoginAt: null, createTime: new Date('2026-10-26T09:00:00'), userId: 203, department: '', dutyRoles: [] },
      { id: 8, username: '20240204', nickname: '陆青野', role: 2, status: 0, lastLoginAt: new Date('2026-09-20T12:00:00'), createTime: new Date('2026-09-12T09:00:00'), userId: 204, department: '播音部', dutyRoles: ['播音'] },
    ];
    return { list, total: list.length, page: 1, pageSize: 50 };
  }

  if (p === '/partner/slots') {
    return {
      canEdit: true, canPublish: true, hasPublished: true, pendingDraft: false,
      published: { id: 1, version: 2, state: 'published', templates: TEMPLATES, slots: SLOTS, slotCount: TEMPLATES.length, dayCount: 5, publishedAt: new Date('2026-10-12T10:00:00'), publishedBy: 1, publishedByName: '陈老师', reason: '秋学期起，午间加一个播音位', updateTime: new Date('2026-10-12T10:00:00') },
      draft: null,
      editing: { id: null, version: 3, state: 'draft', templates: TEMPLATES, slots: SLOTS, slotCount: TEMPLATES.length, dayCount: 5 },
    };
  }
  if (p === '/partner/slots/published') return { published: { version: 2, templates: TEMPLATES, slots: SLOTS }, ready: true };

  if (p === '/partner/rules') {
    return {
      items: [
        { key: 'day', name: '每天最多场次', value: 1, on: true, unit: '场' },
        { key: 'week', name: '每周最多场次', value: 3, on: true, unit: '场' },
      ],
      defaults: [],
    };
  }

  if (p === '/partner/schedule') return readWeek();
  if (p === '/partner/schedule/month') {
    return {
      month: '2026-10', weeks: ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'],
      list: [
        { personId: 2, personName: '林小满', count: 9 },
        { personId: 3, personName: '周予安', count: 8 },
        { personId: 5, personName: '苏晚笛', count: 7 },
        { personId: 6, personName: '沈亦声', count: 6 },
        { personId: 4, personName: '许听白', count: 5 },
        { personId: 7, personName: '陈知遥', count: 4 },
      ],
      total: 39,
    };
  }

  if (p === '/partner/availability') {
    const rows = AV_ROWS;
    return {
      weekStart: WEEK, weekDates: DATES, slotVersion: 2, slots: SLOTS, ready: true, people: PEOPLE,
      me: null, target: null, targetId: 1,
      summary: { total: rows.length, confirmed: rows.filter((r) => r.confirmed).length, pending: rows.filter((r) => !r.confirmed).length, rows },
      abilities: { canProxy: true },
    };
  }

  if (p === '/partner/leave/pending') {
    return { list: LEAVES, total: LEAVES.length, counts: { pending: LEAVES.length, approved: 14, rejected: 3 } };
  }
  const impactM = /^\/partner\/leave\/(\d+)\/impact$/.exec(p);
  if (impactM) {
    const lv = LEAVES.find((x) => x.id === Number(impactM[1])) || LEAVES[0];
    return {
      leave: lv,
      willEmpty: { day: lv.day, dayName: DAY[DATES.indexOf(lv.day)], slot: lv.slot, personName: lv.personName },
      slot: { name: lv.slot, need: 2, timeText: '12:00-12:30', filled: 1, afterFilled: 1 },
      limits: { dayMax: 1, weekMax: 3 },
      candidates: PEOPLE.filter((x) => x.personId !== lv.personId).map((x, i) => {
        const blocked = [null, null, '本周已满 3 场', null, '没填「能来」', null][i] || '';
        return {
          personId: x.personId, name: x.name, department: x.department,
          weekShifts: [1, 2, 3, 1, 0, 2][i], dayShifts: [0, 0, 0, 0, 0, 0][i],
          ok: !blocked, blocked,
        };
      }),
      candidateCount: 4,
    };
  }

  if (p === '/partner/attendance/week') {
    const days = DATES.map((date, i) => {
      const rows = ASSIGN.filter((a) => a.day === date);
      const map = {};
      rows.forEach((r) => {
        if (!map[r.slot]) map[r.slot] = { slot: r.slot, people: [] };
        map[r.slot].people.push({
          personId: r.personId, personName: r.personName, department: r.department,
          status: i === 0 ? 1 : (i === 1 ? 1 : null), statusText: i < 2 ? '到岗' : '未点', onLeave: false,
        });
      });
      return { day: date, dayName: DAY[i], slots: Object.keys(map).map((k) => map[k]), total: rows.length };
    });
    return {
      weekStart: WEEK, days,
      summary: { posts: ASSIGN.length, marked: 4, present: 4, absent: 0, leave: 0 },
    };
  }
  if (p === '/partner/attendance/overview') {
    return {
      weekStart: WEEK,
      summary: { posts: ASSIGN.length, present: 4, absent: 0, leave: 0, unmarked: ASSIGN.length - 4 },
      people: [
        { name: '林小满', posts: 3, present: 2, absent: 0, leave: 0, unmarked: 1 },
        { name: '周予安', posts: 2, present: 1, absent: 0, leave: 0, unmarked: 1 },
        { name: '许听白', posts: 2, present: 1, absent: 0, leave: 0, unmarked: 1 },
        { name: '沈亦声', posts: 2, present: 0, absent: 0, leave: 0, unmarked: 2 },
        { name: '苏晚笛', posts: 2, present: 0, absent: 0, leave: 0, unmarked: 2 },
        { name: '陈知遥', posts: 2, present: 0, absent: 0, leave: 0, unmarked: 2 },
      ],
    };
  }

  if (p === '/partner/draft/review') {
    const st = Number(params && params.status === undefined ? 1 : params.status);
    return { list: DRAFTS.filter((d) => d.status === st), total: DRAFTS.filter((d) => d.status === st).length, page: 1, pageSize: 20, status: st };
  }
  const detM = /^\/partner\/draft\/(\d+)$/.exec(p);
  if (detM) {
    const d = DRAFTS.find((x) => x.id === Number(detM[1])) || DRAFTS[0];
    return Object.assign({}, d, { body: DRAFT_BODY, rate: 240, rejectReason: '', updateTime: d.submittedAt, createTime: d.submittedAt });
  }
  const verM = /^\/partner\/draft\/(\d+)\/versions$/.exec(p);
  if (verM) {
    const d = DRAFTS.find((x) => x.id === Number(verM[1])) || DRAFTS[0];
    return {
      id: d.id, title: d.title, columnName: d.columnName, current: d.version,
      list: [
        { v: d.version, title: d.title, body: DRAFT_BODY, wordCount: d.wordCount, seconds: d.seconds, status: d.status, statusText: d.statusText, savedAt: d.submittedAt, current: true },
        { v: d.version - 1, title: d.title, body: DRAFT_BODY.split('\n').slice(0, 4).join('\n'), wordCount: d.wordCount - 120, seconds: d.seconds - 30, status: 0, statusText: '草稿', savedAt: new Date('2026-10-26T20:00:00'), current: false },
        { v: d.version - 2, title: d.title + '（初稿）', body: DRAFT_BODY.split('\n').slice(0, 2).join('\n'), wordCount: d.wordCount - 300, seconds: d.seconds - 75, status: 0, statusText: '草稿', savedAt: new Date('2026-10-24T19:00:00'), current: false },
      ],
    };
  }

  if (p === '/partner/feedback/overview') {
    return {
      weekStart: WEEK, given: 7, onDuty: ASSIGN.length,
      people: [
        { personId: 2, personName: '林小满', received: 3 },
        { personId: 3, personName: '周予安', received: 2 },
        { personId: 4, personName: '许听白', received: 1 },
        { personId: 7, personName: '陈知遥', received: 1 },
      ],
    };
  }

  if (p === '/partner/accounts/candidates') {
    return { list: [
      { userId: 101, name: '顾南乔', username: '20240101', grade: '高一(3)班' },
      { userId: 102, name: '温言', username: '20240102', grade: '高一(5)班' },
      { userId: 103, name: '叶知秋', username: '20240103', grade: '高二(1)班' },
    ] };
  }

  return {};
}

async function call(method, url, a, b) {
  await delay();
  const isBody = method === 'post' || method === 'put' || method === 'patch';
  const config = (isBody ? b : a) || {};
  const params = config.params || {};
  const p = String(url || '');
  // 写操作只提示，不真改（预览壳没有后端）
  if (method !== 'get') {
    // eslint-disable-next-line no-console
    console.log('[预览] 写操作（未真正执行）', method.toUpperCase(), p, isBody ? a : config.data);
    if (p === '/partner/schedule' || p.indexOf('/partner/schedule/') === 0) return { week: readWeek(), generated: ASSIGN.length || 0, missing: [], cell: { day: '', slot: '', personIds: [] } };
    if (p.indexOf('/partner/slots') === 0) return { draft: { version: 3, templates: (a && a.templates) || TEMPLATES }, published: { version: 3, templates: (a && a.templates) || TEMPLATES } };
    if (p.indexOf('/partner/attendance') === 0) {
      return { marked: 1, days: pick('/partner/attendance/week', {}).days };
    }
    if (p.indexOf('/partner/availability') === 0) return { removed: 1 };
    // 账号管理 › 新增站员：预览壳里也走通，好让人看到建完的回报文案
    if (p === '/partner/accounts/import') {
      const ids = (a && Array.isArray(a.userIds)) ? a.userIds : [];
      const pool = (pick('/partner/accounts/candidates', {}) || {}).list || [];
      const created = pool.filter((c) => ids.indexOf(c.userId) >= 0)
        .map((c, i) => ({ id: 900 + i, userId: c.userId, username: c.username, name: c.name, role: 2 }));
      return {
        created,
        skipped: [],
        createdCount: created.length,
        passwordRule: '初始密码 = user + 学号（首次登录会引导改密）',
        by: '预览',
      };
    }
    return {};
  }
  return pick(p, params);
}

const http = {
  get: (url, cfg) => call('get', url, cfg),
  post: (url, data, cfg) => call('post', url, data, cfg),
  put: (url, data, cfg) => call('put', url, data, cfg),
  patch: (url, data, cfg) => call('patch', url, data, cfg),
  delete: (url, cfg) => call('delete', url, cfg),
  request: (cfg) => call(cfg.method || 'get', cfg.url, cfg.params ? { params: cfg.params } : cfg, cfg.data),
  defaults: {},
  interceptors: { request: { use() {} }, response: { use() {} } },
};

export default http;
export const requestMode = 'preview';
export const cloudApiUrl = '';
