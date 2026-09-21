<template>
  <div class="stu">
    <!-- ══════════ 筛选条件条 ══════════ -->
    <div class="fbar">
      <FilterPill
        label="年级" v-model="q.grade" :options="gradeOptions"
        placeholder="全部年级" width="210"
      />
      <FilterPill
        label="班级" v-model="q.classNo" :options="classOptions"
        :disabled="!q.grade" disabled-hint="先选年级"
        placeholder="全部班级" width="190"
      />
      <FilterPill
        label="启用状态" v-model="q.status" :options="STATUS_OPTS"
        placeholder="不限" width="150"
      />
      <FilterPill
        label="激活状态" v-model="q.activated" :options="ACT_OPTS"
        placeholder="不限" width="150"
      />
      <FilterPill
        label="导入批次" v-model="q.batchId" :options="batchOptions"
        placeholder="不限批次" clear-text="不限批次" width="220"
      />

      <div class="fsearch" :class="{ on: q.keyword }">
        <IconSearch :size="14" />
        <input
          ref="searchRef"
          v-model="q.keyword"
          placeholder="搜索姓名 / 账号 / 备注"
          spellcheck="false"
          @keydown.esc.stop="clearKeyword"
        />
        <button v-if="q.keyword" type="button" class="fs-x" title="清空" @click="clearKeyword">
          <IconClose :size="12" />
        </button>
        <kbd v-else>/</kbd>
      </div>

      <div class="fbar-right">
        <button ref="moreBtnRef" type="button" class="btn-ghost" @click="moreOpen = true">
          <IconDots :size="15" class="btn-ico" />更多操作
        </button>
        <button type="button" class="btn-main" @click="importOpen = true">
          <IconUpload :size="15" class="btn-ico" />名册导入
        </button>
      </div>
    </div>

    <!-- ══════════ 更多操作（就地展开浮层） ══════════ -->
    <PopMenu v-model="moreOpen" :anchor="moreBtnRef" :width="292" align="right">
      <button type="button" class="mi" @click="moreOpen = false; importOpen = true;">
        <IconUpload :size="15" />
        <span><span class="mi-t">名册导入</span><span class="mi-d">上传 xlsx，逐行预览后再写入</span></span>
      </button>
      <button type="button" class="mi" @click="moreOpen = false; batchesOpen = true;">
        <IconInbox :size="15" />
        <span><span class="mi-t">导入批次与撤销</span><span class="mi-d">{{ batchRows.length }} 个批次 · 传错表格可一键回滚</span></span>
      </button>
      <div class="mi-sep"></div>
      <button type="button" class="mi" @click="moreOpen = false; exportScope();">
        <IconDownload :size="15" />
        <span><span class="mi-t">导出当前结果</span><span class="mi-d">{{ listTotal }} 条 · 含初始密码明文</span></span>
      </button>
      <button type="button" class="mi" @click="moreOpen = false; quickInactive();">
        <IconClock :size="15" />
        <span><span class="mi-t">只看未激活</span><span class="mi-d">密码发出去了但还没登录过的人</span></span>
      </button>
    </PopMenu>

    <!-- ══════════ 已选条件（可摘，摘除后其余平滑挪位） ══════════ -->
    <TransitionGroup v-if="chips.length" name="chip" tag="div" class="picked">
      <span class="pk-lead" :key="'__lead'">已选条件</span>
      <button
        v-for="c in chips" :key="c.key"
        type="button" class="pk" @click="c.clear()"
      >
        <b>{{ c.text }}</b>
        <IconClose :size="11" />
      </button>
      <button :key="'__all'" type="button" class="pk-clear" @click="clearAll">全部清掉</button>
    </TransitionGroup>
    <div v-else class="picked picked-empty">
      <span class="pk-lead">未设置条件 —— 显示全部 {{ listTotal }} 个账号。条件会同步写进地址栏。</span>
    </div>

    <!-- ══════════ 深色 hero：页面最重的一条信息 ══════════ -->
    <div class="hero">
      <div class="hero-top">
        <div class="hero-main">
          <div class="hero-k">命中账号</div>
          <div class="hero-v num">{{ listTotal }}</div>
          <div class="hero-sum">
            <template v-if="summary">
              <b>{{ condSummary }}</b> —— 已激活 {{ summary.activated }} ·
              未激活 {{ listTotal - summary.activated }} ·
              已停用 {{ summary.disabled }} ·
              有投稿记录 {{ summary.withSubmit }}
            </template>
            <template v-else>
              <b>{{ condSummary }}</b>
            </template>
          </div>
        </div>
        <div class="hero-acts">
          <button type="button" class="hb hb-white" :disabled="busy || !listTotal" @click="exportScope">
            导出这 {{ listTotal }} 条
          </button>
          <button type="button" class="hb" :disabled="busy || !listTotal" @click="scopeResetPwd">
            重置这 {{ listTotal }} 个的密码
          </button>
        </div>
      </div>

      <!-- 整届操作：只在选中某个年级时出现 -->
      <div v-if="q.grade && gradeDetail" class="hero-issue">
        <div class="hi-ic"><IconTrash :size="15" /></div>
        <div class="hi-txt">
          <div class="hi-t">整届操作 · {{ gradeDetail.name }}</div>
          <div class="hi-m">
            毕业清理按 safe 规则：没有投稿记录的 <b>{{ gradeDetail.canDelete }}</b> 人真删，
            有投稿记录的 <b>{{ gradeDetail.withSubmit }}</b> 人改为停用。执行后这一届的登录态立即作废。
          </div>
        </div>
        <div class="hi-acts">
          <button type="button" class="hb" :disabled="busy" @click="exportGrade">导出本届</button>
          <button type="button" class="hb hb-danger" @click="purgeOpen = true">毕业清理…</button>
        </div>
      </div>
    </div>

    <!-- ══════════ 结果表（自绘，v3 细线表） ══════════ -->
    <div class="tablecard">
      <!-- 加载骨架：列宽与真实表格一一对应，块=真实组件尺寸 -->
      <div v-if="loading && !listRows.length" class="sk" aria-hidden="true">
        <div v-for="i in 6" :key="i" class="sk-row">
          <span class="sk-box"></span>
          <span class="sk-line" style="width: 88px"></span>
          <span class="sk-av"></span>
          <span class="sk-line" style="width: 84px"></span>
          <span class="sk-pill"></span>
          <span class="sk-pill"></span>
          <span class="sk-line" style="width: 36px"></span>
          <span class="sk-line" style="width: 118px"></span>
          <span class="sk-ops">
            <i class="sk-btn"></i>
            <i class="sk-btn"></i>
            <i class="sk-btn sk-btn--sm"></i>
          </span>
        </div>
      </div>

      <template v-else-if="listRows.length">
        <table class="tb">
          <colgroup>
            <col style="width: 46px" /><col style="width: 122px" /><col style="width: 128px" />
            <col style="width: 124px" /><col style="width: 88px" /><col style="width: 92px" />
            <col style="width: 100px" /><col style="width: 152px" /><col />
          </colgroup>
          <thead>
            <tr>
              <th class="c">
                <button type="button" class="cb" :class="{ on: allOnPage }" @click="toggleSelAll">
                  <IconCheck v-if="allOnPage" :size="11" :stroke-width="3" />
                </button>
              </th>
              <th>账号</th>
              <th>姓名</th>
              <th>届 · 班</th>
              <th class="c">启用</th>
              <th class="c">激活</th>
              <th>导入批次</th>
              <th>最近登录</th>
              <th class="r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in listRows" :key="row.id" :class="{ sel: selected.has(row.id) }">
              <td class="c">
                <button
                  type="button" class="cb" :class="{ on: selected.has(row.id) }"
                  :aria-label="selected.has(row.id) ? '取消选择' : '选择'"
                  @click="toggleSel(row.id)"
                >
                  <IconCheck v-if="selected.has(row.id)" :size="11" :stroke-width="3" />
                </button>
              </td>
              <td><span class="mono tb-user">{{ row.username }}</span></td>
              <td>
                <!-- 就地改名：不弹模态（v3：日常动作不要确认框） -->
                <input
                  v-if="renamingId === row.id"
                  ref="renameInputRef"
                  v-model="renameValue"
                  class="cell-input"
                  spellcheck="false"
                  maxlength="64"
                  @keydown.enter.prevent="commitRename()"
                  @keydown.esc.stop.prevent="cancelRename()"
                  @blur="commitRename()"
                />
                <span v-else class="rowc" style="gap: 8px">
                  <span class="av">{{ (row.name || '?').charAt(0) }}</span>
                  <span class="el" :title="row.name">{{ row.name || '—' }}</span>
                </span>
              </td>
              <td><span class="tb-dim">{{ row.className || '—' }}</span></td>
              <td class="c">
                <span class="tag" :class="row.status === 1 ? 'tag-ok' : 'tag-reject'">
                  {{ row.status === 1 ? '启用' : '停用' }}
                </span>
              </td>
              <td class="c">
                <span class="tag" :class="row.activated ? 'tag-ok' : 'tag-mute'">
                  {{ row.activated ? '已激活' : '未激活' }}
                </span>
              </td>
              <td>
                <span
                  class="mono tb-dim"
                  :title="batchMap.get(row.importBatchId) || ''"
                >#{{ row.importBatchId || '—' }}</span>
              </td>
              <td><span class="tb-dim num">{{ row.lastLoginAt ? fmt(row.lastLoginAt) : '从未登录' }}</span></td>
              <td>
                <div class="rowact">
                  <button type="button" class="rx" :disabled="busy" @click="startRename(row)">改名</button>
                  <button type="button" class="rx" :disabled="busy" @click="resetPassword(row)">重置密码</button>
                  <button
                    type="button" class="rx" :class="{ 'rx-danger': row.status === 1 }"
                    :disabled="busy" @click="toggleStatus(row)"
                  >{{ row.status === 1 ? '停用' : '启用' }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <EmptyState
        v-else
        variant="content"
        :title="chips.length ? '没有符合条件的账号' : '还没有学生账号'"
        :description="chips.length ? '当前条件没有交集，摘掉一个再看看' : '用「名册导入」上传名册，或先下载模板看看格式'"
      />
    </div>

    <!-- ══════════ 分页（自绘，v3） ══════════ -->
    <div v-if="listTotal" class="pager">
      <span class="pg-info num">
        显示 {{ rangeStart }} – {{ rangeEnd }} 条，共 {{ listTotal }} 条 · 每页 {{ q.pageSize }} 条
      </span>
      <button
        v-for="p in pageList" :key="p.key" type="button"
        class="pg num" :class="{ on: p.n === q.page, gap: p.gap }"
        :disabled="p.gap" @click="!p.gap && goPage(p.n)"
      >{{ p.gap ? '…' : p.n }}</button>
      <button type="button" class="pg" :disabled="q.page >= pageCount" @click="goPage(q.page + 1)">‹</button>
    </div>

    <!-- ══════════ 批量浮条：勾选后浮起（毛玻璃，居中） ══════════ -->
    <Transition name="bb">
      <div v-if="selected.size" class="batchbar">
        <span class="bb-cnt">已选 <b class="num">{{ selected.size }}</b> 条</span>
        <span class="bb-hint">范围＝勾选的 {{ selected.size }} 个</span>
        <button type="button" class="btn-ghost" :disabled="busy" @click="batchResetPwd">重置为初始密码</button>
        <button type="button" class="btn-ghost" :disabled="busy" @click="batchDisable">批量停用</button>
        <button v-if="auth.isSuperAdmin" type="button" class="btn-danger" :disabled="busy" @click="batchRemove">批量删除</button>
        <button type="button" class="btn-plain" @click="clearSelection">取消选择</button>
      </div>
    </Transition>

    <!-- ══════════ 三个页内弹层 ══════════ -->
    <ImportSheet v-model="importOpen" @done="onImported" />
    <BatchesSheet
      v-model="batchesOpen"
      @filter="(id) => { q.batchId = id; batchesOpen = false; }"
      @done="afterWrite"
    />
    <PurgeSheet v-model="purgeOpen" :grade="q.grade" @done="afterWrite" />

    <!-- ══════════ 轻反馈（可撤销） ══════════ -->
    <ToastHost ref="toastRef" />
  </div>
</template>

<script setup>
/**
 * 学生账号（v3 —— preview/student-admin-v3 的业务落地）
 *
 * 形态（v2 定的，别再改回页签或目录树；v3 换的是手感和材质）：
 *   筛选条件条 → 已选条件胶囊 → 深色 hero → 自绘结果表 → 自绘分页 → 批量浮条
 *   · 条件顺序：年级 → 班级 → 启用状态 → 激活状态 → 导入批次 → 关键字
 *   · 班级级联于年级：没选年级就禁用并写「先选年级」，改年级自动清班级
 *   · hero 是页面最重的一条信息：命中数 + 摘要 + 「导出这 N 条 / 重置这 N 个的密码」；
 *     选中年级时出现「整届操作」（导出本届 / 毕业清理）
 *   · 批量浮条只在**勾选**后浮起（范围级动作住在 hero 里，不混在浮条里）
 *   · 日常动作（改名 / 启停用 / 批量停用）不弹二次确认，toast + 可撤销；
 *     确认只留给真正不可逆的（批量删除、毕业清理）
 *   · 改名是表格内就地编辑，不弹模态
 *
 * ⚠️ 班级选项只从「当前选中年级」的详情里取 —— 以前取的是 gradeInfo.classes
 *    （取决于上次打开过哪个年级），那就是「主目录 / 子目录混淆」那个 bug。
 * ⚠️ utils/http 对业务错误只 reject 不弹提示，catch 里必须自己 ElMessage.error。
 */
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';
import {
  IconSearch, IconUpload, IconClose, IconCheck, IconDots,
  IconDownload, IconClock, IconInbox, IconTrash,
} from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';
import FilterPill from '@/components/FilterPill.vue';
import PopMenu from '@/components/PopMenu.vue';
import ImportSheet from '@/components/student/ImportSheet.vue';
import BatchesSheet from '@/components/student/BatchesSheet.vue';
import PurgeSheet from '@/components/student/PurgeSheet.vue';
import ToastHost from '@/components/student/ToastHost.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const fmt = (t) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—');

