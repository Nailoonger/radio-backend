<template>
  <div class="empty-state">
    <svg class="empty-art" viewBox="0 0 120 100" aria-hidden="true">
      <template v-if="variant === 'content'">
        <rect x="26" y="22" width="68" height="62" rx="7" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.6" />
        <path d="M26 36h68" stroke="#cbd5e1" stroke-width="1.6" />
        <circle cx="36" cy="29" r="2.4" fill="#e2e8f0" />
        <circle cx="44" cy="29" r="2.4" fill="#e2e8f0" />
        <line x1="38" y1="50" x2="82" y2="50" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round" />
        <line x1="38" y1="62" x2="70" y2="62" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round" />
        <line x1="38" y1="74" x2="60" y2="74" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round" />
        <circle cx="90" cy="72" r="17" fill="#eef2ff" stroke="#6366f1" stroke-width="1.8" />
        <path d="M90 64v16M82 72h16" stroke="#6366f1" stroke-width="2.6" stroke-linecap="round" />
      </template>
      <template v-else>
        <rect x="22" y="16" width="62" height="76" rx="7" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.6" />
        <line x1="34" y1="34" x2="66" y2="34" stroke="#cbd5e1" stroke-width="1.6" stroke-linecap="round" />
        <line x1="34" y1="46" x2="72" y2="46" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round" />
        <line x1="34" y1="58" x2="58" y2="58" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round" />
        <circle cx="84" cy="66" r="21" fill="#ecfeff" stroke="#06b6d4" stroke-width="1.8" />
        <path d="M75 66.5l6 6 12-12.5" fill="none" stroke="#06b6d4" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
      </template>
    </svg>

    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>

    <slot name="action" />
  </div>
</template>

<script setup>
/**
 * 表格 / 列表空状态
 * variant: 'review' 审核类（对勾插画） | 'content' 内容类（新增插画）
 */
defineProps({
  variant: { type: String, default: 'review' },
  title: { type: String, default: '暂无数据' },
  description: { type: String, default: '' },
});
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
}
.empty-art {
  width: 120px;
  height: 100px;
  margin-bottom: 14px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: #334155;
}
.empty-desc {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 5px;
}
.empty-state :deep(.el-button) {
  margin-top: 14px;
}
</style>
