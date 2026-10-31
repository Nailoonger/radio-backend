// pages-partner/roster/roster.js · v2（2026-10-31 加手机号）
//
// 名册：GET /partner/people（admin 表 status=1 的全部账号，顺带回 me 那一行）。
//
// ═══════════ 这一版加的手机号 ═══════════
//   ① 没填过（me.needPhone）⇒ 进来就先弹「先留个手机号」，**弹层没有关闭、点遮罩也不收**，
//      没填对「保存并进入」一直是禁用的 —— 需求原话「否则无法进入」就是这个意思。
//   ② 列表最底下一行红字「修改我的个人资料」，点开同一个弹层（这次有取消），只能改号码。
//   ③ 姓名、学号是学校名册来的，**这里只有只读文本**；后端也只允许改 phone 一个字段，
//      前端不给输入框、后端也不收 nickname —— 两边都堵，改包也改不了。
//
// ⚠️ 为什么不在前端自己推「要不要弹」：判据来自后端 `needPhone`。
//    前端自己 `!me.phone` 判空，一旦哪个脏数据写成 null / undefined 就判错，
//    而错的方式是「静默不弹」或「每次都弹」，都不会报错。
// ⚠️ 输入框用 `model:value` 双向绑定，`bindinput` **只算校验、不写回输入值** ——
//    手写 value + setData 会跟输入法 composition 抢，中文/数字输入都可能被打断。

const { adminRequest } = require('../../utils/request.js');

/** 11 位、1 开头、第二位 3–9（与后端 normalizePhone 同一套规则） */
function phoneOK(v) {
  return /^1[3-9]\d{9}$/.test(String(v || '').replace(/\D/g, ''));
}

/** 只留数字，最多 11 位 */
function digits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '').slice(0, 11);
}

/** 13900002407 → 139 0000 2407（只是显示，不参与校验） */
function fmtPhone(v) {
  const d = digits(v);
  return d.length === 11 ? `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}` : d;
}