const STATUS_OPTS = [
  { value: '1', label: '启用' },
  { value: '0', label: '停用' },
];
const ACT_OPTS = [
  { value: '1', label: '已激活' },
  { value: '0', label: '未激活' },
];

/* ── 条件 ── */
const q = reactive({
  page: 1, pageSize: 20,
  keyword: '', grade: '', classNo: '', batchId: '',
  status: '', activated: '',
});

/* ── 数据 ── */
const gradeList = ref([]);
const gradeCache = reactive({});          // grade → 该届详情（含班级分布与试算）
const batchRows = ref([]);
const batchMap = computed(() => {
  const m = new Map();
  batchRows.value.forEach((b) => m.set(b.id, b.filename));
  return m;
});

const listRows = ref([]);
const listTotal = ref(0);
const summary = ref(null);                // {total, activated, disabled, withSubmit}
const loading = ref(false);
const busy = ref(false);
const selected = ref(new Set());          // 勾选（跨页保留）

const importOpen = ref(false);
const batchesOpen = ref(false);
const purgeOpen = ref(false);
const moreOpen = ref(false);
const moreBtnRef = ref(null);
const searchRef = ref(null);
const toastRef = ref(null);

const gradeDetail = computed(() => (q.grade ? gradeCache[q.grade] || null : null));

