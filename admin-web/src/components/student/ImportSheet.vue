<template>
  <SlideSheet v-model="inner" title="名册导入" :subtitle="sub" width="920">
    <!-- ① 选文件 -->
    <template v-if="!preview && !result">
      <div class="imp-intro">
        <div class="ii-l">
          <div class="sec-title">上传学生名册</div>
          <ul class="ii-list">
            <li>支持 <b>.xlsx / .xls / .csv</b>；表头需含 年级 / 班级 / 序号 / 姓名（也兼容紧凑格式）</li>
            <li>账号规则：<span class="mono">年级(4) + 班级(2) + 序号(2)</span>，如 <span class="mono">20240101</span></li>
            <li>初始密码：<span class="mono">user + 学号</span>，学生首次登录必须改密</li>
            <li>名册姓名即学生的显示名（全站不收集头像）</li>
          </ul>
        </div>
        <el-button @click="downloadTemplate">下载模板</el-button>
      </div>

      <div class="dz" @click="fileInput?.click()" @dragover.prevent @drop.prevent="onDrop">
        <IconUpload :size="26" />
        <div class="dz-t">点击选择文件，或把名册拖到这里</div>
        <div class="micro">解析后先给你预览，确认无误再写入 —— 不会直接动库</div>
      </div>
      <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onPick" />
    </template>

    <!-- ② 预览与确认 -->
    <template v-else-if="preview">
      <div class="sum-bar">
        <span class="sum-it"><el-tag size="small" effect="light" type="success">新建</el-tag><b class="num">{{ preview.summary.new || 0 }}</b></span>
        <span class="sum-it"><el-tag size="small" effect="light" type="warning">覆盖</el-tag><b class="num">{{ preview.summary.update || 0 }}</b><span class="micro">未激活，可安全覆盖</span></span>
        <span class="sum-it"><el-tag size="small" effect="light" type="info">受保护</el-tag><b class="num">{{ preview.summary.active || 0 }}</b><span class="micro">已激活，默认跳过</span></span>
        <span class="sum-it"><el-tag size="small" effect="light" type="danger">异常</el-tag><b class="num">{{ preview.summary.invalid || 0 }}</b><span class="micro">带原文行号，不写库</span></span>
      </div>

      <el-table :data="rows" max-height="380" :row-class-name="rowClass" class="imp-table">
        <el-table-column label="行号" width="84" align="center">
          <template #default="{ row }"><span class="mono">第 {{ row.rowNo }} 行</span></template>
        </el-table-column>
        <el-table-column label="表格原内容" min-width="200">
          <template #default="{ row }"><span class="mono">{{ rawText(row) }}</span></template>
        </el-table-column>
        <el-table-column label="识别结果" width="132">
          <template #default="{ row }"><span class="mono" :class="{ strong: row.username }">{{ row.username || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="结论" width="96" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="light" :type="CONCL[row.state]?.type || 'info'">{{ CONCL[row.state]?.text || row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="280">
          <template #default="{ row }">
            <span class="micro" :class="{ 'im-err': row.state === 'invalid' }" v-html="explain(row)"></span>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyState variant="content" title="没有解析到数据行" description="表头下面全是空行？回表格补上再传" />
        </template>
      </el-table>

      <div class="imp-sw">
        <div class="sw-row">
          <el-switch v-model="impForce" @change="repreview" />
          <div class="sw-txt">
            <div class="sw-name">强制覆盖已激活</div>
            <div class="micro">默认关。打开后覆盖备注与三元组，<b>仍然不碰密码</b></div>
          </div>
        </div>
        <div class="sw-row">
          <el-switch v-model="impStrict" />
          <div class="sw-txt">
            <div class="sw-name">严格模式</div>
            <div class="micro">有异常行就整批不导入（当前：<b>{{ preview.summary.invalid || 0 }} 行异常{{ preview.summary.invalid ? '，整批会被拦下' : '' }}</b>）</div>
          </div>
        </div>
      </div>

      <div class="im-warn">
        <IconInfo :size="15" />
        <span>导出文件<b>含初始密码明文</b>，只用于分发给本人；已改过密码的行会留空。</span>
      </div>
    </template>

    <!-- ③ 回执 -->
    <template v-else>
      <div class="rcpt">
        <div class="rc-nums">
          <div class="rc-n"><span class="num">{{ result.created }}</span><em>新建</em></div>
          <div class="rc-n"><span class="num">{{ result.updated }}</span><em>覆盖</em></div>
          <div class="rc-n"><span class="num">{{ result.skipped }}</span><em>跳过</em></div>
          <div class="rc-n"><span class="num">#{{ result.batchId }}</span><em>批次号</em></div>
        </div>
        <div class="rc-note">
          初始密码 = <b>user + 学号</b>（如 user20240101）。密码只在导出文件里能看到，
          本页与列表都不显示；学生首次登录会被强制改密。
        </div>
        <div class="rc-note">本次批次可在「导入批次」里撤销（只删本次新建、且没有投稿记录的账号）。</div>
      </div>
    </template>

    <template #footer>
      <template v-if="!preview && !result">
        <span class="micro">只解析不落库，确认后才写入</span>
        <el-button class="ml" @click="inner = false">关闭</el-button>
      </template>

      <template v-else-if="preview">
        <span class="micro">待写入 {{ importableCount }} 行 · {{ preview.filename }}</span>
        <el-button class="ml" @click="resetImport">重新选择</el-button>
        <el-button v-if="preview.summary.invalid" link type="primary" :disabled="importing" @click="confirmImport(false)">
          忽略异常行继续
        </el-button>
        <el-button type="primary" :loading="importing" @click="confirmImport(true)">
          确认导入 {{ importableCount }} 行
        </el-button>
      </template>

      <template v-else>
        <span class="micro">导入完成</span>
        <el-button class="ml" @click="resetImport">再导一份</el-button>
        <el-button type="primary" @click="inner = false">完成</el-button>
      </template>
    </template>
  </SlideSheet>
