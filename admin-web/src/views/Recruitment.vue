<template>
  <div class="recruitment-page">
    <el-alert v-if="!recruitmentAvailable" :title="recruitmentUnavailableMessage" type="warning" :closable="false" show-icon />
    <template v-else>
      <div class="section-toolbar">
        <div class="filters">
          <button class="filter" :class="{ on: !batchQuery.archived }" @click="changeArchive(false)">当前批次</button>
          <button class="filter" :class="{ on: batchQuery.archived }" @click="changeArchive(true)">历史归档</button>
        </div>
        <div class="actions">
          <el-button :loading="batchLoading" @click="refresh">刷新</el-button>
          <el-button v-if="auth.isSuperAdmin" type="primary" @click="openConfig()">新建招新批次</el-button>
        </div>
      </div>

      <div class="panel" v-loading="batchLoading">
        <el-table v-if="batches.length" :data="batches" row-key="id" highlight-current-row :current-row-key="selectedBatch?.id" @row-click="selectBatch">
          <el-table-column label="招新批次" min-width="210">
            <template #default="{ row }"><span class="strong">{{ row.title }}</span></template>
          </el-table-column>
          <el-table-column label="报名时间（北京时间）" min-width="290">
            <template #default="{ row }"><div>{{ formatTime(row.opensAt) }}</div><div class="micro">至 {{ formatTime(row.closesAt) }}</div></template>
          </el-table-column>
          <el-table-column label="状态" width="125">
            <template #default="{ row }"><span class="tag" :class="batchTag(row)">{{ batchState(row) }}</span></template>
          </el-table-column>
          <el-table-column label="待决定" width="90">
            <template #default="{ row }">{{ row.unresolvedCount ?? 0 }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90" align="right">
            <template #default="{ row }"><el-button type="primary" link @click.stop="selectBatch(row)">查看报名</el-button></template>
          </el-table-column>
        </el-table>
        <EmptyState v-else variant="content" :title="batchQuery.archived ? '暂无历史批次' : '暂无招新批次'" :description="auth.isSuperAdmin ? '新建批次，配置报名问题后发布。' : '超级管理员发布招新批次后，可在这里查看和审核报名。'" />
        <el-pagination v-if="batchTotal > batchQuery.pageSize" v-model:current-page="batchQuery.page" :page-size="batchQuery.pageSize" :total="batchTotal" layout="total, prev, pager, next" class="pager" @current-change="loadBatches" />
      </div>

      <template v-if="selectedBatch">
        <div class="batch-summary">
          <div class="summary-main">
            <div class="summary-caption">统一招录 · {{ batchState(selectedBatch) }}</div>
            <h2>{{ selectedBatch.title }}</h2>
            <p>{{ formatTime(selectedBatch.opensAt) }} 至 {{ formatTime(selectedBatch.closesAt) }}（北京时间）</p>
            <p>仅限高一、初一学生报名 · 无需学生账号 · {{ selectedBatch.questions?.length || 0 }} 道自定义问题</p>
          </div>
          <div class="summary-count"><strong>{{ selectedBatch.unresolvedCount ?? 0 }}</strong><span>份报名待决定</span></div>
        </div>
        <div class="batch-actions">
          <span class="micro">{{ selectedBatch.resultPublishedAt ? '结果已统一发布，审核和面试安排已锁定。' : isClosed(selectedBatch) ? '报名已截止，可审核、安排面试和拟定录取结果。' : '报名截止后开始审核；结果发布前，报名者看不到内部录取决定。' }}</span>
          <div v-if="auth.isSuperAdmin" class="actions">
            <el-button @click="openConfig(selectedBatch)">{{ selectedBatch.archivedAt ? '查看批次' : selectedBatch.publishedAt ? '查看 / 编辑批次' : '配置批次' }}</el-button>
            <el-button v-if="!selectedBatch.publishedAt" type="primary" :loading="batchActing" @click="batchAction('publish')">发布报名</el-button>
            <el-button v-else-if="!selectedBatch.resultPublishedAt" type="primary" :loading="batchActing" :disabled="!isClosed(selectedBatch) || selectedBatch.unresolvedCount !== 0" @click="batchAction('results')">统一发布录取结果</el-button>
            <el-button v-if="selectedBatch.resultPublishedAt && !selectedBatch.archivedAt" :loading="batchActing" @click="batchAction('archive')">归档批次</el-button>
          </div>
        </div>

        <div class="section-toolbar application-toolbar">
          <h3>报名名单 <span class="micro">共 {{ applicationTotal }} 份</span></h3>
          <div class="actions">
            <el-input v-model="applicationQuery.grade" placeholder="按填写的年级筛选" clearable class="grade-filter" @keyup.enter="filterApplications" @clear="filterApplications" />
            <el-select v-model="applicationQuery.status" placeholder="全部状态" clearable class="status-filter" @change="filterApplications">
              <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-button @click="filterApplications">筛选</el-button>
          </div>
        </div>
        <div class="panel" v-loading="applicationLoading">
          <el-table v-if="applications.length" :data="applications" row-key="id">
            <el-table-column prop="name" label="姓名" min-width="90" />
            <el-table-column prop="studentNo" label="学号" min-width="130" />
            <el-table-column prop="grade" label="年级" min-width="100" />
            <el-table-column prop="className" label="班级" min-width="100" />
            <el-table-column label="审核状态" min-width="125">
              <template #default="{ row }"><span class="tag" :class="applicationTag(row)">{{ applicationState(row) }}</span></template>
            </el-table-column>
            <el-table-column label="面试安排（北京时间）" min-width="180">
              <template #default="{ row }"><template v-if="row.interview"><div>{{ formatTime(row.interview.at) }}</div><div class="micro">{{ row.interview.location }}</div></template><span v-else class="micro">未安排</span></template>
            </el-table-column>
            <el-table-column label="提交时间" min-width="165">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="100" align="right">
              <template #default="{ row }"><el-button type="primary" link @click="openApplication(row)">查看 / 审核</el-button></template>
            </el-table-column>
          </el-table>
          <EmptyState v-else :title="selectedBatch.publishedAt ? '暂无符合条件的报名' : '批次尚未发布'" :description="selectedBatch.publishedAt ? '可以调整年级或状态筛选条件。' : '发布后，学生可从「我的」页面的「加入我们」报名。'" />
          <el-pagination v-if="applicationTotal" v-model:current-page="applicationQuery.page" v-model:page-size="applicationQuery.pageSize" :page-sizes="[20, 50, 100]" :total="applicationTotal" layout="total, sizes, prev, pager, next" class="pager" @current-change="loadApplications" @size-change="filterApplications" />
        </div>
      </template>
    </template>

    <el-dialog v-model="configVisible" :title="config.id ? '招新批次配置' : '新建招新批次'" width="min(820px, 94vw)" :close-on-click-modal="false">
      <el-alert v-if="config.publishedAt" :title="config.archivedAt ? '历史批次已归档，配置只读。' : configStarted ? '批次已开始：题目、名称和报名时间已锁定，可修改介绍。' : '批次已发布：题目与名称已锁定，报名开始前可调整时间。'" type="info" :closable="false" show-icon class="form-alert" />
      <el-form label-position="top" :disabled="!!config.archivedAt">
        <el-form-item label="批次名称（最多 100 字）" required><el-input v-model="config.title" :disabled="!!config.publishedAt" placeholder="例如：2026 年秋季广播站招新" /></el-form-item>
        <el-form-item label="招新介绍（最多 10000 字）" required><el-input v-model="config.intro" type="textarea" :rows="5" placeholder="填写招新说明、报名要求和联系渠道。" /></el-form-item>
        <div class="two-columns">
          <el-form-item label="报名开始时间（北京时间）" required><el-date-picker v-model="config.opensAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :disabled="configStarted" placeholder="选择开始时间" /></el-form-item>
          <el-form-item label="报名截止时间（北京时间）" required><el-date-picker v-model="config.closesAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" :disabled="configStarted" placeholder="选择截止时间" /></el-form-item>
        </div>
      </el-form>
      <div class="fixed-fields"><strong>固定必填信息</strong><p>姓名、学号、年级、班级，由报名者自行填写。表单统一标注「仅限高一、初一学生报名」，不校验学生名册或年级资格。</p></div>
      <div class="section-toolbar question-heading"><h3>自定义问题 <span class="micro">{{ config.questions.length }} / 20</span></h3><el-button v-if="!config.publishedAt" type="primary" plain :disabled="config.questions.length >= 20" @click="addQuestion">添加问题</el-button></div>
      <div v-if="!config.questions.length" class="question-empty">暂未添加自定义问题，报名表将只包含四项固定信息。</div>
      <div v-for="(question, index) in config.questions" :key="question.id" class="question-editor">
        <div class="question-top"><strong>问题 {{ index + 1 }}</strong><div v-if="!config.publishedAt" class="actions"><el-button size="small" :disabled="index === 0" @click="moveQuestion(index, -1)">上移</el-button><el-button size="small" :disabled="index === config.questions.length - 1" @click="moveQuestion(index, 1)">下移</el-button><el-button size="small" type="danger" plain @click="config.questions.splice(index, 1)">删除</el-button></div></div>
        <el-form label-position="top" :disabled="!!config.publishedAt">
          <el-form-item label="题目（最多 200 字）" required><el-input v-model="question.title" placeholder="填写问题" /></el-form-item>
          <div class="question-settings"><el-select v-model="question.type" class="type-select" @change="changeQuestionType(question)"><el-option v-for="item in questionTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select><el-switch v-model="question.required" active-text="必填" /></div>
          <div v-if="isChoice(question)" class="option-editor">
            <div v-for="(option, optionIndex) in question.options" :key="option.id" class="option-row"><span class="micro">{{ optionIndex + 1 }}</span><el-input v-model="option.label" placeholder="选项内容（最多 100 字）" /><el-button v-if="!config.publishedAt" :disabled="question.options.length <= 2" @click="question.options.splice(optionIndex, 1)">移除</el-button></div>
            <el-button v-if="!config.publishedAt" :disabled="question.options.length >= 20" @click="question.options.push(newOption())">添加选项</el-button>
            <p class="micro">至少 2 个选项，最多 20 个；选项内容不能重复。</p>
          </div>
        </el-form>
      </div>
      <template #footer><el-button @click="configVisible = false">{{ config.archivedAt ? '关闭' : '取消' }}</el-button><el-button v-if="!config.archivedAt" type="primary" :loading="configSaving" @click="saveConfig">{{ config.publishedAt ? '保存允许修改的配置' : '保存草稿' }}</el-button></template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="报名详情与审核" size="min(680px, 96vw)" :close-on-click-modal="false" @closed="clearDetail">
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="detail">
          <div class="detail-heading"><div><h2>{{ detail.name }}</h2><p class="micro">{{ detail.batch?.title }} · {{ formatTime(detail.createdAt) }} 提交</p></div><span class="tag" :class="applicationTag(detail)">{{ applicationState(detail) }}</span></div>
          <el-alert v-if="!canReview" :title="reviewLockReason" type="info" :closable="false" class="form-alert" />
          <el-alert v-else title="内部决定先保存，超管统一发布后报名者才可查看结果。" type="info" :closable="false" class="form-alert" />
          <el-descriptions :column="2" border><el-descriptions-item label="姓名">{{ detail.name }}</el-descriptions-item><el-descriptions-item label="学号">{{ detail.studentNo }}</el-descriptions-item><el-descriptions-item label="年级">{{ detail.grade }}</el-descriptions-item><el-descriptions-item label="班级">{{ detail.className }}</el-descriptions-item></el-descriptions>
          <section class="detail-section"><h3>报名回答</h3><div v-for="(question, index) in detail.batch?.questions || []" :key="question.id" class="answer"><div class="answer-title">{{ index + 1 }}. {{ question.title }} <span class="micro">{{ question.required ? '必填' : '选填' }}</span></div><div class="answer-content">{{ answerText(question, detail.answers?.[question.id]) }}</div></div><p v-if="!detail.batch?.questions?.length" class="micro">本批次未设置自定义问题。</p></section>
          <section class="detail-section">
            <h3>面试安排</h3><p class="micro">保存后报名者可立即凭查询码查看。所有时间均为北京时间。</p>
            <p v-if="detail.decision" class="lock-hint">已有审核决定，面试安排已锁定；结果发布前可修正决定，或先撤销拟定结果再调整面试安排。</p>
            <el-form label-position="top" :disabled="!canReview || !!detail.decision">
              <el-form-item label="面试时间（北京时间）" required><el-date-picker v-model="interviewForm.at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="选择面试时间" /></el-form-item>
              <el-form-item label="面试地点（最多 200 字）" required><el-input v-model="interviewForm.location" placeholder="例如：教学楼 301 广播室" /></el-form-item>
              <el-form-item label="面试说明（报名者可见，最多 2000 字）"><el-input v-model="interviewForm.note" type="textarea" :rows="3" placeholder="填写到场要求或需准备的内容。" /></el-form-item>
            </el-form>
            <el-button v-if="canReview && !detail.decision" type="primary" :loading="detailSaving" @click="saveInterview">{{ detail.interview ? '更新面试安排' : '安排面试' }}</el-button>
          </section>
          <section class="detail-section">
            <h3>审核与结果</h3>
            <el-form label-position="top" :disabled="!canReview">
              <el-form-item label="内部备注（仅管理员可见，最多 2000 字）"><el-input v-model="reviewForm.internalNote" type="textarea" :rows="4" placeholder="审核记录、面试评价等。" /></el-form-item>
              <el-form-item label="审核决定"><el-select v-model="reviewForm.decision" :clearable="!detail.decision" placeholder="暂不决定，仅保存备注"><el-option v-if="detail.progress === 'interview'" label="拟录取" value="accepted" /><el-option label="拟不录取" value="rejected" /></el-select><p class="micro">{{ detail.progress === 'submitted' ? '已提交报名可安排面试，或直接拟定不录取；录取须先安排面试。' : '可拟定录取或不录取，统一发布前可以修正决定。' }}</p></el-form-item>
              <el-form-item label="结果说明（统一发布后报名者可见，最多 2000 字）"><el-input v-model="reviewForm.publicNote" type="textarea" :rows="3" placeholder="填写录取后的要求，或未录取的对外说明。" /></el-form-item>
            </el-form>
            <div v-if="canReview" class="actions"><el-button type="primary" :loading="detailSaving" @click="saveReview">保存审核</el-button><el-button v-if="detail.decision" :disabled="detailSaving" @click="retractDecision">撤销拟定结果</el-button></div>
          </section>
        </template>
        <EmptyState v-else-if="!detailLoading" title="未能加载报名详情" description="关闭后重试，或刷新报名名单。" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import EmptyState from '@/components/EmptyState.vue';
