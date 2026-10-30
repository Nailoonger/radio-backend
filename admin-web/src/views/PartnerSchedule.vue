<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ week.total || 0 }}</b><span>个岗位已排</span></div>
      <div class="pv-stat-s">
        状态 {{ stateText }}<template v-if="week.version"> · 第 {{ week.version }} 版</template>
        <template v-if="week.publishedAt"> · {{ fmtTime(week.publishedAt) }} 发布</template>
        <br />缺岗 {{ missingList.length }} 格 · 手改 {{ manualCount }} 格
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note warn" v-if="!err && week.state === 'published'">
      这一周<b>已发布</b>，不能再改。要调整先「撤回」—— 撤回只改状态，班表内容原样保留。
    </div>
    <div class="pv-note" v-if="!err && !slotDefs.length">
      还没有<b>已发布的值班时段</b>。先去「值班时段」发一版，才能生成班表。
    </div>

    <!-- ══════ 周切换 ══════ -->
    <div class="pv-week">
      <button @click="shiftWeek(-7)">← 上一周</button>
      <div class="pv-week-n">
        {{ weekStart }} 起那一周<i>{{ weekRangeText }}</i>
      </div>
      <button @click="shiftWeek(7)">下一周 →</button>
      <button @click="shiftWeek(0)">回到本周</button>
    </div>

    <!-- ══════ 周视图 ══════ -->
    <div class="pv-h">
      班表<span class="pv-h-s">点一格可以换人</span>
      <span class="pv-h-r">{{ canManage ? '社干 / 超管可编辑' : '只读' }}</span>
    </div>

    <div class="pv-card pad" v-if="matrix.length">
      <table class="pv-grid wk">
        <thead>
          <tr>
            <th style="width: 110px;">时段</th>
            <th v-for="(d, i) in days" :key="d.day">{{ d.dayName }}<br /><span class="dt">{{ d.day.slice(5) }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in matrix" :key="row.slot">
            <td>
              <b>{{ row.slot }}</b>
              <i v-if="row.timeText">{{ row.timeText }}</i>
            </td>
            <td v-for="(d, i) in days" :key="d.day">
              <div class="cell" :class="{ miss: cellMiss(d.day, row.slot) }">
                <span class="pv-pill" :class="{ me: false }" v-for="p in peopleOf(d.day, row.slot)" :key="p.personId">
                  {{ p.personName }}<i v-if="p.source === 'manual'">手改</i>
                </span>
                <span class="pv-pill empty" v-if="!peopleOf(d.day, row.slot).length">空</span>
                <button class="cell-edit" v-if="canManage && week.state !== 'published'" @click="openCell(d.day, row.slot)">改</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="pv-card pad" v-else>
      <div class="pv-empty">这一周还没有班表。点下面「生成草稿」自动排一版。</div>
    </div>

    <!-- ══════ 缺岗 ══════ -->
    <div class="pv-h" v-if="missingList.length">缺岗<span class="pv-h-s">硬约束优先，宁缺不凑</span></div>
    <div class="pv-card" v-if="missingList.length">
      <div class="pv-line static" v-for="(m, i) in missingList" :key="i">
        <span class="pv-line-t">
          <b>{{ dayNameOf(m.day) }} · {{ m.slot }}</b>
          <i>应到 {{ m.need }} 人 · 已排 {{ m.got }} 人</i>
        </span>
        <span class="pv-bd err">缺 {{ m.need - m.got }}</span>
      </div>
    </div>

    <!-- ══════ 动作 ══════ -->
    <div class="pv-btnrow">
      <button class="pv-btn ghost" :disabled="!canManage || busy" @click="doGenerate(false)">
        {{ week.total ? '重新生成' : '生成草稿' }}
      </button>
      <button class="pv-btn ghost" :disabled="!canManage || busy" @click="doGenerate(true)">强制重排</button>
      <button class="pv-btn primary" v-if="week.state !== 'published'" :disabled="!canManage || busy || !week.total" @click="doPublish">发布</button>
      <button class="pv-btn danger" v-else :disabled="!canManage || busy" @click="doWithdraw">撤回</button>
      <button class="pv-btn ghost" :disabled="!matrix.length" @click="exportCsv">导出 CSV</button>
    </div>
    <div class="pv-note" v-if="!err">
      「重新生成」遇到已发布的周会拒绝；「强制重排」会覆盖这一周的草稿内容。
      生成只动<b>草稿</b>，已发布的周必须显式撤回。
    </div>

    <!-- ══════ 本月场次 ══════ -->
    <div class="pv-h">人员轮值<span class="pv-h-s">{{ month }} · 按周起点归属</span></div>
    <div class="pv-card">
      <div class="pv-line static" v-for="p in monthList" :key="p.personId">
        <span class="pv-line-t"><b>{{ p.personName }}</b></span>
        <span class="pv-bd" :class="p.count >= 3 ? 'acc' : 'off'">{{ p.count }} 场</span>
      </div>
      <div class="pv-empty" v-if="!monthList.length">本月还没有排班记录。</div>
    </div>

    <!-- ══════ 改一格 ══════ -->
    <div class="pv-sheet" v-if="cell">
      <div class="pv-mask" @click="cell = null"></div>
      <div class="pv-sheet-body tall">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd">
          <b>{{ dayNameOf(cell.day) }} · {{ cell.slot }}</b>
          <span class="pv-bd" :class="cellPeople.length >= cellNeed ? 'ok' : 'err'">
            {{ cellPeople.length }} / {{ cellNeed }} 人
          </span>
        </div>
        <p class="pv-sh-sub">
          点名字移出这一格，点下面「加入」补人。<br />
          <span class="pv-micro">候选按「本周已填可排时间」标绿；没填的人也能加（社干知道有人能临时顶）。</span>
        </p>

        <div class="pv-h" style="margin-top: 4px;">这一格现在有谁</div>
        <div class="pv-card pad">
          <div class="pv-line static" v-for="p in cellPeople" :key="p.personId">
            <span class="pv-line-t"><b>{{ p.personName }}</b><i>{{ p.department || '未填部门' }}</i></span>
            <button class="pv-btn sm danger" @click="dropPerson(p.personId)">移出</button>
          </div>
          <div class="pv-empty" v-if="!cellPeople.length">还没有人 —— 这一格发布后会是缺岗。</div>
        </div>

        <div class="pv-h">候选</div>
        <div class="pv-card">
          <div class="pv-line" v-for="c in candList" :key="c.personId" @click="addPerson(c)">
            <span class="pv-line-t">
              <b>{{ c.name }}</b>
              <i>{{ c.department || '未填部门' }} · {{ c.confirmed ? `已填可排（${c.canCount} 格）` : '本周还没填可排' }}</i>
            </span>
            <span class="pv-bd" :class="c.confirmed ? 'ok' : 'off'">{{ c.confirmed ? '可排' : '未填' }}</span>
            <span class="ar">＋</span>
          </div>
          <div class="pv-empty" v-if="!candList.length">没有可加的人了。</div>
        </div>

        <div class="pv-btnrow">
          <button class="pv-btn ghost" @click="cell = null">完成</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
/** 能排班的是超管(0) / 社干(1)；站员(2)不进电脑端，这里再兜一层，别只靠服务端报错 */
const canManage = computed(() => Number(auth.admin?.role) === 0 || Number(auth.admin?.role) === 1);

const DAY_CN = ['周一', '周二', '周三', '周四', '周五'];

const err = ref('');
const loadError = ref('');
const busy = ref(false);
const weekStart = ref('');
const week = ref({ total: 0, state: 'empty', days: [], slotOrder: [] });
const slotDefs = ref([]);
const monthList = ref([]);
const month = ref('');
const cell = ref(null);
const availRows = ref([]);

const days = computed(() => week.value.days || []);
const stateText = computed(() => ({ empty: '还没生成', draft: '草稿', published: '已发布' }[week.value.state] || week.value.state));

/** 行的集合 = 已发布时段模板 ∪ 班表里实际出现的时段 */
const matrix = computed(() => {
  const order = [];
  const seen = {};
  (week.value.slotOrder || []).forEach((s) => { if (!seen[s]) { seen[s] = 1; order.push({ slot: s, timeText: '' }); } });
  (week.value.days || []).forEach((d) => (d.slots || []).forEach((s) => {
    if (!seen[s.slot]) { seen[s.slot] = 1; order.push({ slot: s.slot, timeText: s.timeText || '' }); }
  }));
  (slotDefs.value || []).forEach((s) => {
    if (!seen[s.title]) { seen[s.title] = 1; order.push({ slot: s.title, timeText: s.timeText || '' }); }
  });
  return order;
});

const manualCount = computed(() => {
  let n = 0;
  (week.value.days || []).forEach((d) => (d.slots || []).forEach((s) => (s.people || []).forEach((p) => {
    if (p.source === 'manual') n += 1;
  })));
  return n;
});

/** 缺岗：应到（时段模板 count） vs 已排 */
const missingList = computed(() => {
  const out = [];
  (week.value.days || []).forEach((d) => {});
  (days.value || []).forEach((d) => {
    const idx = days.value.indexOf(d);
    (slotDefs.value || []).forEach((sd) => {
      if (Number(sd.day) !== idx) return;
      const got = peopleOf(d.day, sd.title).length;
      const need = Math.max(1, Number(sd.count) || 1);
      if (got < need) out.push({ day: d.day, slot: sd.title, need, got });
    });
  });
  return out;
});

function peopleOf(day, slot) {
  const d = (week.value.days || []).find((x) => x.day === day);
  if (!d) return [];
  const s = (d.slots || []).find((x) => x.slot === slot);
  return s ? (s.people || []) : [];
}
function cellMiss(day, slot) {
  return missingList.value.some((m) => m.day === day && m.slot === slot);
}
function dayNameOf(day) {
  const i = (week.value.days || []).findIndex((x) => x.day === day);
  return i >= 0 ? DAY_CN[i] : day;
}
const weekRangeText = computed(() => {
  if (!days.value.length) return '';
  return `${days.value[0].day.slice(5)} ~ ${days.value[days.value.length - 1].day.slice(5)}`;
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

async function loadWeek(w) {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/schedule', { params: w ? { week: w } : {} });
    week.value = d || { total: 0, state: 'empty', days: [], slotOrder: [] };
    weekStart.value = String(d.weekStart || '');
  } catch (e) {
    loadError.value = `班表读取失败：${e.message || '请重试'}`;
  }
}

async function loadSlots() {
  try {
    const d = await http.get('/partner/slots/published');
    slotDefs.value = (d.published && d.published.slots) || [];
  } catch (e) {
    slotDefs.value = [];
  }
}

async function loadMonth() {
  if (!weekStart.value) return;
  const ym = weekStart.value.slice(0, 7);
  try {
    const d = await http.get('/partner/schedule/month', { params: { month: ym } });
    month.value = d.month || ym;
    monthList.value = d.list || [];
  } catch (e) {
    monthList.value = [];
  }
}

async function loadAvail() {
  try {
    const d = await http.get('/partner/availability', { params: { week: weekStart.value } });
    availRows.value = (d.summary && d.summary.rows) || [];
  } catch (e) {
    availRows.value = [];
  }
}

async function reloadAll(w) {
  await loadWeek(w);
  await Promise.all([loadSlots(), loadMonth(), loadAvail()]);
}

function shiftWeek(n) {
  if (n === 0) return reloadAll('');
  if (!weekStart.value) return;
  reloadAll(addDays(weekStart.value, n));
}

async function doGenerate(force) {
  if (!weekStart.value) return;
  busy.value = true;
  try {
    const d = await http.put('/partner/schedule/generate', { weekStart: weekStart.value, force: !!force });
    week.value = d.week || week.value;
    const miss = (d.missing || []).length;
    ElMessage[miss ? 'warning' : 'success'](
      miss ? `排好 ${d.generated} 个岗位，有 ${miss} 格缺岗（硬约束优先，没硬凑）` : `排好 ${d.generated} 个岗位`
    );
  } catch (e) {
    ElMessage.error(e.message || '生成失败');
  } finally {
    busy.value = false;
  }
}

async function doPublish() {
  busy.value = true;
  try {
    const d = await http.post('/partner/schedule/publish', { weekStart: weekStart.value });
    week.value = d.week || week.value;
    ElMessage.success('已发布，站员在小程序里就能看到');
  } catch (e) {
    ElMessage.error(e.message || '发布失败');
  } finally {
    busy.value = false;
  }
}

async function doWithdraw() {
  busy.value = true;
  try {
    const d = await http.post('/partner/schedule/withdraw', { weekStart: weekStart.value });
    week.value = d.week || week.value;
    ElMessage.success('已撤回，班表内容还在，改完再发');
  } catch (e) {
    ElMessage.error(e.message || '撤回失败');
  } finally {
    busy.value = false;
  }
}

/* ── 改一格 ── */
const cellPeople = computed(() => (cell.value ? peopleOf(cell.value.day, cell.value.slot) : []));
const cellNeed = computed(() => {
  if (!cell.value) return 1;
  const idx = days.value.findIndex((x) => x.day === cell.value.day);
  const sd = (slotDefs.value || []).find((s) => Number(s.day) === idx && s.title === cell.value.slot);
  return sd ? Math.max(1, Number(sd.count) || 1) : Math.max(1, cellPeople.value.length);
});
const candList = computed(() => {
  if (!cell.value) return [];
  const inCell = {};
  cellPeople.value.forEach((p) => { inCell[p.personId] = 1; });
  return (availRows.value || []).filter((c) => !inCell[c.personId]);
});

function openCell(day, slot) {
  cell.value = { day, slot };
}

async function writeCell(personIds) {
  busy.value = true;
  try {
    const d = await http.put('/partner/schedule/cell', {
      weekStart: weekStart.value, day: cell.value.day, slot: cell.value.slot, personIds,
    });
    week.value = d.week || week.value;
    await loadMonth();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    busy.value = false;
  }
}

function dropPerson(pid) {
  writeCell(cellPeople.value.map((p) => p.personId).filter((x) => x !== pid));
}
function addPerson(c) {
  writeCell(cellPeople.value.map((p) => p.personId).concat([c.personId]));
}

/* ── 导出（电脑端出真文件，不用像手机端那样只复制文本） ── */
function exportCsv() {
  const head = ['时段'].concat(days.value.map((d) => `${d.dayName} ${d.day}`));
  const lines = [head.join(',')];
  matrix.value.forEach((row) => {
    const cells = days.value.map((d) => peopleOf(d.day, row.slot).map((p) => p.personName).join(' / ') || '（空）');
    lines.push([row.slot].concat(cells).map((s) => `"${String(s).replace(/"/g, '""')}"`).join(','));
  });
  if (missingList.value.length) {
    lines.push('');
    lines.push('"缺岗"');
    missingList.value.forEach((m) => lines.push(`"${dayNameOf(m.day)} ${m.slot}","应到 ${m.need} / 已排 ${m.got}"`));
  }
  // ⚠️ BOM：不加的话 Excel 打开中文是乱码
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `班表-${weekStart.value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success('已导出，Excel 可直接打开');
}

onMounted(() => reloadAll(''));
</script>

<style scoped>
.wk td { vertical-align: top; }
.wk td i { display: block; font-style: normal; font-size: var(--fs-2xs); color: var(--muted); margin-top: 2px; }
.wk th .dt { font-weight: 400; color: var(--soft); }
.cell { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.cell.miss { background: var(--red-bg); border-radius: 10px; padding: 6px; margin: -6px; }
.cell-edit {
  border: 0; background: none; color: var(--accent); font-size: var(--fs-xs);
  cursor: pointer; font-family: inherit; padding: 0 2px;
}
.pv-line.static .pv-btn { flex: none; }
</style>
