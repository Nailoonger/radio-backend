<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ given }}</b><span>条评语</span></div>
      <div class="pv-stat-s">
        {{ weekStart }} 起那一周 · 班表上 {{ onDuty }} 人次在岗
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>

    <div class="pv-note acc">
      <b>互评是匿名的。</b>这里只给「谁收到几条」的聚合数，<b>不给「谁评了谁」的明细</b> ——
      一旦能查到明细，匿名承诺就废了。需要了解情况请当面聊。
    </div>

    <div class="pv-week">
      <button @click="shiftWeek(-7)">← 上一周</button>
      <div class="pv-week-n">{{ weekStart || '—' }}<i>只读</i></div>
      <button @click="shiftWeek(7)">下一周 →</button>
      <button @click="shiftWeek(0)">回到本周</button>
    </div>

    <div class="pv-h">收到几条<span class="pv-h-s">按人聚合，按条数排序</span></div>

    <div class="pv-card">
      <div class="pv-line static" v-for="p in people" :key="p.personId">
        <span class="pv-line-t"><b>{{ p.personName }}</b></span>
        <span class="pv-bd" :class="p.received ? 'acc' : 'off'">{{ p.received }} 条</span>
      </div>
      <div class="pv-empty" v-if="!people.length">这一周还没有互评记录。</div>
    </div>

    <div class="pv-note">
      互评的范围是<b>同一天同一时段搭班的人</b> —— 不跨场次、不评全站。
      一人对一人一场，一周只能评一次。评语上限 200 字，不打分也不打标签。
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import http from '@/utils/http';

const loadError = ref('');
const weekStart = ref('');
const given = ref(0);
const onDuty = ref(0);
const people = ref([]);

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

async function load(w) {
  loadError.value = '';
  try {
    const d = await http.get('/partner/feedback/overview', { params: w ? { week: w } : {} });
    weekStart.value = d.weekStart || '';
    given.value = d.given || 0;
    onDuty.value = d.onDuty || 0;
    people.value = d.people || [];
  } catch (e) {
    loadError.value = `互评统计读取失败：${e.message || '请重试'}`;
  }
}

function shiftWeek(n) {
  if (n === 0 || !weekStart.value) return load('');
  load(addDays(weekStart.value, n));
}

onMounted(() => load(''));
</script>