import { useAuthStore } from '@/stores/auth';
import { clearPageHeader, setPageHeader } from '@/utils/pageHeader';
import {
  recruitmentAvailable, recruitmentUnavailableMessage, listBatches, getBatch, createBatch,
  updateBatch, publishBatch, publishResults, archiveBatch, listApplications, getApplication,
  reviewApplication, arrangeInterview,
} from '@/api/recruitment';

const auth = useAuthStore();
const batches = ref([]);
const batchTotal = ref(0);
const batchLoading = ref(false);
const batchActing = ref(false);
const batchQuery = reactive({ page: 1, pageSize: 10, archived: false });
const selectedBatch = ref(null);
const applications = ref([]);
const applicationTotal = ref(0);
const applicationLoading = ref(false);
const applicationQuery = reactive({ page: 1, pageSize: 20, grade: '', status: '' });
let batchRequest = 0;
let selectionRequest = 0;
let applicationRequest = 0;

const statusOptions = [
  { value: 'submitted', label: '已提交' }, { value: 'interview', label: '待面试' },
  { value: 'accepted', label: '已录取（含未发布）' }, { value: 'rejected', label: '未录取（含未发布）' },
  { value: 'withdrawn', label: '已撤回' },
];
const questionTypes = [
  { value: 'text', label: '单行文本' }, { value: 'textarea', label: '多行文本' },
  { value: 'single', label: '单选' }, { value: 'multiple', label: '多选' },
];