const gradeOptions = computed(() =>
  gradeList.value.filter((g) => g.total > 0).map((g) => ({
    value: String(g.grade), label: `${g.grade} 级`, hint: `${g.total} 人`,
  }))
);

/** 班级选项＝当前年级的班级（级联），不是「上次打开过的那个年级」 */
const classOptions = computed(() =>
  (gradeDetail.value?.classes || []).map((c) => ({
    value: String(c.classNo), label: `${Number(c.classNo)} 班`, hint: `${c.total} 人`,
  }))
);

const batchOptions = computed(() =>
  batchRows.value.map((b) => ({
    value: b.id, label: `#${b.id} · ${b.filename}`, hint: `新建 ${fmt(b.createTime).slice(5, 10)}`,
  }))
);

/* ── 已选条件胶囊 ── */
const chips = computed(() => {
  const out = [];
  if (q.grade) out.push({ key: 'grade', text: `${q.grade} 级`, clear: () => { q.grade = ''; } });
  if (q.classNo) out.push({ key: 'classNo', text: `${Number(q.classNo)} 班`, clear: () => { q.classNo = ''; } });
  if (q.status !== '') out.push({ key: 'status', text: q.status === '1' ? '启用' : '停用', clear: () => { q.status = ''; } });
  if (q.activated !== '') out.push({ key: 'activated', text: q.activated === '1' ? '已激活' : '未激活', clear: () => { q.activated = ''; } });
  if (q.batchId) out.push({ key: 'batchId', text: `批次 #${q.batchId}`, clear: () => { q.batchId = ''; } });
  if (q.keyword) out.push({ key: 'keyword', text: `“${q.keyword}”`, clear: () => { q.keyword = ''; } });
  return out;
});

