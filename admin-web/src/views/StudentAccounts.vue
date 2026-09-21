<template>
  <div class="stu" :class="{ 'has-bar': showBar }">
    <!-- ══════════ 筛选条件条 ══════════ -->
    <div class="fbar">
      <span class="fbar-lead">
        <IconFilter :size="14" />筛选条件
      </span>

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
        <input v-model="q.keyword" placeholder="搜索姓名 / 账号" @keyup.enter="reloadNow" />
        <button v-if="q.keyword" class="fs-x" title="清空" @click="q.keyword = ''">
          <IconClose :size="12" />
        </button>
      </div>

      <div class="fbar-right">
        <button type="button" class="btn-ghost" @click="batchesOpen = true">导入批次</button>
        <el-button type="primary" @click="importOpen = true">
          <IconUpload :size="15" class="btn-ico" />名册导入
        </el-button>
      </div>
    </div>

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

    <!-- ══════════ 深色 hero：命中数 + 整届操作 ══════════ -->
    <div class="hero">
      <div class="h-l">
        <span class="h-k">命中账号</span>
        <span class="h-v num">{{ listTotal }}</span>
      </div>
      <div class="h-mid">
        <span>初始密码 = <b>user + 学号</b></span>
        <span v-if="switchState.accountLoginRequired">· 登录已强制，微信登录已关闭</span>
        <span v-else>· 微信登录仍开放</span>
      </div>
      <div class="h-r" v-if="q.grade && gradeDetail">
        <span class="micro">
          {{ gradeDetail.name }} · {{ gradeDetail.total }} 个账号 ·
          已激活 {{ gradeDetail.activated }} · {{ gradeDetail.classCount }} 个班
        </span>
        <button type="button" class="btn-dark" @click="exportScope">导出本届</button>
        <button type="button" class="btn-dark btn-dark-danger" @click="purgeOpen = true">毕业清理</button>
      </div>
      <div class="h-r" v-else>
        <span class="micro">选定年级后，这里会出现「导出本届 / 毕业清理」</span>
      </div>
    </div>

    <!-- ══════════ 结果表 ══════════ -->
    <el-card>
      <!-- v6 加载骨架：块尺寸 = 真实组件（正文 12 / 标签 22 / 按钮 36），呼吸不转圈 -->
      <div v-if="loading && !listRows.length" class="sk" aria-hidden="true">
        <div v-for="i in 6" :key="i" class="sk-row">
          <span class="sk-box"></span>
          <span class="sk-line" style="width: 88px"></span>
          <span class="sk-line" style="width: 56px"></span>
          <span class="sk-line" style="width: 88px"></span>
          <span class="sk-pill"></span>
          <span class="sk-pill sk-pill--wide"></span>
          <span class="sk-line" style="width: 104px"></span>
          <span class="sk-ops">
            <i class="sk-line"></i>
            <i class="sk-btn"></i>
            <i class="sk-btn sk-btn--sm"></i>
          </span>
        </div>
      </div>

      <el-table
        v-else
        ref="tableRef"
        :data="listRows" stripe
        :class="{ 'is-busy': loading }"
        @selection-change="(r) => (selected = r)"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="账号" prop="username" width="132">
          <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
        </el-table-column>
        <el-table-column label="姓名" width="110">
          <template #default="{ row }">{{ row.name || '—' }}</template>
        </el-table-column>
        <el-table-column label="班级" width="120">
          <template #default="{ row }">{{ row.className || '—' }}</template>
        </el-table-column>
        <el-table-column label="启用" width="106" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="light" :type="row.status === 1 ? 'success' : 'danger'">
              {{ row.status === 1 ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="激活" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="light" :type="row.pwdChangedAt ? 'success' : 'info'">
              {{ row.pwdChangedAt ? '已激活' : '未激活' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近登录" min-width="150">
          <template #default="{ row }">
            <span class="c-time">{{ row.lastLoginAt ? fmt(row.lastLoginAt) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="216" align="right">
          <template #default="{ row }">
            <div class="op-cell">
              <button type="button" class="link-btn" @click="openRename(row)">改名</button>
              <el-button size="small" @click="resetPassword(row)">重置密码</el-button>
              <el-button size="small" plain :type="row.status === 1 ? 'danger' : 'primary'" @click="toggleStatus(row)">
                {{ row.status === 1 ? '停用' : '启用' }}
              </el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState
            variant="content"
            :title="chips.length ? '没有符合条件的账号' : '还没有学生账号'"
            :description="chips.length ? '摘掉一个条件再看看' : '用「名册导入」上传名册，或先下载模板看看格式'"
          />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="q.page"
        v-model:page-size="q.pageSize"
        :total="listTotal"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pager"
      />
    </el-card>

    <!-- ══════════ 批量操作条：范围＝筛选结果（勾选后收敛为选中的 N 个） ══════════ -->
    <Transition name="bb">
      <div v-if="showBar" class="batchbar">
        <span class="bb-cnt">
          <template v-if="selected.length">已选 <b class="num">{{ selected.length }}</b> 条</template>
          <template v-else>范围＝筛选结果 <b class="num">{{ listTotal }}</b> 个</template>
        </span>
        <span class="micro bb-hint">勾选列表里的行可把范围收敛到选中的那几个</span>
        <button type="button" class="btn-quiet" :disabled="busy" @click="exportScope">导出 xlsx</button>
        <button type="button" class="btn-quiet" :disabled="busy" @click="batchResetPwd">重置为初始密码</button>
        <button type="button" class="btn-quiet" :disabled="busy" @click="batchDisable">批量停用</button>
        <button v-if="auth.isSuperAdmin" type="button" class="btn-danger" :disabled="busy" @click="batchRemove">批量删除</button>
        <button v-if="selected.length" type="button" class="btn-plain" @click="clearSelection">取消选择</button>
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

    <!-- ══════════ 改名 ══════════ -->
    <el-dialog v-model="renameVisible" width="420px" title="修改姓名">
      <div class="micro" style="margin:-4px 0 10px">
        账号 <span class="mono">{{ renameRow?.username || '—' }}</span> ·
        {{ renameRow?.className || '未分班' }} —— 保存后学生端「我的」页也会同步显示新名字。
      </div>
      <el-input v-model="renameValue" placeholder="学生姓名" maxlength="64" @keyup.enter="submitRename" />
      <template #footer>
        <el-button @click="renameVisible = false">取消</el-button>
        <el-button type="primary" @click="submitRename">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
/**
 * 学生账号（单页 + 筛选条件）
 *
 * 形态（v2/v3 定的，别再改回页签或目录树）：
 *   筛选条件条 → 已选条件胶囊 → 深色 hero → 结果表 → 分页 → 批量条
 *   · 条件顺序：年级 → 班级 → 启用状态 → 激活状态 → 导入批次 → 关键字
 *   · 班级级联于年级：没选年级就禁用并写「先选年级」，改年级自动清班级
 *   · 批量操作范围＝筛选结果；勾选后收敛成选中的那几个
 *   · 整届操作（导出本届 / 毕业清理）只在选了年级时出现
 *   · 条件全部同步进地址栏（?grade=&class=&status=&activated=&batch=&q=&page=&size=）
 *
 * ⚠️ 班级选项只从「当前选中年级」的详情里取 —— 以前取的是 gradeInfo.classes
 *    （取决于上次打开过哪个年级），那就是「主目录 / 子目录混淆」那个 bug。
 */
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';
import { IconSearch, IconUpload, IconFilter, IconClose } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';
import FilterPill from '@/components/FilterPill.vue';
import ImportSheet from '@/components/student/ImportSheet.vue';
import BatchesSheet from '@/components/student/BatchesSheet.vue';
import PurgeSheet from '@/components/student/PurgeSheet.vue';

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

const gradeList = ref([]);
const gradeCache = reactive({});          // grade → 该届详情（含班级分布与试算）
const batchRows = ref([]);
const switchState = reactive({ accountLoginRequired: true });

const listRows = ref([]);
const listTotal = ref(0);
const loading = ref(false);
const busy = ref(false);
const tableRef = ref(null);
const selected = ref([]);

const importOpen = ref(false);
const batchesOpen = ref(false);
const purgeOpen = ref(false);

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
    value: b.id, label: `#${b.id} · ${b.filename}`, hint: `新建 ${b.created}`,
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

function clearAll() {
  q.grade = ''; q.classNo = ''; q.batchId = '';
  q.status = ''; q.activated = ''; q.keyword = '';
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

async function loadSwitchState() {
  try {
    const d = await http.get('/admin/switch/list');
    const arr = Array.isArray(d) ? d : (d?.list || []);
    const item = arr.find((x) => x.key === 'account_login_required');
    if (item) switchState.accountLoginRequired = !!item.value;
  } catch { /* 静默 */ }
}

/** 选定年级后取该届详情：班级选项 + 毕业清理试算都靠它 */
async function loadGradeDetail(grade) {
  if (!grade || gradeCache[grade]) return;
  try {
    gradeCache[grade] = await http.get(`/admin/student/grade/${grade}`);
  } catch { /* 该届可能已被清理 */ }
}

/* ── 地址栏同步 ── */
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

function reload() { fetchStudents(); syncRoute(); }
function reloadNow() { q.page = 1; reload(); }

let kwTimer = null;
watch(() => [q.grade, q.classNo, q.batchId, q.status, q.activated], () => { q.page = 1; reload(); });
watch(() => [q.page, q.pageSize], () => reload());
watch(() => q.keyword, () => {
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => { q.page = 1; reload(); }, 320);
});
watch(() => q.grade, (g) => { q.classNo = ''; loadGradeDetail(g); });

/* ── 批量：范围＝筛选结果（勾选后收敛） ── */
const showBar = computed(() => listTotal.value > 0);

function clearSelection() {
  selected.value = [];
  tableRef.value?.clearSelection?.();
}

/** 没勾选时按当前筛选条件把 id 全取回来（最多 2000，够用） */
async function scopeIds() {
  if (selected.value.length) return selected.value.map((r) => r.id);
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

const scopeText = () => (selected.value.length
  ? `选中的 ${selected.value.length} 个账号`
  : `筛选出的 ${listTotal.value} 个账号`);

async function exportScope() {
  const params = buildParams();
  delete params.page; delete params.pageSize;
  try {
    const blob = await http.get('/admin/student/export', { params, responseType: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `学生账号_${dayjs().format('YYYYMMDD-HHmm')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage.success('已导出（含初始密码列）');
  } catch (e) {
    ElMessage.error(e?.message || '导出失败');
  }
}

async function batchResetPwd() {
  const text = scopeText();
  try {
    await ElMessageBox.confirm(
      `把${text}重置为各自的初始密码（user + 学号）？重置后他们当前的登录态会立即失效。`,
      '重置为初始密码',
      { type: 'warning', confirmButtonText: '重置' }
    );
  } catch { return; }
  busy.value = true;
  try {
    const ids = await scopeIds();
    const d = await http.post('/admin/student/reset-password/batch', { ids });
    ElMessage.success(`已重置 ${d?.affected ?? ids.length} 个账号为初始密码`);
    clearSelection();
    await fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '重置失败');
  } finally { busy.value = false; }
}

async function batchDisable() {
  const text = scopeText();
  try {
    await ElMessageBox.confirm(
      `停用${text}？他们立刻登不进来，但账号与历史投稿都还在（可再启用）。`,
      '批量停用',
      { type: 'warning', confirmButtonText: '停用' }
    );
  } catch { return; }
  busy.value = true;
  try {
    const ids = await scopeIds();
    const d = await http.post('/admin/student/status/batch', { ids, status: 0 });
    ElMessage.success(`已停用 ${d?.affected ?? ids.length} 个账号`);
    clearSelection();
    await fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '停用失败');
  } finally { busy.value = false; }
}

async function batchRemove() {
  const text = scopeText();
  try {
    await ElMessageBox.confirm(
      `删除${text}？没有投稿记录的会真删（不可恢复），有投稿记录的会自动改为「停用」，`
        + '相关的投稿记录仍留在审核列表里。',
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    );
  } catch { return; }
  busy.value = true;
  try {
    const ids = await scopeIds();
    const d = await http.post('/admin/student/delete/batch', { ids });
    ElMessage.success(
      `已处理 ${d.total} 个：删除 ${d.deleted} 个、转为停用 ${d.disabled} 个`
      + (d.failed?.length ? `，${d.failed.length} 个失败` : '')
    );
    clearSelection();
    await Promise.all([fetchStudents(), loadGrades()]);
  } catch (e) {
    ElMessage.error(e?.message || '删除失败');
  } finally { busy.value = false; }
}

/* ── 行内动作 ── */
const renameVisible = ref(false);
const renameValue = ref('');
const renameRow = ref(null);

function openRename(row) {
  renameRow.value = row;
  renameValue.value = row.name || '';
  renameVisible.value = true;
}

async function submitRename() {
  const name = String(renameValue.value || '').trim();
  if (!name) {
    ElMessage.warning('姓名不能为空');
    return;
  }
  if (name === String(renameRow.value?.name || '').trim()) {
    renameVisible.value = false;
    ElMessage.info('姓名没有变化');
    return;
  }
  try {
    // ⚠️ 字段名必须是 name：后端 updateStudent 读 payload.name，并同时写进
    //    remark（管理端列表）与 nickname（投稿 / 留言 / 小程序「我的」）。
    //    以前发 { remark, nickname } 后端认不出来 → 回 200 但一个字没改。
    await http.put(`/admin/student/${renameRow.value.id}`, { name });
    ElMessage.success('姓名已更新，学生端同步生效');
    renameVisible.value = false;
    fetchStudents();
  } catch (e) {
    // http 拦截器对业务错误只 reject、不弹提示，这里必须自己说人话
    ElMessage.error(e?.message || '保存失败');
  }
}

async function resetPassword(row) {
  try {
    const d = await http.put(`/admin/student/${row.id}/reset-password`);
    await ElMessageBox.alert(
      `新密码：${d.initPassword}（= user + 学号）；学生下次登录必须改密。`,
      '已重置',
      { confirmButtonText: '知道了' }
    );
    fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '重置失败');
  }
}

async function toggleStatus(row) {
  const next = row.status === 1 ? 0 : 1;
  try {
    await ElMessageBox.confirm(
      next === 0 ? '停用后该学生立即无法登录（旧 token 下一次请求失效）。' : '启用后该学生可以正常登录。',
      next === 0 ? '停用账号' : '启用账号',
      { type: 'warning' }
    );
  } catch { return; }
  try {
    await http.put(`/admin/student/${row.id}/status`, { status: next });
    ElMessage.success(next === 0 ? '已停用' : '已启用');
    fetchStudents();
  } catch (e) {
    ElMessage.error(e?.message || '操作失败');
  }
}

/* ── 弹层回写 ── */
async function onImported() {
  await Promise.all([loadGrades(), loadBatches()]);
  Object.keys(gradeCache).forEach((k) => delete gradeCache[k]);
  await fetchStudents();
}
async function afterWrite() {
  await Promise.all([loadGrades(), loadBatches()]);
  Object.keys(gradeCache).forEach((k) => delete gradeCache[k]);
  if (q.grade) await loadGradeDetail(q.grade);
  await fetchStudents();
}

async function refreshPage() {
  await Promise.all([loadGrades(), loadBatches(), loadSwitchState()]);
  await fetchStudents();
}

onMounted(async () => {
  fromRoute();
  setRefreshHandler(refreshPage);
  await refreshPage();
  if (q.grade) await loadGradeDetail(q.grade);
  setPageHeader({
    title: '学生账号',
    subtitle: `${gradeList.value.length} 个年级 · 共 ${gradeList.value.reduce((s, g) => s + g.total, 0)} 个账号`,
  });
});

onBeforeUnmount(() => {
  clearTimeout(kwTimer);
  clearRefreshHandler(refreshPage);
  clearPageHeader();
});
</script>

<style scoped>
.stu { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
.stu.has-bar { padding-bottom: 84px; }
.mono { font-family: var(--mono); }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.c-time { font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums; }

/* ══════════ 筛选条件条 ══════════ */
.fbar {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--parchment); border-radius: 16px;
}
.fbar-lead {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: var(--fs-xs); font-weight: 600; color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm); padding-right: 4px;
}
.fbar-lead :deep(svg) { color: var(--muted-2); }
.fbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

.fsearch {
  display: inline-flex; align-items: center; gap: 7px;
  flex: 1 1 150px; min-width: 128px; max-width: 220px;
  box-sizing: border-box;
  height: 34px; padding: 0 11px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); color: var(--soft);
  transition: border-color 0.16s var(--ease), box-shadow 0.16s var(--ease);
}
.fsearch:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
}
.fsearch.on { border-color: var(--accent); }
.fsearch input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink);
}
.fsearch input::placeholder { color: var(--soft); }
.fs-x {
  border: none; background: transparent; cursor: pointer; padding: 2px;
  display: inline-flex; color: var(--soft); border-radius: 50%;
}
.fs-x:hover { color: var(--ink); }

.btn-ghost {
  height: 34px; padding: 0 13px;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.btn-ghost:hover { border-color: var(--soft); background: var(--parchment); }
.btn-ico { margin-right: 4px; vertical-align: -2px; }

/* ══════════ 已选条件胶囊（摘一枚，其余平滑挪位） ══════════ */
.picked { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pk-lead { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); margin-right: 2px; }
.pk {
  display: inline-flex; align-items: center; gap: 5px;
  height: 26px; padding: 0 9px;
  border: 1px solid transparent; background: var(--acc-bg);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); font-weight: 600; color: var(--accent);
  transition: background 0.16s var(--ease);
}
.pk:hover { background: #d6e6f7; }
.pk b { font-weight: 600; }
.pk-clear {
  border: none; background: transparent; cursor: pointer;
  font-family: inherit; font-size: var(--fs-sm); color: var(--muted);
  padding: 0 4px; text-decoration: underline;
}
.pk-clear:hover { color: var(--ink); }

/* 弹簧味的挪位（Vue 的 TransitionGroup 本身用 FLIP，这里只给曲线） */
.chip-move { transition: transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1); }
.chip-enter-active { transition: opacity 0.2s var(--ease), transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1); }
.chip-leave-active { transition: opacity 0.16s var(--ease), transform 0.16s var(--ease); position: absolute; }
.chip-enter-from, .chip-leave-to { opacity: 0; transform: scale(0.9); }

/* ══════════ hero（深色卡） ══════════ */
.hero {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  padding: 16px 20px;
  background: var(--tile); color: #fff;
  border-radius: var(--r-tile);
}
.h-l { display: flex; align-items: baseline; gap: 10px; flex: none; }
.h-k { font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62); letter-spacing: var(--ls-wide-sm); }
.h-v { font-size: var(--fs-num); font-weight: 600; line-height: 1; letter-spacing: var(--ls-tight); }
.h-mid {
  flex: 1; min-width: 0;
  font-size: var(--fs-sm); color: rgba(255, 255, 255, 0.72); line-height: 1.6;
}
.h-mid b { color: #fff; }
.h-r { flex: none; display: flex; align-items: center; gap: 10px; }
.h-r .micro { color: rgba(255, 255, 255, 0.62); }

.btn-dark {
  height: 30px; padding: 0 13px;
  border: 1px solid rgba(255, 255, 255, 0.24); background: rgba(255, 255, 255, 0.1);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: #fff;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.btn-dark:hover { background: rgba(255, 255, 255, 0.18); border-color: rgba(255, 255, 255, 0.4); }
.btn-dark-danger { border-color: rgba(255, 69, 58, 0.55); color: #ff8a80; }
.btn-dark-danger:hover { background: rgba(255, 69, 58, 0.16); border-color: rgba(255, 69, 58, 0.8); }

/* ══════════ 行内操作：只切视图＝文字链接；会改数据＝实体描边按钮 ══════════ */
.op-cell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.op-cell :deep(.el-button) { flex: none; }
.link-btn {
  border: none; background: transparent; cursor: pointer; padding: 0;
  font-family: inherit; font-size: var(--fs-md); font-weight: 500; color: var(--accent);
  white-space: nowrap; flex: none;
}
.link-btn:hover { text-decoration: underline; }

.pager { margin-top: 14px; justify-content: flex-end; }

/* ══════════ 加载骨架（v6 标准）：列宽与真实表格一一对应，块=真实组件尺寸 ══════════ */
.sk { display: flex; flex-direction: column; }
.sk-row {
  display: grid;
  grid-template-columns: 46px 132px 110px 120px 106px 100px 1fr 216px;
  align-items: center;
  height: 54px;
  padding: 0 12px;
}
.sk-row + .sk-row { border-top: 1px solid var(--divider); }
.sk-box { width: 16px; height: 16px; border-radius: 4px; background: var(--divider); justify-self: center; }
.sk-line { display: block; height: 12px; border-radius: 6px; background: var(--divider); }
.sk-pill { width: 52px; height: 22px; border-radius: var(--r-pill); background: var(--divider); justify-self: center; }
.sk-pill--wide { width: 58px; }
.sk-ops { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.sk-ops .sk-line { width: 28px; }
.sk-btn { display: block; width: 76px; height: 36px; border-radius: 10px; background: var(--divider); }
.sk-btn--sm { width: 49px; }
@keyframes sk-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.sk .sk-box, .sk .sk-line, .sk .sk-pill, .sk .sk-btn { animation: sk-breathe 1.4s ease-in-out infinite; }
.is-busy { opacity: 0.55; pointer-events: none; }

/* ══════════ 批量条：自包含圆角卡片（弹簧感的入场） ══════════ */
.batchbar {
  position: fixed; left: 252px; right: 20px; bottom: 16px; z-index: 40;
  display: flex; align-items: center; gap: 10px;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 16px;
  box-shadow: 0 12px 32px -14px rgba(0, 0, 0, 0.24);
  padding: 10px 16px;
}
.bb-cnt { font-size: var(--fs-md); color: var(--ink); flex: none; }
.bb-cnt b { font-weight: 600; }
.bb-hint { flex: 1; min-width: 0; }

.btn-quiet, .btn-plain, .btn-danger {
  flex: none;
  height: 32px; padding: 0 14px;
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); white-space: nowrap;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease), color 0.16s var(--ease);
}
.btn-quiet { border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink-2); }
.btn-quiet:hover { border-color: var(--soft); background: var(--parchment); }
.btn-quiet:active { transform: scale(0.985); }
.btn-plain { border: none; background: transparent; color: var(--muted); padding: 0 6px; }
.btn-plain:hover { color: var(--ink); }
.btn-danger { border: 1px solid #f0c4c0; background: var(--canvas); color: var(--red-fg); }
.btn-danger:hover { background: var(--red-bg); border-color: #e3a9a4; }
.btn-danger:active { transform: scale(0.985); }
.btn-quiet:disabled, .btn-danger:disabled { opacity: 0.5; cursor: default; }

.bb-enter-active { transition: opacity 0.24s var(--ease), transform 0.34s cubic-bezier(0.34, 1.4, 0.64, 1); }
.bb-leave-active { transition: opacity 0.16s var(--ease), transform 0.2s var(--ease); }
.bb-enter-from, .bb-leave-to { opacity: 0; transform: translateY(18px) scale(0.97); }
</style>