// 日期输入始终表示北京时间，避免管理员浏览器的时区改变报名窗口。
const beijingFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timestamp = (value) => value ? new Date(value).getTime() : NaN;
function dateInput(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? beijingFormatter.format(new Date(time)) : '';
}
const formatTime = (value) => dateInput(value).slice(0, 16) || '—';
const fromDateInput = (value) => value ? new Date(`${value.replace(' ', 'T')}+08:00`).getTime() : NaN;
const textLength = (value) => [...String(value || '')].length;
const isClosed = (batch) => !!batch?.publishedAt && timestamp(batch.closesAt) <= Date.now();
function batchState(batch) {
  if (batch.archivedAt) return '已归档';
  if (batch.resultPublishedAt) return '结果已发布';
  if (!batch.publishedAt) return '草稿';
  if (timestamp(batch.opensAt) > Date.now()) return '尚未开放';
  return isClosed(batch) ? '报名已截止' : '报名中';
}
function batchTag(batch) { return batch.resultPublishedAt ? 'tag-pass' : batch.publishedAt && !isClosed(batch) ? 'tag-wait' : 'tag-mute'; }
function applicationState(application) {
  if (application.progress === 'withdrawn') return '已撤回';
  if (application.decision) {
    const published = application.batch?.resultPublishedAt || selectedBatch.value?.id === application.batchId && selectedBatch.value?.resultPublishedAt;
    return application.decision === 'accepted' ? (published ? '已录取' : '拟录取·未发布') : (published ? '未录取' : '拟不录取·未发布');
  }
  return application.progress === 'interview' ? '待面试' : '已提交';
}
function applicationTag(application) {
  return application.progress === 'withdrawn' ? 'tag-mute' : application.decision === 'accepted' ? 'tag-pass' : application.decision === 'rejected' ? 'tag-reject' : 'tag-wait';
}

