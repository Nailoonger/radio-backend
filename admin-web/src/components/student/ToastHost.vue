<template>
  <Teleport to="body">
    <div class="th" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="t in items" :key="t.id" class="toast">
          <component :is="t.icon || IconCheck" :size="14" class="toast-ic" />
          <span class="toast-txt">{{ t.text }}</span>
          <button v-if="t.undo" type="button" class="toast-undo" @click="runUndo(t)">撤销</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 轻反馈 toast（学生账号 v3）
 *
 * 与 ElMessage 的差别就一条：**能带「撤销」**。
 * v3 的原则是「日常动作（改名 / 停用）不弹二次确认，改成一条可撤销的 toast」——
 * ElMessage 塞不进撤销按钮，所以自绘。深色毛玻璃胶囊，底部居中（与批量浮条同轴）。
 *
 * 用法：
 *   const toast = ref(null);
 *   toast.value.push({ text: '已停用 张三', undo: () => rollback() });
 */
import { ref } from 'vue';
import { IconCheck } from '@/components/icons';

const items = ref([]);
let seq = 0;

function push({ text = '', icon = null, undo = null, ms = 0 } = {}) {
  const item = { id: ++seq, text, icon, undo };
  // 同屏最多 3 条：新的顶掉最老的
  while (items.value.length >= 3) items.value.shift();
  items.value.push(item);
  const life = ms || (undo ? 5600 : 2600);
  setTimeout(() => dismiss(item.id), life);
  return item.id;
}

function runUndo(t) {
  try { t.undo?.(); } catch { /* 撤销失败不炸 UI */ }
  dismiss(t.id);
}

function dismiss(id) {
  const i = items.value.findIndex((x) => x.id === id);
  if (i >= 0) items.value.splice(i, 1);
}

defineExpose({ push, dismiss });
</script>

<style scoped>
.th {
  position: fixed;
  left: calc(50% + 116px);   /* 内容区中轴（侧栏 232px 的一半） */
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 17px;
  border-radius: var(--r-pill);
  background: rgba(39, 39, 41, 0.86);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  color: #fff;
  font-size: var(--fs-sm);
  font-weight: 500;
  letter-spacing: var(--ls-wide);
  white-space: nowrap;
  box-shadow: 0 14px 40px -14px rgba(0, 0, 0, 0.26), 0 2px 8px -2px rgba(0, 0, 0, 0.1);
}
.toast-ic { flex: none; opacity: 0.9; }
.toast-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.toast-undo {
  flex: none;
  border: none; background: transparent; cursor: pointer;
  font-family: inherit; font-size: var(--fs-xs); font-weight: 600;
  color: #6cb6ff; padding: 2px 4px;
}
.toast-undo:hover { text-decoration: underline; }

.toast-enter-active { transition: opacity 0.28s cubic-bezier(0.34, 1.4, 0.64, 1), transform 0.32s cubic-bezier(0.34, 1.4, 0.64, 1); }
.toast-leave-active { transition: opacity 0.18s var(--ease), transform 0.18s var(--ease); }
.toast-enter-from { opacity: 0; transform: translateY(14px); }
.toast-leave-to { opacity: 0; transform: translateY(10px); }
</style>
