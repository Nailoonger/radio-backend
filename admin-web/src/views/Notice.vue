<template>
  <el-card>
    <el-form inline>
      <el-form-item>
        <el-input v-model="query.keyword" placeholder="搜索标题或内容" clearable style="width:200px;" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">
          <IconSearch :size="15" class="btn-icon" />查询
        </el-button>
      </el-form-item>
      <el-form-item style="margin-left:auto;">
        <el-button type="primary" @click="openEdit()">
          <IconPlus :size="15" class="btn-icon" />发布公告
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="标题" prop="title" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="title-cell">
            <IconMegaphone v-if="row.isTop===1" :size="15" class="top-icon" />
            <span class="c-strong">{{ row.title }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="内容预览" min-width="200">
        <template #default="{ row }">
          <span class="ellipsis">{{ row.content }}</span>
        </template>
      </el-table-column>
      <el-table-column label="置顶" width="76" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.isTop===1" type="danger" size="small" effect="light">置顶</el-tag>
          <span v-else class="c-muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="106" align="center">
        <template #default="{ row }">
          <StatusTag :status="row.isShow===1 ? 1 : 3" :label="row.isShow===1?'展示中':'已隐藏'" />
        </template>
      </el-table-column>
      <el-table-column label="发布时间" width="152">
        <template #default="{ row }">
          <span class="c-time">{{ fmt(row.publishTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="118" fixed="right" align="right">
        <template #default="{ row }">
          <div class="op-cell">
            <el-tooltip content="编辑" placement="top" :show-after="300">
              <el-button size="small" text circle @click="openEdit(row)">
                <IconEdit :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip :content="row.isShow===1?'隐藏':'展示'" placement="top" :show-after="300">
              <el-button size="small" text circle class="op-toggle" @click="toggle(row)">
                <component :is="row.isShow===1 ? IconEyeOff : IconEye" :size="16" />
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
        <EmptyState variant="content" title="暂无公告" description="点击右上角「发布公告」创建第一条公告" />
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

  <el-dialog v-model="dialog" :title="form.id?'编辑公告':'发布公告'" width="560px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="标题" required><el-input v-model="form.title" /></el-form-item>
      <el-form-item label="内容" required>
        <el-input v-model="form.content" type="textarea" :rows="6" />
      </el-form-item>
      <el-form-item label="置顶">
        <el-switch v-model="form.isTop" :active-value="1" :inactive-value="0" />
      </el-form-item>
      <el-form-item label="立即发布">
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
import dayjs from 'dayjs';
import {
  IconSearch, IconPlus, IconEdit, IconTrash,
  IconEye, IconEyeOff, IconMegaphone,
} from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 20, keyword: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const dialog = ref(false);
const form = reactive({ id: null, title: '', content: '', isTop: 0, isShow: 1 });
const fmt = (t) => dayjs(t).format('YYYY-MM-DD HH:mm');

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/notice/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, row);
  else Object.assign(form, { id: null, title: '', content: '', isTop: 0, isShow: 1 });
  dialog.value = true;
}

async function save() {
  if (!form.title || !form.content) return ElMessage.warning('请填写完整');
  if (form.id) await http.put(`/admin/notice/${form.id}`, form);
  else await http.post('/admin/notice/create', form);
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

async function toggle(row) {
  await http.put(`/admin/notice/${row.id}/toggle`);
  ElMessage.success('已切换');
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm('确认删除？', '提示', { type: 'warning' });
  await http.delete(`/admin/notice/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }

.title-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.top-icon { color: #ef4444; flex-shrink: 0; }
.c-strong { font-weight: 600; color: #0f172a; }
.c-muted { color: #cbd5e1; }
.c-time { color: #475569; font-variant-numeric: tabular-nums; font-size: 13px; }
.ellipsis {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: #64748b;
  font-size: 13px;
}

.op-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
.op-cell :deep(.el-button) { margin-left: 0; }
.op-cell :deep(.el-button) { color: #64748b; }
.op-cell :deep(.el-button:hover) { color: #0891b2; background: #ecfeff; }
.op-toggle { color: #64748b; }
.op-delete { color: #94a3b8; }
.op-delete:hover { color: #dc2626; background: #fef2f2; }
</style>
