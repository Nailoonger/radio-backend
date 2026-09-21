<template>
  <teleport to="body">
    <div v-if="mounted" ref="elRef" class="pm" :style="boxStyle" @click.stop>
      <slot :close="requestClose" />
    </div>
  </teleport>
</template>

<script setup>
/**
 * 就地展开的浮层（PopMenu）
 *
 * 与 el-dropdown 的差别：定位是 `position:fixed` + 手动算，不会被父级的
 * `overflow:hidden` 裁掉；进出是弹簧而不是固定时长，展开到一半点另一个能平滑接管。
 *
 * 用法：
 *   <button ref="btn">年级</button>
 *   <PopMenu v-model="open" :anchor="btn" :width="220"> ... </PopMenu>
 *
 * `anchor` 传**元素本身**（模板 ref），不是选择器。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { createAnim } from '@/utils/spring';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  anchor: { default: null },
  width: { type: [Number, String], default: 220 },
  // 左缘对齐触发点（默认）还是右缘对齐
  align: { type: String, default: 'left' },
  offset: { type: Number, default: 6 },
});
const emit = defineEmits(['update:modelValue', 'closed']);

const mounted = ref(false);
const elRef = ref(null);
const pos = ref({ left: 0, top: 0, ox: 0, oy: 0 });

let anim = null;
let closing = false;
let targetClose = false;

const boxStyle = computed(() => ({
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
  width: typeof props.width === 'number' ? `${props.width}px` : props.width,
  transformOrigin: `${pos.value.ox}px ${pos.value.oy}px`,
}));

function paint(v) {
  const el = elRef.value;
  if (!el) return;
  el.style.opacity = String(v);
  el.style.transform = `translateY(${(1 - v) * -5}px) scale(${0.94 + 0.06 * v})`;
  if (targetClose && v <= 0.01) finish();
}

/** 贴着触发元素放；下方放不下就翻到上方（transform-origin 跟着翻到触发点那一侧） */
function place() {
  const a = props.anchor;
  const el = elRef.value;
  if (!a || !el) return;
  const r = a.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = props.align === 'right' ? r.right - w : r.left;
  left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
  let top = r.bottom + props.offset;
  let flip = false;
  if (top + h > window.innerHeight - 10) {
    top = Math.max(10, r.top - h - props.offset);
    flip = true;
  }
  const ox = Math.max(0, Math.min(r.left + r.width / 2 - left, w));
  pos.value = { left, top, ox, oy: flip ? h : 0 };
}

async function open() {
  closing = false;
  targetClose = false;
  mounted.value = true;
  await nextTick();
  place();
  anim = createAnim(0, paint, { damping: 1, response: 0.3 });
  anim.set(1);
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
}

function close() {
  if (!mounted.value || closing) return;
  closing = true;
  targetClose = true;
  if (anim) anim.set(0);
  else finish();
}

function finish() {
  if (!mounted.value) return;
  mounted.value = false;
  closing = false;
  targetClose = false;
  if (anim) { anim.stop(); anim = null; }
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  emit('closed');
}

function onDocDown(e) {
  const el = elRef.value;
  if (el && el.contains(e.target)) return;
  if (props.anchor && props.anchor.contains && props.anchor.contains(e.target)) return;
  requestClose();
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); requestClose(); }
}

function requestClose() { emit('update:modelValue', false); }

watch(() => props.modelValue, (v) => { if (v) open(); else close(); });

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  if (anim) anim.stop();
});
</script>

<style scoped>
.pm {
  position: fixed;
  z-index: 3000;
  opacity: 0;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.04);
  padding: 6px;
  max-height: 62vh;
  overflow-y: auto;
  will-change: transform, opacity;
}
</style>
