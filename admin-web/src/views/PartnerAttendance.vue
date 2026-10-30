<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ summary.marked || 0 }}</b><span>/ {{ summary.posts || 0 }} 人次已点</span></div>
      <div class="pv-stat-s">
        到岗 {{ summary.present || 0 }} · 缺岗 {{ summary.absent || 0 }} · 请假 {{ summary.leave || 0 }}
        <br />{{ weekStart }} 起那一周
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note" v-if="!err && !summary.posts">
      这一周<b>班表还是空的</b>。没有班表就没有考勤 —— 先去「班表」排一版并发布。
    </div>
    <div class="pv-note" v-if="!err">
      已批准的请假会<b>自动记成请假</b>，不用手点。点了「到岗 / 缺岗」会覆盖它。
    </div>

    <div class="pv-week">
      <button @click="shiftWeek(-7)">← 上一周</button>
      <div class="pv-week-n">{{ weekStart || '—' }}<i>按场点名</i></div>
      <button @click="shiftWeek(7)">下一周 →</button>
      <button @click="shiftWeek(0)">回到本周</button>
    </div>

    <!-- ══════ 按天点名 ══════ -->
    <div class="pv-card pad" v-for="d in days" :key="d.day" style="margin-bottom: 12px;">
      <div class="at-day">{{ d.dayName }}<span>{{ d.day }}</span><em>{{ d.total }} 人次</em></div>
      <div class="at-slot" v-for="s in d.slots" :key="s.slot">
        <div class="at-slot-h">{{ s.slot }}</div>
        <div class="at-people">
          <div class="at-one" v-for="p in s.people" :key="p.personId">
            <span class="at-nm">
              {{ p.personName }}
              <i v-if="p.department">{{ p.department }}</i>
              <em v-if="p.onLeave" class="lv">已请假</em>
            </span>
            <span class="at-btns">
              <button :class="{ on: p.status === 1 }" @click="setMark(d, s, p, 1)">到岗</button>
              <button :class="{ on: p.status === 0 }" @click="setMark(d, s, p, 0)">缺岗</button>
              <button :class="{ on: p.status === 2 }" @click="setMark(d, s, p, 2)">请假</button>
            </span>
          </div>
          <div class="pv-empty" v-if="!s.people.length">这一场没人。</div>
        </div>
      </div>
      <div class="pv-empty" v-if="!d.slots.length">这一天没有排班。</div>
    </div>

    <!-- ══════ 总览 ══════ -->
    <div class="pv-h">总览<span class="pv-h-s">按人汇总</span></div>
    <div class="pv-card">
      <table class="pv-grid">
        <thead>
          <tr>
            <th>成员</th><th>应到</th><th>到岗</th><th>缺岗</th><th>请假</th><th>未点</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in people" :key="p.name">
            <td>{{ p.name }}</td>
            <td class="n">{{ p.posts }}</td>
            <td class="n">{{ p.present }}</td>
            <td class="n">{{ p.absent }}</td>
            <td class="n">{{ p.leave }}</td>
            <td class="n">{{ p.unmarked }}</td>
          </tr>
        </tbody>
      </table>
      <div class="pv-empty" v-if="!people.length">这一周没有考勤数据。</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';

const err = ref('');
const loadError = ref('');
const weekStart = ref('');
const days = ref([]);
const summary = ref({});
const people = ref([]);

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

async function loadWeek(w) {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/attendance/week', { params: w ? { week: w } : {} });
    weekStart.value = d.weekStart || '';
    days.value = d.days || [];
    summary.value = d.summary || {};
  } catch (e) {
    loadError.value = `考勤读取失败：${e.message || '请重试'}`;
  }
}

async function loadOverview() {
  if (!weekStart.value) return;
  try {
    const d = await http.get('/partner/attendance/overview', { params: { week: weekStart.value } });
    people.value = d.people || [];
  } catch (e) {
    people.value = [];
  }
}

async function reloadAll(w) {
  await loadWeek(w);
  await loadOverview();
}

function shiftWeek(n) {
  if (n === 0 || !weekStart.value) return reloadAll('');
  reloadAll(addDays(weekStart.value, n));
}

async function setMark(d, s, p, status) {
  const next = p.status === status ? null : status;
  try {
    const r = await http.put('/partner/attendance', {
      weekStart: weekStart.value,
      day: d.day,
      slot: s.slot,
      records: [{ personId: p.personId, status: next === null ? (p.onLeave ? 2 : 0) : next }],
    });
    days.value = r.days || days.value;
    await loadOverview();
  } catch (e) {
    ElMessage.error(e.message || '点名失败');
  }
}

onMounted(() => reloadAll(''));
</script>

<style scoped>
.at-day {
  display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-lg); font-weight: 600;
  letter-spacing: var(--ls-tight-sm); color: var(--ink); margin-bottom: 10px;
}
.at-day span { font-size: var(--fs-xs); font-weight: 400; color: var(--muted); letter-spacing: 0; }
.at-day em { margin-left: auto; font-style: normal; font-size: var(--fs-xs); color: var(--muted); font-weight: 400; }
.at-slot { padding: 8px 0; border-top: 1px solid var(--divider); }
.at-slot-h { font-size: var(--fs-sm); color: var(--muted); margin-bottom: 6px; }
.at-people { display: flex; flex-direction: column; gap: 8px; }
.at-one { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.at-nm { font-size: var(--fs-md); color: var(--ink); }
.at-nm i { font-style: normal; font-size: var(--fs-xs); color: var(--muted); margin-left: 6px; }
.at-nm .lv {
  font-style: normal; font-size: var(--fs-2xs); margin-left: 6px; padding: 2px 6px;
  border-radius: var(--r-pill); background: var(--amber-bg); color: var(--amber-fg);
}
.at-btns { display: flex; gap: 6px; margin-left: auto; }
.at-btns button {
  min-height: 30px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--hairline);
  background: var(--canvas); color: var(--muted); font-size: var(--fs-sm); font-family: inherit; cursor: pointer;
}
.at-btns button.on { background: var(--acc-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
</style>