async function loadBatches() {
  if (!recruitmentAvailable) return;
  const request = ++batchRequest;
  batchLoading.value = true;
  try {
    const data = await listBatches({ ...batchQuery });
    if (request !== batchRequest) return;
    batches.value = data.items || [];
    batchTotal.value = data.total || 0;
    setPageHeader({ title: '招新管理', subtitle: '公开报名、面试安排与统一录取' });
    const existing = batches.value.find((item) => item.id === selectedBatch.value?.id);
    if (existing) selectedBatch.value = existing;
    else if (!selectedBatch.value && batches.value.length) await selectBatch(batches.value[0]);
  } catch { /* 请求层已提示。 */ }
  finally { if (request === batchRequest) batchLoading.value = false; }
}
function changeArchive(archived) {
  if (batchQuery.archived === archived) return;
  batchQuery.archived = archived;
  batchQuery.page = 1;
  selectionRequest++;
  applicationRequest++;
  selectedBatch.value = null;
  applications.value = [];
  applicationTotal.value = 0;
  loadBatches();
}
async function selectBatch(row) {
  if (batchActing.value) return;
  const request = ++selectionRequest;
  selectedBatch.value = row;
  applicationQuery.page = 1;
  applicationQuery.grade = '';
  applicationQuery.status = '';
  applications.value = [];
  applicationTotal.value = 0;
  try {
    const batch = await getBatch(row.id);
    if (request !== selectionRequest) return;
    selectedBatch.value = batch;
    await loadApplications();
  } catch { /* 请求层已提示。 */ }
}
async function refreshSelectedBatch() {
  const id = selectedBatch.value?.id;
  if (!id) return;
  const batch = await getBatch(id);
  if (selectedBatch.value?.id !== id) return;
  selectedBatch.value = batch;
  const index = batches.value.findIndex((item) => item.id === id);
  if (index >= 0) batches.value[index] = batch;
}
async function loadApplications() {
  const id = selectedBatch.value?.id;
  if (!id) return;
  const request = ++applicationRequest;
  applicationLoading.value = true;
  try {
    const data = await listApplications({ batchId: id, ...applicationQuery, grade: applicationQuery.grade.trim() || undefined, status: applicationQuery.status || undefined });
    if (request !== applicationRequest || selectedBatch.value?.id !== id) return;
    applications.value = data.items || [];
    applicationTotal.value = data.total || 0;
    await refreshSelectedBatch();
  } catch { /* 请求层已提示。 */ }
  finally { if (request === applicationRequest) applicationLoading.value = false; }
}
function filterApplications() { applicationQuery.page = 1; loadApplications(); }
async function refresh() { await loadBatches(); if (selectedBatch.value) await loadApplications(); }

