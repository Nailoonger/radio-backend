// pages-partner/availability/availability.js
//
// 伙伴端 · 可排时间填报（P1）
//
// 这一页吃三件事：
//   ① 自己填：按天分组的方块，点一下在「能来 / 不能来」之间切换（两态，没有第三态）
//   ② 代录（社干）：顶部选人，替某个成员填，必须写原因
//   ③ 我的值班部门（社干 / 超管）：自己选「播音部 / 主持部 / 编辑部」，单选（2026-10-30）
//      ⚠️ 岗位（播音 / 主持 / 编辑）由后端按部门自动带，界面上不再让人选第二遍
//
// ⚠️ 顶部标题栏只写「值班时间代录」，**不写日期**；当周的月和日放在下面的周切换卡里居中显示
//    （2026-10-30 陛下定：大粗体标题删掉，换成「10/26 — 10/30」+ 左右翻周按钮装进一张卡）。
//
// ⚠️ 周锚点不从手机算。首次加载**不传 week**，由云函数按北京时间返回**下一周**周一
//    （2026-10-31 定：站员这一周填的是下一周），之后翻页才 ±7 天。小程序端自己 `new Date().getDay()` 算周一，
//    在跨时区 / 跨月 / 系统时间被改过的手机上会和后端差一周，而班表错一周是无声的。
//
// ⚠️ 规则「有不能来的时段必须填说明」在前端只是提示，真正的拦截在云函数
//    （见 handlers/partner/availability.js）。绕过前端也写不进空说明。
const { adminRequest } = require('../../utils/request.js');

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];
const MAX_REASON = 200;

/**
 * 岗位（多选）—— 2026-10-30 定稿：界面上**只让人配岗位**，部门由岗位反推落库。
 *
 * ⚠️ 只列播音 / 主持 / 编辑 三项（陛下点名这三个）；库里已有的记者 / 技术
 *    **照原样带回**（见 `_extraOf`），不能因为界面没列出来，保存一次就被悄悄清掉。
 * ⚠️⚠️ 上一版是反过来的（界面上只配部门、岗位由部门推），陛下当天就退回来了 ——
 *    **主维度是岗位**，部门是它的影子。别再翻回去。
 * ⚠️ 但「部门」不能从提示里消失：排班硬条件里它有位置，用户得知道它被自动归到了哪儿。
 */
const DUTY_ROLE_OPTIONS = ['播音', '主持', '编辑'];
/** 岗位 → 部门（与后端 `me.js#DEPT_BY_ROLE` 一致，只用来把「自动归到哪个部门」说清楚） */
const DEPT_BY_ROLE = { 播音: '播音部', 主持: '主持部', 编辑: '编辑部' };
/** 部门白名单 —— 与后端 DEPARTMENTS 一致，用于校验与回显 */
const DEPARTMENTS = ['播音部', '主持部', '编辑部'];

/** '2026-11-02' ± n 天（纯日期运算，走 UTC 避免夏令时/时区干扰） */
function addDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return ymd;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000;
  const d = new Date(t);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** '2026-11-02' → '11/02'（顶部周标签与天头日期共用，全页统一斜杠） */
