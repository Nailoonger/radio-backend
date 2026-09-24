<template>
  <!-- v8：状态胶囊＝浅色底 + 语义字色，无圆点无描边 -->
  <span class="status-tag" :class="`status-${status}`">{{ text }}</span>
</template>

<script setup>
import { computed } from 'vue';

/**
 * 审核状态徽章（点歌「协议版」八态统一，与后端 songStatusService.ST 一一对应）
 *   0 待审核 / 1 已排期 / 2 已驳回 / 3 候补中 / 4 已补位·待审【v2 遗留·不再产生】
 *   5 已播放 / 6 已通过·待排期 / 7 已取消
 *
 * ⚠️ 这是**派生镜像** status 的口径，真实状态在后端三维里
 *    （review_status / schedule_status / play_status），别在前端反推。
 *
 * ⚠️ 文案按类型分叉，调用方用 label 传进来覆盖：
 *    点歌 1 = 「已排期」、6 = 「已通过 · 待排期」
 *    文稿 1 / 6 = 「已通过」（文稿没有播出时段，说「排期」不通）
 */
const props = defineProps({
  status: { type: [Number, String], default: 0 },
  // 可选自定义文案，例如 文稿的 6 → "已通过"
  label: { type: String, default: '' },
});

const STATUS_MAP = {
  0: { text: '待审核', key: 'pending' },
  1: { text: '已排期', key: 'approved' },
  2: { text: '已驳回', key: 'rejected' },
  3: { text: '候补中', key: 'queued' },
  // 4 是 v2 的「已补位 · 待审」，协议版不再产生；留着只为读旧数据不显示「未知」
  4: { text: '已补位 · 待审', key: 'promoted' },
  5: { text: '已播放', key: 'played' },
  6: { text: '已通过 · 待排期', key: 'approve-wait' },
  7: { text: '已取消', key: 'cancelled' },
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
/* 4 已补位·待审（v2 遗留）：强调色浅底 —— 保留旧样式，避免老数据看起来像异常 */
.status-promoted {
  color: var(--accent);
  background: var(--acc-bg);
}
/* 5 已播放：中性灰。历史态，不抢眼 —— 播出后不需要任何操作了 */
.status-played {
  color: var(--muted-2);
  background: #ebebee;
}
/* 6 已通过·待排期：强调色浅底 —— 唯一「审核已过但还没落座」的中间态，
   是管理员最该盯着催的桶，所以给强调色（协议版新增） */
.status-approve-wait {
  color: var(--accent);
  background: var(--acc-bg);
}
/* 7 已取消：中性灰。学生自己撤销的，行不删只改状态（协议版新增） */
.status-cancelled {
  color: var(--muted-2);
  background: #ebebee;
}
.status-unknown {
  color: var(--muted-2);
  background: var(--divider);
}
</style>