/** 输入提示：空 → 说明；不足 → 还差几位；满了但不像 → 不像手机号；对了 → 肯定 */
function errTextOf(v) {
  if (!v) return '必填：11 位手机号，方便伙伴找到你';
  if (v.length < 11) return `还差 ${11 - v.length} 位（1 开头的 11 位）`;
  if (!phoneOK(v)) return '这串号码不像手机号（要 1 开头、11 位）';
  return '格式没问题，保存后伙伴都能看到这个号';
}

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    kw: '',
    total: 0,
    superCount: 0,
    deptCount: 0,
    list: [],
    raw: [],
    me: { personId: 0, name: '', username: '', phone: '', needPhone: true },
    // 手机号弹层；null = 不显示
    sheet: null,
  },

  onLoad() {
    const app = getApp();
    if (!app || !app.isAdminLoggedIn || !app.isAdminLoggedIn()) {
      wx.reLaunch({ url: '/pages-partner/login/login' });
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

  /** 遮罩层吞掉点击与滑动：没填完就是进不去，别让它点一下就穿透到下面的列表 */
  noop() {},

  load() {
    this.setData({ loading: true });
    return adminRequest('/partner/people', 'GET', {})
      .then((d) => {
        const rows = (d && d.list) || (Array.isArray(d) ? d : []);
        const me = (d && d.me) || null;
        const myId = me ? Number(me.personId) : 0;

        const raw = rows.map((x) => {
          const name = x.name || x.username || ('账号' + x.personId);
          const roles = (x.dutyRoles || []).join(' · ');
          const sub = [x.department || '未分部门', roles].filter(Boolean).join(' · ');
          const phone = x.phone || '';
          const isMe = myId && Number(x.personId) === myId;
          return {
            personId: x.personId,
            name,
            username: x.username || '',
            initial: name.slice(0, 1),
            sub,
            phone: isMe && me ? me.phone : phone,   // 自己那行永远以 me 为准（刚填完要立刻变）
            tel: fmtPhone(isMe && me ? me.phone : phone),
            isMe,
            isSuper: !!x.isSuper,
            isMember: !!x.isMember,
            chip: x.isSuper ? '超管' : (x.isMember ? '站员' : '社干'),
            department: x.department || '',
          };
        });

        // 自己那行置顶：一进名册先看到自己，也顺手确认号填对没有
        raw.sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));

        const depts = {};
        raw.forEach((x) => { if (x.department) depts[x.department] = 1; });

        this.setData({
          loading: false,
          raw,
          list: raw,
          total: raw.length,
          superCount: raw.filter((x) => x.isSuper).length,
          deptCount: Object.keys(depts).length,
          me: me || { personId: 0, name: '', username: '', phone: '', needPhone: true },
        });

        // 没填过 → 立刻弹「先留个手机号」，且这一层关不掉
        if (!me || me.needPhone) this.openSheet(false);
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' });
      });
  },

  onKw(e) {
    const kw = e.detail.value.trim().toLowerCase();
    const list = kw
      ? this.data.raw.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0
        || String(x.username).toLowerCase().indexOf(kw) >= 0
        || String(x.phone).indexOf(kw) >= 0)
      : this.data.raw;
    this.setData({ kw: e.detail.value, list });
  },

  /* ══════════ 手机号弹层 ══════════ */

  /**
   * @param {boolean} editing true = 「修改我的个人资料」；false = 首次强制填写
   */
  openSheet(editing) {
    const phone = editing ? digits(this.data.me.phone) : '';
    const ok = phoneOK(phone);
    this._lastPhone = phone;          // 打开时就把提交源对齐，编辑态原样保存也不会读到空
    this.setData({
      sheet: {
        editing: !!editing,
        phone,
        ok,
        focus: false,
        err: errTextOf(phone),
        errTone: ok || !phone ? 'mute' : 'warn',
        title: editing ? '修改我的个人资料' : '先留个手机号，再进名册',
        desc: editing
          ? '姓名和学号来自学校名册，这里改不了；手机号想换随时在这儿换。'
          : '名册里的电话只给站内伙伴看，用来约班、换班、临时找人。不填就不进名册。',
        btn: editing ? '保存修改' : '保存并进入',
      },
    });
  },

  onEditProfile() {
    this.openSheet(true);
  },

  onCancel() {
    this.setData({ sheet: null });
  },

  /** 输入：只算校验，不改输入值（值由 model:value 双向绑定负责） */
  /**
   * 输入手机号
   *
   * ⚠️⚠️ 为什么还要单独存一份 `this._lastPhone`（2026-10-31 陛下截图打回）：
   *    `model:value` 和 setData 都是**异步**落地的。用户输完第 11 位、手指马上点「保存」，
   *    这时 `this.data.sheet.phone` 有可能还是上一拍的值（10 位）⇒ 校验判失败、
   *    弹一句「手机号要 11 位」，可屏幕上明明写着 11 位、按钮还是亮的。
   *    ⇒ 提交一律读 `_lastPhone`（bindinput 里同步赋值，不经过 setData），
   *      `sheet.phone` 只负责回显。
   * ⚠️ 号码一旦合法就把之前那句错误 toast 收掉，否则「格式没问题」和「要 11 位」会同屏打架。
   */
  onPhone(e) {
    const v = digits(e.detail.value);
    this._lastPhone = v;
    const ok = phoneOK(v);
    if (ok) wx.hideToast();
    this.setData({
      'sheet.ok': ok,
      'sheet.err': errTextOf(v),
      'sheet.errTone': ok || !v ? 'mute' : 'warn',
    });
  },

  onSave() {
    const sheet = this.data.sheet;
    if (!sheet) return;
    // 以 bindinput 同步缓存的那份为准；没有过输入事件（编辑态原样保存）才退回 data
    const phone = digits(this._lastPhone != null ? this._lastPhone : sheet.phone);
    if (!phoneOK(phone)) {
      wx.showToast({ title: '手机号要 11 位、1 开头', icon: 'none' });
      return;
    }
    if (this.saving) return;
    this.saving = true;
    wx.showLoading({ title: '保存中', mask: true });

    adminRequest('/partner/me/profile', 'PUT', { phone })
      .then((d) => {
        wx.hideLoading();
        this.saving = false;
        const saved = (d && d.phone) || phone;

        // 就地更新：不要为了刷新一行再重拉整张名册（会闪一下，还会把搜索词丢掉）
        const me = Object.assign({}, this.data.me, { phone: saved, needPhone: false });
        const raw = this.data.raw.map((x) => (x.isMe
          ? Object.assign({}, x, { phone: saved, tel: fmtPhone(saved) })
          : x));
        const kw = this.data.kw.trim().toLowerCase();
        const list = kw
          ? raw.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0
            || String(x.username).toLowerCase().indexOf(kw) >= 0
            || String(x.phone).indexOf(kw) >= 0)
          : raw;

        this.setData({ me, raw, list, sheet: null });
        wx.showToast({ title: sheet.editing ? '手机号已更新' : '已保存，可以看名册了', icon: 'none' });
      })
      .catch((err) => {
        wx.hideLoading();
        this.saving = false;
        const msg = (err && err.message) || '保存失败';
        wx.showToast({ title: msg, icon: 'none' });
        // 后端说是号码不合法：把提示落到弹层里，别只弹个 toast 就没了
        if (err && Number(err.code) === 40001) {
          this.setData({ 'sheet.err': msg, 'sheet.errTone': 'warn' });
        }
      });
  },
});
