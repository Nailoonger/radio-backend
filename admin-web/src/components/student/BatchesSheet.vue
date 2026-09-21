<template>
  <SlideSheet v-model="inner" title="导入批次" subtitle="选一个批次加进筛选条件，或撤销它" width="960">
    <div class="tablecard">
      <table v-if="rows.length" class="tb">
        <colgroup>
          <col style="width: 64px" /><col style="width: 136px" /><col />
          <col style="width: 84px" /><col style="width: 60px" /><col style="width: 60px" />
          <col style="width: 60px" /><col style="width: 158px" />
        </colgroup>
        <thead>
          <tr>
            <th>批次</th><th>时间</th><th>文件</th><th>操作人</th>
            <th class="r">新建</th><th class="r">更新</th><th class="r">跳过</th><th class="r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td><span class="mono">#{{ row.id }}</span></td>
            <td><span class="dim num">{{ fmt(row.createTime) }}</span></td>
            <td><span class="el" :title="row.filename">{{ row.filename }}</span></td>
            <td>{{ row.operator || '—' }}</td>
            <td class="r num">{{ row.created }}</td>
            <td class="r num">{{ row.updated }}</td>
            <td class="r num">{{ row.skipped }}</td>
            <td>
              <div class="rowact">
                <button type="button" class="link-btn" @click="emit('filter', row.id)">
                  筛选这批<em>→</em>
                </button>
                <template v-if="!rolledBack.has(row.id)">
                  <span class="vsep"></span>
                  <button type="button" class="rx rx-danger" :disabled="busy === row.id" @click="rollback(row)">
                    {{ busy === row.id ? '撤销中' : '撤销' }}
                  </button>
                </template>
                <span v-else class="tag tag-mute">本次已撤销</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="loading" class="bt-loading">读取批次中…</div>
      <EmptyState
        v-else
        variant="content" title="还没有导入批次" description="用「名册导入」上传一份名册，这里会记录每次导入"
      />
    </div>

    <div class="noteline">
      <IconInfo :size="15" />
      <span><b>「筛选这批」只是把批次加进筛选条件</b>，不改任何数据 —— 点它等于关掉这个弹层并在筛选条上多出一枚批次胶囊。
        撤销的边界：只删<b>本次新建</b>且<b>没有投稿记录</b>的账号；有投稿记录的改停用；学生已经自己改过密码的不动。</span>
    </div>

    <template #footer>
      <span class="hint">蓝色文字只把 <code>?batch=</code> 加进筛选条件，不改任何数据；描边按钮才会改数据</span>
      <button type="button" class="bt-close" @click="inner = false">关闭</button>
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
import { IconInfo } from '@/components/icons';
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
.dim { font-size: 11.5px; color: var(--muted-2); }
.el { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }

/* ── 自绘细线表（v3 .tablecard/.tb） ── */
.tablecard {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 5px 0;
  max-height: 460px;
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
}
.tb tr:last-child td { border-bottom: none; }
.tb .r { text-align: right; }
.bt-loading { padding: 40px; text-align: center; font-size: var(--fs-sm); color: var(--muted); }

.tag {
  display: inline-flex; align-items: center; height: 23px; padding: 0 10px;
  border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: 500;
  letter-spacing: var(--ls-wide-sm); line-height: 1; white-space: nowrap;
}
.tag-mute { background: #ebebee; color: var(--muted); }

/* 行内动作按「会不会改数据」分层：只切视图＝文字链接；会改数据＝实体描边按钮 */
.rowact { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-right: 2px; }
.link-btn {
  border: none; background: transparent; cursor: pointer; padding: 0;
  font-family: inherit; font-size: var(--fs-xs); font-weight: 600;
  color: var(--accent); display: inline-flex; align-items: center; gap: 4px;
  white-space: nowrap; flex: none; height: 27px;
}
.link-btn em { font-style: normal; transition: transform 0.18s var(--ease); }
.link-btn:hover { text-decoration: underline; }
.link-btn:hover em { transform: translateX(2px); }
.vsep { width: 1px; height: 14px; background: var(--hairline); flex: none; }
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
.rx:disabled { opacity: 0.5; cursor: default; }
.rx-danger { border-color: var(--red-bg); color: var(--red-fg); }
.rx-danger:hover { background: var(--red-bg); border-color: #f0c4c0; }

.noteline {
  margin-top: 14px;
  display: flex; gap: 8px; align-items: flex-start;
  font-size: var(--fs-sm); color: var(--ink-2); background: rgba(255, 255, 255, 0.6);
  border-radius: 12px; padding: 11px 13px; line-height: 1.65; letter-spacing: var(--ls-wide);
}
.noteline :deep(svg) { flex: none; margin-top: 2px; color: var(--muted); }
.noteline b { color: var(--accent); }
.noteline code {
  font-family: var(--mono); font-size: 11.5px;
  background: var(--parchment); border-radius: 5px; padding: 1px 5px;
}
.hint { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.hint code {
  font-family: var(--mono); font-size: 11.5px;
  background: var(--parchment); border-radius: 5px; padding: 1px 5px;
}
.ml { margin-left: auto; }
.bt-close {
  margin-left: auto; height: 32px; padding: 0 14px; border-radius: 980px; cursor: pointer; font-family: inherit;
  font-size: var(--fs-sm); background: var(--canvas); border: 1px solid var(--hairline); color: var(--ink-2);
  transition: border-color 0.16s var(--ease), color 0.16s var(--ease), transform 0.16s var(--ease);
}
.bt-close:hover { border-color: var(--soft); color: var(--ink); }
.bt-close:active { transform: scale(0.96); }
</style>