const configVisible = ref(false);
const configSaving = ref(false);
const config = reactive({ id: null, version: 0, title: '', intro: '', opensAt: '', closesAt: '', originalOpensAt: null, questions: [], publishedAt: null, archivedAt: null });
const configStarted = computed(() => !!config.publishedAt && timestamp(config.originalOpensAt) <= Date.now());
const newId = () => crypto.randomUUID().replaceAll('-', '');
const newOption = () => ({ id: newId(), label: '' });
const isChoice = (question) => question.type === 'single' || question.type === 'multiple';
function openConfig(batch) {
  Object.assign(config, {
    id: batch?.id || null, version: batch?.version || 0, title: batch?.title || '', intro: batch?.intro || '',
    opensAt: dateInput(batch?.opensAt), closesAt: dateInput(batch?.closesAt), originalOpensAt: batch?.opensAt || null,
    questions: JSON.parse(JSON.stringify(batch?.questions || [])), publishedAt: batch?.publishedAt || null, archivedAt: batch?.archivedAt || null,
  });
  configVisible.value = true;
}
function addQuestion() { if (config.questions.length < 20) config.questions.push({ id: newId(), type: 'text', title: '', required: true, options: [] }); }
function moveQuestion(index, direction) { const [question] = config.questions.splice(index, 1); config.questions.splice(index + direction, 0, question); }
function changeQuestionType(question) {
  if (isChoice(question)) { if (question.options.length < 2) question.options = [newOption(), newOption()]; }
  else question.options = [];
}
function validateConfig() {
  if (!config.title.trim() || !config.intro.trim()) return '请填写批次名称和招新介绍。';
  if (textLength(config.title.trim()) > 100 || textLength(config.intro.trim()) > 10000) return '批次名称或介绍超出长度上限。';
  const opensAt = fromDateInput(config.opensAt), closesAt = fromDateInput(config.closesAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt)) return '请选择完整的报名时间。';
  if (opensAt >= closesAt) return '报名开始时间必须早于截止时间。';
  for (const [index, question] of config.questions.entries()) {
    if (!question.title.trim() || textLength(question.title.trim()) > 200) return `请填写问题 ${index + 1} 的题目，最多 200 字。`;
    if (isChoice(question)) {
      const options = question.options.map((option) => option.label.trim());
      if (options.length < 2 || options.length > 20 || options.some((label) => !label || textLength(label) > 100)) return `问题 ${index + 1} 需要 2～20 个非空选项，每项最多 100 字。`;
      if (new Set(options).size !== options.length) return `问题 ${index + 1} 的选项不能重复。`;
    }
  }
  return '';
}
async function saveConfig() {
  if (configSaving.value || config.archivedAt) return;
  const warning = validateConfig();
  if (warning) return ElMessage.warning(warning);
  configSaving.value = true;
  try {
    let body;
    if (config.publishedAt) {
      body = { version: config.version, intro: config.intro.trim() };
      if (!configStarted.value) Object.assign(body, { opensAt: fromDateInput(config.opensAt), closesAt: fromDateInput(config.closesAt) });
    } else {
      body = { title: config.title.trim(), intro: config.intro.trim(), opensAt: fromDateInput(config.opensAt), closesAt: fromDateInput(config.closesAt), questions: config.questions.map((question) => ({ ...question, title: question.title.trim(), options: question.options.map((option) => ({ ...option, label: option.label.trim() })) })) };
      if (config.id) body.version = config.version;
    }
    const saved = config.id ? await updateBatch(config.id, body) : await createBatch(body);
    configVisible.value = false;
    selectedBatch.value = saved;
    batchQuery.archived = !!saved.archivedAt;
    batchQuery.page = 1;
    ElMessage.success(saved.publishedAt ? '批次配置已保存。' : '草稿已保存，发布后学生即可报名。');
    await refresh();
  } catch (error) {
    if (error.code === 40910 && config.id) {
      const latest = await getBatch(config.id).catch(() => null);
      if (latest) openConfig(latest);
      ElMessage.warning('批次已被更新，已重新加载，请核对后再保存。');
    }
  } finally { configSaving.value = false; }
}