const condSummary = computed(() => (chips.value.length
  ? chips.value.map((c) => c.text).join(' / ')
  : '全部账号'));

function clearAll() {
  q.grade = ''; q.classNo = ''; q.batchId = '';
  q.status = ''; q.activated = ''; q.keyword = '';
}

function clearKeyword() {
  q.keyword = '';
  searchRef.value?.focus?.();
}

function quickInactive() {
  q.activated = '0';
}

/* ── 取数 ── */
function buildParams() {
  const p = {
    page: q.page, pageSize: q.pageSize,
    keyword: q.keyword, grade: q.grade, classNo: q.classNo,
    batchId: q.batchId, status: q.status, activated: q.activated,
  };
  Object.keys(p).forEach((k) => { if (p[k] === '' || p[k] == null) delete p[k]; });
  return p;
}

async function fetchStudents() {
  loading.value = true;
  try {
    const d = await http.get('/admin/student/list', { params: buildParams() });
    listRows.value = d.list || [];
    listTotal.value = d.total || 0;
    summary.value = d.summary || null;
  } catch (e) {
    ElMessage.error(e?.message || '账号列表加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadGrades() {
  try {
    const d = await http.get('/admin/student/grades');
    gradeList.value = d.list || [];
  } catch { /* 静默：年级只影响下拉选项 */ }
}

async function loadBatches() {
  try {
    const d = await http.get('/admin/student/batches');
    batchRows.value = d.list || [];
  } catch { /* 静默 */ }
}

/** 选定年级后取该届详情：班级选项 + 整届操作都靠它 */
async function loadGradeDetail(grade) {
  if (!grade || gradeCache[grade]) return;
  try {
    gradeCache[grade] = await http.get(`/admin/student/grade/${grade}`);
  } catch { /* 该届可能已被清理 */ }
}

/* ── 地址栏 / 顶栏同步 ── */
function syncRoute() {
  const query = {};
  if (q.grade) query.grade = String(q.grade);
  if (q.classNo) query.class = String(q.classNo);
  if (q.batchId) query.batch = String(q.batchId);
  if (q.status !== '') query.status = q.status;
  if (q.activated !== '') query.activated = q.activated;
  if (q.keyword) query.q = q.keyword;
  if (q.page > 1) query.page = String(q.page);
  if (q.pageSize !== 20) query.size = String(q.pageSize);
  router.replace({ query });
}

function syncHeader() {
  setPageHeader({
    title: '学生账号',
    subtitle: chips.value.length
      ? `${condSummary.value} · 命中 ${listTotal.value} 个`
      : `共 ${listTotal.value} 个账号 · ${gradeList.value.length || '—'} 届`,
  });
}

function fromRoute() {
  const r = route.query;
  q.grade = r.grade ? String(r.grade) : '';
  q.classNo = r.class ? String(r.class) : '';
  q.batchId = r.batch ? (Number(r.batch) || '') : '';
  q.status = r.status === '0' || r.status === '1' ? r.status : '';
  q.activated = r.activated === '0' || r.activated === '1' ? r.activated : '';
  q.keyword = r.q ? String(r.q) : '';
  q.page = Number(r.page) || 1;
  q.pageSize = Number(r.size) || 20;
}

async function reload() {
  syncRoute();
  await fetchStudents(); // 顶栏副标题用命中数 —— 必须等数据回来再刷，否则停留在旧 total
  syncHeader();
}

let kwTimer = null;
watch(() => [q.grade, q.classNo, q.batchId, q.status, q.activated], () => { q.page = 1; reload(); });
watch(() => [q.page, q.pageSize], () => reload());
// 关键字防抖：数据在服务端（不是原型里的内存数据），每键一个请求会打爆接口；
// 胶囊文本是响应式的，视觉上仍然「敲了就变」。
watch(() => q.keyword, () => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => { q.page = 1; reload(); }, 320);
});
watch(() => q.grade, (g) => { q.classNo = ''; loadGradeDetail(g); });

/* `/` 聚焦搜索（焦点不在输入框时） */
function onKeydown(e) {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    searchRef.value?.focus?.();
  }
}

/* ── 分页 ── */
const pageCount = computed(() => Math.max(1, Math.ceil(listTotal.value / q.pageSize)));
const rangeStart = computed(() => (listTotal.value ? (q.page - 1) * q.pageSize + 1 : 0));
const rangeEnd = computed(() => Math.min(q.page * q.pageSize, listTotal.value));

/** 首尾 + 当前 ±1，中间用 … 收缩（几十页时不能全铺开） */
const pageList = computed(() => {
  const n = pageCount.value;
  const cur = q.page;
  const out = [];
  const push = (num, gap = false) => out.push({ key: gap ? `g${out.length}` : `p${num}`, n: num, gap });
  if (n <= 7) {
    for (let i = 1; i <= n; i += 1) push(i);
    return out;
  }
  push(1);
  const lo = Math.max(2, cur - 1);
  const hi = Math.min(n - 1, cur + 1);
  if (lo > 2) push(0, true);
  for (let i = lo; i <= hi; i += 1) push(i);
  if (hi < n - 1) push(0, true);
  push(n);
  return out;
});

function goPage(p) {
  if (p < 1 || p > pageCount.value || p === q.page) return;
  q.page = p;
}

