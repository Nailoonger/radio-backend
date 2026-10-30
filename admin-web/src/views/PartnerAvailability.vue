<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ summary.confirmed || 0 }}</b><span>/ {{ summary.total || 0 }} 人已填</span></div>
      <div class="pv-stat-s">
        {{ weekStart }} 起那一周<template v-if="slotVersion"> · 时段第 {{ slotVersion }} 版</template>
        <br />未填 {{ summary.pending || 0 }} 人
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note warn" v-if="!err && !ready">
      本周的<b>值班时段还没发布</b>，站员没东西可填。先去「值班时段」发一版。
    </div>
    <div class="pv-note" v-if="!err && ready && !slots.length">时段已发布但里面没有时段。</div>

    <div class="pv-week">
      <button @click="shiftWeek(-7)">← 上一周</button>
      <div class="pv-week-n">{{ weekStart || '—' }}<i>周一 ~ 周五</i></div>
      <button @click="shiftWeek(7)">下一周 →</button>
      <button @click="shiftWeek(0)">回到本周</button>
    </div>

    <div class="pv-h">填报情况<span class="pv-h-s">点一行可以代录 / 撤销</span></div>

    <div class="pv-card">
      <div class="pv-line" v-for="r in rows" :key="r.personId" @click="openWho(r)">
        <span class="pv-line-t">
          <b>{{ r.name }}</b>
          <i>
            {{ r.department || '未填部门' }}
            <template v-if="r.dutyRoles && r.dutyRoles.length"> · {{ r.dutyRoles.join('、') }}</template>
            <template v-if="r.confirmedAt"> · {{ fmtTime(r.confirmedAt) }}</template>
          </i>
        </span>
        <span class="pv-bd" :class="r.stale ? 'warn' : (r.confirmed ? 'ok' : 'off')">
          {{ r.stale ? '时段已变·需重填' : (r.confirmed ? `能来 ${r.canCount} 格` : '未填') }}
        </span>
        <span class="pv-bd off" v-if="r.source === 'proxy'">代录</span>
        <span class="ar">›</span>
      </div>
      <div class="pv-empty" v-if="!rows.length">人员池是空的 —— 先去「伙伴账号」把站员加进来。</div>
    </div>

    <!-- ══════ 单个人：看 / 代录 ══════ -->
    <div class="pv-sheet" v-if="who">
      <div class="pv-mask" @click="who = null"></div>
      <div class="pv-sheet-body tall">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd">
          <b>{{ who.name }}</b>
          <span class="pv-bd" :class="who.confirmed ? 'ok' : 'off'">{{ who.confirmed ? '已填' : '未填' }}</span>
        </div>
        <p class="pv-sh-sub">
          {{ weekStart }} 那一周<template v-if="who.department"> · {{ who.department }}</template>
          <br /><span class="pv-micro">社干代录要写原因（谁授权、为什么替他填）—— 这条会留在记录里。</span>
        </p>

        <div class="av-grid" v-if="slots.length">
          <div class="av-day" v-for="(g, di) in grouped" :key="di">
            <div class="av-day-h">周{{ DAY_CN[di] }}<span>{{ weekDates[di] ? weekDates[di].slice(5) : '' }}</span></div>
            <button
              v-for="s in g" :key="s.slotKey"
              class="av-pick" :class="{ on: pickOf(s.slotKey) === true, off: pickOf(s.slotKey) === false }"
              @click="toggle(s.slotKey)"
            >
              <b>{{ s.title }}</b><i>{{ s.timeText }}</i>
            </button>
          </div>
        </div>
        <div class="pv-empty" v-else>没有可填的时段。</div>

        <div class="pv-h" style="margin-top: 14px;">
          {{ needReason ? '代录原因（必填）' : '填报说明（有「不能来」时必填）' }}
        </div>
        <textarea class="pv-ta" v-model="reason" rows="2" maxlength="200" placeholder="如：本人请假，电话授权由我代填"></textarea>

        <div class="pv-btnrow">
          <button class="pv-btn ghost" :disabled="saving" @click="savePicks">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="pv-btn danger" :disabled="saving || !who.confirmed" @click="resetPicks">撤销填报</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';

const DAY_CN = ['一', '二', '三', '四', '五'];

