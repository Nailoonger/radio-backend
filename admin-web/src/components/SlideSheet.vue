<template>
  <teleport to="body">
    <div v-if="mounted" class="ss">
      <div ref="scrimRef" class="ss-scrim" @click="requestClose" />
      <div
        ref="sheetRef"
        class="ss-sheet"
        :style="{ width: boxWidth }"
        role="dialog"
        aria-modal="true"
      >
        <!-- 顶部整条都能抓着拖（往下甩即关） -->
        <header ref="gripRef" class="ss-head">
          <div class="ss-titles">
            <div class="ss-title">{{ title }}</div>
            <div v-if="subtitle" class="ss-sub">{{ subtitle }}</div>
          </div>
          <button type="button" class="ss-x" aria-label="关闭" @click="requestClose">
            <IconClose :size="15" />
          </button>
          <span class="ss-grip" aria-hidden="true"></span>
        </header>

        <div class="ss-body"><slot /></div>

        <footer v-if="$slots.footer" class="ss-foot"><slot name="footer" /></footer>
      </div>
    </div>
  </teleport>
</template>

<script setup>
/**
 * 模态弹层（SlideSheet）
 *
 * 与 el-dialog 的差别（v3 / apple-design 要求的那几件事）：
 *   1. 进出是**弹簧**，不是固定时长 —— 动到一半被新输入接管不会跳帧；
 *   2. **能抓着顶部往下拖着关**：松手时把手势速度当弹簧初速甩出去，甩得快就关，
 *      慢慢拖过头会自己弹回来；往上拖有橡皮筋（渐进抵抗，不是硬停）；
 *   3. 模态＝ scrim 变暗 + 父层后退 3.5%，弹层自身 scale 0.93 → 1。
 *
 * ⚠️ 刻意**不做**「逐帧改 backdrop-filter 半径」：全屏毛玻璃每帧改半径是最贵的一件事，
 *    实测会把渲染进程压崩（截图变空白页）。材料感到场交给 scale + 透明度。
 *
 * 用法：<SlideSheet v-model="open" title="…" subtitle="…" width="860"> … </SlideSheet>
 */
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { createAnim, project, rubberband } from '@/utils/spring';
import { IconClose } from '@/components/icons';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  width: { type: [Number, String], default: 860 },
  closeOnScrim: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue', 'closed']);

const mounted = ref(false);
const scrimRef = ref(null);
const sheetRef = ref(null);
const gripRef = ref(null);

const boxWidth = typeof props.width === 'number' ? `${props.width}px` : props.width;

let sP = null;   // 开合进度 0→1
let sY = null;   // 拖拽位移 px
let closing = false;
let dismissByDrag = false;
let drag = null;

function paint() {
  const el = sheetRef.value;
  if (!el) return;
  const p = sP ? sP.value() : 0;
  const y = sY ? sY.value() : 0;
  const h = el.offsetHeight || 600;
  const fade = 1 - Math.min(Math.abs(y) / h, 1);
  const op = Math.max(0, Math.min(1, p) * fade);

  el.style.opacity = String(op);
  el.style.transform =
    `translate(-50%, -50%) translateY(${18 * (1 - p) + y}px) scale(${0.93 + 0.07 * p})`;
  if (scrimRef.value) scrimRef.value.style.opacity = String(op);
  recede(op);

  // 两种收尾：甩出去的（等淡到 0）／正常关的（等进度回到 0）
  if (dismissByDrag && op <= 0.01) { finish(); requestClose(); return; }
  if (closing && !dismissByDrag && p <= 0.005) finish();
}

/** 父层后退：模态感来自「后面的东西退了一步」，不只是变暗 */
function recede(op) {
  const app = document.getElementById('app');
  if (!app) return;
  const e = Math.max(0, Math.min(1, op));
  if (e > 0.001) {
    app.style.transformOrigin = 'center center';
    app.style.transform = `scale(${1 - 0.035 * e})`;
  } else {
    app.style.transform = '';
  }
}

/* ── 拖拽 ── */
function onDown(e) {
  if (e.button != null && e.button !== 0) return;
  // ⚠️ 按在关闭钮上：绝不能 setPointerCapture —— 捕获后 click 的 target 会变成 header，
  // × 的 click 事件永远不触发（线上真实点击失效的根因；程序化 .click() 不经过 hit-testing 所以测不出来）。
  if (e.target && e.target.closest && e.target.closest('.ss-x')) return;
  const el = sheetRef.value;
  if (!el) return;
  drag = { startY: e.clientY, lastY: e.clientY, lastT: performance.now(), v: 0, h: el.offsetHeight, id: e.pointerId };
  if (sY) sY.stop();
  try { gripRef.value.setPointerCapture(e.pointerId); } catch { /* 不支持就算了 */ }
}

