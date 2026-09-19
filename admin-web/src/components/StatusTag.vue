<template>
  <!-- v8：状态胶囊＝浅色底 + 语义字色，无圆点无描边 -->
  <span class="status-tag" :class="`status-${status}`">{{ text }}</span>
</template>

<script setup>
import { computed } from 'vue';

/**
 * 审核状态徽章（三态统一）
 * status: 0 待审核 / 1 已通过 / 2 已驳回
 */
const props = defineProps({
  status: { type: [Number, String], default: 0 },
  // 可选自定义文案，例如 "展示中"/"已隐藏"
  label: { type: String, default: '' },
});

const STATUS_MAP = {
  0: { text: '待审核', key: 'pending' },
  1: { text: '已通过', key: 'approved' },
  2: { text: '已驳回', key: 'rejected' },
};

const text = computed(() => props.label || STATUS_MAP[props.status]?.text || '未知');
const status = computed(() => STATUS_MAP[props.status]?.key || 'unknown');
</script>

<style scoped>
.status-tag {
  display: inline-flex;
  align-items: center;
  height: 23px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  letter-spacing: var(--ls-wide-sm);
  border: none;
}

.status-pending {
  color: var(--amber-fg);
  background: var(--amber-bg);
}
.status-approved {
  color: var(--green-fg);
  background: var(--green-bg);
}
.status-rejected {
  color: var(--red-fg);
  background: var(--red-bg);
}
.status-unknown {
  color: var(--muted-2);
  background: var(--divider);
}
</style>
