// custom-tab-bar/index.js
// 胶囊浮动底部导航（设计稿「01/02/03/04」底部）
//
// ── 动画契约 v11（2026-11-19 重写：修「抽搐 / 不从原位滑 / 位置错乱」）──────
// 改之前先读完这段，下面几条任何一条改回去，毛病都会原样复发：
//
// ① 指示器只动 left + width，**绝不许 scaleX**。拖尾要"两端弧度不变"（永远是标准半圆），
//    只有真改宽度靠 border-radius: 999rpx 才能做到；scaleX 会把圆角一起横向缩放 ⇒
//    两端变成被拉扁的椭圆尖（2026-11-19 陛下当场退回）。
//    代价是每帧重排，但对象是绝对定位、无后代、无文字的纯色块，重排范围就一小块。
//    v10 抽搐的真因不是这个：是「两段 setData 起点错位 + scaleY 纵向挤压 + 在错的位置补演」。
// ② 滑动发生在**用户正在看的那一格上**（点按那一刻就开演），不在目标页 onShow 里补演。
//    v10 是"点了什么都不动 → 等 switchTab 完成 → 新页 onShow 才开始滑"，
//    中间那段"没反应 + 突然出现 + 再滑"就是抽搐的主体。
//    而且每个 tab 页各有一个 tabBar 实例，只有点按时那个实例的格位是可信的
//    （用户眼睛看到的就是它）—— 在别的实例里演，起点只能靠猜。
//    切页本身压后 ~170ms（见 MOTION_MS / SWITCH_DELAY），让拖尾先在旧页上把
//    "拉长"演完；不压后的话页面一换，拖尾就只剩一帧。
// ③ 起点写死在 keyframe 里（ind-<from><to>，见 index.wxss 末尾 12 组），
//    与元素当时的样式无关 ⇒ 起点永远不会错，也不用靠 setData 时序去抢。
// ④ 一次切页只允许一次 setData（点按那一次）。目标页 onShow 只做"静态落位"，
//    正常路径下连 setData 都不发 —— 实例的格位在页面隐藏时就已经拨正了。
// ⑤ 页面隐藏时把实例拨回「本页自己的格位」（selected + indicatorClass 一起）。
//    这一步用户看不见，但它是"再次出现时第一帧不闪在上一格"的唯一保证。
//
// 状态只有一份来源：app.globalData.tabIndex（当前页格位）。
// 点按写 tabFrom，目标页 onShow 消费后清空；取不到 tabFrom 就静态落位、不演动画
// （从详情页返回、冷启动、切页失败重试都属于这一类 —— 那种时候硬滑反而像抽筋）。

// 拖尾 240ms（见 index.wxss 的 12 组 ind-*）。切页要等它把"拉长"这段演完再走，
// 否则 wx.switchTab 一换页，拖尾就被砍在拉伸中途 —— 看着像"刚拉长就瞬间归位"。
// 0.71×240 ≈ 170ms：拖尾进入收缩段的位置，黑条已经在收，页面正好换过来，两边接得上。
const MOTION_MS = 240;
const SWITCH_DELAY = Math.round(MOTION_MS * 0.71);

Component({
  options: {
    // 让 app.wxss 里的全局类可用
    addGlobalClass: true,
  },

  data: {
    selected: 0,          // 真实选中格（决定 icon/文字配色）
    indicatorClass: '',   // '' | ind-rest-<n>（静态落位）| ind-<from><to>（滑动）
    // 启动动画期间由首页通过 getTabBar() 驱动：
    //   hidden —— 胶囊退到屏幕外（容器无底色，不会有白板出现）
    //   enter  —— 胶囊自下而上滑入（加类即播，不受 setData 合并影响）
    hidden: false,
    enter: false,
    list: [
      { pagePath: '/pages/index/index',    text: '首页', icon: '/assets/tab-home.png',    iconOn: '/assets/tab-home-on.png' },
      { pagePath: '/pages/submit/submit',  text: '投稿', icon: '/assets/tab-submit.png',  iconOn: '/assets/tab-submit-on.png' },
      { pagePath: '/pages/members/members', text: '风采', icon: '/assets/tab-members.png', iconOn: '/assets/tab-members-on.png' },
      { pagePath: '/pages/mySubmit/mySubmit', text: '我的', icon: '/assets/tab-user.png',  iconOn: '/assets/tab-user-on.png' },
    ],
  },

  pageLifetimes: {
    hide() {
      // 页面已经不可见了，这时把实例拨回"本页自己的格位"，用户看不到这一下。
      // 作用是让下次本页出现的第一帧就是对的（见契约 ⑤）：
      // 不复位的话，复用的实例会带着"上次离开时滑到的那格"重新出现，先闪一帧再归位。
      const i = this._own;
      if (!Number.isInteger(i)) return;
      const cls = `ind-rest-${i}`;
      if (this.data.selected !== i || this.data.indicatorClass !== cls) {
        this.setData({ selected: i, indicatorClass: cls });
      }
    },
  },

  methods: {
    /**
     * 点按 tab：只记来源格、立刻在当前实例上演完这段滑动，然后发起切页。
     * ⚠️ 这里必须"先动再切"，不能只记状态等目标页去演（契约 ②）。
     */
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item) return;

      const global = getApp().globalData;
      const from = Number.isInteger(global.tabIndex) ? global.tabIndex : 0;
      if (index === from) return;

      global.tabIndex = index;
      global.tabFrom = from;
      this._own = index;

      // 唯一一次 setData：选中态 + 位移一起给，一次渲染、一段动画、没有第二段。
      this.setData({ selected: index, indicatorClass: `ind-${from}${index}` });

      const request = global.tabRequest = (global.tabRequest || 0) + 1;
      clearTimeout(this._switchTimer);
      this._switchTimer = setTimeout(() => {
        wx.switchTab({
          url: item.pagePath,
          fail: () => {
            // 切页失败：视觉与来源格一起回滚，别留下"点了但没走"的黑胶囊
            if (global.tabRequest !== request) return;
            global.tabIndex = from;
            global.tabFrom = undefined;
            this._own = from;
            this.setData({ selected: from, indicatorClass: `ind-rest-${from}` });
          },
        });
      }, SWITCH_DELAY);
    },

    /**
     * 页面 onShow 调用，参数是本页在 list 里的格位。
     * 只做"静态落位"（滑动已经在点按那一刻演完了），并返回方向给内容入场用。
     */
    setSelected(index) {
      const global = getApp().globalData;
      const raw = global.tabFrom;
      global.tabFrom = undefined;
      global.tabIndex = index;
      this._own = index;

      const direction = Number.isInteger(raw) && raw >= 0 && raw < this.data.list.length && raw !== index
        ? Math.sign(index - raw) : 0;

      const cls = `ind-rest-${index}`;
      // 正常路径：隐藏时已复位（契约 ⑤）⇒ 这里一次 setData 都不发
      if (this.data.selected === index && this.data.indicatorClass === cls) return direction;

      this.setData({ selected: index, indicatorClass: cls });
      return direction;
    },
  },
});
