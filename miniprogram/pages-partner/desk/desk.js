// pages-partner/desk/desk.js · v5（2026-10-28）
//
// 工作台：站员 home / 社干·超管 desk 一页多态，对齐 v151 原型。
// 视觉参数 = partner-hub/app.html 的 headless Chrome 实测值（见 desk.wxss 头注释），不许自己起。
//
// 数据口径：
//   · 待审数 = /admin/submit/list?reviewStatus=0 的 total（全部待处理量，非"今日新增"）
//   · 留言数 = /admin/message/list?status=0 的 total
//   · 没有接口的卡（内部稿件 / 请假审批 / 考勤录入 / 账号 / 规则 / 考勤总览）
//     n=null ⇒ 左下不渲染数字（v151 对 null 的处理：'<span></span>'）——**不编假数字**。
//     ⚠️ 2026-10-31 更正：这几张卡其实都有接口（见 fetchModules 的注释），
//        当时写「没有接口」是错的；现在只有真的取不到才留 null。
//   · 大白卡轮播只放"有真数据"的卡：
//     第 1 张「正式值班安排」= /partner/schedule 四态；
//     第 2 张「本周点歌排期」= /admin/submit/list?type=1&reviewStatus=1 的
//     scheduleStatus(1 已排 / 2 候补) —— 与 song-schedule 页同一个接口同一套口径。
//     ⚠️ 2026-10-30 曾在这里写「点歌排期接口还没落地」，是错的：接口早就有，页面也在用。
//   · 第 1 张「正式值班安排」的内容**跟着本周班表四态走**（published/draft/withdrawn/empty），
//     数据源 = /partner/schedule（+ 站员的 /partner/schedule/mine 取自己几场）——
//     2026-10-30 之前这里是写死的一句「班表还没有发布。」，发布完回首页也不会变。
//   · swiper 高度由 measureSlide() 渲染后实测回填（swiper 不支持 height:auto，v3 教训）。
//   · 底部角标与页面数字同源（v151 TODO 唯一事实源口径）：审核 tab = 投稿 + 留言。
//
// ⚠️ 2026-10-28 陛下拍板：区块严格照 v151 —— 社干/超管就是"听众投稿 / 站内协作"两块
//    （超管前面多一块「管理」）。「排班协作」（可排时间 / 值班时段）已删除：
//    原型把这两项挂在「班表」tab，班表页落地后在那里给入口；ROUTES 里的
//    availability / slots 保留着复用，不是死代码。
//
// ⚠️ 站员通道：/partner/me 只认 admin_token，站员（user 表）目前没有进伙伴端的登录通道。
//    member 态的 UI 按 v151 全量写好，等站员通道定了自动生效；在那之前页面只会以 manager/super 出现。

const { adminRequest } = require('../../utils/request.js');

/* v151 greetWord()：逐时段问候，原样搬 */
function greetWord() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 14) return '中午好';
  if (h >= 14 && h < 18) return '下午好';
  if (h >= 18 && h < 23) return '晚上好';
  return '夜深了';
}

/* v151 careLine()：欢迎带副句，原样搬 */
function careLine() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return '新的一天，慢慢开始就好。';
  if (h >= 11 && h < 14) return '忙碌了一上午，记得好好吃顿饭。';
  if (h >= 14 && h < 18) return '泡杯热的，剩下的慢慢来。';
  if (h >= 18 && h < 23) return '工作辛苦了，剩下的明天再忙。';
  return '记得早点休息 —— 事都在，跑不了。';
}

