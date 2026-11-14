// utils/skeleton.js · 加载骨架的统一闸门（2026-11-13，00:07 按陛下退回改写）
//
// ⚠️⚠️ 口径改过一次，别退回旧版：
//   旧版是「首帧先渲染真内容（空壳），300ms 后数据还没到才把骨架盖上来」
//   ⇒ 陛下看到的是「内容都已经出来了，然后再去运行加载骨架」。
//   现在：**骨架从第一帧就在**，内容层整块 wx:if 掉（骨架期间它根本不存在）。
//
// 现行口径：
//   1. 页面 data 里 sk 初值必须是 true（骨架首帧就画，不能先出内容）
//   2. 内容区一律 wx:if="{{!sk}}" —— 不是"被盖住"，是"不存在"，所以不会露出来、也不会先跳一下
//   3. 300ms 内数据回来 ⇒ 骨架直接硬切掉，不放淡出、不放进场（才闪 3~5 帧，加动画反而更明显）
//   4. 超过 300ms ⇒ 骨架留到数据落地，120ms 淡出，内容按 i0…i7 依次顶出来
//   5. 只在本次进入页面后的首次加载跑；下拉刷新 / 切 tab 回来都不重播
//   6. 兜底：2.5s 还没齐也必须落定 —— 骨架永不走是最糟的结局
//
// 用法：
//   const skeleton = require('../../utils/skeleton.js');
//   data: { sk: true, skOut: false, enter: false }
//   onLoad() { this.skGate = skeleton.create(this, { when: () => !this.data.loading }); this.skGate.boot(); }
//   每个「数据到齐」的地方（setData 之后）调 this.skGate.check();
//
// wxml：
//   <view class="sklayer {{skOut ? 'sklayer-out' : ''}}" wx:if="{{sk}}">…骨架…</view>
//   <view class="body {{enter ? 'enter' : ''}}" wx:if="{{!sk}}">
//     <view class="in i0">…</view><view class="in i1">…</view>

const HOLD_MS = 300;   // 亮满这么久才算「真的等过」，之前回来就硬切、不放入场
const MAX_WAIT = 2500; // 兜底：再慢也必须落定
const OUT_MS = 160;    // 骨架淡出 120ms + 40ms 余量

function create(page, opts) {
  const o = opts || {};
  const when = typeof o.when === 'function' ? o.when : function () { return true; };

  let tHold = null;
  let tForce = null;
  let settled = false; // 已经落定（本次进入只落定一次）
  let held = false;    // 骨架已经亮满 HOLD_MS（决定淡出 + 入场放不放）
  let booted = false;  // 已经 boot 过（防止 onShow 重复触发）

  function safeSet(patch) {
    // 页面已经卸载就别再 setData（控制台会报警告，也浪费一次逻辑层通信）
    if (!page || typeof page.setData !== 'function' || page._gone) return;
    page.setData(patch);
  }

  /**
   * 落定。force=true 时忽略 when（兜底超时用）。
   */
  function settle(force) {
    if (settled) return;
    if (!force && !when()) return;
    settled = true;
    clearTimeout(tHold);
    clearTimeout(tForce);
    tHold = null;
    tForce = null;

    if (!held) {
      // 秒回：骨架一共没亮几帧 ⇒ 硬切，不淡出也不放入场（放动画等于把这一下"放大"）
      safeSet({ sk: false, skOut: false, enter: false });
      return;
    }
    // 亮满了：骨架淡出与第一行进场同帧开始，两层交叠，避免「骨架没了、内容还没来」的空帧
    safeSet({ skOut: true, enter: true });
    setTimeout(function () {
      safeSet({ sk: false, skOut: false });
    }, OUT_MS);
  }

  return {
    /** 页面 onLoad 里调一次。 */
    boot: function () {
      if (booted) return;
      booted = true;
      settled = false;
      held = false;

      // 数据可能已经在本地（缓存 / 二次渲染）⇒ 立刻就绪，第一帧直接给内容，骨灰都不留
      if (when()) {
        settle();
        return;
      }
      // ⚠️ 这里**不再延迟显示骨架** —— 骨架由页面 data 的 sk:true 从首帧就画出来，
      //    这个定时器只负责记「已经亮够 300ms 了」，决定落地时放不放淡出 + 入场。
      tHold = setTimeout(function () {
        if (settled) return;
        held = true;
      }, HOLD_MS);
      // 2.5s 兜底：不管 when 真假，必须落定
      tForce = setTimeout(function () {
        settle(true);
      }, MAX_WAIT);
    },

    /** 每个「数据到齐」的地方（setData 之后）调一次，条件满足就落定。 */
    check: function () {
      if (settled) return;
      settle();
    },

    /** 强制落定（接口失败等异常分支用）。 */
    done: function () {
      settle(true);
    },

    /** 下拉刷新后用：不重播骨架，只保证 enter 不会再被打开。 */
    get settled() {
      return settled;
    },
  };
}

module.exports = { create: create, HOLD_MS: HOLD_MS, MAX_WAIT: MAX_WAIT };