async function batchAction(action) {
  if (batchActing.value || !selectedBatch.value || !auth.isSuperAdmin) return;
  batchActing.value = true;
  try {
    const batch = await getBatch(selectedBatch.value.id);
    selectedBatch.value = batch;
    const messages = {
      publish: [`发布「${batch.title}」？发布后题目、选项、必填设置和顺序将锁定，学生可在报名窗口内公开报名。`, '发布招新', '发布报名'],
      results: [`统一发布「${batch.title}」的录取结果？所有报名者可立即凭查询码查看自己的结果。发布后不能修改决定和对外说明，也不能撤销发布。`, '发布录取结果', '确认发布'],
      archive: [`归档「${batch.title}」？批次将移至历史列表，报名记录和查询码仍然有效。`, '归档批次', '确认归档'],
    };
    if (action === 'results' && (!isClosed(batch) || batch.unresolvedCount !== 0)) return ElMessage.warning('报名截止且所有未撤回报名都有最终决定后，才能发布结果。');
    const [message, title, confirmButtonText] = messages[action];
    await ElMessageBox.confirm(message, title, { type: 'warning', confirmButtonText, cancelButtonText: '取消' });
    const handlers = { publish: publishBatch, results: publishResults, archive: archiveBatch };
    selectedBatch.value = await handlers[action](batch.id, batch.version);
    ElMessage.success(action === 'publish' ? '招新批次已发布。' : action === 'results' ? '录取结果已统一发布。' : '批次已归档。');
    if (action === 'archive') { selectedBatch.value = null; applications.value = []; applicationTotal.value = 0; }
    await refresh();
  } catch (error) {
    if (error?.code === 40910) await refresh();
  } finally { batchActing.value = false; }
}