/* 已落地的页面路由；表外的 id = 还没落地，点了 toast */
const ROUTES = {
  review: '/pages-partner/review/review',
  // v151：留言并入统一审核台 ⇒ 带 type=message 直达留言档（message 页只留作旧链接兜底）
  message: '/pages-partner/review/review?type=message',
  availability: '/pages-partner/availability/availability',
  // 稿件是 tab 页（底部「稿件」），点工作台卡片也应该切 tab 而不是压栈
  work: '/pages-partner/work/work',
  slots: '/pages-partner/schedule/slots/slots',
  schedule: '/pages-partner/schedule/index/index',
  attendance: '/pages-partner/attendance/attendance',
  'att-overview': '/pages-partner/attendance/attendance',
  'leave-approve': '/pages-partner/leave/leave',
  leave: '/pages-partner/leave/leave',
  roster: '/pages-partner/roster/roster',
  rules: '/pages-partner/rules/rules',
  'my-att': '/pages-partner/attendance/attendance',
  feedback: '/pages-partner/feedback/feedback',
  notices: '/pages/notices/notices',
  accounts: '/pages-partner/accounts/accounts',
  'song-schedule': '/pages-partner/song-schedule/song-schedule',
  planning: '/pages-partner/schedule/planning/planning',
  me: '/pages-partner/me/me',
};
/* v151 卡片 id → 未落地提示文案（点了告诉用户去哪，不装死） */
const PENDING_TIP = {
};

