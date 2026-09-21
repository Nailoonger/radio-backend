/**
 * 弹簧引擎（零依赖）
 *
 * 来源：admin-web 学生账号 v3 预览（preview/student-admin-v3）里已验证过的一套，
 * 依据 Apple《Designing Fluid Interfaces》的两个参数：
 *
 *   damping  阻尼比：1.0 = 临界阻尼、不过冲（默认）；< 1 会过冲。
 *            **只有手势自带动量时才降到 ~0.8** —— 一个淡入的菜单不该过冲。
 *   response 响应：多久到目标（秒）。它**不是时长** —— 弹簧没有固定时长，
 *            停下来的时间是从参数里长出来的。
 *
 * 关键性质（这是它比 CSS transition 强的地方）：
 *   **任何时刻 set() 都能改写目标，而且保留当前速度 v。**
 *   所以动到一半被新输入接管时不会跳帧、也不会撞上「速度断崖」。
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 创建一个弹簧。返回的对象自带 set / jump / stop。
 * @param {number} init 初始值（当前屏幕上的值）
 * @param {(v:number)=>void} onUpdate 每帧回调
 * @param {{damping?:number, response?:number, eps?:number, onRest?:Function}} [opts]
 */
export function createSpring(init, onUpdate, opts = {}) {
  let x = init;
  let v = 0;
  let target = init;
  let raf = null;
  let last = 0;
  let running = false;

  const zeta = opts.damping == null ? 1 : opts.damping;
  const w0 = 8 / (opts.response || 0.35);
  const eps = opts.eps == null ? 0.02 : opts.eps;

  function frame(now) {
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 1 / 30) dt = 1 / 30; // 掉帧保护：不让积分炸掉
    const n = 8;
    const h = dt / n;
    for (let i = 0; i < n; i += 1) {
      const a = -w0 * w0 * (x - target) - 2 * zeta * w0 * v;
      v += a * h;
      x += v * h;
    }
    if (Math.abs(x - target) < eps && Math.abs(v) < eps * 40) {
      x = target;
      v = 0;
      onUpdate(x);
      running = false;
      raf = null;
      last = 0;
      if (opts.onRest) opts.onRest();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(frame);
  }

  return {
    /** 改写目标；传入 velocity 就是「速度交接」 */
    set(t, velocity) {
      target = t;
      if (velocity != null) v = velocity;
      if (!running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    },
    /** 直接落到某个值（不产生动画） */
    jump(t) {
      target = t;
      x = t;
      v = 0;
      onUpdate(x);
    },
    value: () => x,
    velocity: () => v,
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      running = false;
      last = 0;
    },
  };
}

/**
 * 在 `prefers-reduced-motion: reduce` 下降级：不滑不弹，直接落到位。
 * 注意降级**不是「没有反馈」**，而是换一种不引起前庭不适的等价反馈（调用方仍会拿到 onUpdate）。
 */
export function createAnim(init, onUpdate, opts = {}) {
  if (!prefersReducedMotion()) return createSpring(init, onUpdate, opts);
  return {
    set(t) { onUpdate(t); },
    jump(t) { onUpdate(t); },
    value: () => 0,
    velocity: () => 0,
    stop() {},
  };
}

/**
 * 动量投影：预测「这一甩会停在哪」，再决定吸附到哪个目标。
 * 苹果给的是指数衰减形式（不是物理课本的 v²/2a）。
 * @param {number} velocity px/s
 * @param {number} decelerationRate 0.998 ≈ 正常滚动手感
 */
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/**
 * 橡皮筋：越拖越沉，而不是到边界硬停。
 * 「硬停」读起来像卡住，「渐进抵抗」读起来像「到头了，确实没有更多」。
 */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export { prefersReducedMotion };
