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
        <button type="button" class="pf-btn pf-plain ii-tpl" @click="downloadTemplate">下载模板</button>
      </div>

      <div class="dz" @click="fileInput?.click()" @dragover.prevent @drop.prevent="onDrop">
        <IconUpload :size="26" />
        <div class="dz-t">点击选择文件，或把名册拖到这里</div>
        <div class="micro">解析后先给你预览，确认无误再写入 —— 不会直接动库</div>
      </div>
      <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onPick" />
    </template>

    <!-- ② 预览与确认（自绘细线表，v3） -->
    <template v-else-if="preview">
      <div class="gcard sum-bar">
        <span class="sum-it"><span class="tag tag-ok">新建</span><b class="num">{{ preview.summary.new || 0 }}</b></span>
        <span class="sum-it"><span class="tag tag-warn">覆盖</span><b class="num">{{ preview.summary.update || 0 }}</b><span class="hint">未激活，可安全覆盖</span></span>
        <span class="sum-it"><span class="tag tag-mute">受保护</span><b class="num">{{ preview.summary.active || 0 }}</b><span class="hint">已激活，默认跳过</span></span>
        <span class="sum-it"><span class="tag tag-reject">异常</span><b class="num">{{ preview.summary.invalid || 0 }}</b><span class="hint">带原文行号，不写库</span></span>
      </div>

      <div class="tablecard">
        <table class="tb">
          <colgroup>
            <col style="width: 84px" /><col style="width: 240px" /><col style="width: 126px" />
            <col style="width: 92px" /><col />
          </colgroup>
          <thead>
            <tr><th>行号</th><th>表格原内容</th><th>识别结果</th><th class="c">结论</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.rowNo" :class="{ 'row-invalid': row.state === 'invalid' }">
              <td><span class="mono dim">第 {{ row.rowNo }} 行</span></td>
              <td><span class="mono">{{ rawText(row) }}</span></td>
              <td><span class="mono strong">{{ row.username || '—' }}</span></td>
              <td class="c">
                <span class="tag" :class="CONCL[row.state]?.cls || 'tag-mute'">{{ CONCL[row.state]?.text || row.state }}</span>
              </td>
              <td>
                <span class="hint" :class="{ 'im-err': row.state === 'invalid' }" v-html="explain(row)"></span>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState
          v-if="!rows.length"
          variant="content" title="没有解析到数据行" description="表头下面全是空行？回表格补上再传"
        />
      </div>

      <div class="gcard imp-sw">
        <div class="sw-row">
          <button type="button" class="sw" :class="{ on: impForce }" @click="toggleForce" />
          <div class="sw-txt">
            <div class="sw-name">强制覆盖已激活</div>
            <div class="hint">默认关。打开后覆盖备注与三元组，<b>仍然不碰密码</b></div>
          </div>
        </div>
        <div class="sw-row">
          <button type="button" class="sw" :class="{ on: impStrict }" @click="impStrict = !impStrict" />
          <div class="sw-txt">
            <div class="sw-name">严格模式</div>
            <div class="hint">有异常行就整批不导入（当前：<b>{{ preview.summary.invalid || 0 }} 行异常{{ preview.summary.invalid ? '，整批会被拦下' : '' }}</b>）</div>
          </div>
        </div>
      </div>

      <div class="warnline">
        <IconInfo :size="15" />
        <span>导出文件含初始密码明文，只用于分发给本人；已改过密码的行会留空。</span>
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
        <span class="hint">只解析不落库，确认后才写入</span>
        <button type="button" class="pf-btn pf-plain ml" @click="inner = false">关闭</button>
      </template>

      <template v-else-if="preview">
        <span class="hint">待写入 {{ importableCount }} 行 · {{ preview.filename }}</span>
        <button type="button" class="pf-btn pf-plain ml" :disabled="importing" @click="resetImport">重新选择</button>
        <button v-if="preview.summary.invalid" type="button" class="pf-link" :disabled="importing" @click="confirmImport(false)">
          忽略异常行继续
        </button>
        <button type="button" class="pf-btn pf-primary" :disabled="importing" @click="confirmImport(true)">
          确认导入 {{ importableCount }} 行
        </button>
      </template>

      <template v-else>
        <span class="hint">导入完成</span>
        <button type="button" class="pf-btn pf-plain ml" @click="resetImport">再导一份</button>
        <button type="button" class="pf-btn pf-primary" @click="inner = false">完成</button>
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
  new: { text: '新建', cls: 'tag-ok' },
  update: { text: '覆盖', cls: 'tag-warn' },
  active: { text: '受保护', cls: 'tag-mute' },
  invalid: { text: '异常', cls: 'tag-reject' },
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
async function toggleForce() {
  impForce.value = !impForce.value;
  await repreview();
}
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
.dim { font-size: 11.5px; color: var(--muted-2); }
.strong { font-weight: 600; color: var(--ink); }