Page({
  data: {
    statusBarHeight: 20,
    ready: false,

    // 身份（先用本地 adminInfo 出界面避免闪错，再以 /partner/me 为准）
    roleKey: 'manager',          // member | manager | super
    roleTag: '社干',
    name: '',
    greet: greetWord(),
    care: careLine(),

    // 待办数字（唯一事实源，页面与角标都从这算）
    submitPending: 0,
    messagePending: 0,

    /**
     * 模块卡左下的小计数器（原型 .mod-n 的「5 个账号 / 12 条规则 / 88 场已录」）。
     * ⚠️ null = 这个数还没拉到或没有接口 ⇒ wxml 不渲染数字（不编假数字）。
     *   2026-10-31 之前这里全是 null —— 当时以为是"没有接口"，其实五个接口早就有，
     *   陛下拿原型的「5 个账号」问了一句才补齐。
     */
    mods: { accounts: null, rules: null, recorded: null, unmarked: null, drafts: null, leaves: null },

    // 社干 / 超管：三联卡区块（见 buildSections）
    sections: [],
    // 站员：需要你处理（数据接口就绪前显示 v151 空态句）
    needs: [],
    needCount: 0,

    // 大白卡轮播（v151 .carousel）
    // 第 1 张「正式值班安排」/ 第 2 张「本周点歌排期」，两张都走真接口（见 buildSlides）。
    current: 0,
    slideH: 340,                // swiper 必须有固定高（含 100rpx 投影空间）；真实高度由 measureSlide() 实测覆盖
    slides: [],

    // 本周班表真实状态（大白卡据此变色，不再写死「还没有发布」）
    // state：published | draft | withdrawn | empty   —— 与班表页同一套四态口径
    weekState: 'empty',
    weekVersion: 0,
    // 已发布时卡里列「我这一周播什么」（原型 homeTop 的 myslots）：[{ key, day, time, dept }]
    myShifts: [],
    // 第 2 张卡「本周点歌排期」：{ seated, waiting, lines[] }；null = 还没拉到 ⇒ 先不渲染这张
    songs: null,
    // 底部导航
    tabActive: 'desk',
    badges: {},
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
      return;
    }
    const info = (app.globalData && app.globalData.adminInfo) || {};
    const roleKey = roleKeyOf(info.role);
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      roleKey,
      roleTag: roleTagOf(roleKey),
      name: info.nickname || info.username || '',
      // 站员的底栏第一个 tab 是 home，社干/超管是 desk
      tabActive: roleKey === 'member' ? 'home' : 'desk',
    });
    this.fetchMe();
  },

  onShow() {
    if (!this.data.ready) return;
    // 大白卡写的是「本周班表」的状态，在排班工作台发布 / 撤回之后回首页必须跟着变，
    // 所以这里和待办数字一起重拉（只拉数字会出现「已发布，首页还写着未发布」）。
    this.fetchCounts();
    this.fetchModules();
    this.fetchSchedule();
    this.fetchSongs();
  },

  onUnload() { this._gone = true; },

  onSwiper(e) {
    this.setData({ current: e.detail.current }, () => this.measureSlide());
  },

  /**
   * 量当前那张大白卡的真实高度，回写给 swiper。
   * ⚠️ 两个坑（都踩过）：
   *   ① swiper 不支持 height:auto（v3：整卡塌陷消失）；
   *   ② swiper 自带 overflow:hidden（v5.1：高度只给卡片 ⇒ .bigc 的投影被裁掉，卡片看着是死的）。
   * 原型的做法是 .slides 给 margin-bottom:52px 当投影落地空间 ⇒ 这里量完卡高再加 100rpx（52px）。
   */
  measureSlide() {
    const SHADOW_ROOM = 100;      /* 52px 投影落地空间（原型 .slides margin-bottom:52px） */
    const w = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
    const vw = w.windowWidth || 375;
    wx.createSelectorQuery().in(this).selectAll('.bigc').boundingClientRect((rects) => {
      if (!rects || !rects.length) return;
      const i = Math.min(this.data.current, rects.length - 1);
      const h = rects[i] && rects[i].height;
      if (!h) return;
      const rpx = Math.ceil(h * (750 / vw)) + SHADOW_ROOM;
      if (rpx !== this.data.slideH) this.setData({ slideH: rpx });
    }).exec();
  },

  /**
   * 大白卡内容：v151 homeTop() 的第 1 张「正式值班安排」。
   *
   * ⚠️⚠️ 原来这一张是**写死**的「班表还没有发布。」—— 结果是发布完回首页，
   *    三个角色看到的还是那句未发布（陛下 2026-10-30 报的「大白卡都没有变化」）。
   *
   * 已发布的形态**照原型 homeTop() 搬**（2026-10-30 第二版，陛下拿原型截图对过）：
   *   · 右上角胶囊「已发布 · 第 N 版」（.tag.ok：--accent-tint 底 + --accent 字）
   *   · 主句「本周 N 个班次」，下面逐行「周一　早会 06:50　…………　主持部」
   *   · 没排到人时主句「本周没有你的班次」+ 一句说明，不留空白
   *   ⚠️ 三个角色**同一口径 = 我自己的班次**（社干/超管也是人，原型里他们照样看自己的）。
   *      第一版我写成社干看「已排 x/y 人」的全站汇总，是错的 —— 汇总在「班表」tab 里看。
   *
   * 草稿 / 已撤回 两态原型没有（快照），按班表页四态口径补，只在主副句上说清当前进度。
   *
   * 站员看不到别人的人选，服务端只给 state 不给 rows ⇒ 自己的班次单独走
   * /partner/schedule/mine 取（myShifts）。同一接口取三个角色都能用。
   *
   * 第 1 张是「正式值班安排」，第 2 张是「本周点歌排期」（原型 homeTop 的第 2 张；
   * 点歌那张只在 songs 拉到之后才 push 进来，没拉到不编数字）。
   *
   * @param {object} [st] 外部先算好的状态对象（setData 之前调用时 this.data 还是旧值）
   */
  buildSlides(st) {
    const s = st || this.data;
    const member = s.roleKey === 'member';
    const mine = Array.isArray(s.myShifts) ? s.myShifts : [];
    const eb = '正式值班安排';
    let duty;

    if (s.weekState === 'published') {
      const ver = Number(s.weekVersion) || 1;
      duty = {
        eb,
        tag: `已发布 · 第 ${ver} 版`,
        b2: mine.length ? `本周 ${mine.length} 个班次` : '本周没有你的班次',
        d2: mine.length ? '' : '班表已发布，这一周还没排到你。可以先确认可排时间，或联系社干调整。',
        slots: mine,
      };
    } else if (s.weekState === 'withdrawn') {
      duty = {
        eb, tag: '', slots: [],
        b2: '本周班表已撤回。',
        d2: member ? '社干在重新调整，重新发布后这里会更新。'
                   : '原安排已转成草稿，改完重新发布即可。',
      };
    } else if (s.weekState === 'draft') {
      duty = {
        eb, tag: '', slots: [],
        b2: '本周班表还是草稿。',
        d2: member ? '社干还在排，发布后你就能看到班次。'
                   : '还没发布，发布后站员就能看到班次。',
      };
    } else {
      /* empty：时段还没发布 / 本周还没生成草稿 —— 与原型原句一致 */
      duty = {
        eb, tag: '', slots: [],
        b2: '班表还没有发布。',
        d2: member ? '可先确认可排时间，社干发布后再查看班次。'
                   : '可先确认可排时间，发布后站员就能看到班次。',
      };
    }

    const slides = [duty];
    const song = s.songs;
    if (song) slides.push(this.buildSongSlide(song));
    return slides;
  },

  /**
   * 第 2 张「本周点歌排期」（原型 homeTop 第 2 张：已排 7 首 · 候补 3 首 + 三首歌）。
   * 数据源与 song-schedule 页完全一致：/admin/submit/list?type=1&reviewStatus=1，
   * 按 scheduleStatus 分档（1 已排 / 2 候补；0 未排、3 自动驳回都不算排上）。
   */
  buildSongSlide(song) {
    const seated = Number(song.seated) || 0;
    const waiting = Number(song.waiting) || 0;
    const lines = Array.isArray(song.lines) ? song.lines : [];
    if (!seated && !waiting) {
      return {
        eb: '本周点歌排期', tag: '', slots: [],
        b2: '本周还没排歌',
        d2: '点歌通过审核后，在电脑端排进节目单。',
      };
    }
    return {
      eb: '本周点歌排期', tag: '', slots: [],
      b2: `已排 ${seated} 首 · 候补 ${waiting} 首`,
      d2: lines.length ? lines.join(' · ') : '排好的歌都在「歌曲排期」里。',
    };
  },

  /**
   * 第 2 张卡的数据：本周点歌排期。
   *
   * 接口与 song-schedule 页同一个：`/admin/submit/list?type=1&reviewStatus=1`
   * （type=1 点歌、reviewStatus=1 已通过），再按 `scheduleStatus` 分档：
   *   0 未排 / 1 已排 / 2 候补 / 3 自动驳回（名额满被刷下，不算排上也不算候补）
   * 卡片只取「已排几首 / 候补几首 + 头 3 首」，点进去才是完整排期。
   *
   * ⚠️ 失败就保持上一份（首屏 null ⇒ 先不渲染这张卡），不编数字也不闪。
   */
  fetchSongs() {
    return adminRequest('/admin/submit/list', 'GET', { type: 1, reviewStatus: 1, page: 1, pageSize: 100 })
      .then((d) => {
        if (this._gone) return;
        const rows = (d && d.list) || [];
        const seated = rows.filter((r) => Number(r.scheduleStatus) === 1);
        const songs = {
          seated: seated.length,
          waiting: rows.filter((r) => Number(r.scheduleStatus) === 2).length,
          lines: seated.slice(0, 3).map(songLine),
        };
        // 同 fetchSchedule：只写 songs，算卡用合并视图
        const view = Object.assign({}, this.data, { songs });
        this.setData({ songs, slides: this.buildSlides(view) }, () => this.measureSlide());
      })
      .catch(() => {});
  },

  onPullDownRefresh() {
    // 下拉的转圈必须无条件收掉：任何一条挂掉也 stopPullDownRefresh，否则页面永远在转
    return Promise.all([this.fetchCounts(), this.fetchModules(), this.fetchSchedule(), this.fetchSongs()])
      .catch(() => {})
      .then(() => wx.stopPullDownRefresh());
  },

  /**
   * 拉本周班表状态（大白卡唯一数据源）。
   *
   * 口径：
   *   · 不传 week ⇒ 云函数按**北京时间**给本周周一，前端不自己算日历（铁律）
   *   · 自己的班次走 /partner/schedule/mine（三个角色都通用）；
   *     `/partner/schedule` 那份对站员只给 state、rows 恒为空
   *   · 拿不到就**保持上一次状态**（首屏即 empty，与原句一致），不弹错、不把卡翻回「未发布」
   *     ⚠️ 这一条是必须的：网络抖一下就把「已发布」刷回「还没有发布」，
   *        和陛下报的那个 bug 长得一模一样，会被当成没修。
   *
   * ⚠️ 撤回在库里落的是 `state:'draft' + withdrawnAt`（不是 'withdrawn'），
   *    所以这里要按 withdrawnAt 还原成「已撤回」，跟班表页 view-model 的四态对齐。
   */
  fetchSchedule() {
    return Promise.all([
      adminRequest('/partner/schedule', 'GET', {}).catch(() => null),
      adminRequest('/partner/schedule/mine', 'GET', {}).catch(() => null),
    ]).then(([week, mine]) => {
      if (this._gone || !week) return;
      const w = week;
      const raw = w.state || 'empty';
      const weekState = raw === 'published' ? 'published'
        : (raw === 'draft' && w.withdrawnAt ? 'withdrawn' : raw);
      // ⚠️ 分开「只写自己这几个字段」和「算卡时看到的合并视图」：
      //    setData 里塞整个 this.data 会把别的请求刚写进去的 sections/badges 打回旧值；
      //    而算卡又必须看到对方已经写进去的数据（卡片是「班表 + 点歌」两张，两条请求并发落地）。
      const patch = {
        roleKey: this.data.roleKey,
        weekState,
        weekVersion: Number(w.version) || 0,
        // mine 拉失败时保留上一次的行，别一会儿有一会儿空
        myShifts: mine && Array.isArray(mine.list) ? mine.list.map(toShiftRow) : this.data.myShifts,
      };
      const view = Object.assign({}, this.data, patch);
      this.setData(Object.assign({}, patch, { slides: this.buildSlides(view) }), () => this.measureSlide());
    });
  },

  /**
   * 能力位与身份以后端为准（缓存 role 可能是降权前写下的）。
   * /partner/me 失败不阻塞页面：入口照常，数字各自兜底为 0。
   */
  fetchMe() {
    return adminRequest('/partner/me', 'GET', {})
      .then((me) => {
        const m = me || {};
        const roleKey = roleKeyOf(m.role);
        this.setData({
          ready: true,
          roleKey,
          roleTag: m.isSuper ? '超管' : (m.roleText || '社干'),
          name: m.name || this.data.name,
          // ⚠️ 身份刚变，大白卡副句按新身份重出一遍；班表状态另有 fetchSchedule 负责
          slides: this.buildSlides(Object.assign({}, this.data, { roleKey })),
        }, () => this.measureSlide());
        this.fetchSchedule();
        this.fetchSongs();
        this.fetchModules();
        return this.fetchCounts();
      })
      .catch((err) => {
        if (err && err.code === 40101) {
          wx.reLaunch({ url: '/pages-partner/login/login' });
          return;
        }
        this.setData({ ready: true, slides: this.buildSlides() }, () => this.measureSlide());
        this.fetchSchedule();
        this.fetchSongs();
        this.fetchModules();
        this.fetchCounts();
      });
  },

  fetchCounts() {
    return Promise.all([
      adminRequest('/admin/submit/list', 'GET', { reviewStatus: 0, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0),
      adminRequest('/admin/message/list', 'GET', { status: 0, page: 1, pageSize: 1 })
        .then((d) => Number((d && d.total) || 0))
        .catch(() => 0),
    ]).then(([submitPending, messagePending]) => {
      // 同 fetchModules：算卡前先把这两个数合进视图，别指望 setData 已经生效
      const view = Object.assign({}, this.data, { submitPending, messagePending });
      this.setData({
        submitPending,
        messagePending,
        sections: this.buildSections(submitPending, messagePending, view),
        badges: this.buildBadges(submitPending, messagePending),
      });
    });
  },

  /**
   * 模块卡左下的小计数器（原型「5 个账号 / 12 条规则 / 88 场已录 / 1 条待批」）。
   *
   * ⚠️ 2026-10-31 之前这些数全是 null，注释还写着"没有接口"——其实五个接口早就有了
   *    （陛下拿原型的「5 个账号」问了一句才补上）。取不到才留 null，绝不编。
   *
   * 一个请求都不多开：考勤那两项用同一份 overview 算（已录 = posts - unmarked）。
   * 站员没有这几张卡 ⇒ 直接跳过，不发请求。
   */
  fetchModules() {
    if (this.data.roleKey === 'member') return Promise.resolve();
    const isSuper = this.data.roleKey === 'super';
    // Promise.resolve 包一层：任何一项拿不到（或返回非 Promise）都只是 null，不带崩整页
    const pick = (p, fn) => Promise.resolve(p).then(fn).catch(() => null);
    return Promise.all([
      // 账号：/admin/admin/list 只给超管（asSuper），社干那条直接给 null
      isSuper
        ? pick(adminRequest('/admin/admin/list', 'GET', { page: 1, pageSize: 1 }), (d) => Number((d && d.total) || 0))
        : Promise.resolve(null),
      pick(adminRequest('/partner/rules', 'GET', {}), (d) => (d && Array.isArray(d.items) ? d.items.length : 0)),
      pick(adminRequest('/partner/attendance/overview', 'GET', {}), (d) => {
        const s = d && d.summary;
        if (!s) return null;
        const posts = Number(s.posts) || 0;
        const unmarked = Number(s.unmarked) || 0;
        return { recorded: Math.max(0, posts - unmarked), unmarked };
      }),
      // 内部稿件待审：/partner/draft/review 是全站待审（list 那个只看自己的稿）
      pick(adminRequest('/partner/draft/review', 'GET', { status: 0, page: 1, pageSize: 1 }), (d) => Number((d && d.total) || 0)),
      pick(adminRequest('/partner/leave/pending', 'GET', {}), (d) => Number((d && d.counts && d.counts.pending) || 0)),
    ]).then(([accounts, rules, att, drafts, leaves]) => {
      if (this._gone) return;
      const mods = {
        accounts, rules, drafts, leaves,
        recorded: att ? att.recorded : null,
        unmarked: att ? att.unmarked : null,
      };
      /**
       * ⚠️⚠️ 必须先把 mods 合进 view 再算 sections。
       *    `setData({ mods, sections: this.buildSections(...) })` 里 buildSections 是在
       *    setData **执行之前**跑的，那时 this.data.mods 还是旧值（全 null）⇒
       *    卡片一个数字都不显示（2026-10-31 陛下「没看到显示数字啊」就是这个）。
       *    这个坑和 fetchMe 里 roleKey 那个是同一个：**setData 之前 this.data 是旧值**。
       */
      const view = Object.assign({}, this.data, { mods });
      this.setData({
        mods,
        sections: this.buildSections(this.data.submitPending, this.data.messagePending, view),
      });
    });
  },

  /* 三联卡区块。卡内容 = v151 原型 V.desk() 的模块清单；
     其中「投稿&点歌 / 留言」对齐我们真实页面（一期是合一的审核台）。
     计数器取不到 ⇒ n=null，左下不渲染数字（不编假数）。
     @param {object} [view] 合并后的状态视图（算卡时要把刚拉到的数一起算进去，见 fetchModules） */
  buildSections(submitPending, messagePending, view) {
    const src = view || this.data;
    const mods = src.mods || {};
    // null 保留成 null（不渲染数字），0 要照常显示 0
    const n = (v) => (v === null || v === undefined ? null : Number(v) || 0);
    const pub = [
      { go: 'review', t: '投稿 & 点歌审核', d: '歌曲与祝福 · 听众来稿', n: submitPending, u: '待审' },
      { go: 'message', t: '留言审核', d: '通过展示 / 屏蔽', n: messagePending, u: '待审' },
      // 原型这张也不给数字（排期是要点进去看的清单，不是待办数）
      { go: 'song-schedule', t: '歌曲排期', d: '播出安排与候补', n: null, u: '' },
    ];
    const coop = [
      { go: 'work', t: '内部稿件', d: '站内伙伴来稿', n: n(mods.drafts), u: '待审' },
      { go: 'leave-approve', t: '请假审批', d: '等待你确认', n: n(mods.leaves), u: '条' },
      { go: 'attendance', t: '考勤录入', d: '按节目场点名', n: n(mods.unmarked), u: '未录入' },
    ];
    /* ⚠️ 2026-10-28 陛下拍板：第三块「排班协作」（可排时间 / 值班时段）去掉 ——
       v151 社干工作台就只有"听众投稿 / 站内协作"两块，这两项原型挂在「班表」tab。
       班表 tab 落地后在那里给入口；ROUTES 里的 availability / slots 保留着复用。 */
    /* 站员工作台：v151 V.home 只留五个入口 —— 我的稿件 / 考勤 / 请假申请 / 互评 / 站内公告。
       ⚠️ 一条都不能少也不能多：站员不审稿、不排班、不看全站。 */
    if (src.roleKey === 'member') {
      return [
        {
          head: '我的手头',
          right: '',
          mods: [
            { go: 'work', t: '我的稿件', d: '草稿 · 在审 · 已通过', n: null, u: '' },
            { go: 'my-att', t: '我的考勤', d: '本月场次 · 出勤', n: null, u: '' },
            { go: 'leave', t: '请假申请', d: '挑一场 · 写事由', n: null, u: '' },
          ],
        },
        {
          head: '站里',
          right: '',
          mods: [
            { go: 'feedback', t: '互评', d: '当场说一句', n: null, u: '' },
            { go: 'notices', t: '站内公告', d: '站里的通知', n: null, u: '' },
          ],
        },
      ];
    }

    // 站内协作右上：原型 = 「内部稿件待审 + 请假待批 + 考勤未录入」三项求和。
    // 任何一项没拉到就不给数（写「站内伙伴的事」），不能拿残缺的和当总数。
    const coopKnown = [mods.drafts, mods.leaves, mods.unmarked].every((v) => v !== null && v !== undefined);
    const coopTotal = coopKnown ? (Number(mods.drafts) || 0) + (Number(mods.leaves) || 0) + (Number(mods.unmarked) || 0) : 0;
    const sections = [
      { head: '听众投稿', right: (submitPending + messagePending) + ' 项待审', mods: pub },
      { head: '站内协作', right: coopKnown ? coopTotal + ' 项待处理' : '站内伙伴的事', mods: coop },
    ];
    if (src.roleKey === 'super') {
      sections.unshift({
        head: '管理',
        right: '超管独有',
        // ⚠️ 原型管理区只有这三张卡（账号/排班规则/考勤总览）。
        //   「值班时段」入口在排班工作台的四行子模块里（原型 v111：并进工作台，
        //   班表首页/工作台管理区都不重复收）—— 2026-10-29 曾在这里补过一张，
        //   排班工作台对齐后按原型撤掉。
        mods: [
          { go: 'accounts', t: '账号', d: '分发 · 重置 · 停用', n: n(mods.accounts), u: '个账号' },
          { go: 'rules', t: '排班规则', d: '场次上限与轮值', n: n(mods.rules), u: '条规则' },
          { go: 'att-overview', t: '考勤总览', d: '全站出勤统计', n: n(mods.recorded), u: '场已录' },
        ],
        note: '模块开关 / 系统设置 / 数据看板 / 批量导出 只在电脑端后台做，手机端不留入口。',
      });
    }
    return sections;
  },

  /* 角标与待办同源：审核 tab = 投稿 + 留言；工作台暂无"要你动手"的真值 ⇒ 0（归零即隐）。 */
  buildBadges(submitPending, messagePending) {
    return {
      desk: 0,
      home: 0,
      submissions: submitPending + messagePending,
      'my-drafts': 0,
      scheduling: 0,
      schedule: 0,
      me: 0,
    };
  },

  onNav(e) {
    const go = e.currentTarget.dataset.go;
    if (!go) return;
    const url = ROUTES[go];
    if (url) {
      // ⚠️ 目标是**底部 tab 页**（审核 / 我的）时用 reLaunch，不是 navigateTo ——
      //    navigateTo 会带返回箭头、把 tab 页当成二级页，用户点底栏却"跳转"就错了。
      const isTab = (go === 'review' || go === 'message' || go === 'me' || go === 'work');
      wx[isTab ? 'reLaunch' : 'navigateTo']({ url });
      return;
    }
    const tip = PENDING_TIP[go];
    if (tip) wx.showToast({ title: tip, icon: 'none' });
  },

  /* 底部导航切换：四个 tab 页之间一律 reLaunch（tab 之间不留栈），
     没落地的 tab 给 toast，不做假页面 */
  onTab(e) {
    const id = e.detail && e.detail.id;
    if (!id || id === this.data.tabActive) return;
    const map = {
      desk: '/pages-partner/desk/desk',
      home: '/pages-partner/desk/desk',
      submissions: '/pages-partner/review/review',
      'my-drafts': '/pages-partner/work/work',
      // ⚠️ 2026-10-29 补：tabbar 组件的 id 是「站员=schedule / 社干·超管=scheduling」，
      //    这里两个都要有。原来只写了 4 个，点底部「班表」直接落到 toast「这一页还没落地」
      //    —— 页面早就落地了，是这张映射表漏了，纯 bug。
      schedule: '/pages-partner/schedule/index/index',
      scheduling: '/pages-partner/schedule/index/index',
      me: '/pages-partner/me/me',
    };
    const url = map[id];
    if (url) {
      wx.reLaunch({ url });
      return;
    }
    wx.showToast({ title: '这一页还没落地', icon: 'none' });
  },

});

