// pages-partner/schedule/slots/slots.js
//
// 伙伴端 · 值班时段配置 —— v2（2026-10-29 照原型「值班时段配置」屏重做）
//
// 原型口径（partner-hub _cmpA.html `timeslots` 屏 + `slotNewSheet` + `slotCards`）：
//   卡片 = 一个「场次」（名称 + 起止 + 哪几天 + 部门×人数），
//   不是 v1 的「逐天逐部门一行」表格 —— 那是后端存储形状，不是给人看的形状。
//   后端 templates 仍是逐行（day×dept），前端聚合/展开即可，存储不动。
//
// 原句全部照抄原型，一字不改（见 docs/specs/14-partner-hub/partner-design-spec-v1.md）。
//
// ⚠️ 权限只在前端置灰，真正的拦截在云函数（PUT/POST 都是 asSuperPartner）。
// ⚠️ 时间在前端用 picker 的 'HH:MM'，提交时转「当天分钟数」（410 = 06:50）：
//    重叠校验、排序、同格多部门的 seq 编号全部依赖可比较的数值。
const { adminRequest } = require('../../../utils/request.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const DEPARTMENTS = ['主持部', '播音部', '编辑部'];   // 原型表单顺序：主持部 / 播音部 / 编辑部
/** 部门 → 主岗位（原型明细行「主持部-主持」的映射，_cmpA slotCards 原句逻辑） */
const ROLE_OF = { 播音部: '播音', 主持部: '主持', 编辑部: '编辑' };

const pad2 = (n) => String(n).padStart(2, '0');

/** 'HH:MM' → 分钟数；非法返回 null */
function toMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → 'HH:MM' */
function toHHMM(min) {
  const n = Math.max(0, Math.min(1439, Number(min) || 0));
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

/** 本周周一（日历日）。与 schedule/index 同口径，别拿裸 new Date() 算周 */
function mondayOf(offWeeks) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;              // 周一=0
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + (offWeeks || 0) * 7);
  return `${mon.getFullYear()}-${pad2(mon.getMonth() + 1)}-${pad2(mon.getDate())}`;
}

function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return ymd;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 一年里的第几周（ISO 周，周一为一周开始）——只用于展示「第 N 周」 */
function weekNo(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return 1;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);   // 移到本周周四（ISO 周由周四定年）
  const first = new Date(t.getFullYear(), 0, 4);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7) + 3);
  return 1 + Math.round((t - first) / (7 * 86400000));
}

/** 后端逐行 templates → 原型「场次卡」（_cmpA slotCards 原逻辑：按 名称|起|止 聚合） */
function rowsToCards(rows, monday) {
  const map = {};
  const order = [];
  (rows || []).forEach((r) => {
    const key = `${r.title}|${r.start}|${r.end}`;
    if (!map[key]) {
      map[key] = { key, name: r.title || '', start: Number(r.start) || 0, end: Number(r.end) || 0, days: [], depts: {} };
      order.push(key);
    }
    const c = map[key];
    if (c.days.indexOf(Number(r.day)) < 0) c.days.push(Number(r.day));
    // ⚠️ 「每场 N 人」= 单场配置。同一部门在多天出现时不能累加（3 人 × 5 天 ≠ 15 人），
    //    取各天里的最大值即可（正常配置每天相同；脏数据取大也不亏）
    if (r.dept) {
      const n = Number(r.count) || 1;
      if (c.depts[r.dept] === undefined || c.depts[r.dept] < n) c.depts[r.dept] = n;
    }
  });
  order.sort((a, b) => (map[a].start - map[b].start) || String(map[a].name).localeCompare(String(map[b].name), 'zh'));
  return order.map((k) => {
    const c = map[k];
    c.days.sort((x, y) => x - y);
    const deptKeys = Object.keys(c.depts).filter((d) => c.depts[d] > 0);
    const total = deptKeys.reduce((n, d) => n + c.depts[d], 0);
    c.deptLines = deptKeys.map((d) => ({ dept: d, role: ROLE_OF[d] || '', count: c.depts[d] }));
    c.dayText = c.days.map((d) => `${DAY_NAMES[d]} ${addDays(monday, d).slice(8, 10)} 日`).join('、');
    c.startText = toHHMM(c.start);
    c.endText = toHHMM(c.end);
    c.dayCount = c.days.length;
    c.deptCount = deptKeys.length;
    c.total = total;
    return c;
  });
}

