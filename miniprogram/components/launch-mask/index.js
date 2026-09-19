// components/launch-mask/index.js
// 「声波唤醒」启动动画（设计稿 fileId 726404665321310 / 16:1）
//
// 重要：微信的启动画面无法自定义，所以这不是"启动图"，而是首页上的一个全屏覆盖层。
//   数据先到 → 调 dismiss() 立刻淡出，不拖沓；
//   数据后到 → 入场播完停在声波律动态（本身就是加载态），不会出现白屏。
//
// 用法：
//   <launch-mask id="launch" />
//   this.selectComponent('#launch').dismiss();

const WORD = '菁悠广播站';

// 设计稿声波条高度 5/9/14/19/24/27/24/19/14/9/5 px，×1.923 转 rpx
const BAR_HEIGHTS = [10, 17, 27, 37, 46, 52, 46, 37, 27, 17, 10];

// 时间轴（毫秒），与设计稿保持一致
const T = {
  badge: 100,
  wordBase: 360,
  wordStep: 70,
  barBase: 620,
  barStep: 45,
  barPulseBase: 1200,
  barPulseStep: 50,
  tagline: 1100,
  caption: 1350,
  exit: 420,      // 与 wxss 里 .mask 的 transition 时长对齐
};

Component({
  data: {
    leaving: false,
    gone: false,
    chars: [],
    bars: [],
  },

  lifetimes: {
    attached() {
      const chars = WORD.split('').map((c, i) => ({ i, c, d: T.wordBase + i * T.wordStep }));
      const bars = BAR_HEIGHTS.map((h, i) => ({
        i,
        h,
        d: T.barBase + Math.abs(5 - i) * T.barStep,
        pd: T.barPulseBase + i * T.barPulseStep,
      }));
      this.setData({ chars, bars });
    },

    detached() {
      if (this._timer) clearTimeout(this._timer);
    },
  },

  methods: {
    /** wxml 里 catchtouchmove 引用的空方法（挡住穿透滚动） */
    noop() {},

    /** 数据就绪后调用：淡出并卸载遮罩 */
    dismiss() {
      if (this.data.leaving || this.data.gone) return;
      this.setData({ leaving: true });
      this._timer = setTimeout(() => {
        this.setData({ gone: true });
      }, T.exit);
    },
  },
});