const err = ref('');
const loadError = ref('');
const weekStart = ref('');
const weekDates = ref([]);
const slotVersion = ref(0);
const slots = ref([]);
const ready = ref(false);
const rows = ref([]);
const summary = ref({});
const who = ref(null);
const picks = ref({});          // slotKey -> true/false/undefined
const reason = ref('');
const saving = ref(false);

const needReason = computed(() => {
  // 代录（不是我自己）必须写原因；本人填报只有在勾了「不能来」时才必填
  return Object.values(picks.value).some((v) => v === false);
});

const grouped = computed(() => {
  const out = [[], [], [], [], []];
  (slots.value || []).forEach((s) => {
    const d = Number(s.day) || 0;
    if (out[d]) out[d].push(s);
  });
  return out;
});

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}
function pickOf(k) {
  const v = picks.value[k];
  return v === true ? true : (v === false ? false : undefined);
}
function toggle(k) {
  const cur = picks.value[k];
  if (cur === true) picks.value[k] = false;
  else if (cur === false) delete picks.value[k];
  else picks.value[k] = true;
  picks.value = Object.assign({}, picks.value);
}

async function load(w) {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/availability', { params: w ? { week: w } : {} });
    weekStart.value = d.weekStart || '';
    weekDates.value = d.weekDates || [];
    slotVersion.value = Number(d.slotVersion) || 0;
    slots.value = d.slots || [];
    ready.value = !!d.ready;
    summary.value = d.summary || {};
    rows.value = (d.summary && d.summary.rows) || [];
  } catch (e) {
    loadError.value = `可排时间读取失败：${e.message || '请重试'}`;
  }
}

function openWho(r) {
  who.value = r;
  reason.value = '';
  loadOne(r.personId);
}

async function loadOne(personId) {
  try {
    const d = await http.get('/partner/availability', { params: { week: weekStart.value, personId } });
    const doc = d.target || d.me;
    const map = {};
    ((doc && doc.picks) || []).forEach((p) => { map[p.slotKey] = !!p.can; });
    picks.value = map;
    reason.value = (doc && doc.reason) || '';
  } catch (e) {
    ElMessage.error(e.message || '读取失败');
  }
}

async function savePicks() {
  const list = Object.keys(picks.value)
    .filter((k) => picks.value[k] !== undefined)
    .map((k) => ({ slotKey: k, can: picks.value[k] === true }));
  if (!list.length) {
    ElMessage.warning('至少点一个时段（点一下=能来，再点一下=不能来，第三下=不表态）');
    return;
  }
  if (needReason.value && String(reason.value || '').trim().length < 2) {
    ElMessage.warning('有「不能来」的时段，先写说明（至少 2 个字）');
    return;
  }
  saving.value = true;
  try {
    await http.put('/partner/availability', {
      week: weekStart.value,
      personId: who.value.personId,
      picks: list,
      reason: String(reason.value || '').trim(),
    });
    ElMessage.success('已保存');
    who.value = null;
    await load(weekStart.value);
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function resetPicks() {
  saving.value = true;
  try {
    await http.delete('/partner/availability', { data: { week: weekStart.value, personId: who.value.personId } });
    ElMessage.success('已撤销，这一周他回到「未填」');
    who.value = null;
    await load(weekStart.value);
  } catch (e) {
    ElMessage.error(e.message || '撤销失败');
  } finally {
    saving.value = false;
  }
}

function shiftWeek(n) {
  if (n === 0 || !weekStart.value) return load('');
  load(addDays(weekStart.value, n));
}

onMounted(() => load(''));
</script>

<style scoped>
.av-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
.av-day { display: flex; flex-direction: column; gap: 6px; }
.av-day-h {
  font-size: var(--fs-xs); color: var(--muted); text-align: center; padding-bottom: 4px;
  border-bottom: 1px solid var(--hairline);
}
.av-day-h span { display: block; font-size: var(--fs-2xs); color: var(--soft); }
.av-pick {
  border: 1px solid var(--hairline); background: var(--canvas); border-radius: 12px;
  padding: 8px 4px; cursor: pointer; font-family: inherit; text-align: center;
}
.av-pick b { display: block; font-size: var(--fs-sm); font-weight: 500; color: var(--ink); }
.av-pick i { display: block; font-style: normal; font-size: var(--fs-2xs); color: var(--muted); margin-top: 2px; }
.av-pick.on { background: var(--acc-bg); border-color: var(--accent); }
.av-pick.on b { color: var(--accent); }
.av-pick.off { background: var(--parchment); opacity: .55; text-decoration: line-through; }
</style>