/** 场次卡 → 后端逐行 templates（同名同时间的旧行由调用方先剔除） */
function cardToRows(card) {
  const out = [];
  (card.days || []).forEach((day) => {
    (card.deptLines || []).forEach((l) => {
      if (!l.count) return;
      out.push({
        day,
        title: String(card.name || '').trim(),
        start: toMin(card.start),
        end: toMin(card.end),
        dept: l.dept,
        role: ROLE_OF[l.dept] || '',
        count: Number(l.count) || 1,
      });
    });
  });
  return out;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    loadError: '',
    canEdit: false,

    weekNo: '',
    weekRange: '',
    pubTag: '草稿未发布',
    // ⚠️ pendingDraft = 服务端存在未发布草稿。顶部标签必须反映「你现在正在改的那份」，
    //    不能只看 hasPublished —— 否则有草稿时仍显示「已发布」，陛下会以为保存即生效。
    pendingDraft: false,

    cards: [],
    hasAny: false,

    saving: false,
    publishing: false,
    resetting: false,

    // 弹层（加/编辑一个场次）—— 原型 slotNewSheet
    sheet: false,
    shTitle: '加一个值班时段',
    shDesc: '选哪天、叫什么、几点到几点；再勾上这一场需要哪几个部门、各要几个人。',
    shDays: [],
    shName: '',
    shStart: '12:10',
    shEnd: '12:40',
    shDepts: [],
    shEditKey: '',
    delKey: '',
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
    });
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  /** 返回上一级（原型导航栏左上 ›）；没有栈就回班表页 */
  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages-partner/schedule/index/index' }),
    });
  },


  fetch() {
    const monday = mondayOf(0);
    const friday = addDays(monday, 4);
    this.setData({
      loading: true,
      loadError: '',
      weekNo: `第 ${weekNo(monday)} 周`,
      weekRange: `${monday.slice(5, 7)}/${monday.slice(8, 10)} – ${friday.slice(5, 7)}/${friday.slice(8, 10)}`,
    });
    return adminRequest('/partner/slots', 'GET', {})
      .then((d) => {
        const data = d || {};
        const editing = data.editing || { templates: [] };
        this._templates = (editing.templates || []).map((t) => Object.assign({}, t));
        const cards = rowsToCards(this._templates, monday);
        // 标签口径：有草稿 = 你现在改的这份还没上线；没草稿 = 看到的就是线上那版
        const pendingDraft = !!data.pendingDraft;
        this.setData({
          loading: false,
          canEdit: !!data.canEdit,
          isPublished: !pendingDraft && !!data.hasPublished,
          pendingDraft,
          pubTag: pendingDraft ? '草稿未发布' : (data.hasPublished ? '已发布' : '草稿未发布'),
          cards,
          hasAny: cards.length > 0,
        });
      })
      .catch((err) => {
        // ⚠️ 拉不到 ≠ 没数据：把云函数的真因一并显示（见 partner-design-spec-v1 第五节）
        const raw = (err && err.data && err.data.error) ? String(err.data.error) : '';
        this.setData({
          loading: false,
          loadError: `${(err && err.message) || '加载失败'}${raw ? ' · ' + raw.slice(0, 140) : ''}`,
        });
      });
  },

  /* ── 卡片操作（原型：编辑 / 删除，删除有二步确认） ── */
  onEdit(e) {
    const key = e.currentTarget.dataset.key;
    const card = this.data.cards.find((x) => x.key === key);
    if (!card) return;
    this.setData({
      sheet: true,
      shTitle: '编辑值班时段',
      shDesc: '改完点「保存修改」，这一周的时段和站员端同步更新。',
      shEditKey: key,
      shDays: DAY_NAMES.map((n, i) => ({ i, name: n, on: card.days.indexOf(i) >= 0 })),
      shName: card.name,
      shStart: toHHMM(card.start),
      shEnd: toHHMM(card.end),
      shDepts: DEPARTMENTS.map((d) => ({
        dept: d,
        count: (card.deptLines.find((x) => x.dept === d) || {}).count || 0,
      })),
    });
  },

  onAdd() {
    this.setData({
      sheet: true,
      shTitle: '加一个值班时段',
      shDesc: '选哪天、叫什么、几点到几点；再勾上这一场需要哪几个部门、各要几个人。',
      shEditKey: '',
      shDays: DAY_NAMES.map((n, i) => ({ i, name: n, on: i === 0 })),
      shName: '',
      shStart: '12:10',
      shEnd: '12:40',
      shDepts: DEPARTMENTS.map((d) => ({ dept: d, count: d === '播音部' ? 1 : 0 })),
    });
  },

  onDelAsk(e) { this.setData({ delKey: e.currentTarget.dataset.key }); },
  onDelNo() { this.setData({ delKey: '' }); },

  onDelYes() {
    const key = this.data.delKey;
    if (!key) return;
    const left = (this._templates || [])
      .filter((r) => `${r.title}|${r.start}|${r.end}` !== key);
    this._templates = left;
    this.setData({ delKey: '' });
    this.saveDraft(left, '已删除');
  },

  /* ── 弹层 ── */
  closeSheet() { this.setData({ sheet: false, shEditKey: '' }); },
  stop() {},

  toggleDay(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({ shDays: this.data.shDays.map((d) => (d.i === i ? { ...d, on: !d.on } : d)) });
  },

  // 名称输入交给 `model:value`（双向绑定）自己同步 data，这里不再挂 bindinput。
  // 历史教训：① 只记实例不 setData ⇒ 别的 setData 一来就被重置成空串；
  //           ② 手写 setData 回写 ⇒ 和中文输入法的 composition 抢，拼音上不了屏。
  //           model:value 是微信给这两个坑的统一解（基础库 2.9.3+，本项目 2.32.3）。
  onStart(e) { this.setData({ shStart: e.detail.value }); },
  onEnd(e) { this.setData({ shEnd: e.detail.value }); },
  onStart(e) { this.setData({ shStart: e.detail.value }); },
  onEnd(e) { this.setData({ shEnd: e.detail.value }); },

  deptMinus(e) { this.bumpDept(e.currentTarget.dataset.dept, -1); },
  deptPlus(e) { this.bumpDept(e.currentTarget.dataset.dept, 1); },
  bumpDept(dept, delta) {
    this.setData({
      shDepts: this.data.shDepts.map((d) => (d.dept === dept
        ? { ...d, count: Math.max(0, Math.min(20, (Number(d.count) || 0) + delta)) }
        : d)),
    });
  },

  saveSheet() {
    // 名称只认 data.shName（model:value 双向绑定，输入过程中就已经同步）
    const { shName, shStart, shEnd, shDays, shDepts, shEditKey } = this.data;
    const name = String(shName || '').trim();
    const days = shDays.filter((d) => d.on).map((d) => d.i);
    const depts = shDepts.map((d) => ({ dept: d.dept, count: Number(d.count) || 0 }));
    const say = (t) => wx.showModal({ title: '还差一步', content: t, showCancel: false });
    if (!days.length) return say('先勾星期几');
    if (!name) return say('写个时段名称');
    if (name.length > 6) return say('名称最多 6 个字');
    const s = toMin(shStart);
    const e2 = toMin(shEnd);
    if (s === null || e2 === null || e2 <= s) return say('结束时间要晚于开始时间');
    if (!depts.some((d) => d.count > 0)) return say('至少要有一个部门的人数大于 0');

    const card = { key: shEditKey, name, start: shStart, end: shEnd, days, deptLines: depts };
    let rows = (this._templates || []).slice();
    if (shEditKey) rows = rows.filter((r) => `${r.title}|${r.start}|${r.end}` !== shEditKey);
    rows = rows.concat(cardToRows(card));
    this._templates = rows;
    this.closeSheet();
    this.saveDraft(rows, null);
  },

  /** 存草稿（服务端权威校验：时间重叠、部门白名单在这里被拦） */
  saveDraft(templates, okText) {
    // ⚠️ 原来这里直接 return —— 连点两下时第二次被静默吞掉，界面什么都不动，
    //    看着就是「点了没反应」。至少要让陛下知道在存。
    if (this.data.saving) {
      wx.showToast({ title: '正在保存，请稍候', icon: 'none' });
      return Promise.resolve();
    }
    this.setData({ saving: true });
    return adminRequest('/partner/slots/draft', 'PUT', { templates })
      .then(() => this.fetch())
      .then(() => { if (okText) wx.showToast({ title: okText, icon: 'none' }); else wx.showToast({ title: '已保存', icon: 'success' }); })
      .catch((err) => {
        // ⚠️ 失败必须把本地 `_templates` 拉回服务端真值：
        //    删除/编辑是「先改本地、再整份 PUT」，失败后本地已缺行，
        //    不重拉就会在下一次保存时把脏数据一起写上去。
        this.fetch();
        // ⚠️ 保存失败必须让陛下看到**完整原因**（toast 会截断且一闪而过，
        //    看不见就等于「点了没反应」）——code 和原文一起给
        wx.showModal({
          title: `保存失败（${(err && err.code) || '?'}）`,
          content: Number(err && err.code) === 40401
            ? '云函数还没更新到这个版本（缺 PUT /partner/slots/draft），改动没写进去。需要先发布云函数。'
            : ((err && err.message) || '请求失败，请重试'),
          showCancel: false,
        });
      })
      .finally(() => this.setData({ saving: false }));
  },

  /** 发布（原型 note：发布必须填原因，记进发布记录） */
  onPublish() {
    if (this.data.publishing) return;
    wx.showModal({
      title: '发布本周值班时段',
      editable: true,
      placeholderText: '发布原因（记进发布记录，可留空）',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ publishing: true });
        adminRequest('/partner/slots/publish', 'POST', { reason: String(r.content || '').trim() })
          .then(() => this.fetch())
          .then(() => wx.showToast({ title: '已发布', icon: 'success' }))
          .catch((err) => wx.showModal({
            title: `发布失败（${(err && err.code) || '?'}）`,
            content: (err && err.message) || '请求失败，请重试',
            showCancel: false,
          }))
          .finally(() => this.setData({ publishing: false }));
      },
    });
  },

  /**
   * 重置全部时段（危险区）
   * 为什么需要一个「删记录」而不是「发一个空版本」的入口：
   *   publish 明确拒绝空模板，所以一旦有了已发布版本，界面上就没有任何办法把它清回
   *   「从未配置」——只能进云开发控制台删库。初始化 / 清理联调脏数据时天天要用。
   * 两步确认 + 必填原因，口令由前端固定带 RESET（与点歌清空的 confirm:"DELETE" 同一口径）。
   */
  onReset() {
    if (!this.data.canEdit || this.data.resetting) return;
    wx.showModal({
      title: '重置全部值班时段',
      content: '会删掉全部时段版本（含已发布的），站员端立刻看不到任何时段，可排时间也不能再填。此操作不可撤销。',
      confirmText: '继续',
      confirmColor: '#B42318',
      success: (r) => {
        if (!r.confirm) return;
        wx.showModal({
          title: '填写重置原因',
          editable: true,
          placeholderText: '比如：初始化，清掉联调时留下的测试时段',
          success: (r2) => {
            if (!r2.confirm) return;
            const reason = String(r2.content || '').trim();
            if (reason.length < 2) return wx.showToast({ title: '原因至少 2 个字', icon: 'none' });
            this.setData({ resetting: true });
            adminRequest('/partner/slots', 'DELETE', { confirm: 'RESET', reason })
              .then((d) => {
                this.fetch();
                wx.showModal({
                  title: '已重置',
                  content: `删掉 ${(d && d.removed) || 0} 条时段记录，现在可以重新配了。`,
                  showCancel: false,
                });
              })
              .catch((err) => {
                // ⚠️ 40401 = 云函数路由里没有这条路：不是代码问题，是**云函数还没发布到这一版**。
                //    直接说「接口不存在」陛下没法判断下一步，把结论写进弹窗。
                const code = Number(err && err.code);
                wx.showModal({
                  title: `重置失败（${code || '?'}）`,
                  content: code === 40401
                    ? '云函数还没更新到这个版本（缺 DELETE /partner/slots）。要么先发布云函数，要么现在去云开发控制台删 duty_slot_versions 里的记录。'
                    : ((err && err.message) || '请求失败，请重试'),
                  showCancel: false,
                });
              })
              .finally(() => this.setData({ resetting: false }));
          },
        });
      },
    });
  },
});
