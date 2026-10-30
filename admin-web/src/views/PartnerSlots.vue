<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ slotCount }}</b><span>个值班时段</span></div>
      <div class="pv-stat-s">
        当前生效 第 {{ pubVersion || 0 }} 版<template v-if="pubAt"> · {{ fmtTime(pubAt) }} 发布</template>
        <template v-if="pubBy"> · {{ pubBy }}</template>
        <br />覆盖 {{ dayCount }} 个工作日 · 合计 {{ seatCount }} 个岗位
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>

    <div class="pv-note warn" v-if="!err && pendingDraft">
      有一份<b>未发布的草稿</b>（第 {{ draftVersion }} 版）。站员和社干现在看到的还是第 {{ pubVersion || 0 }} 版，发布后才生效。
    </div>
    <div class="pv-note" v-if="!err && !canEdit">
      值班时段只有超级管理员能改。社干在这里只能看。
    </div>
    <div class="pv-note" v-if="!err && !hasPublished">
      还没有发布过值班时段。排班、可排时间都依赖它 —— 先配一版再发布。
    </div>

    <!-- ══════ 已发布版本 ══════ -->
    <div class="pv-h" v-if="published">当前生效<span class="pv-h-s">第 {{ published.version }} 版</span></div>
    <div class="pv-card pad" v-if="published && published.templates.length">
      <div class="pv-kv" v-for="(t, i) in published.templates" :key="'p' + i">
        <span class="k">周{{ dayCn(t.day) }}</span>
        <span class="v">{{ t.title }} · {{ mm(t.start) }}–{{ mm(t.end) }}<template v-if="t.dept"> · {{ t.dept }}</template><template v-if="t.role"> · {{ t.role }}</template> · {{ t.count }} 人</span>
      </div>
      <div class="pv-kv" v-if="published.reason">
        <span class="k">发布说明</span><span class="v">{{ published.reason }}</span>
      </div>
    </div>

    <!-- ══════ 草稿编辑 ══════ -->
    <div class="pv-h">
      编辑草稿<span class="pv-h-s">第 {{ editing.version }} 版</span>
      <span class="pv-h-r" v-if="canEdit">改完先「存草稿」，确认无误再「发布」</span>
    </div>

    <div class="pv-card" style="padding: 12px 16px 4px;">
      <div class="sl-row sl-head">
        <span>星期</span><span>名称</span><span>开始</span><span>结束</span><span>部门</span><span>岗位</span><span>人数</span><span></span>
      </div>
      <div class="sl-row" v-for="(t, i) in rows" :key="i">
        <select class="pv-sel" v-model.number="t.day" :disabled="!canEdit">
          <option v-for="d in 5" :key="d" :value="d - 1">周{{ dayCn(d - 1) }}</option>
        </select>
        <input class="pv-inp sm" v-model="t.title" placeholder="如 早会" :disabled="!canEdit" maxlength="20" />
        <input class="pv-inp sm" type="time" v-model="t.startText" :disabled="!canEdit" />
        <input class="pv-inp sm" type="time" v-model="t.endText" :disabled="!canEdit" />
        <select class="pv-sel" v-model="t.dept" :disabled="!canEdit">
          <option value="">不限</option>
          <option v-for="d in DEPARTMENTS" :key="d" :value="d">{{ d }}</option>
        </select>
        <select class="pv-sel" v-model="t.role" :disabled="!canEdit">
          <option value="">不限</option>
          <option v-for="r in DUTY_ROLES" :key="r" :value="r">{{ r }}</option>
        </select>
        <input class="pv-inp sm num" type="number" min="1" max="20" v-model.number="t.count" :disabled="!canEdit" />
        <button class="sl-del" :disabled="!canEdit" @click="rows.splice(i, 1)" title="删掉这一行">×</button>
      </div>
      <div class="pv-empty" v-if="!rows.length">还没有时段。点下面「加一个时段」开始配。</div>
    </div>

    <div class="pv-btnrow">
      <button class="pv-btn ghost sm" :disabled="!canEdit" @click="addRow">＋ 加一个时段</button>
      <button class="pv-btn ghost" :disabled="!canEdit || saving" @click="saveDraft">{{ saving ? '保存中…' : '存草稿' }}</button>
      <button class="pv-btn primary" :disabled="!canEdit || saving" @click="pubOpen = true">发布这一版</button>
    </div>
    <div class="pv-note" v-if="!canEdit && canPublish !== undefined">（保存与发布已按「仅超管」置灰）</div>

    <!-- ══════ 发布确认 ══════ -->
    <div class="pv-sheet" v-if="pubOpen">
      <div class="pv-mask" @click="pubOpen = false"></div>
      <div class="pv-sheet-body">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd"><b>发布第 {{ editing.version }} 版</b></div>
        <p class="pv-sh-sub">
          发布后，站员填「可排时间」和生成班表都用这一版。<br />
          同一天内时段不能重叠；重叠会在保存时被拦下。
        </p>
        <textarea class="pv-ta" v-model="pubReason" rows="3" placeholder="发布说明（可留空）：为什么改，改了什么" maxlength="200"></textarea>
        <div class="pv-sh-acts">
          <button :disabled="saving" @click="doPublish">{{ saving ? '发布中…' : '确认发布' }}</button>
          <button @click="pubOpen = false">再改改</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';

