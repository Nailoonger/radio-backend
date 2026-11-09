// pages-partner/club-keys/create.js
// 伙伴端 · 新建社团（2026-11-09）
//
// 起因：陛下「你在伙伴端没有给我做新建社团的入口啊」—— 原来那五家是种子数据
// （services/clubKey.js 的 SEED_CLUBS），只能看 / 改 / 重置 / 作废，加不了第六家。
//
// ═══════════ 两个形态，同一页 ═══════════
//   ① 表单态：名称（必填）/ 负责人 / 指导老师 → 「创建并生成密钥」
//   ② 结果态：建完**当场**摊开第一把密钥的六格 + 分享文案（与编辑页「重置之后」同一个形态，
//             不是第二套 CSS —— create.wxss 直接 @import 了 edit.wxss）
//
// ═══════════ 为什么创建和发钥匙是同一次请求 ═══════════
// 拆成「先建社团、再重置」两次的话，中间会留下「建好了但没钥匙」的半截状态：
// 那家社团已经出现在学生的社团轮播里，却谁都进不来。后端 clubKey.create 一次做完。
//
// ⚠️⚠️ 明文只活一次：库里只有 sha256 + 掩码（`····M7`）。所以这里
//    **不写 wx.setStorage、不打日志**，离开页面 / 点「隐藏」/ 再进来就没了。
//    这不是 bug，是「弄丢找社干重新生成」的产品语义。
//
// ⚠️⚠️ 名称建好**不能改**：库里的 `_id` 是 `club:<社团名>`（防并发重复插同一家），
//    改名等于换主键。所以表单下面那句「建好之后不能改」是硬事实，不是劝告。
//
// ⚠️ 只有超管能进来（后端 asSuperPartner 是闸，列表页那个入口也只给超管）。
//    社干即便被勾了 clubkey 位，也只有看 / 重置 / 作废 —— 多一家社团会出现在
//    全校学生的轮播里，那是增减组织，不是密钥操作。

const { adminRequest } = require('../../utils/request.js');

/** 与后端 services/clubKey.js 的 NAME_MIN / NAME_MAX 保持一致（改一处要回头改另一处） */
const NAME_MIN = 2;
const NAME_MAX = 12;

/** 按「字」数，不用 .length —— 一个生僻字/emoji 会被 .length 算成 2 */
function charLen(s) {
  return Array.from(String(s == null ? '' : s)).length;
}

/** 名称归一：首尾空白去掉、中间连续空白压一个（与后端 normalizeName 同一套规则） */
function tidyName(s) {
  return String(s == null ? '' : s).replace(/[\s\u3000]+/g, ' ').trim();
}

Page({
  data: {
    statusBarHeight: 20,

    // ── 表单态 ──
    name: '',
    ownerName: '',
    teacherName: '',
    /** 名称不合法（超长/太短且已经写了东西）时把下面那句说明变红 */
    nameBad: false,
    canSubmit: false,
    busy: false,

    // ── 结果态 ──
    done: false,
    record: null,
    initial: '社',
    cells: [],
    plain: '',
    shareText: '',

    denied: false,
    denyText: '',
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp().globalData.statusBarHeight || 20 });
  },

  /* ───────── 表单 ─────────
   * ⚠️ 输入值一律走 wxml 的 `model:value` 双向绑定，这里**只算派生状态、不写回输入值**。
   *    手写 value + setData 会跟输入法 composition 抢（中文打一半被打断）。
   * ⚠️ 输入框的 maxlength 只是**存储上限**（40），绝不当业务字数限制：
   *    「青年志愿者协会」的拼音要 20 多个字母，maxlength=12 会在第 12 个字母就截断，
   *    汉字永远上不了屏。业务限制（2~12 字）只在校验里做。
   */
  onName(e) {
    const v = (e && e.detail && e.detail.value) || '';
    const n = charLen(tidyName(v));
    this.setData({
      nameBad: tidyName(v).length > 0 && (n < NAME_MIN || n > NAME_MAX),
      canSubmit: n >= NAME_MIN && n <= NAME_MAX,
    });
  },

  /** 负责人 / 指导老师只是备注，不参与校验（后端也是 trim + 截 20 字） */
  onOwner(e) { this.setData({ ownerName: (e && e.detail && e.detail.value) || '' }); },
  onTeacher(e) { this.setData({ teacherName: (e && e.detail && e.detail.value) || '' }); },

  submit() {
    if (this.data.busy) return;
    const name = tidyName(this.data.name);
    const n = charLen(name);
    if (n < NAME_MIN) {
      wx.showToast({ title: `社团名称至少 ${NAME_MIN} 个字`, icon: 'none' });
      return;
    }
    if (n > NAME_MAX) {
      wx.showToast({ title: `社团名称最多 ${NAME_MAX} 个字`, icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    adminRequest('/partner/club-keys', 'POST', {
      name,
      ownerName: String(this.data.ownerName || '').trim(),
      teacherName: String(this.data.teacherName || '').trim(),
    })
      .then((d) => {
        const plain = d.plain || '';
        const r = d.record || {};
        this.setData({
          done: true,
          record: r,
          initial: (r.name || '社').charAt(0),
          plain,
          cells: plain.split(''),
          shareText: d.shareText || '',
          nameBad: false,
        });
        wx.showToast({ title: '已创建' });
      })
      .catch((err) => this.fail(err))
      .then(() => this.setData({ busy: false }));
  },

  /* ───────── 结果态 ───────── */

  /** 复制明文（六格） */
  copyPlain() {
    if (!this.data.plain) {
      wx.showToast({ title: '密钥已经藏起来了，要再看只能去这个社团里重置', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: this.data.plain,
      success: () => wx.showToast({ title: '密钥已复制' }),
    });
  },

  /** 复制整段（发给社长和指导老师那段话） */
  copyShare() {
    if (!this.data.shareText) return;
    wx.setClipboardData({
      data: this.data.shareText,
      success: () => wx.showToast({ title: '已复制，直接发群' }),
    });
  },

  /** 隐藏 = 把明文从内存里丢掉，之后要看得进这个社团再重置一次 */
  hide() {
    this.setData({ plain: '', cells: [] });
    wx.showToast({ title: '已隐藏，要再看只能再重置', icon: 'none' });
  },

  /** 完成：清掉内存里的明文再回列表（列表 onShow 会重新拉，新社团自然在里面） */
  finish() {
    this.setData({ plain: '', cells: [], shareText: '' });
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/club-keys/keys' });
  },

  goBack() {
    // 正在建的时候别半路退：请求已经发出去了，退回去会得到"建好了但没看到密钥"
    if (this.data.busy) return;
    if (this.data.done) { this.finish(); return; }
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: '/pages-partner/club-keys/keys' });
  },

  fail(err) {
    if (err && err.code === 40301) {
      this.setData({ denied: true, denyText: (err && err.message) || '暂无权限' });
      return;
    }
    // 40901 = 重名（后端撞 `_id`）。把焦点留在名称上，别让人以为是网络问题
    if (err && err.code === 40901) {
      this.setData({ nameBad: true });
      wx.showToast({ title: (err && err.message) || '已经有这家社团了', icon: 'none' });
      return;
    }
    wx.showToast({ title: (err && err.message) || '创建失败', icon: 'none' });
  },
});