/** admin.role：0 超管 / 1 社干 / 2 站员（2026-10-29 新增） */
function roleKeyOf(role) {
  const r = Number(role);
  if (r === 0) return 'super';
  if (r === 2) return 'member';
  return 'manager';
}
function roleTagOf(roleKey) {
  if (roleKey === 'super') return '超管';
  if (roleKey === 'member') return '站员';
  return '社干';
}

/**
 * /partner/schedule/mine 的一行 → 原型 `.msl` 的三格：周几 /「时段名 开始时间」/ 部门。
 * 原型 slotTime() 只取开始时间（早会 06:50），不是 06:50-07:30 的整段 —— 卡片窄，照搬。
 */
function toShiftRow(x, i) {
  const r = x || {};
  const start = String(r.timeText || '').split('-')[0];
  return {
    key: `${r.day || i}-${r.slotKey || i}`,
    day: r.dayName || '',
    time: [r.slot || '', start].filter(Boolean).join(' '),
    dept: r.department || '',
  };
}

/**
 * 已排的一首 → 「周三午间《夜空中最亮的星》」（原型 homeTop 第 2 张 d2 的写法）。
 * 时段取 scheduledSlot（排到哪一格），没有就退回听众写的想播时间，再没有就「未定时段」——
 * 与 song-schedule 页的 slotText 口径一致，不另造一套。
 */
function songLine(r) {
  const song = (r && r.songName) || '（未填歌名）';
  const slot = (r && (r.scheduledSlot || r.wantBroadcastTime)) || '未定时段';
  return `${slot}《${song}》`;
}
