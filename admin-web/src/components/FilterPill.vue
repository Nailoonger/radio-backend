<template>
  <div class="fp">
    <button
      ref="btnRef"
      type="button"
      class="fp-btn"
      :class="{ on: hasValue, dis: disabled }"
      :disabled="disabled"
      :title="disabled ? disabledHint : label"
      @click="toggle"
    >
      <span class="fp-k">{{ label }}</span>
      <span class="fp-v">{{ disabled ? disabledHint : (display || placeholder) }}</span>
      <IconChevronDown :size="13" class="fp-c" :class="{ up: open }" />
    </button>

    <PopMenu v-model="open" :anchor="btnRef" :width="width" align="left">
      <div class="fp-menu">
        <button type="button" class="fp-opt" :class="{ sel: !hasValue }" @click="pick('')">
          <span class="fp-ol">{{ clearText }}</span>
          <IconCheck v-if="!hasValue" :size="14" class="fp-ck" />
        </button>
        <div v-if="!options.length" class="fp-empty">
          {{ loading ? '读取中…' : emptyText }}
        </div>
        <button
          v-for="o in options" :key="o.value" type="button"
          class="fp-opt" :class="{ sel: String(o.value) === String(modelValue) }"
          @click="pick(o.value)"
        >
          <span class="fp-ol">{{ o.label }}</span>
          <em v-if="o.hint" class="fp-oh">{{ o.hint }}</em>
          <IconCheck v-if="String(o.value) === String(modelValue)" :size="14" class="fp-ck" />
        </button>
      </div>
    </PopMenu>
  </div>
</template>

<script setup>
/**
 * 筛选条件胶囊（FilterPill）
 *
 * 一个条件＝一枚胶囊，点开是就地浮层。用来替代原来那排 el-select：
 * 条件读起来是「年级 2024级 / 班级 01班」，而不是几个看不出当前值的下拉框。
 *
 * ⚠️ 班级这类「级联」条件：没选年级时传 `disabled` + `disabledHint="先选年级"`，
 *    **不要**偷偷给一份全量班级 —— 那正是之前「子目录和主目录混淆」的坑。
 */
import { ref, computed } from 'vue';
import PopMenu from '@/components/PopMenu.vue';
import { IconChevronDown, IconCheck } from '@/components/icons';

const props = defineProps({
  label: { type: String, required: true },
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },   // [{ value, label, hint? }]
  placeholder: { type: String, default: '全部' },
  clearText: { type: String, default: '不限' },
  emptyText: { type: String, default: '没有可选项' },
  width: { type: [Number, String], default: 200 },
  disabled: { type: Boolean, default: false },
  disabledHint: { type: String, default: '先选年级' },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

const open = ref(false);
const btnRef = ref(null);

const hasValue = computed(() => props.modelValue !== '' && props.modelValue !== null && props.modelValue !== undefined);
const display = computed(() => {
  const hit = props.options.find((o) => String(o.value) === String(props.modelValue));
  return hit ? hit.label : '';
});

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}
function pick(v) {
  emit('update:modelValue', v);
  emit('change', v);
  open.value = false;
}
</script>

<style scoped>
.fp { display: inline-flex; flex: none; }

.fp-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 13px;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease), box-shadow 0.16s var(--ease);
  max-width: 280px;
}
.fp-btn:hover { border-color: var(--soft); background: var(--parchment); }
.fp-btn:active { transform: scale(0.985); }
.fp-btn.on { border-color: transparent; background: var(--acc-bg); color: var(--accent); }
.fp-btn.dis { border-style: dashed; color: var(--soft); cursor: not-allowed; background: var(--canvas); }
.fp-btn.dis:hover { background: var(--canvas); border-color: var(--hairline); }

.fp-k { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); flex: none; }
.fp-btn.on .fp-k { color: var(--accent); opacity: 0.75; }
.fp-btn.dis .fp-k { color: var(--soft); }
.fp-v {
  font-size: var(--fs-md); font-weight: 600; color: inherit;
  max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fp-btn.dis .fp-v { font-weight: 400; }
.fp-c { flex: none; color: var(--soft); transition: transform 0.18s var(--ease); }
.fp-c.up { transform: rotate(180deg); }
.fp-btn.on .fp-c { color: var(--accent); }

/* ── 菜单 ── */
.fp-menu { display: flex; flex-direction: column; }
.fp-opt {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 10px; border: none; background: transparent;
  border-radius: 9px; cursor: pointer; text-align: left;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
  transition: background 0.12s var(--ease);
}
.fp-opt:hover { background: var(--parchment); }
.fp-opt.sel { color: var(--accent); font-weight: 600; }
.fp-ol { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-oh { font-style: normal; font-size: var(--fs-xs); color: var(--muted-2); flex: none; font-weight: 400; }
.fp-ck { flex: none; align-self: center; }
.fp-empty { padding: 10px; font-size: var(--fs-sm); color: var(--muted); text-align: center; }
</style>