/* ── 勾选（跨页保留，与原型一致） ── */
const allOnPage = computed(() => {
  if (!listRows.value.length) return false;
  return listRows.value.every((r) => selected.value.has(r.id));
});

function toggleSel(id) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleSelAll() {
  const next = new Set(selected.value);
  if (allOnPage.value) listRows.value.forEach((r) => next.delete(r.id));
  else listRows.value.forEach((r) => next.add(r.id));
  selected.value = next;
}

function clearSelection() {
  selected.value = new Set();
}

/** 没勾选时按当前筛选条件把 id 全取回来（每次 200，最多 10 页 = 2000，够用） */
async function scopeIds() {
  if (selected.value.size) return [...selected.value];
  const base = buildParams();
  delete base.page;
  const ids = [];
  for (let p = 1; p <= 10; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    const d = await http.get('/admin/student/list', { params: { ...base, page: p, pageSize: 200 } });
    const list = d.list || [];
    ids.push(...list.map((r) => r.id));
    if (!list.length || ids.length >= (d.total || 0)) break;
  }
  return ids;
}

/* ── 导出 ── */
async function downloadExport(params, filename) {
  try {
    const blob = await http.get('/admin/student/export', { params, responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}_${dayjs().format('YYYYMMDD-HHmm')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success('已导出（含初始密码列）');
  } catch (e) {
    ElMessage.error(e?.message || '导出失败');
  }
}

function exportParams() {
  const params = buildParams();
  delete params.page;
  delete params.pageSize;
  return params;
}

function exportScope() {
  return downloadExport(exportParams(), '学生账号');
}

function exportGrade() {
  if (!q.grade) return;
  return downloadExport({ grade: q.grade }, `学生账号_${q.grade}级`);
}

/* ── 范围级重置密码（hero：范围＝筛选结果，v3 不弹确认，toast 反馈） ── */
async function scopeResetPwd() {
  if (!listTotal.value) return;
  busy.value = true;
  try {
    const ids = await scopeIds();
    const d = await http.post('/admin/student/reset-password/batch', { ids });
    toastRef.value?.push({
      text: `已重置 ${d?.affected ?? ids.length} 个账号的密码为初始密码`,
      icon: IconKey,
    });
    clearSelection();
    await fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '重置失败');
  } finally { busy.value = false; }
}

/* ── 行内：重置密码（不弹确认，toast 带回初始密码） ── */
async function resetPassword(row) {
  try {
    const d = await http.put(`/admin/student/${row.id}/reset-password`);
    toastRef.value?.push({
      text: `已把 ${row.name || row.username} 的密码重置为 ${d?.initPassword || `user${row.username}`}`,
      icon: IconKey,
    });
    fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '重置失败');
  }
}

/* ── 行内：启 / 停用（不弹确认；toast 可撤销） ── */
async function toggleStatus(row) {
  const before = row.status;
  const next = before === 1 ? 0 : 1;
  busy.value = true;
  try {
    await http.put(`/admin/student/${row.id}/status`, { status: next });
    toastRef.value?.push({
      text: `已${next === 0 ? '停用' : '启用'} ${row.name || row.username}`,
      undo: async () => {
        try {
          await http.put(`/admin/student/${row.id}/status`, { status: before });
          fetchStudents();
        } catch (e) {
          ElMessage.error(e?.message || '撤销失败');
        }
      },
    });
    fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '操作失败');
  } finally { busy.value = false; }
}

/* ── 行内：就地改名（表格内编辑，Enter/失焦保存，Esc 取消） ── */
const renamingId = ref(null);
const renameValue = ref('');
const renameInputRef = ref(null);
let renameDone = false;

async function startRename(row) {
  renamingId.value = row.id;
  renameValue.value = row.name || '';
  renameDone = false;
  await nextTick();
  const inp = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value;
  inp?.focus?.();
  inp?.select?.();
}

function cancelRename() {
  renameDone = true;
  renamingId.value = null;
}

async function commitRename(row) {
  if (renameDone) return;
  renameDone = true;
  const id = renamingId.value;
  renamingId.value = null;
  if (id == null) return;
  const target = listRows.value.find((r) => r.id === id);
  if (!target) return;
  const name = String(renameValue.value || '').trim();
  const old = target.name || '';
  if (!name || name === old) return;   // 空名 / 没变化：静默结束（Esc 同路径）
  try {
    // ⚠️ 字段名必须是 name：后端 updateStudent 读 payload.name，并同时写进
    //    remark（管理端列表）与 nickname（投稿 / 留言 / 小程序「我的」）。
    await http.put(`/admin/student/${id}`, { name });
    toastRef.value?.push({
      text: '姓名已更新，学生端同步生效',
      undo: async () => {
        try {
          await http.put(`/admin/student/${id}`, { name: old });
          fetchStudents();
        } catch (e) {
          ElMessage.error(e?.message || '撤销失败');
        }
      },
    });
    fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '保存失败');
    fetchStudents();
  }
}

/* ── 批量（浮条）：只对勾选的 N 个 ── */
async function batchResetPwd() {
  const ids = [...selected.value];
  if (!ids.length) return;
  busy.value = true;
  try {
    const d = await http.post('/admin/student/reset-password/batch', { ids });
    toastRef.value?.push({
      text: `已重置 ${d?.affected ?? ids.length} 个账号的密码为初始密码`,
      icon: IconKey,
    });
    clearSelection();
    await fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '重置失败');
  } finally { busy.value = false; }
}

