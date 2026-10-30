<template>
  <div class="pp">
    <aside class="pp-aside">
      <div class="pp-brand">伙伴端管理 · 预览 v1</div>
      <div class="pp-note">静态预览：数据是假的，接口调用只打印不真写。点左边逐屏看。</div>
      <a
        v-for="it in items" :key="it.name"
        class="pp-item" :class="{ on: cur === it.name }"
        @click="cur = it.name"
      >{{ it.title }}</a>
    </aside>
    <main class="pp-main">
      <div class="pp-top">
        <b>{{ titleOf }}</b>
        <span>admin-web · 伙伴端</span>
      </div>
      <div class="pp-body">
        <component :is="comp" :key="cur" />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, defineAsyncComponent } from 'vue';

const items = [
  { name: 'accounts', title: '伙伴账号' },
  { name: 'slots', title: '值班时段' },
  { name: 'rules', title: '排班规则' },
  { name: 'schedule', title: '班表' },
  { name: 'availability', title: '可排时间' },
  { name: 'leave', title: '请假审批' },
  { name: 'attendance', title: '考勤' },
  { name: 'drafts', title: '站内稿件' },
  { name: 'feedback', title: '互评' },
];

const MAP = {
  accounts: () => import('@/views/PartnerAccounts.vue'),
  slots: () => import('@/views/PartnerSlots.vue'),
  rules: () => import('@/views/PartnerRules.vue'),
  schedule: () => import('@/views/PartnerSchedule.vue'),
  availability: () => import('@/views/PartnerAvailability.vue'),
  leave: () => import('@/views/PartnerLeave.vue'),
  attendance: () => import('@/views/PartnerAttendance.vue'),
  drafts: () => import('@/views/PartnerDrafts.vue'),
  feedback: () => import('@/views/PartnerFeedback.vue'),
};

const cur = ref('schedule');
const comp = computed(() => defineAsyncComponent(MAP[cur.value]));
const titleOf = computed(() => (items.find((x) => x.name === cur.value) || {}).title || '');

/** 支持 #班表名 直达（截图脚本要用） */
function fromHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
  if (h && MAP[h]) cur.value = h;
}
fromHash();
window.addEventListener('hashchange', fromHash);
</script>

<style>
/* 预览壳自己的样式：只在这个入口生效，不进生产包 */
html, body { margin: 0; height: 100%; }
.pp { display: flex; height: 100vh; font-family: var(--font, sans-serif); background: var(--parchment, #f5f5f7); }
.pp-aside {
  width: 208px; flex: none; background: #fff; border-right: 1px solid var(--hairline, #e0e0e0);
  padding: 16px 12px; overflow-y: auto;
}
.pp-brand { font-size: 15px; font-weight: 600; color: #1d1d1f; margin-bottom: 6px; }
.pp-note { font-size: 11px; color: #7a7a7a; line-height: 1.6; margin-bottom: 12px; }
.pp-item {
  display: block; padding: 9px 10px; border-radius: 10px; font-size: 13px; color: #333;
  cursor: pointer; margin-bottom: 2px;
}
.pp-item:hover { background: #f5f5f7; }
.pp-item.on { background: #e6f0fa; color: #0066cc; font-weight: 600; }
.pp-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pp-top {
  height: 56px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 20px;
  background: #fff; border-bottom: 1px solid var(--hairline, #e0e0e0);
}
.pp-top b { font-size: 16px; font-weight: 600; color: #1d1d1f; }
.pp-top span { font-size: 11.5px; color: #7a7a7a; }
.pp-body { flex: 1; overflow-y: auto; }
</style>