.dz {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 34px 20px;
  border: 1px dashed var(--soft); border-radius: 14px;
  background: var(--parchment); cursor: pointer; color: var(--muted);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.dz:hover { border-color: var(--accent); background: var(--acc-bg); color: var(--accent); }
.dz-t { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }

/* ── 自绘细线表（v3 .tablecard/.tb） ── */
.gcard {
  background: rgba(255, 255, 255, 0.72);
  border-radius: var(--r-card);
  padding: 14px 16px;
}
.sum-bar { display: flex; flex-wrap: wrap; gap: 18px; }
.sum-it { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-md); }
.sum-it b { font-size: var(--fs-xl); font-weight: 600; }
.hint { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); line-height: 1.65; }
.hint b { color: var(--ink); }

.tablecard {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 5px 0;
  max-height: 420px;
  overflow-y: auto;
}
.tb { width: 100%; border-collapse: collapse; table-layout: fixed; }
.tb th {
  text-align: left; font-size: var(--fs-xs); font-weight: 500; color: var(--muted);
  letter-spacing: var(--ls-wide-sm); padding: 11px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.07); white-space: nowrap;
  position: sticky; top: 0; background: var(--parchment); z-index: 1;
}
.tb td {
  font-size: var(--fs-md); line-height: 1.5; padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.045); vertical-align: middle; color: var(--ink-2);
  overflow-wrap: anywhere;
}
.tb tr:last-child td { border-bottom: none; }
.tb .c { text-align: center; }
.row-invalid td { background: #fdf4f4; }
.im-err { color: var(--red-fg); }

.tag {
  display: inline-flex; align-items: center; height: 23px; padding: 0 10px;
  border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 500;
  letter-spacing: var(--ls-wide-sm); line-height: 1; white-space: nowrap;
}
.tag-ok { background: var(--green-bg); color: var(--green-fg); }
.tag-warn { background: var(--amber-bg); color: var(--amber-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-mute { background: #ebebee; color: var(--muted); }

/* ── 自绘开关（44×26 胶囊，弹簧滑块） ── */
.imp-sw { display: flex; flex-wrap: wrap; gap: 12px 32px; margin-top: 2px; }
.sw-row { display: flex; align-items: flex-start; gap: 12px; min-width: 280px; }
.sw {
  width: 44px; height: 26px; flex: none;
  border: none; border-radius: var(--r-pill); cursor: pointer; padding: 0;
  background: var(--soft); position: relative;
  transition: background 0.22s var(--ease);
}
.sw::after {
  content: ''; position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  transition: transform 0.32s cubic-bezier(0.32, 1.4, 0.5, 1);
}
.sw:active::after { width: 24px; }
.sw.on { background: var(--accent); }
.sw.on::after { transform: translateX(18px); }
.sw-name { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.sw-txt .hint { display: block; margin-top: 2px; }
.sw-txt .hint b { color: var(--ink); }

.warnline {
  display: flex; gap: 8px; align-items: flex-start;
  font-size: var(--fs-sm); color: var(--red-fg); background: var(--red-bg);
  border-radius: 12px; padding: 11px 13px; line-height: 1.65; letter-spacing: var(--ls-wide);
}
.warnline :deep(svg) { flex: none; margin-top: 2px; }

.rcpt { display: flex; flex-direction: column; gap: 14px; }
.rc-nums { display: flex; gap: 26px; padding: 18px 20px; background: var(--tile); border-radius: 16px; }
.rc-n { display: flex; flex-direction: column; gap: 3px; }
.rc-n span { font-size: var(--fs-3xl); font-weight: 600; color: #fff; line-height: 1; letter-spacing: var(--ls-tight); }
.rc-n em { font-style: normal; font-size: var(--fs-xs); color: rgba(255, 255, 255, 0.62); letter-spacing: var(--ls-wide-sm); }
.rc-note { font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.75; }
.rc-note b { color: var(--ink); }

.ml { margin-left: auto; }

/* footer / 顶部自绘按钮（替换 el-button：EP 的 primary 是渐变，违反唯一强调色铁律） */
.ii-tpl { flex: none; }
.pf-btn {
  height: 34px; padding: 0 14px; border-radius: 980px; cursor: pointer; font-family: inherit;
  font-size: var(--fs-sm); font-weight: 500; border: 1px solid transparent;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s var(--ease);
}
.pf-btn:active { transform: scale(0.96); }
.pf-btn:disabled { opacity: 0.45; pointer-events: none; }
.pf-plain { background: var(--canvas); border-color: var(--hairline); color: var(--ink-2); }
.pf-plain:hover { border-color: var(--soft); color: var(--ink); }
.pf-primary { background: var(--accent); color: #fff; font-weight: 600; }
.pf-primary:hover { filter: brightness(1.08); }
.pf-link {
  border: none; background: transparent; cursor: pointer; font-family: inherit;
  font-size: var(--fs-sm); font-weight: 500; color: var(--accent); padding: 0 6px;
}
.pf-link:hover { text-decoration: underline; }
.pf-link:disabled { opacity: 0.45; pointer-events: none; }
</style>