async function batchDisable() {
  const ids = [...selected.value];
  if (!ids.length) return;
  // undo 只需要恢复「原本启用」的那部分（原本就停用的不动）
  const wasOn = listRows.value.filter((r) => ids.includes(r.id) && r.status === 1).map((r) => r.id);
  busy.value = true;
  try {
    const d = await http.post('/admin/student/status/batch', { ids, status: 0 });
    toastRef.value?.push({
      text: `已停用 ${d?.affected ?? ids.length} 个账号`,
      undo: async () => {
        if (!wasOn.length) return;
        try {
          await http.post('/admin/student/status/batch', { ids: wasOn, status: 1 });
          fetchStudents();
        } catch (e) {
          ElMessage.error(e?.message || '撤销失败');
        }
      },
    });
    clearSelection();
    await fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '停用失败');
  } finally { busy.value = false; }
}

/** 批量删除：真删不可逆 —— 这是「确认只给真正不可逆的」那类（v3 §16） */
async function batchRemove() {
  const ids = [...selected.value];
  if (!ids.length) return;
  try {
    await ElMessageBox.confirm(
      `删除选中的 ${ids.length} 个账号？没有投稿记录的会真删（不可恢复），`
        + '有投稿记录的会自动改为「停用」，相关投稿记录仍留在审核列表里。',
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    );
  } catch { return; }
  busy.value = true;
  try {
    const d = await http.post('/admin/student/delete/batch', { ids });
    ElMessage.success(
      `已处理 ${d.total} 个：删除 ${d.deleted} 个、转为停用 ${d.disabled} 个`
      + (d.failed?.length ? `，${d.failed.length} 个失败` : '')
    );
    clearSelection();
    Object.keys(gradeCache).forEach((k) => delete gradeCache[k]);
    if (q.grade) await loadGradeDetail(q.grade);
    await Promise.all([fetchStudents(), loadGrades()]);
  } catch (e) {
    ElMessage.error(e?.message || '删除失败');
  } finally { busy.value = false; }
}

/* ── 弹层回写 ── */
async function onImported() {
  await Promise.all([loadGrades(), loadBatches()]);
  Object.keys(gradeCache).forEach((k) => delete gradeCache[k]);
  if (q.grade) await loadGradeDetail(q.grade);
  await fetchStudents();
  syncHeader();
}
async function afterWrite() {
  await Promise.all([loadGrades(), loadBatches()]);
  Object.keys(gradeCache).forEach((k) => delete gradeCache[k]);
  if (q.grade) await loadGradeDetail(q.grade);
  await fetchStudents();
  syncHeader();
}

async function refreshPage() {
  await Promise.all([loadGrades(), loadBatches()]);
  await fetchStudents();
  if (q.grade) await loadGradeDetail(q.grade);
  syncHeader();
}

onMounted(async () => {
  fromRoute();
  setRefreshHandler(refreshPage);
  document.addEventListener('keydown', onKeydown);
  await refreshPage();
});

onBeforeUnmount(() => {
  clearTimeout(kwTimer);
  document.removeEventListener('keydown', onKeydown);
  clearRefreshHandler(refreshPage);
  clearPageHeader();
});
</script>

<style scoped>
.stu { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
.mono { font-family: var(--mono); }
.el { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowc { display: inline-flex; align-items: center; }

/* ══════════ 筛选条件条 ══════════ */
.fbar {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--parchment); border-radius: var(--r-card);
}
.fbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

.fsearch {
  display: inline-flex; align-items: center; gap: 8px;
  flex: 1 1 190px; min-width: 190px; max-width: 280px;
  box-sizing: border-box;
  height: 34px; padding: 0 13px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); color: var(--soft);
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}
.fsearch:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.09);
}
.fsearch.on { border-color: var(--accent); }
.fsearch input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-family: inherit; font-size: var(--fs-sm); letter-spacing: var(--ls-wide-sm); color: var(--ink);
}
.fsearch input::placeholder { color: var(--soft); }
.fsearch kbd {
  font-family: inherit; font-size: var(--fs-2xs); color: var(--muted);
  background: var(--parchment); border-radius: 5px; padding: 1px 5px;
}
.fs-x {
  border: none; background: transparent; cursor: pointer; padding: 2px;
  display: inline-flex; color: var(--soft); border-radius: 50%;
}
.fs-x:hover { color: var(--ink); }

/* ══════════ 按钮（页面内自绘，v3 胶囊钮） ══════════ */
.btn-main {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 16px;
  border: none; background: var(--accent); color: #fff;
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); font-weight: 600; white-space: nowrap;
  transition: background 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.btn-main:hover { background: #0058b0; }
.btn-main:active { transform: scale(0.955); }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 14px;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink-2); white-space: nowrap;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.btn-ghost:hover { border-color: var(--soft); background: var(--parchment); }
.btn-ghost:active { transform: scale(0.965); }
.btn-ghost:disabled, .btn-danger:disabled { opacity: 0.45; pointer-events: none; }
.btn-danger {
  height: 34px; padding: 0 14px;
  border: 1px solid #f0c4c0; background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--red-fg); white-space: nowrap;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.btn-danger:hover { background: var(--red-bg); border-color: #e3a9a4; }
.btn-danger:active { transform: scale(0.965); }
.btn-plain {
  border: none; background: transparent; cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--muted);
  padding: 0 10px; height: 34px;
}
.btn-plain:hover { color: var(--ink); }
.btn-ico { margin-right: 2px; }

/* ══════════ 更多操作菜单项 ══════════ */
.mi {
  display: flex; align-items: flex-start; gap: 10px; width: 100%;
  padding: 9px 10px; border: none; background: transparent;
  border-radius: 9px; cursor: pointer; text-align: left;
  font-family: inherit; transition: background 0.14s var(--ease);
}
.mi:hover { background: var(--parchment); }
.mi :deep(svg) { flex: none; margin-top: 2px; color: var(--muted); }
.mi-t { display: block; font-size: var(--fs-md); font-weight: 500; color: var(--ink); }
.mi-d { display: block; margin-top: 1px; font-size: var(--fs-xs); color: var(--muted); line-height: 1.55; }
.mi-sep { height: 1px; background: var(--divider); margin: 6px 8px; }