const DEPARTMENTS = ['播音部', '主持部', '编辑部'];
const DUTY_ROLES = ['播音', '主持', '编辑', '记者', '技术'];
const DAY_CN = ['一', '二', '三', '四', '五'];

const err = ref('');
const loadError = ref('');
const canEdit = ref(false);
const canPublish = ref(false);
const hasPublished = ref(false);
const pendingDraft = ref(false);
const published = ref(null);
const draftVersion = ref(0);
const rows = ref([]);
const editing = ref({ version: 1 });
const saving = ref(false);
const pubOpen = ref(false);
const pubReason = ref('');

const dayCn = (d) => DAY_CN[Number(d) || 0] || '一';
const mm = (min) => {
  const n = Math.max(0, Number(min) || 0);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const fmtTime = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const pubVersion = computed(() => (published.value ? Number(published.value.version) || 0 : 0));
const pubAt = computed(() => (published.value ? published.value.publishedAt : null));
const pubBy = computed(() => (published.value ? published.value.publishedByName : ''));
const slotCount = computed(() => rows.value.length);
const dayCount = computed(() => new Set(rows.value.map((t) => t.day)).size);
const seatCount = computed(() => rows.value.reduce((n, t) => n + (Number(t.count) || 1), 0));

function addRow() {
  rows.value.push({ day: 0, title: '', startText: '07:30', endText: '07:50', dept: '', role: '', count: 1 });
}

function fromTemplates(list) {
  return (list || []).map((t) => ({
    day: Number(t.day) || 0,
    title: t.title || '',
    startText: mm(t.start),
    endText: mm(t.end),
    dept: t.dept || '',
    role: t.role || '',
    count: Number(t.count) || 1,
  }));
}

function toTemplates() {
  return rows.value.map((t) => ({
    day: Number(t.day) || 0,
    title: String(t.title || '').trim(),
    start: toMin(t.startText),
    end: toMin(t.endText),
    dept: t.dept || '',
    role: t.role || '',
    count: Number(t.count) || 1,
  }));
}

async function load() {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/slots');
    canEdit.value = !!d.canEdit;
    canPublish.value = !!d.canPublish;
    hasPublished.value = !!d.hasPublished;
    pendingDraft.value = !!d.pendingDraft;
    published.value = d.published || null;
    draftVersion.value = d.draft ? Number(d.draft.version) || 0 : 0;
    editing.value = d.editing || { version: 1 };
    rows.value = fromTemplates((d.editing && d.editing.templates) || []);
  } catch (e) {
    loadError.value = `值班时段读取失败：${e.message || '请重试'}。若提示云函数不存在，先上传 api 云函数。`;
  }
}

async function saveDraft() {
  if (!rows.value.length) {
    ElMessage.warning('至少配一个时段再存');
    return;
  }
  saving.value = true;
  try {
    const d = await http.put('/partner/slots/draft', { templates: toTemplates() });
    editing.value = d.draft || editing.value;
    draftVersion.value = Number((d.draft && d.draft.version) || 0);
    pendingDraft.value = true;
    ElMessage.success('草稿已保存，还没发布');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function doPublish() {
  saving.value = true;
  try {
    // 发布前先存一份，避免「改了没存就发布」
    if (rows.value.length) await http.put('/partner/slots/draft', { templates: toTemplates() });
    const d = await http.post('/partner/slots/publish', { reason: pubReason.value });
    published.value = d.published || null;
    pendingDraft.value = false;
    pubOpen.value = false;
    pubReason.value = '';
    ElMessage.success('已发布，站员填可排时间时看到的就是这一版');
    await load();
  } catch (e) {
    ElMessage.error(e.message || '发布失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.sl-row {
  display: grid; gap: 8px; align-items: center; padding: 8px 0;
  grid-template-columns: 74px 1.4fr 96px 96px 108px 96px 66px 32px;
  border-bottom: 1px solid var(--divider);
}
.sl-row:last-child { border-bottom: 0; }
.sl-head {
  font-size: var(--fs-xs); color: var(--muted); padding: 4px 0; border-bottom: 1px solid var(--hairline);
}
.sl-head span { display: block; }
.pv-inp.num { padding: 0 8px; }
.sl-del {
  width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--hairline);
  background: var(--canvas); color: var(--muted); font-size: 16px; line-height: 1; cursor: pointer;
  font-family: inherit;
}
.sl-del:hover:not(:disabled) { border-color: var(--red-fg); color: var(--red-fg); }
.sl-del:disabled { opacity: .4; cursor: not-allowed; }
</style>