const detailVisible = ref(false);
const detailLoading = ref(false);
const detailSaving = ref(false);
const detail = ref(null);
const interviewForm = reactive({ at: '', location: '', note: '' });
const reviewForm = reactive({ decision: '', internalNote: '', publicNote: '' });
let detailRequest = 0;
const canReview = computed(() => detail.value && detail.value.progress !== 'withdrawn' && isClosed(detail.value.batch) && !detail.value.batch?.resultPublishedAt);
const reviewLockReason = computed(() => detail.value?.progress === 'withdrawn' ? '报名已撤回，不参与审核。' : detail.value?.batch?.resultPublishedAt ? '录取结果已发布，审核和面试安排已锁定。' : '报名尚未截止，目前仅可查看报名。');
function assignDetail(application) {
  detail.value = application;
  Object.assign(interviewForm, { at: dateInput(application.interview?.at), location: application.interview?.location || '', note: application.interview?.note || '' });
  Object.assign(reviewForm, { decision: application.decision || '', internalNote: application.internalNote || '', publicNote: application.publicNote || '' });
}
async function openApplication(row) {
  const request = ++detailRequest;
  detail.value = null;
  detailVisible.value = true;
  detailLoading.value = true;
  try { const application = await getApplication(row.id); if (request === detailRequest) assignDetail(application); }
  catch { /* 请求层已提示。 */ }
  finally { if (request === detailRequest) detailLoading.value = false; }
}
function clearDetail() { detailRequest++; detail.value = null; }
function answerText(question, answer) {
  if (answer === undefined || answer === null || answer === '' || Array.isArray(answer) && !answer.length) return '未填写';
  if (!isChoice(question)) return String(answer);
  const values = Array.isArray(answer) ? answer : [answer];
  return values.map((id) => question.options.find((option) => option.id === id)?.label || '未知选项').join('、');
}
async function afterDetailSave(application, message) {
  assignDetail(application);
  ElMessage.success(message);
  await loadApplications();
}
async function handleDetailConflict(error) {
  if (error.code !== 40910 || !detail.value) return;
  const application = await getApplication(detail.value.id).catch(() => null);
  if (application) assignDetail(application);
  await loadApplications();
  ElMessage.warning('报名已被更新，已重新加载，请核对后再保存。');
}
async function saveInterview() {
  if (detailSaving.value || !canReview.value || detail.value.decision) return;
  if (!Number.isFinite(fromDateInput(interviewForm.at)) || !interviewForm.location.trim()) return ElMessage.warning('请填写面试时间和地点。');
  if (textLength(interviewForm.location.trim()) > 200 || textLength(interviewForm.note.trim()) > 2000) return ElMessage.warning('面试地点或说明超出长度上限。');
  detailSaving.value = true;
  try {
    const application = await arrangeInterview(detail.value.id, { version: detail.value.version, at: fromDateInput(interviewForm.at), location: interviewForm.location.trim(), note: interviewForm.note.trim() });
    await afterDetailSave(application, '面试安排已保存，报名者可立即查看。');
  } catch (error) { await handleDetailConflict(error); }
  finally { detailSaving.value = false; }
}
async function saveReview() {
  if (detailSaving.value || !canReview.value) return;
  if (textLength(reviewForm.internalNote.trim()) > 2000 || textLength(reviewForm.publicNote.trim()) > 2000) return ElMessage.warning('备注或对外说明最多 2000 字。');
  detailSaving.value = true;
  try {
    const body = { version: detail.value.version, internalNote: reviewForm.internalNote.trim(), publicNote: reviewForm.publicNote.trim() };
    if (reviewForm.decision) body.decision = reviewForm.decision;
    const application = await reviewApplication(detail.value.id, body);
    await afterDetailSave(application, '审核已保存；录取决定在统一发布后对报名者可见。');
  } catch (error) { await handleDetailConflict(error); }
  finally { detailSaving.value = false; }
}
async function retractDecision() {
  if (detailSaving.value || !canReview.value || !detail.value.decision) return;
  try {
    await ElMessageBox.confirm(`撤销「${detail.value.name}」的拟定结果？报名将恢复为未决定，原报名进度和面试安排保留，可继续审核或调整面试。`, '撤销拟定结果', { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' });
  } catch { return; }
  detailSaving.value = true;
  try {
    const application = await reviewApplication(detail.value.id, { version: detail.value.version, decision: null });
    await afterDetailSave(application, '拟定结果已撤销，可继续安排面试或审核。');
  } catch (error) { await handleDetailConflict(error); }
  finally { detailSaving.value = false; }
}

onMounted(() => { setPageHeader({ title: '招新管理', subtitle: '公开报名、面试安排与统一录取' }); loadBatches(); });
onBeforeUnmount(() => { batchRequest++; selectionRequest++; applicationRequest++; detailRequest++; clearPageHeader(); });
</script>

<style scoped>
.recruitment-page { max-width: 1440px; margin: 0 auto; }
.section-toolbar, .batch-actions, .question-top, .detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.section-toolbar { margin-bottom: 14px; }
.actions, .filters, .question-settings { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }
.filter { height: 32px; padding: 0 16px; border: 1px solid var(--hairline); border-radius: var(--r-pill); background: var(--canvas); color: var(--ink-2); font: inherit; cursor: pointer; }
.filter:hover { border-color: var(--soft); }
.filter.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.tag { display: inline-flex; align-items: center; height: 23px; padding: 0 10px; border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); white-space: nowrap; }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-wait { background: var(--amber-bg); color: var(--amber-fg); }
.tag-mute { background: var(--parchment); color: var(--muted-2); }
.panel { border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.strong { font-weight: 600; color: var(--ink); }
.pager { padding: 16px; justify-content: flex-end; flex-wrap: wrap; }
.batch-summary { background: var(--tile); color: #fff; border-radius: var(--r-tile); padding: 24px 26px; margin-top: 24px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.summary-caption { color: rgba(255, 255, 255, .6); font-size: var(--fs-sm); }
.batch-summary h2 { margin: 8px 0 12px; font-size: 23px; }
.batch-summary p { color: rgba(255, 255, 255, .7); margin: 5px 0; line-height: 1.6; font-size: var(--fs-sm); }
.summary-count { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; gap: 6px; }
.summary-count strong { font-size: 36px; font-variant-numeric: tabular-nums; }
.summary-count span { color: rgba(255, 255, 255, .6); font-size: var(--fs-xs); }
.batch-actions { margin: 14px 0 24px; }
.batch-actions > .micro { flex: 1; min-width: 220px; line-height: 1.7; }
h3 { font-size: var(--fs-lg); margin: 0; color: var(--ink); }
h3 .micro { margin-left: 8px; font-weight: 400; }
.grade-filter { width: 180px; }
.status-filter { width: 195px; }
.form-alert { margin-bottom: 20px; }
.two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.two-columns :deep(.el-date-editor), .detail-section :deep(.el-date-editor) { width: 100%; }
.fixed-fields, .question-editor { background: var(--parchment); border-radius: 14px; padding: 18px; }
.fixed-fields p { color: var(--muted-2); line-height: 1.7; margin: 8px 0 0; }
.question-heading { margin: 22px 0 12px; }
.question-empty { padding: 22px; border: 1px dashed var(--hairline); border-radius: 14px; color: var(--muted); }
.question-editor { margin-bottom: 12px; }
.question-top { margin-bottom: 16px; }
.question-settings { gap: 22px; margin-bottom: 16px; }
.type-select { width: 150px; }
.option-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.option-row > .micro { width: 15px; flex-shrink: 0; }
.option-editor > .micro { margin-bottom: 0; }
.detail-heading { margin-bottom: 18px; }
.detail-heading h2 { margin: 0 0 6px; font-size: 24px; }
.detail-heading p { margin: 0; }
.detail-section { padding-top: 24px; margin-top: 24px; border-top: 1px solid var(--divider); }
.detail-section > h3 { margin-bottom: 14px; }
.detail-section > .micro, .lock-hint { line-height: 1.7; }
.detail-section :deep(.el-form-item .micro) { width: 100%; margin: 8px 0 0; line-height: 1.7; }
.answer { margin: 16px 0; }
.answer-title { font-weight: 500; line-height: 1.7; }
.answer-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin-top: 6px; background: var(--parchment); border-radius: 10px; padding: 12px 14px; }
.lock-hint { color: var(--muted-2); padding: 12px 14px; background: var(--parchment); border-radius: 10px; }
@media (max-width: 900px) {
  .batch-summary { padding: 20px; }
  .two-columns { grid-template-columns: 1fr; gap: 0; }
  .application-toolbar { align-items: flex-start; }
  .application-toolbar > .actions { width: 100%; }
  .grade-filter, .status-filter { flex: 1; min-width: 160px; }
}
</style>