/* ══════════ 已选条件胶囊 ══════════ */
.picked { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 26px; }
.picked-empty { min-height: 18px; }
.pk-lead { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); margin-right: 2px; }
.pk {
  display: inline-flex; align-items: center; gap: 5px;
  height: 26px; padding: 0 9px;
  border: 1px solid transparent; background: var(--acc-bg);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--accent);
  transition: background 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.pk:hover { background: #d9e8f8; }
.pk:active { transform: scale(0.94); }
.pk b { font-weight: 600; }
.pk-clear {
  border: none; background: transparent; cursor: pointer;
  font-family: inherit; font-size: var(--fs-sm); color: var(--muted);
  padding: 0 4px; text-decoration: underline;
}
.pk-clear:hover { color: var(--ink); }
.chip-move { transition: transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1); }
.chip-enter-active { transition: opacity 0.2s var(--ease), transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1); }
.chip-leave-active { transition: opacity 0.16s var(--ease), transform 0.16s var(--ease); position: absolute; }
.chip-enter-from, .chip-leave-to { opacity: 0; transform: scale(0.9); }

/* ══════════ 深色 hero（页面最重的一条信息，v3 结构） ══════════ */
.hero {
  position: relative; overflow: hidden;
  background: var(--tile); color: #fff;
  border-radius: var(--r-tile);
  padding: 20px 24px;
  display: flex; flex-direction: column; gap: 13px;
}
.hero::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  border-top: 1px solid rgba(255, 255, 255, 0.13);
}
.hero-top { display: flex; align-items: flex-start; gap: 18px; }
.hero-k { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.58); letter-spacing: var(--ls-wide-sm); }
.hero-v {
  font-size: var(--fs-num); font-weight: 600; letter-spacing: -0.02em;
  line-height: 1.06; margin-top: 2px;
}
.hero-sum {
  font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.78);
  letter-spacing: var(--ls-wide); line-height: 1.65; margin-top: 4px; max-width: 640px;
}
.hero-sum b { color: #fff; font-weight: 600; }
.hero-acts { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

/* 深色卡上的胶囊钮（描边 = 微白；主白钮用于最重要的动作） */
.hb {
  display: inline-flex; align-items: center; gap: 6px;
  height: 31px; padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.14);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-sm); font-weight: 500; color: #fff; white-space: nowrap;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.hb:hover { background: rgba(255, 255, 255, 0.22); border-color: rgba(255, 255, 255, 0.4); }
.hb:active { transform: scale(0.955); }
.hb:disabled { opacity: 0.4; pointer-events: none; }
.hb-white { background: #fff; color: var(--accent); font-weight: 600; border-color: #fff; }
.hb-white:hover { background: #f2f6fb; border-color: #fff; }
.hb-danger { background: var(--red-fg); border-color: var(--red-fg); font-weight: 600; }
.hb-danger:hover { background: #9a1d14; border-color: #9a1d14; }

/* 整届操作行 */
.hero-issue {
  display: flex; align-items: center; gap: 12px;
  padding-top: 13px; border-top: 1px solid rgba(255, 255, 255, 0.12);
}
.hi-ic {
  width: 28px; height: 28px; flex: none; border-radius: 9px;
  background: rgba(255, 69, 58, 0.17); color: #ff7b72;
  display: flex; align-items: center; justify-content: center;
}
.hi-txt { flex: 1; min-width: 0; }
.hi-t { font-size: var(--fs-md); font-weight: 600; letter-spacing: var(--ls-wide); }
.hi-m {
  font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.6);
  margin-top: 2px; letter-spacing: var(--ls-wide-sm); line-height: 1.6;
}
.hi-m b { color: #fff; font-weight: 600; }
.hi-acts { display: flex; align-items: center; gap: 8px; flex: none; }

/* ══════════ 自绘表格（v3 细线表） ══════════ */
.tablecard {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 5px 0;
  overflow-x: auto;
}
.tb { width: 100%; min-width: 1080px; border-collapse: collapse; table-layout: fixed; }
.tb th {
  text-align: left; font-size: var(--fs-xs); font-weight: 500; color: var(--muted);
  letter-spacing: var(--ls-wide-sm); padding: 11px 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.07); white-space: nowrap;
}
.tb td {
  font-size: var(--fs-md); line-height: 1.5; padding: 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.045); vertical-align: middle; color: var(--ink-2);
}
.tb th:first-child, .tb td:first-child { padding-left: 18px; }
.tb th:last-child, .tb td:last-child { padding-right: 18px; }
.tb tbody tr { transition: background 0.16s var(--ease); }
.tb tbody tr:hover { background: rgba(255, 255, 255, 0.8); }
.tb tbody tr.sel { background: rgba(0, 102, 204, 0.055); }
.tb tbody tr:last-child td { border-bottom: none; }
.tb .c { text-align: center; }
.tb .r { text-align: right; }
.tb-user { font-size: 12.5px; }
.tb-dim { font-size: 11.5px; color: var(--muted-2); }

/* 自绘 checkbox（16px 圆角方框，按下缩放） */
.cb {
  width: 16px; height: 16px; border-radius: 5px;
  border: 1.5px solid #d2d2d7; background: var(--canvas);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; vertical-align: middle; cursor: pointer; padding: 0; color: #fff;
  transition: transform 0.15s cubic-bezier(0.34, 1.6, 0.64, 1), background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.cb:active { transform: scale(0.86); }
.cb.on { background: var(--accent); border-color: var(--accent); }

/* 头像圆（姓名首字，全站规则） */
.av {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  background: var(--canvas); border: 1px solid var(--hairline);
  color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-xs); font-weight: 600; line-height: 1;
}

/* 状态标签（23px 胶囊，语义色只出现在这里） */
.tag {
  display: inline-flex; align-items: center; height: 23px; padding: 0 10px;
  border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 500;
  letter-spacing: var(--ls-wide-sm); line-height: 1; white-space: nowrap;
}
.tag-ok { background: var(--green-bg); color: var(--green-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-mute { background: #ebebee; color: var(--muted); }

/* 行内操作：27px 小胶囊钮 */
.rowact { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.rx {
  display: inline-flex; align-items: center; justify-content: center;
  height: 27px; padding: 0 11px; flex: none;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-xs); font-weight: 500; color: var(--ink-2); white-space: nowrap;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease), transform 0.16s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.rx:hover { border-color: #cfcfd4; }
.rx:active { transform: scale(0.94); }
.rx:disabled { opacity: 0.45; pointer-events: none; }
.rx-danger { border-color: var(--red-bg); color: var(--red-fg); }
.rx-danger:hover { background: var(--red-bg); border-color: #f0c4c0; }

/* 就地改名输入框 */
.cell-input {
  width: 100%; height: 30px; padding: 0 9px;
  background: var(--canvas); border: 1px solid var(--accent);
  border-radius: 8px; outline: none; box-sizing: border-box;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink);
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
}

/* ══════════ 分页（自绘） ══════════ */
.pager { display: flex; align-items: center; gap: 5px; padding: 0 4px; flex-wrap: wrap; }
.pg-info {
  font-size: var(--fs-sm); color: var(--muted);
  letter-spacing: var(--ls-wide); margin-right: auto;
}
.pg {
  min-width: 30px; height: 30px; padding: 0 9px; border: none; border-radius: 9px;
  background: transparent; cursor: pointer;
  font-family: inherit; font-size: var(--fs-sm); color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.16s var(--ease), transform 0.15s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.pg:hover { background: rgba(0, 0, 0, 0.045); }
.pg:active { transform: scale(0.9); }
.pg.on { background: var(--ink); color: #fff; font-weight: 600; }
.pg.gap { cursor: default; pointer-events: none; }
.pg:disabled { opacity: 0.35; pointer-events: none; }

/* ══════════ 加载骨架：列宽与真实表格一一对应 ══════════ */
.sk { display: flex; flex-direction: column; min-width: 1080px; }
.sk-row {
  display: grid;
  grid-template-columns: 46px 122px 128px 124px 88px 92px 100px 152px 1fr;
  align-items: center;
  height: 52px;
  padding: 0 10px;
}
.sk-row:first-child { padding-left: 18px; }
.sk-row + .sk-row { border-top: 1px solid rgba(0, 0, 0, 0.045); }
.sk-box { width: 16px; height: 16px; border-radius: 4px; background: var(--divider); justify-self: center; }
.sk-line { display: block; height: 12px; border-radius: 6px; background: var(--divider); }
.sk-av { width: 26px; height: 26px; border-radius: 50%; background: var(--divider); }
.sk-pill { width: 46px; height: 23px; border-radius: var(--r-pill); background: var(--divider); justify-self: center; }
.sk-ops { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.sk-btn { display: block; width: 62px; height: 27px; border-radius: var(--r-pill); background: var(--divider); }
.sk-btn--sm { width: 40px; }
@keyframes sk-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.sk .sk-box, .sk .sk-line, .sk .sk-av, .sk .sk-pill, .sk .sk-btn { animation: sk-breathe 1.4s ease-in-out infinite; }

/* ══════════ 批量浮条：毛玻璃、居中、勾选后浮起 ══════════ */
.batchbar {
  position: fixed;
  left: calc(50% + 116px);   /* 内容区中轴（侧栏 232px 的一半） */
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 40;
  display: flex; align-items: center; gap: 10px;
  background: rgba(255, 255, 255, 0.74);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  border-radius: var(--r-pill);
  padding: 8px 9px 8px 20px;
  box-shadow: 0 14px 40px -14px rgba(0, 0, 0, 0.26), 0 2px 8px -2px rgba(0, 0, 0, 0.1);
}
.batchbar::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  border-top: 1px solid rgba(255, 255, 255, 0.65);
}
.bb-cnt { font-size: var(--fs-md); font-weight: 500; color: var(--ink-2); white-space: nowrap; }
.bb-cnt b { font-size: var(--fs-xl); font-weight: 600; color: var(--accent); margin: 0 3px; }
.bb-hint { font-size: var(--fs-xs); color: var(--muted-2); margin-right: 6px; white-space: nowrap; }
.batchbar .btn-ghost, .batchbar .btn-danger { height: 31px; font-size: var(--fs-sm); }
.batchbar .btn-plain { height: 31px; font-size: var(--fs-sm); padding: 0 8px; }

.bb-enter-active { transition: opacity 0.24s var(--ease), transform 0.34s cubic-bezier(0.34, 1.4, 0.64, 1); }
.bb-leave-active { transition: opacity 0.16s var(--ease), transform 0.2s var(--ease); }
.bb-enter-from, .bb-leave-to { opacity: 0; transform: translateX(-50%) translateY(16px); }
.bb-enter-to, .bb-leave-from { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (prefers-reduced-motion: reduce) {
  .chip-move, .chip-enter-active, .chip-leave-active,
  .bb-enter-active, .bb-leave-active { transition-duration: 0.01ms; }
}
</style>