function onMove(e) {
  if (!drag) return;
  const now = performance.now();
  const dt = Math.max(now - drag.lastT, 1);
  drag.v = ((e.clientY - drag.lastY) / dt) * 1000;
  drag.lastY = e.clientY;
  drag.lastT = now;
  const dy = e.clientY - drag.startY;
  if (!sY) return;
  sY.jump(dy >= 0 ? dy : -rubberband(-dy, drag.h, 0.55));
}

function onUp(e) {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  const h = drag.h;
  const v = drag.v;
  drag = null;
  if (!sY) return;
  const predicted = dy + project(v);
  if (predicted > h * 0.3 || dy > h * 0.34) {
    dismissByDrag = true;      // 甩出去：等 paint 里 fade 到 0 再真正关
    sY.set(h + 80, v);
  } else {
    sY.set(0, v);              // 不够快也不够远 → 弹回原位
  }
}

function bindDrag() {
  const g = gripRef.value;
  if (!g) return;
  g.addEventListener('pointerdown', onDown);
  g.addEventListener('pointermove', onMove);
  g.addEventListener('pointerup', onUp);
  g.addEventListener('pointercancel', onUp);
}
function unbindDrag() {
  const g = gripRef.value;
  if (!g) return;
  g.removeEventListener('pointerdown', onDown);
  g.removeEventListener('pointermove', onMove);
  g.removeEventListener('pointerup', onUp);
  g.removeEventListener('pointercancel', onUp);
}

/* ── 开 / 关 ── */
async function open() {
  closing = false;
  dismissByDrag = false;
  mounted.value = true;
  await nextTick();
  bindDrag();
  document.addEventListener('keydown', onKey);
  sP = createAnim(0, paint, { damping: 1, response: 0.42 });
  sY = createAnim(0, paint, { damping: 1, response: 0.42 });
  sP.set(1);
}

function close() {
  if (!mounted.value || closing) return;
  closing = true;
  if (sY) sY.stop();
  if (sP) sP.set(0);
  else finish();
}

function finish() {
  if (!mounted.value) return;
  mounted.value = false;
  closing = false;
  dismissByDrag = false;
  unbindDrag();
  document.removeEventListener('keydown', onKey);
  if (sP) { sP.stop(); sP = null; }
  if (sY) { sY.stop(); sY = null; }
  const app = document.getElementById('app');
  if (app) app.style.transform = '';
  emit('closed');
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
}

function requestClose() { emit('update:modelValue', false); }

watch(() => props.modelValue, (v) => { if (v) open(); else close(); });

onBeforeUnmount(() => {
  unbindDrag();
  document.removeEventListener('keydown', onKey);
  if (sP) sP.stop();
  if (sY) sY.stop();
  const app = document.getElementById('app');
  if (app) app.style.transform = '';
});
</script>

<style scoped>
.ss-scrim {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(29, 29, 31, 0.42);
  opacity: 0;
}
.ss-sheet {
  position: fixed; z-index: 2001;
  left: 50%; top: 50%;
  display: flex; flex-direction: column;
  max-height: calc(100vh - 72px);
  max-width: calc(100vw - 48px);
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 22px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  opacity: 0;
  transform: translate(-50%, -50%);
  will-change: transform, opacity;
}

.ss-head {
  position: relative;
  display: flex; align-items: flex-start; gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--divider);
  flex: none;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.ss-head:active { cursor: grabbing; }
.ss-grip {
  position: absolute; left: 50%; top: 7px;
  width: 36px; height: 4px; margin-left: -18px;
  border-radius: 2px; background: var(--hairline);
}
.ss-titles { min-width: 0; flex: 1; }
.ss-title {
  font-size: var(--fs-2xl); font-weight: 600; color: var(--ink);
  letter-spacing: var(--ls-tight-sm); line-height: var(--lh-2xl);
}
.ss-sub { margin-top: 3px; font-size: var(--fs-sm); color: var(--muted); letter-spacing: var(--ls-wide); }
.ss-x {
  flex: none;
  width: 28px; height: 28px; border-radius: 50%;
  border: none; background: var(--parchment); color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.ss-x:hover { background: var(--hairline); color: var(--ink); }

.ss-body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; }
.ss-foot {
  flex: none;
  display: flex; align-items: center; gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--divider);
  background: var(--canvas);
}
</style>
