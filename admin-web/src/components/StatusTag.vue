<template>
  <span class="status-tag" :class="`status-${status}`">
    <span class="status-dot"></span>
    {{ text }}
  </span>
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
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}

.status-pending {
  color: #b45309;
  background: #fffbeb;
  border-color: #fde68a;
}
.status-approved {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}
.status-rejected {
  color: #b91c1c;
  background: #fef2f2;
  border-color: #fecaca;
}
.status-unknown {
  color: #475569;
  background: #f8fafc;
  border-color: #e2e8f0;
}
</style>