</template>

<script setup>
/**
 * 名册导入（页内弹层）
 *
 * 三步都在这一层里完成：选文件 → 预览与确认 → 回执。
 * 后端不改：preview 只解析不落库，commit 时服务端拿 rawRows 重新解析校验（不信任前端结论）。
 */
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import SlideSheet from '@/components/SlideSheet.vue';
import EmptyState from '@/components/EmptyState.vue';
import { IconUpload, IconInfo } from '@/components/icons';
import http from '@/utils/http';

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue', 'done']);

const inner = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const fileInput = ref(null);
const preview = ref(null);
const result = ref(null);
const importing = ref(false);
const impForce = ref(false);
const impStrict = ref(true);
const lastFile = ref(null);

const rows = computed(() => preview.value?.rows || []);

const CONCL = {
  new: { text: '新建', type: 'success' },
  update: { text: '覆盖', type: 'warning' },
  active: { text: '受保护', type: 'info' },
  invalid: { text: '异常', type: 'danger' },
};

const importableCount = computed(
  () => (Number(preview.value?.summary?.new) || 0) + (Number(preview.value?.summary?.update) || 0)
);

const sub = computed(() => {
  if (result.value) return '导入完成';
  if (preview.value) {
    return `${preview.value.filename} · 已解析 ${rows.value.length} 行 · 表头识别：第 ${(preview.value.headerRowIndex ?? 0) + 1} 行`;
  }
  return '上传名册 → 预览 → 确认写入';
});

