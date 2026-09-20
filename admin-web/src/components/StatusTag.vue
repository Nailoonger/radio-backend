<template>
  <!-- v8：状态胶囊＝浅色底 + 语义字色，无圆点无描边 -->
  <span class="status-tag" :class="`status-${status}`">{{ text }}</span>
</template>

<script setup>
import { computed } from 'vue';

/**
 * 审核状态徽章（点歌 v2 五态统一）
 * status: 0 待审核 / 1 已排期 / 2 已驳回 / 3 候补中 / 4 已补位·待审
 *
 * ⚠️ 1 的点歌叫「已排期」、文稿叫「已通过」—— 文稿没有播出时段，说「排期」不通。
 *    调用方用 label 传进来区分（SubmitList 里 statusLabel(row)）。
 */
const props = defineProps({
  status: { type: [Number, String], default: 0 },
  // 可选自定义文案，例如 点歌的 1 → "已排期"
  label: { type: String, default: '' },
});

const STATUS_MAP = {
  0: { text: '待审核', key: 'pending' },
  1: { text: '已排期', key: 'approved' },
  2: { text: '已驳回', key: 'rejected' },
  3: { text: '候补中', key: 'queued' },
  4: { text: '已补位 · 待审', key: 'promoted' },
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
/* 3 候补中：中性灰 —— 灰色＝在排队、没占位、不需要管理员动手 */
.status-queued {
  color: var(--ink-2);
  background: #ebebee;
}
/* 4 已补位·待审：强调色浅底 —— 唯一「已占位但还没人审、且有截止时间」的状态，必须最显眼 */
.status-promoted {
  color: var(--accent);
  background: var(--acc-bg);
}
.status-unknown {
  color: var(--muted-2);
  background: var(--divider);
}
</style>