function shortDate(ymd) {
  const s = String(ymd || '');
  if (s.length < 10) return s;
  return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

/**
 * 岗位数组归一：去空、去重，顺序固定成「播音 → 主持 → 编辑 → 其他」。
 * ⚠️ 顺序必须定死：主部门是取第一个命中项（后端 `deptOfRoles`），顺序飘了部门就会跟着飘。
 */
function normRoles(list) {
  if (!Array.isArray(list)) return [];
  const clean = list.map((r) => String(r).trim()).filter(Boolean);
  const uniq = clean.filter((r, i) => clean.indexOf(r) === i);
  return DUTY_ROLE_OPTIONS.filter((r) => uniq.indexOf(r) >= 0)
    .concat(uniq.filter((r) => DUTY_ROLE_OPTIONS.indexOf(r) < 0));
}

/**
 * 两态 → 展示文案与样式类（对齐 v151 `S.av.picks[k] ? 0 : 1`）
 *
 * ⚠️⚠️ 只有两态：蓝＝能来，灰＝不能来。**没有「待选」**（陛下 2026-10-29 打回：
 *    「按钮不就两种状态吗这有三种，蓝色消失后为啥还要点两下才会再亮」）。
 *    三态循环（能来→不能来→待选）会让用户每点亮一次都得多点一下，是自创出来的东西。
 * ⚠️ 在 JS 里算好，不写 WXML 里的嵌套三元：模板只负责渲染，不负责判断。
 */
function stateOf(can) {
  if (can === 1) return { stateText: '能来', cls: 'on' };
  return { stateText: '不能', cls: 'off' };
}

/** 把云函数返回的扁平 slots 按天分组，并把已选状态贴回每个格子上 */
function groupByDay(slots, weekDates, pickMap) {
  const days = [];
  for (let i = 0; i < 5; i++) {
    const date = (weekDates && weekDates[i]) || '';
    const mine = (slots || []).filter((s) => Number(s.day) === i);

    // ⚠️ 先按「名称 + 起止」聚合成**场次块**，再渲染成方块。
    //    一个时段可能要多个部门（早会＝主持部 1 + 播音部 2），后端是逐行的，
    //    直接一行一个方块会出现两个「早会 06:50-07:30」（陛下 2026-10-29 打回）。
    //    填可排时间的粒度是「这一场你能不能来」，与部门无关。
    const blocks = [];
    const seen = {};
    mine.forEach((s) => {
      const bk = `${s.title}|${s.timeText}`;
      if (seen[bk] === undefined) {
        seen[bk] = blocks.length;
        blocks.push({ bk, title: s.title, timeText: s.timeText, keys: [], depts: [], count: 0 });
      }
      const b = blocks[seen[bk]];
      b.keys.push(s.slotKey);
      if (s.dept && b.depts.indexOf(s.dept) < 0) b.depts.push(s.dept);
      b.count += Number(s.count) || 1;
    });

    const slotList = blocks.map((b) => {
      // 默认「不能来」（灰）：与 v151 一致（picks 空对象 → 全部不亮），点一下才是能来。
      // 组内任意一格有记录就代表整场。
      let can = 0;
      b.keys.forEach((k) => { if (pickMap[k] !== undefined) can = pickMap[k]; });
      return Object.assign({
        // ⚠️⚠️ 聚合键**必须带天**：`名称|起止` 在不同天会重复（每天都有「午间 12:10-12:40」），
        //    拿它当 wx:key → 列表 diff 把 5 天的同名场次当同一个节点复用；
        //    拿它当批量 chips 的匹配依据 → 点周一那场，周二到周五那 4 场一起亮（陛下 2026-10-29 打回）。
        slotKey: `${i}|${b.bk}`, // 聚合块的唯一键（天 + 名称|起止）
        keys: b.keys,         // 真实的 slotKey 列表，点击 / 提交时逐个写
        title: b.title,
        timeText: b.timeText,
        dept: b.depts.join('/'),
        count: b.count,
        can,
      }, stateOf(can));
    });

    // 当天「能来几个 / 一共几个」—— v151 的 .avdh 右侧计数
    const onCount = slotList.filter((s) => s.can === 1).length;
    if (slotList.length) {
      days.push({ day: i, name: DAY_NAMES[i], date, dateText: shortDate(date), slots: slotList, onCount });
    }
  }
  return days;
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    ready: false,          // 这一周的时段是否已发布
    weekStart: '',
    weekText: '',          // 「10/26 – 10/30」（不含「本周」二字，胶囊单独说）
    isThisWeek: true,      // 看的是不是日历上的本周（只用于文案，不决定默认周）
    isTargetWeek: true,    // 看的是不是「这一周要填的那一周」＝下一周 ⇒ 红胶囊、右箭头置灰
    weekTag: '下一周',     // 胶囊文案：下一周 / 本周 / 往期 / 后续周
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
    allOn: false,          // 全部方块都是「能来」→ 全选按钮显示「取消全选」
    submitting: false,
    dirty: false,
    slotVersion: 0,
    stale: false,
    // ── v151 对齐：角色视图 ──
    isMember: false,       // 站员：就地填报
    isSuper: false,        // 超管：多批量代录
    cards: [],             // 人员卡片（社干/超管）
    // ── 单人代录弹层 ──
    sheetOpen: false,
    avTitle: '',
    confirmed: false,
    reasonTip: '选填',
    reasonPh: '',
    // ── 批量代录弹层（仅超管） ──
    bulkOpen: false,
    bulkPeople: [],
    bulkEvents: [],
    bulkPickCount: 0,
    bulkEventCount: 0,
    bulkReason: '',
    bulkSaving: false,
    // ── 批量配岗位弹层（仅超管，2026-10-30） ──
    bulkRoleOpen: false,
    bulkRolePeople: [],
    bulkRoleChips: [],
    bulkRolePickCount: 0,
    bulkRoleText: '',      // 预览：选中的岗位串
    bulkRoleDept: '',      // 预览：会归到哪个部门
    bulkRoleSaving: false,
    // ── 我的值班岗位（社干 / 超管自助，多选；部门由岗位自动归） ──
    roleChips: [],         // [{ label: '播音', on: false }, ...] 只列三个主岗位
    roleText: '未选',      // 徽章文案（含库里额外的记者 / 技术）
    roleHint: '',          // 底部提示
    roleDirty: false,
    roleSaving: false,
    // ── 超管替别人配岗位（2026-10-30） ──
    roleSheetOpen: false,
    roleTargetId: 0,
    roleTargetName: '',
    roleTargetChips: [],   // 三格岗位（多选）
    roleTargetRoles: [],   // 当前勾选的完整岗位串（含界面没列出的记者 / 技术）
    roleTargetSaving: false,
  },

  /** 内部状态：slotKey → 0/1，不直接放 setData 以外的地方 */
  _pickMap: {},
  /** 当前查看/代录的对象（0 = 自己） */
  _targetId: 0,
  /** 从排班工作台深链进来时带的「本周」，只为兼容旧链接；界面胶囊现在由云函数的两个锚点算 */
  _baseWeek: '',
  /** 最近一次请求带的 week（空 = 下一周，由云函数兜底） */
  _fetchWeek: '',
  /** 自己的岗位（/partner/me 带回，完整串：含记者 / 技术）。空 → 排班永远过不了「岗位」这条门槛 */
  _myRoles: [],
  /** /partner/me 是否真的拉到了。没拉到不许保存，否则会把别人的岗位写成空 */
  _meLoaded: false,

  onLoad(options) {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const role = Number(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      isMember: role === 2,
      isSuper: role === 0,
    });
    // 站员没有「我的值班角色」这一块，不用多打一次接口
    if (role !== 2) this.loadMe();

    /**
     * 从排班工作台翻到某一周再点「值班时间代录」进来的情况（2026-10-30）。
     * 不带 week 的话，这页会打开默认周（现在是下一周）—— 在工作台翻到别的周代录时，
     * 两边必须是同一周，否则回工作台点「再次生成」一点变化都没有。
     *   week = 要看哪一周（代录/补填指定周时才有）
     */
    const o = options || {};
    this._fetchWeek = String(o.week || '');
    if (o.base) this._baseWeek = String(o.base);
    this.fetch(this._fetchWeek ? { week: this._fetchWeek } : {});
  },

  /** 返回上一级（之前这页没有返回键，只能靠手势，陛下 2026-10-29 指出） */
  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages-partner/desk/desk' });
  },

  onPullDownRefresh() {
    const jobs = [this.fetch({ week: this.data.weekStart || undefined })];
    // 角色卡也要跟着刷新，否则「拉不到就算了」会一直卡在拉不到的状态
    if (!this.data.isMember) jobs.push(this.loadMe());
    Promise.all(jobs)
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

        // ── v151 人员卡片：用 summary.rows（它带 confirmed / canCount），
        //    data.people 是原始名单，没有提交状态，拿不到徽章。
        const meIdNow = this._myId(data);
        const totalSlots = days.reduce((n, d) => n + d.slots.length, 0);
        const cards = ((data.summary && data.summary.rows) || []).map((r) => {
          const submitted = !!r.confirmed;
          const n = Number(r.canCount) || 0;
          return {
            personId: r.personId,
            name: r.name || '伙伴',
            dept: r.department || '',
            // ⚠️ 弹层要回填「这个人现在配了哪些岗位」，所以整串都带上，别只取 [0]
            roles: Array.isArray(r.dutyRoles) ? r.dutyRoles : [],
            cap: [r.department, ((r.dutyRoles || [])[0] || '')].filter(Boolean).join(' · '),
            initial: String(r.name || '伙').slice(0, 1),
            isMe: Number(r.personId) === meIdNow,
            confirmed: submitted,
            desc: submitted
              ? `可排 ${n} / ${totalSlots} 个时段。`
              : '这一周的可排时间尚未提交；可以当面核实后替他填。',
            statText: `可排 ${n} / ${totalSlots} 个时段`,
          };
        });

        const isProxyNow = !!targetId && targetId !== meIdNow;
        const cannotNow = days.reduce((n, d) => n + d.slots.filter((s) => s.can === 0).length, 0);

        // ⚠️⚠️ 说明**不回填**：说明是「这次填报的理由」，不是持久属性。
        //    之前把上次存的 reason 灌进输入框，人一打开就看到一段自己没写过的话
        //    （陛下 2026-10-29：「我从来没填过这个原因为什么每次点开都有自带的」）。
        //    旧原因仍留在库里，只是不再出现在界面上。

        // ── 顶部周标签：下一周 / 本周 / 往期 + 月日 ──
        // ⚠️⚠️ 2026-10-31 口径变了：站员这一周填的是**下一周**（陛下原话「当然是本周填下一周的啊」），
        //    所以默认落在下一周，红色胶囊点亮的也是「下一周」。
        //    两个锚点都由云函数给（thisWeekStart / nextWeekStart），前端**不自己算周一**：
        //    跨时区、跨月、系统时间被改过的手机上算错一周，界面上看不出来（班表错一周是无声的）。
        const ws = data.weekStart || '';
        const thisWs = data.thisWeekStart || '';
        const nextWs = data.nextWeekStart || '';
        // 云函数还是老版本（不回这两个字段）时，按「默认就是下一周」理解，
        // 免得把默认页标成「往期」——那会让人以为打开错了页面。
        const isThis = !!(thisWs && ws === thisWs);
        const isNext = nextWs ? ws === nextWs : !thisWs;
        /**
         * ⚠️ 先判「本周」再判「下一周」：**周日 0 点起两者是同一周**（后端口径）。
         *    那天整站都把它叫「本周」（考勤 / 班表 / 大白卡），这里再写「下一周」就成了孤例。
         */
        let weekTag;
        if (isThis) weekTag = '本周';
        else if (isNext) weekTag = '下一周';
        else if (thisWs && ws < thisWs) weekTag = '往期';
        else weekTag = '后续周';
        this._fetchWeek = o.week || '';

        this.setData({
          loading: false,
          ready: !!data.ready,
          weekStart: ws,
          weekText: this.labelOf(ws, data.weekDates),
          isThisWeek: !!(thisWs && ws === thisWs),
          isTargetWeek: isNext,
          weekTag,
          days,
          cards,
          people,
          personNames: people.map((p) => p.name + (p.department ? ' · ' + p.department : '')),
          personIndex: personIndex < 0 ? 0 : personIndex,
          targetId,
          targetName,
          isProxy: isProxyNow,
          reason: '',
          reasonLen: 0,
          reasonTip: isProxyNow ? '必填 · 写明代录原因' : (cannotNow > 0 ? '必填 · 有不能来的时段' : '选填'),
          reasonPh: isProxyNow ? '例：他手机坏了，托我代填' : '例：周三下午有课来不了',
          // 已经填过的人再进来，确认框默认勾上，省一次点击
          confirmed: !!((shown && shown.picks) || []).length,
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
    // 例：10/26 – 10/30（「本周 / 非本周」是模板里另一个红/灰胶囊，不拼进这行）
    return `${a} – ${b}`;
  },

  /* ══════════ 我的值班岗位（社干 / 超管自助） ══════════
     走现成的 PUT /partner/me/duty（handlers/partner/me.js#saveDuty）。
     ⚠️⚠️ 2026-10-30 定稿：**只配岗位、可多选**，部门由后端按岗位反推落库。
        和人员卡片上的「配岗位」弹层同一套口径 —— 两个地方各选一遍必然对不上（当天被坑过）。*/

  /** 拉自己的岗位 */
  loadMe() {
    return adminRequest('/partner/me', 'GET')
      .then((d) => {
        this._myRoles = normRoles(d && d.dutyRoles);
        this._meLoaded = true;
        this.setData(Object.assign({ roleChips: this._roleChips(this._myRoles), roleDirty: false },
          this._roleStat(this._myRoles, false)));
      })
      .catch(() => {
        // 拉不到就空着渲染，但 _meLoaded 保持 false → 不许保存（见 onSaveRoles）
        this._meLoaded = false;
        this.setData({
          roleChips: this._roleChips([]), roleDirty: false,
          roleText: '未选',
          roleHint: '岗位没拉到，下拉刷新再试。',
        });
      });
  },

  /** 界面上的三格：只列播音 / 主持 / 编辑，选中的亮蓝 */
  _roleChips(roles) {
    return DUTY_ROLE_OPTIONS.map((r) => ({ label: r, on: roles.indexOf(r) >= 0 }));
  },

  /** 徽章文案 + 底部提示（模板只渲染，不判断） */
  _roleStat(roles, dirty) {
    const list = Array.isArray(roles) ? roles : [];
    const picked = DUTY_ROLE_OPTIONS.filter((r) => list.indexOf(r) >= 0);
    // 库里可能有界面没列出来的额外岗位（记者 / 技术）—— 保存时原样带回，提示里也要认
    const extra = list.filter((r) => DUTY_ROLE_OPTIONS.indexOf(r) < 0);
    const depts = picked.map((r) => DEPT_BY_ROLE[r]).filter(Boolean);

    let hint;
    if (dirty) hint = '改动还没保存。';
    else if (picked.length) {
      hint = `部门会按岗位自动归到「${depts[0]}」。`;
      if (extra.length) hint += `另保留 ${extra.join(' / ')}。`;
    } else if (extra.length) {
      hint = `当前只有 ${extra.join(' / ')}；这三格至少选一个才能被排进播音 / 主持 / 编辑的时段。`;
    } else hint = '还没配岗位，排班时不会把你排上岗。';

    const all = picked.concat(extra);
    return { roleText: all.length ? all.join(' / ') : '未选', roleHint: hint };
  },

  /** 岗位多选：点一下切换 */
  onToggleMyRole(e) {
    const label = String((e.currentTarget.dataset || {}).l || '');
    if (DUTY_ROLE_OPTIONS.indexOf(label) < 0) return;
    const list = (this._myRoles || []).slice();
    const i = list.indexOf(label);
    if (i >= 0) list.splice(i, 1); else list.push(label);
    // 顺序跟着界面走，别让「已选」串里顺序乱跳（播音→主持→编辑）
    this._myRoles = DUTY_ROLE_OPTIONS.filter((r) => list.indexOf(r) >= 0)
      .concat(list.filter((r) => DUTY_ROLE_OPTIONS.indexOf(r) < 0));
    this.setData(Object.assign({ roleChips: this._roleChips(this._myRoles), roleDirty: true },
      this._roleStat(this._myRoles, true)));
  },

  onSaveRoles() {
    if (this.data.roleSaving) return;
    // ⚠️ 没拉到就保存 = 把已有的岗位写成空。宁可让他刷新，也不许静默清库
    if (!this._meLoaded) {
      return wx.showToast({ title: '岗位还没加载出来，下拉刷新再试', icon: 'none' });
    }
    if (!this.data.roleDirty) return;   // 没改就不发请求

    const roles = (this._myRoles || []).slice();
    const doSave = () => {
      this.setData({ roleSaving: true });
      // 只发岗位，部门由后端反推 —— 前端再算一遍必然和后端两套口径
      adminRequest('/partner/me/duty', 'PUT', { dutyRoles: roles })
        .then((d) => {
          // 后端回的是落库后的真值（部门也是它推的），以它为准回填
          this._myRoles = normRoles(d && d.dutyRoles);
          this.setData(Object.assign({
            roleSaving: false, roleDirty: false,
            roleChips: this._roleChips(this._myRoles),
          }, this._roleStat(this._myRoles, false)));
          wx.showToast({ title: '值班岗位已保存', icon: 'success' });
          // 人员卡片的副标题是「部门 · 第一个岗位」，改了岗位要跟着变
          this.fetch({ week: this.data.weekStart, personId: this.data.targetId || undefined });
        })
        .catch((err) => {
          this.setData({ roleSaving: false });
          wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
        });
    };

    // 全部取消 = 这个人从此排不上岗，手滑一下就会点成「一个都不亮」，先确认
    if (!roles.length) {
      wx.showModal({
        title: '一个岗位都不选',
        content: '没岗位的人在排班时会被判定为「尚未配置值班岗位」，换人弹层里选不上他。确定要清空吗？',
        cancelText: '返回去选', confirmText: '确定清空', confirmColor: '#B42318',
        success: (r) => { if (r.confirm) doSave(); },
      });
      return;
    }
    doSave();
  },

  /** 重算已选 / 能来 / 不能来 */
  recount() {
    let picked = 0;
    let can = 0;
    let cannot = 0;
    let total = 0;
    this.data.days.forEach((d) => {
      d.slots.forEach((s) => {
        total += 1;
        if (s.can === 1) { picked++; can++; }
        else if (s.can === 0) { picked++; cannot++; }
      });
    });
    this.setData({
      pickedCount: picked, canCount: can, cannotCount: cannot,
      allOn: total > 0 && can === total,
    });
  },

  /**
   * 全选 / 取消全选（v151 avSheet 顶部那个「全选 ›」）
   * 全选 = 全部能来；再点 = 全部不能来（没有「待选」这一层）。
   */
  onToggleAll() {
    const target = this.data.allOn ? 0 : 1;
    const st = stateOf(target);
    const days = (this.data.days || []).map((d) => {
      const slots = d.slots.map((s) => {
        (s.keys || [s.slotKey]).forEach((k) => { this._pickMap[k] = target; });
        return Object.assign({}, s, st, { can: target });
      });
      return Object.assign({}, d, { slots, onCount: target === 1 ? slots.length : 0 });
    });
    this.setData({ days, dirty: true });
    this.recount();
  },

  /** 点方块：能来 ⇄ 不能来（两态，点一下即变） */
  onTapSlot(e) {
    // ⚠️⚠️ 用**数字索引**定位（data-di / data-si），不要靠字符串 key 传定位信息：
    //    聚合键 `名称|起止` 跨天会重复，字符串一撞车就是「点一个亮一片」（批量 chips 踩过）。
    //    索引不会撞，参数没取到时下面还会留 console.warn 便于定罪。
    const di = Number(e.currentTarget.dataset.di);
    const sj = Number(e.currentTarget.dataset.si);
    const days = this.data.days;
    if (!days[di] || !days[di].slots[sj]) {
      // 参数没取到时留个可查的痕迹（不会弹给用户），下次再"点不动"能直接从 Console 定罪
      console.warn('[availability] onTapSlot 定位失败', e.currentTarget.dataset, 'days=' + (days || []).length);
      return;
    }
    const slot = days[di].slots[sj];

    // 两态互切（v151：picks[k] ? 0 : 1）—— 点一下即变，不需要第三下
    const next = slot.can === 1 ? 0 : 1;
    // 一个方块可能对应多个 slotKey（早会＝主持部 + 播音部两行），整块一起写
    (slot.keys || [slot.slotKey]).forEach((k) => { this._pickMap[k] = next; });

    // ⚠️ 整体替换 days，不用 `days[0].slots[0].cls` 深层路径 setData
    const st = stateOf(next);
    const nextDay = Object.assign({}, days[di], {
      slots: days[di].slots.map((x, i) => (i === sj ? Object.assign({}, x, st, { can: next }) : x)),
    });
    nextDay.onCount = nextDay.slots.filter((x) => x.can === 1).length;

    const nextDays = days.slice();
    nextDays[di] = nextDay;
    this.setData({ days: nextDays, dirty: true });
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
    return this._doSubmit();
  },

  /** 真正的提交 —— 站员的「提交」和代录弹层的「保存」共用这一份 */
  _doSubmit(after) {
    if (this.data.submitting) return;
    if (!this.data.ready) {
      return wx.showToast({ title: '这一周的值班时段尚未发布', icon: 'none' });
    }

    const picks = [];
    this.data.days.forEach((d) => {
      d.slots.forEach((s) => {
        if (s.can !== 1 && s.can !== 0) return;
        // 聚合块要展开成真实的 slotKey 逐个提交（后端按行存）
        (s.keys || [s.slotKey]).forEach((k) => picks.push({ slotKey: k, can: s.can === 1 }));
      });
    });

    if (!picks.length) {
      return wx.showToast({ title: '还没有选择任何时段', icon: 'none' });
    }

    // 说明只认**这次输入框里写的东西**：不预填、也不偷偷沿用上次存的那句。
    // 沿用会让「界面上明明是空的」和「库里还留着旧原因」对不上（陛下 2026-10-29 打回）。
    const reason = String(this.data.reason || '').trim();
    const hasCannot = picks.some((p) => !p.can);
    if (!this.data.isProxy && hasCannot && reason.length < 2) {
      return wx.showToast({ title: '有不能来的时段，请填写说明', icon: 'none' });
    }
    if (this.data.isProxy && reason.length < 2) {
      return wx.showToast({ title: '代录必须填写原因', icon: 'none' });
    }
    // v151 的确认勾选框：不勾不许交
    if (!this.data.confirmed) {
      return wx.showToast({ title: '请先勾选「我确认已完整填写」', icon: 'none' });
    }

    this.setData({ submitting: true });

    const body = { week: this.data.weekStart, picks, reason };
    if (this.data.isProxy) body.personId = this.data.targetId;

    adminRequest('/partner/availability', 'PUT', body)
      .then(() => {
        this.setData({ submitting: false, dirty: false });
        wx.showToast({ title: this.data.isProxy ? '已代录' : '已提交', icon: 'success' });
        if (after) after();
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
        // 只有代录态才带 personId（本人时 targetId=0，后端按「0=自己」理解）
        if (this.data.isProxy) body.personId = this.data.targetId;
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

  /* ══════════ 超管替别人配值班岗位（2026-10-30） ══════════
     入口：人员卡片底部的「配岗位」。走 PUT /partner/people/:id/duty，仅超管可调。
     ⚠️⚠️ 2026-10-30 定稿：**只配岗位、可多选**，部门由后端按岗位反推落库。
        陛下原话：「改成配岗位，而且可以多选」。
        上一版是「只配部门」，被退回了 —— 别再加回第二行让人选部门。 */

  openRoleSheet(e) {
    if (!this.data.isSuper) return;
    const id = Number((e.currentTarget.dataset || {}).id || 0);
    const card = (this.data.cards || []).find((c) => Number(c.personId) === id);
    if (!card) return;
    // 回填这个人现有的岗位（含记者 / 技术这种界面没列出来的，保存时原样带回）
    const roles = normRoles(card.roles);
    this.setData({
      roleSheetOpen: true,
      roleTargetId: id,
      roleTargetName: card.name || '该成员',
      roleTargetRoles: roles,
      roleTargetChips: DUTY_ROLE_OPTIONS.map((r) => ({ label: r, on: roles.indexOf(r) >= 0 })),
      roleTargetSaving: false,
    });
  },

  closeRoleSheet() {
    if (this.data.roleTargetSaving) return;
    this.setData({ roleSheetOpen: false });
  },

  /** 岗位多选：点一下切换 */
  onToggleTargetRole(e) {
    const label = String((e.currentTarget.dataset || {}).l || '');
    if (DUTY_ROLE_OPTIONS.indexOf(label) < 0) return;
    const list = (this.data.roleTargetRoles || []).slice();
    const i = list.indexOf(label);
    if (i >= 0) list.splice(i, 1); else list.push(label);
    const roles = normRoles(list);
    this.setData({
      roleTargetRoles: roles,
      roleTargetChips: DUTY_ROLE_OPTIONS.map((r) => ({ label: r, on: roles.indexOf(r) >= 0 })),
    });
  },

  saveTargetRoles() {
    if (this.data.roleTargetSaving) return;
    const id = Number(this.data.roleTargetId || 0);
    if (!id) return;
    const roles = normRoles(this.data.roleTargetRoles);

    // 全部取消 = 让这个人选不上人，手滑一下就会点成「一个都不亮」，先确认一次
    if (!roles.length) {
      wx.showModal({
        title: '一个岗位都不选',
        content: '没岗位的人在排班时会被判定为「尚未配置值班岗位」，换人弹层里选不上他。确定要清空吗？',
        cancelText: '返回去选', confirmText: '确定清空', confirmColor: '#B42318',
        success: (r) => { if (r.confirm) this._doSaveTargetRoles(id, roles); },
      });
      return;
    }
    this._doSaveTargetRoles(id, roles);
  },

  /** 只发岗位 —— 部门由后端反推（前端再算一遍就是两套口径，迟早对不上） */
  _doSaveTargetRoles(id, roles) {
    this.setData({ roleTargetSaving: true });
    adminRequest(`/partner/people/${id}/duty`, 'PUT', { dutyRoles: roles })
      .then((d) => {
        this.setData({ roleTargetSaving: false, roleSheetOpen: false });
        const dept = (d && d.department) || '';
        wx.showToast({ title: dept ? `已更新 · 归入${dept}` : '值班岗位已更新', icon: 'none' });
        // 卡片副标题（部门 · 首个岗位）和排班资格都依赖它
        this.fetch({ week: this.data.weekStart, personId: this.data.targetId || undefined });
      })
      .catch((err) => {
        this.setData({ roleTargetSaving: false });
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /* ══════════ 单人代录弹层（v151 avSheet） ══════════ */

  /**
   * 点人员卡片 → 拉那个人的可排时间 → 开弹层。
   * 不另开数据通道：fetch 换 targetId 后 days 就是目标的，弹层和站员页共用同一份模板。
   */
  openAv(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const meId = this._myId();
    const card = (this.data.cards || []).find((c) => Number(c.personId) === id) || {};
    this.setData({ avTitle: `${card.name || '该成员'} · 下一周可排时间` });
    return this.fetch({ week: this.data.weekStart, personId: id === meId ? 0 : id })
      .then(() => this.setData({ sheetOpen: true, confirmed: false }));
  },

  closeAv() {
    if (this.data.submitting) return;
    this.setData({ sheetOpen: false });
  },

  stop() {},

  onToggleConfirm() {
    this.setData({ confirmed: !this.data.confirmed });
  },

  saveAv() {
    return this._doSubmit(() => this.setData({ sheetOpen: false }));
  },

  /* ══════════ 批量代录（v151 bulkSheet，仅超管） ══════════ */

  openBulk() {
    if (!this.data.isSuper) return;
    if (!this.data.ready) return wx.showToast({ title: '这一周的值班时段还没发布', icon: 'none' });
    const people = (this.data.cards || []).map((c) => ({
      personId: c.personId, name: c.name, on: true,
    }));
    const events = [];
    // ⚠️⚠️ 场次 chips 用**数字索引**定位（di/si），不拿 slotKey 字符串当匹配依据：
    //    字符串一旦撞车就"点一个亮一片"；索引撞不了，而且和 onTapSlot 定位方式一致。
    this.data.days.forEach((d, di) => d.slots.forEach((s, si) => {
      events.push({
        id: `e${di}_${si}`, di, si,
        label: `${d.name} ${s.timeText}`, on: false,
      });
    }));
    if (!events.length) return wx.showToast({ title: '这一周没有可选时段', icon: 'none' });
    this.setData({
      bulkOpen: true, bulkPeople: people, bulkEvents: events,
      bulkPickCount: people.length, bulkEventCount: 0, bulkReason: '',
    });
  },

  closeBulk() {
    if (this.data.bulkSaving) return;
    this.setData({ bulkOpen: false });
  },

  toggleBulkPerson(e) {
    const id = Number(e.currentTarget.dataset.id);
    const list = this.data.bulkPeople.map((p) => (Number(p.personId) === id ? Object.assign({}, p, { on: !p.on }) : p));
    this.setData({ bulkPeople: list, bulkPickCount: list.filter((p) => p.on).length });
  },

  bulkAll() {
    const allOn = (this.data.bulkPeople || []).every((p) => p.on);
    const list = (this.data.bulkPeople || []).map((p) => Object.assign({}, p, { on: !allOn }));
    this.setData({ bulkPeople: list, bulkPickCount: allOn ? 0 : list.length });
  },

  toggleBulkEvent(e) {
    const di = Number(e.currentTarget.dataset.di);
    const si = Number(e.currentTarget.dataset.si);
    const list = (this.data.bulkEvents || []).map((v) => (
      (v.di === di && v.si === si) ? Object.assign({}, v, { on: !v.on }) : v
    ));
    this.setData({ bulkEvents: list, bulkEventCount: list.filter((v) => v.on).length });
  },

  /**
   * 批量保存：对每个选中的人各发一次 PUT。
   * 口径与单人一致 —— 每个时段都要表态（选中的能来，其余不能来），不能只交「能来」那几条。
   * ⚠️ 串行发，不并发：同一个 week 的写会撞 revision。
   */
  saveBulk() {
    if (this.data.bulkSaving) return;
    const reason = String(this.data.bulkReason || '').trim();
    if (reason.length < 2) return wx.showToast({ title: '请填写代录说明', icon: 'none' });
    const persons = (this.data.bulkPeople || []).filter((p) => p.on);
    if (!persons.length) return wx.showToast({ title: '至少选一个人', icon: 'none' });
    const picked = (this.data.bulkEvents || []).filter((v) => v.on);
    if (!picked.length) return wx.showToast({ title: '至少选一个场次', icon: 'none' });

    // 选中集合按「天-格」记，避免不同天同名场次被一起算进来
    const onSet = {};
    picked.forEach((v) => { onSet[`${v.di}-${v.si}`] = true; });

    const picks = [];
    this.data.days.forEach((d, di) => d.slots.forEach((s, si) => {
      const on = !!onSet[`${di}-${si}`];
      (s.keys || [s.slotKey]).forEach((k) => picks.push({ slotKey: k, can: on }));
    }));

    this.setData({ bulkSaving: true });
    const week = this.data.weekStart;
    let done = 0;
    const next = (idx) => {
      if (idx >= persons.length) {
        this.setData({ bulkSaving: false, bulkOpen: false });
        wx.showToast({ title: `已代录 ${done} 人`, icon: 'success' });
        this.fetch({ week });
        return;
      }
      adminRequest('/partner/availability', 'PUT', {
        week, personId: persons[idx].personId, picks, reason,
      })
        .then(() => { done += 1; next(idx + 1); })
        .catch((err) => {
          this.setData({ bulkSaving: false });
          wx.showModal({
            title: '批量代录中断',
            content: `已成功 ${done} 人，第 ${idx + 1} 人失败：${(err && err.message) || '请求失败'}`,
            showCancel: false,
          });
        });
    };
    next(0);
  },

  /* ══════════ 批量配岗位（仅超管，2026-10-30） ══════════
     「再次生成班表只排上我自己」有一半原因在这里：配岗位是**逐人**的，
     漏配一个就等于这个人没资格、生成时直接被跳过。这里一次给多人设同一组岗位（覆盖语义），
     部门照旧由后端按岗位反推 —— 不多开第二个维度。 */

  openBulkRoles() {
    if (!this.data.isSuper) return;
    const people = (this.data.cards || []).map((c) => ({
      personId: c.personId,
      name: c.name || '伙伴',
      cap: c.cap || '尚未配置岗位',
      on: false,
    }));
    if (!people.length) return wx.showToast({ title: '人员名单还没加载出来', icon: 'none' });
    this.setData({
      bulkRoleOpen: true,
      bulkRolePeople: people,
      bulkRoleChips: this._roleChips([]),
      bulkRolePickCount: 0,
      bulkRoleText: '',
      bulkRoleDept: '',
      bulkRoleSaving: false,
    });
  },

  closeBulkRoles() {
    if (this.data.bulkRoleSaving) return;
    this.setData({ bulkRoleOpen: false });
  },

  toggleBulkRolePerson(e) {
    const id = Number((e.currentTarget.dataset || {}).id || 0);
    if (!id) return;
    const people = (this.data.bulkRolePeople || [])
      .map((p) => (p.personId === id ? Object.assign({}, p, { on: !p.on }) : p));
    this.setData({ bulkRolePeople: people, bulkRolePickCount: people.filter((p) => p.on).length });
  },

  /** 全选 / 全不选（一次点全选，再点取消） */
  bulkRoleAll() {
    const list = this.data.bulkRolePeople || [];
    const all = (this.data.bulkRolePickCount || 0) < list.length;
    const people = list.map((p) => Object.assign({}, p, { on: all }));
    this.setData({ bulkRolePeople: people, bulkRolePickCount: all ? people.length : 0 });
  },

  toggleBulkRole(e) {
    const label = String((e.currentTarget.dataset || {}).l || '');
    if (DUTY_ROLE_OPTIONS.indexOf(label) < 0) return;
    const picked = (this.data.bulkRoleChips || []).filter((c) => c.on).map((c) => c.label);
    const i = picked.indexOf(label);
    if (i >= 0) picked.splice(i, 1); else picked.push(label);
    const roles = normRoles(picked);
    // 预览：「播音 / 主持 · 播音部」—— 让人保存前就看到会被改成什么样
    this.setData({
      bulkRoleChips: this._roleChips(roles),
      bulkRoleText: roles.join(' / '),
      bulkRoleDept: DEPT_BY_ROLE[roles[0]] || '',
    });
  },

  saveBulkRoles() {
    if (this.data.bulkRoleSaving) return;
    const ids = (this.data.bulkRolePeople || []).filter((p) => p.on).map((p) => p.personId);
    const roles = (this.data.bulkRoleChips || []).filter((c) => c.on).map((c) => c.label);
    if (!ids.length) return wx.showToast({ title: '先勾要配的人', icon: 'none' });
    if (!roles.length) return wx.showToast({ title: '先勾要配的岗位', icon: 'none' });

    // ⚠️ 是**覆盖**不是追加，说清楚再动手（有人身上可能还有「记者」这种额外岗位）
    wx.showModal({
      title: `给 ${ids.length} 人配岗位`,
      content: `他们的岗位统一改成「${roles.join(' / ')}」，原有岗位（含记者 / 技术）会被覆盖。确定吗？`,
      confirmText: '确定覆盖',
      success: (r) => { if (r.confirm) this._doBulkRoles(ids, normRoles(roles)); },
    });
  },

  /** 逐人串行（就几个人，串行比并发稳，出错也能准确说第几个失败） */
  _doBulkRoles(ids, roles) {
    this.setData({ bulkRoleSaving: true });
    let done = 0;
    const step = (i) => {
      if (i >= ids.length) {
        this.setData({ bulkRoleSaving: false, bulkRoleOpen: false });
        wx.showToast({ title: `已配好 ${done} 人`, icon: 'success' });
        this.fetch({ week: this.data.weekStart, personId: this.data.targetId || undefined });
        return;
      }
      adminRequest(`/partner/people/${ids[i]}/duty`, 'PUT', { dutyRoles: roles })
        .then(() => { done += 1; step(i + 1); })
        .catch((err) => {
          this.setData({ bulkRoleSaving: false });
          wx.showModal({
            title: '批量配岗位中断',
            content: `已成功 ${done} 人，第 ${i + 1} 人失败：${(err && err.message) || '请求失败'}`,
            showCancel: false,
          });
        });
    };
    step(0);
  },
});
