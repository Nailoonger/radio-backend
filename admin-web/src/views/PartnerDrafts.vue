<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ total }}</b><span>篇{{ tabLabel }}</span></div>
      <div class="pv-stat-s">先交先审 · 每页 {{ pageSize }} 篇</div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note" v-if="!err">
      站内稿件是<b>伙伴自己写</b>的稿（可反复改、有版本），和学生投稿（点歌 / 学生文稿）不是一回事。
    </div>

    <div class="pv-tabs">
      <button :class="{ on: status === 1 }" @click="status = 1">待审核</button>
      <button :class="{ on: status === 2 }" @click="status = 2">已通过</button>
      <button :class="{ on: status === 3 }" @click="status = 3">已驳回</button>
    </div>

    <div class="pv-card">
      <div class="pv-line" v-for="d in list" :key="d.id" @click="open(d)">
        <span class="pv-line-t">
          <b>{{ d.title || '（无标题）' }}</b>
          <i>
            {{ d.authorName }}<template v-if="d.columnName"> · {{ d.columnName }}</template>
            · {{ d.wordCount }} 字 · 约 {{ secText(d.seconds) }}
            <template v-if="d.submittedAt"> · {{ fmtDate(d.submittedAt) }} 提交</template>
          </i>
        </span>
        <span class="pv-bd" :class="bdCls(d.status)">{{ d.statusText }}</span>
        <span class="ar">›</span>
      </div>
      <div class="pv-empty" v-if="!list.length">这一档没有稿件。</div>
    </div>

    <!-- ══════ 详情 / 审稿 ══════ -->
    <div class="pv-sheet" v-if="cur">
      <div class="pv-mask" @click="cur = null"></div>
      <div class="pv-sheet-body tall">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd">
          <b>{{ detail.title || '（无标题）' }}</b>
          <span class="pv-bd" :class="bdCls(detail.status)">{{ detail.statusText }}</span>
        </div>
        <p class="pv-sh-sub">
          {{ detail.authorName }}<template v-if="detail.columnName"> · {{ detail.columnName }}</template>
          · 第 {{ detail.version }} 版 · {{ detail.wordCount }} 字 · 约 {{ secText(detail.seconds) }}
        </p>

        <div class="pv-note err" v-if="detail.rejectReason">驳回理由：{{ detail.rejectReason }}</div>

        <div class="pv-tabs">
          <button :class="{ on: pane === 'body' }" @click="pane = 'body'">正文</button>
          <button :class="{ on: pane === 'ver' }" @click="pane = 'ver'">版本（{{ versions.length }}）</button>
        </div>

        <div v-if="pane === 'body'" class="dr-body">{{ detail.body || '（空）' }}</div>

        <div v-else>
          <div class="pv-line" v-for="v in versions" :key="v.v" @click="showVer(v)">
            <span class="pv-line-t">
              <b>第 {{ v.v }} 版<template v-if="v.current"> · 当前</template></b>
              <i>{{ v.wordCount }} 字 · 约 {{ secText(v.seconds) }}<template v-if="v.savedAt"> · {{ fmtDate(v.savedAt) }}</template></i>
            </span>
            <span class="pv-bd" :class="bdCls(v.status)">{{ v.statusText }}</span>
            <span class="ar">›</span>
          </div>
          <div class="pv-empty" v-if="!versions.length">还没有版本记录。</div>
        </div>

        <template v-if="detail.status === 1">
          <div class="pv-h">驳回理由<span class="pv-h-s">批准不用写</span></div>
          <textarea class="pv-ta" v-model="reason" rows="2" maxlength="200" placeholder="驳回时写清楚哪儿要改"></textarea>
          <div class="pv-btnrow">
            <button class="pv-btn primary" :disabled="busy" @click="review(true)">通过</button>
            <button class="pv-btn danger" :disabled="busy" @click="review(false)">驳回</button>
          </div>
        </template>
      </div>
    </div>

    <!-- ══════ 看某一版 ══════ -->
    <div class="pv-sheet" v-if="ver">
      <div class="pv-mask" @click="ver = null"></div>
      <div class="pv-sheet-body tall">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd"><b>第 {{ ver.v }} 版</b><span class="pv-micro">{{ ver.wordCount }} 字 · 约 {{ secText(ver.seconds) }}</span></div>
        <p class="pv-sh-sub">{{ ver.title }}</p>
        <div class="dr-body">{{ ver.body || '（空）' }}</div>
        <div class="pv-btnrow"><button class="pv-btn ghost" @click="ver = null">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';

const err = ref('');
const loadError = ref('');
const status = ref(1);
const list = ref([]);
const total = ref(0);
const pageSize = ref(20);
const cur = ref(null);
const detail = ref({});
const versions = ref([]);
const pane = ref('body');
const ver = ref(null);
const reason = ref('');
const busy = ref(false);

const tabLabel = computed(() => ({ 1: '待审核', 2: '已通过', 3: '已驳回' }[status.value] || ''));
const bdCls = (s) => ({ 0: 'off', 1: 'warn', 2: 'ok', 3: 'err' }[Number(s)] || 'off');
const secText = (s) => {
  const n = Number(s) || 0;
  return `${Math.floor(n / 60)}分${String(n % 60).padStart(2, '0')}秒`;
};
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/draft/review', { params: { status: status.value } });
    list.value = d.list || [];
    total.value = d.total || 0;
    pageSize.value = d.pageSize || 20;
  } catch (e) {
    loadError.value = `稿件列表读取失败：${e.message || '请重试'}`;
  }
}

async function open(d) {
  cur.value = d;
  pane.value = 'body';
  reason.value = '';
  ver.value = null;
  try {
    const [a, b] = await Promise.all([
      http.get(`/partner/draft/${d.id}`),
      http.get(`/partner/draft/${d.id}/versions`),
    ]);
    detail.value = a || {};
    versions.value = (b && b.list) || [];
  } catch (e) {
    ElMessage.error(e.message || '读取失败');
  }
}

function showVer(v) { ver.value = v; }

async function review(approve) {
  if (!approve && String(reason.value || '').trim().length < 1) {
    ElMessage.warning('驳回要写理由');
    return;
  }
  busy.value = true;
  try {
    await http.put(`/partner/draft/${cur.value.id}/review`, { approve, reason: String(reason.value || '').trim() });
    ElMessage.success(approve ? '已通过' : '已驳回');
    cur.value = null;
    await load();
  } catch (e) {
    ElMessage.error(e.message || '处理失败');
  } finally {
    busy.value = false;
  }
}

watch(status, load);
onMounted(load);
</script>

<style scoped>
.dr-body {
  white-space: pre-wrap; font-size: var(--fs-md); line-height: 1.9; color: var(--ink);
  background: var(--parchment); border-radius: var(--r-input); padding: 14px; max-height: 44vh; overflow-y: auto;
}
</style>
