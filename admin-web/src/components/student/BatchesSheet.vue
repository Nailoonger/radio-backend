<template>
  <SlideSheet v-model="inner" title="导入批次" subtitle="选一个批次加进筛选条件，或撤销它" width="900">
    <el-table :data="rows" v-loading="loading" stripe class="bt-table">
      <el-table-column label="批次" width="76">
        <template #default="{ row }"><span class="mono">#{{ row.id }}</span></template>
      </el-table-column>
      <el-table-column label="时间" width="150">
        <template #default="{ row }"><span class="c-time">{{ fmt(row.createTime) }}</span></template>
      </el-table-column>
      <el-table-column label="文件" prop="filename" min-width="190" show-overflow-tooltip />
      <el-table-column label="操作人" prop="operator" width="100" />
      <el-table-column label="新建" prop="created" width="72" align="right" />
      <el-table-column label="更新" prop="updated" width="72" align="right" />
      <el-table-column label="跳过" prop="skipped" width="72" align="right" />
      <el-table-column label="操作" width="152" align="right">
        <template #default="{ row }">
          <div class="rowact">
            <button type="button" class="link-btn" @click="emit('filter', row.id)">
              筛选这批<em>→</em>
            </button>
            <template v-if="!rolledBack.has(row.id)">
              <span class="vsep"></span>
              <button type="button" class="btn-danger-quiet" :disabled="busy === row.id" @click="rollback(row)">
                {{ busy === row.id ? '撤销中' : '撤销' }}
              </button>
            </template>
            <span v-else class="tag-quiet">本次已撤销</span>
          </div>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState variant="content" title="还没有导入批次" description="用「名册导入」上传一份名册，这里会记录每次导入" />
      </template>
    </el-table>

    <div class="note">
      <b>撤销的边界</b>：只删除<b>本次新建</b>且<b>没有投稿记录</b>的账号；
      已经有投稿记录的账号会被改成停用（否则审核列表里就查不到人）；
      已被学生改过密码的账号不会被撤销 —— 那说明人已经在用了。
      <span class="micro">批次记录本身会保留，刷新页面后仍会列出（库里没有「已撤销」这一列，不编造状态）。</span>
    </div>

    <template #footer>
      <span class="micro">蓝色文字只把 <code>?batch=</code> 加进筛选条件，不改任何数据；描边按钮才会改数据。</span>
      <el-button class="ml" @click="inner = false">关闭</el-button>
    </template>
  </SlideSheet>
</template>

<script setup>
/**
 * 导入批次（页内弹层）
 *
 * ⚠️ 两个刻意的设计：
 *  1. 「筛选这批」是**文字链接**而不是按钮 —— 它只改筛选条件，不动数据；
 *     「撤销」才是这一行唯一会改数据的动作，所以是唯一「实心可点」的那个（描边危险按钮）。
 *  2. **没有「状态」列**：后端 `import_batch` 表里没有 rolled_back_at 这种列，
 *     旧页面那个「已撤销 / 生效中」标签永远只会显示「生效中」。宁可不显示，也不编一个状态。
 *     本会话内撤销过的批次用内存 Set 标成「本次已撤销」。
 */
import { ref, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import SlideSheet from '@/components/SlideSheet.vue';
import EmptyState from '@/components/EmptyState.vue';
import http from '@/utils/http';

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue', 'filter', 'done']);

const inner = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const rows = ref([]);
const loading = ref(false);
const busy = ref(0);
const rolledBack = ref(new Set());

const fmt = (t) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—');

async function load() {
  loading.value = true;
  try {
    const d = await http.get('/admin/student/batches');
    rows.value = d.list || [];
  } catch (e) {
    ElMessage.error(e?.message || '批次加载失败');
  } finally {
    loading.value = false;
  }
}

async function rollback(row) {
  try {
    await ElMessageBox.confirm(
      '撤销只删除本次新建且没有投稿记录的账号；有投稿记录的会改为停用。',
      `撤销批次 #${row.id}`,
      { type: 'warning', confirmButtonText: '撤销' }
    );
  } catch { return; }
  busy.value = row.id;
  try {
    const d = await http.post(`/admin/student/batch/${row.id}/rollback`);
    ElMessage.success(d?.message || `已撤销：删除 ${d?.removed ?? 0} 个，保留 ${(d?.keptActivated ?? 0) + (d?.keptWithSubmit ?? 0)} 个`);
    rolledBack.value = new Set(rolledBack.value).add(row.id);
    emit('done', d);
  } catch (e) {
    ElMessage.error(e?.message || '撤销失败');
  } finally {
    busy.value = 0;
  }
}

watch(inner, (v) => { if (v) load(); });
</script>

<style scoped>
.mono { font-family: var(--mono); }
.c-time { font-size: var(--fs-sm); color: var(--muted); font-variant-numeric: tabular-nums; }

/* 行内动作按「会不会改数据」分层：只切视图＝文字链接；会改数据＝实体描边按钮 */
.rowact { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-right: 2px; }
.link-btn {
  border: none; background: transparent; cursor: pointer; padding: 0;
  font-family: inherit; font-size: var(--fs-md); font-weight: 500;
  color: var(--accent); display: inline-flex; align-items: center; gap: 3px;
  white-space: nowrap; flex: none;
}
.link-btn em { font-style: normal; transition: transform 0.18s var(--ease); }
.link-btn:hover { text-decoration: underline; }
.link-btn:hover em { transform: translateX(2px); }
.vsep { width: 1px; height: 14px; background: var(--hairline); flex: none; }
.btn-danger-quiet {
  flex: none;
  height: 26px; padding: 0 11px;
  border: 1px solid #f0c4c0; background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer;
  font-family: inherit; font-size: var(--fs-md); color: var(--red-fg);
  white-space: nowrap;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.btn-danger-quiet:hover { background: var(--red-bg); border-color: #e3a9a4; }
.btn-danger-quiet:disabled { opacity: 0.5; cursor: default; }
.tag-quiet {
  font-size: var(--fs-xs); color: var(--muted-2);
  background: var(--divider); border-radius: var(--r-pill); padding: 3px 9px; flex: none;
}

.note {
  margin-top: 14px; padding: 13px 16px;
  background: var(--parchment); border-radius: 14px;
  font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.75;
}
.note .micro { display: block; margin-top: 5px; }
.ml { margin-left: auto; }
</style>
