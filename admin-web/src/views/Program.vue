<template>
  <el-card>
    <el-form inline>
      <el-form-item>
        <el-button type="primary" @click="openEdit()">
          <IconPlus :size="15" class="btn-icon" />新增节目
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="标题" prop="title" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="title-cell">
            <component :is="IconMic" :size="15" class="title-icon" />
            <span class="c-strong">{{ row.title }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="主持人" prop="host" width="100" show-overflow-tooltip />
      <el-table-column label="播出时间" prop="broadcastTime" width="180" />
      <el-table-column label="日期" prop="broadcastDate" width="118">
        <template #default="{ row }">
          <span class="c-time">{{ row.broadcastDate || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="排序" prop="sort" width="70" align="right" />
      <el-table-column label="展示" width="96" align="center">
        <template #default="{ row }">
          <StatusTag :status="row.isShow===1 ? 1 : 3" :label="row.isShow===1?'展示':'隐藏'" />
        </template>
      </el-table-column>
      <el-table-column label="直播" width="88" align="center">
        <template #default="{ row }">
          <el-switch :model-value="row.isLive===1" @change="(v)=>toggleLive(row, v)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="92" fixed="right" align="right">
        <template #default="{ row }">
          <div class="op-cell">
            <el-tooltip content="编辑" placement="top" :show-after="300">
              <el-button size="small" text circle @click="openEdit(row)">
                <IconEdit :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="删除" placement="top" :show-after="300">
              <el-button size="small" text circle class="op-delete" @click="remove(row)">
                <IconTrash :size="16" />
              </el-button>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>

      <template #empty>
        <EmptyState variant="content" title="暂无节目" description="点击左上角「新增节目」创建第一条节目" />
      </template>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      layout="total, prev, pager, next"
      class="pager"
      @current-change="fetch"
    />
  </el-card>

  <el-dialog v-model="dialog" :title="form.id?'编辑节目':'新增节目'" width="560px">
    <el-form :model="form" label-width="100px">
      <el-form-item label="节目名" required>
        <el-input v-model="form.title" />
      </el-form-item>
      <el-form-item label="主持人">
        <el-input v-model="form.host" />
      </el-form-item>
      <el-form-item label="播出时间" required>
        <el-input v-model="form.broadcastTime" placeholder="如 周一 12:30-13:00" />
      </el-form-item>
      <el-form-item label="具体日期">
        <el-date-picker v-model="form.broadcastDate" type="date" value-format="YYYY-MM-DD" style="width:100%;" />
      </el-form-item>
      <el-form-item label="简介">
        <el-input v-model="form.desc" type="textarea" :rows="3" />
      </el-form-item>
      <el-form-item label="封面 URL">
        <el-input v-model="form.cover" />
      </el-form-item>
      <el-form-item label="排序">
        <el-input-number v-model="form.sort" :min="0" />
      </el-form-item>
      <el-form-item label="是否展示">
        <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog=false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import { IconPlus, IconEdit, IconTrash, IconMic } from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 20 });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const dialog = ref(false);
const form = reactive({ id: null, title: '', host: '', broadcastTime: '', broadcastDate: '', desc: '', cover: '', sort: 0, isShow: 1 });

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/program/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}

function openEdit(row) {
  if (row) Object.assign(form, row);
  else Object.assign(form, { id: null, title: '', host: '', broadcastTime: '', broadcastDate: '', desc: '', cover: '', sort: 0, isShow: 1 });
  dialog.value = true;
}

async function save() {
  if (!form.title || !form.broadcastTime) return ElMessage.warning('请填写节目名和播出时间');
  if (form.id) await http.put(`/admin/program/${form.id}`, form);
  else await http.post('/admin/program/create', form);
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除「${row.title}」？`, '提示', { type: 'warning' });
  await http.delete(`/admin/program/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

async function toggleLive(row, val) {
  await http.put(`/admin/program/${row.id}/live`, { isLive: val ? 1 : 0 });
  ElMessage.success(val ? '已设为正在直播' : '已取消直播');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }

.title-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.title-icon { color: #0891b2; flex-shrink: 0; }
.c-strong { font-weight: 600; color: #0f172a; }
.c-time { color: #475569; font-variant-numeric: tabular-nums; font-size: 13px; }

.op-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
.op-cell :deep(.el-button) { margin-left: 0; color: #64748b; }
.op-cell :deep(.el-button:hover) { color: #0891b2; background: #ecfeff; }
.op-delete { color: #94a3b8; }
.op-delete:hover { color: #dc2626; background: #fef2f2; }
</style>