const rawText = (row) =>
  (Array.isArray(row.raw) ? row.raw.filter((x) => x !== '' && x != null).join(' · ') : (row.raw || '—'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function explain(row) {
  if (row.state === 'invalid') return esc(row.error || '解析失败');
  if (row.state === 'new') {
    return row.name ? `将创建账号，初始密码 <b>user${row.username}</b>` : '将创建账号';
  }
  if (row.state === 'update') return '账号已存在且未激活 → 覆盖备注，<b>不动密码</b>';
  if (row.state === 'active') return '该账号<b>已激活</b>（改过密码/有投稿），默认跳过；要覆盖需打开下面的开关';
  return row.error || '—';
}

const rowClass = ({ row }) => (row.state === 'invalid' ? 'row-invalid' : '');

function resetImport() {
  preview.value = null;
  result.value = null;
  lastFile.value = null;
  if (fileInput.value) fileInput.value.value = '';
}

async function onPick(e) {
  const file = e.target.files?.[0];
  if (file) { lastFile.value = file; await doPreview(file); }
}
async function onDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) { lastFile.value = file; await doPreview(file); }
}

/** 「强制覆盖已激活」会影响 new/update/active 的判定 —— 切换后用同一文件重新 preview */
async function repreview() {
  if (lastFile.value) await doPreview(lastFile.value);
}

async function doPreview(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const d = await http.post(`/admin/student/import/preview?force=${impForce.value ? 1 : 0}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    preview.value = d;
    result.value = null;
    ElMessage.success(`解析完成：可导入 ${(Number(d.summary?.new) || 0) + (Number(d.summary?.update) || 0)} 行，异常 ${d.summary?.invalid || 0} 行`);
  } catch (e) {
    ElMessage.error(e?.message || '解析失败');
  }
}

async function confirmImport(strict = true) {
  if (!preview.value) return;
  importing.value = true;
  try {
    const d = await http.post('/admin/student/import/commit', {
      rows: preview.value.rawRows,
      filename: preview.value.filename,
      force: impForce.value,
      strict,
    });
    result.value = d;
    preview.value = null;
    ElMessage.success('导入完成');
    emit('done', d);
  } catch (e) {
    ElMessage.error(e?.message || '导入失败');
  } finally {
    importing.value = false;
  }
}

async function downloadTemplate() {
  const blob = await http.get('/admin/student/template', { responseType: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '学生名册模板.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.imp-intro { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.ii-l { flex: 1; min-width: 0; }
.ii-list { margin: 8px 0 0; padding-left: 18px; color: var(--ink-2); font-size: var(--fs-md); line-height: 1.85; }
.mono { font-family: var(--mono); }

.dz {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 34px 20px;
  border: 1px dashed var(--soft); border-radius: 14px;
  background: var(--parchment); cursor: pointer; color: var(--muted);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.dz:hover { border-color: var(--accent); background: var(--acc-bg); color: var(--accent); }
.dz-t { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }

.sum-bar { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 14px; }
.sum-it { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-md); }
.sum-it b { font-size: var(--fs-xl); font-weight: 600; }

.imp-table { border: 1px solid var(--divider); border-radius: 12px; overflow: hidden; }
.imp-table :deep(.row-invalid) { background: #fef7f7; }
.im-err { color: var(--red-fg); }
.strong { font-weight: 600; color: var(--ink); }

.imp-sw {
  display: flex; flex-wrap: wrap; gap: 12px 32px;
  margin-top: 14px; padding: 14px 16px;
  background: var(--parchment); border-radius: 14px;
}
.sw-row { display: flex; align-items: flex-start; gap: 10px; min-width: 280px; }
.sw-name { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.sw-txt .micro { display: block; margin-top: 2px; line-height: 1.6; }

.im-warn {
  display: flex; align-items: center; gap: 7px;
  margin-top: 12px; font-size: var(--fs-sm); color: var(--amber-fg);
}

.rcpt { display: flex; flex-direction: column; gap: 14px; }
.rc-nums { display: flex; gap: 26px; padding: 18px 20px; background: var(--tile); border-radius: 16px; }
.rc-n { display: flex; flex-direction: column; gap: 3px; }
.rc-n span { font-size: var(--fs-3xl); font-weight: 600; color: #fff; line-height: 1; letter-spacing: var(--ls-tight); }
.rc-n em { font-style: normal; font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62); letter-spacing: var(--ls-wide-sm); }
.rc-note { font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.75; }

.ml { margin-left: auto; }
</style>
