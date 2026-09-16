<template>
  <el-card>
    <el-alert type="info" :closable="false" style="margin-bottom:16px;">
      系统设置用于配置小程序端的广播站介绍、开播时间、联系方式等 KV。
    </el-alert>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="Key" prop="key" width="200">
        <template #default="{ row }">
          <span class="mono">{{ row.key }}</span>
        </template>
      </el-table-column>
      <el-table-column label="说明" prop="desc" width="200" show-overflow-tooltip />
      <el-table-column label="值" prop="value" min-width="280">
        <template #default="{ row }">
          <span class="ellipsis">{{ row.value }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="76" fixed="right" align="right">
        <template #default="{ row }">
          <div class="op-cell">
            <el-tooltip content="编辑" placement="top" :show-after="300">
              <el-button size="small" text circle @click="openEdit(row)">
                <IconEdit :size="16" />
              </el-button>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>

      <template #empty>
        <EmptyState variant="content" title="暂无配置项" description="后端初始化后会写入默认配置" />
      </template>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" :title="`编辑设置：${form.key}`" width="560px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="Key"><el-input v-model="form.key" disabled /></el-form-item>
      <el-form-item label="说明"><el-input v-model="form.desc" /></el-form-item>
      <el-form-item label="值"><el-input v-model="form.value" type="textarea" :rows="6" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog=false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { IconEdit } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const rows = ref([]); const loading = ref(false);
const dialog = ref(false);
const form = reactive({ key: '', desc: '', value: '' });

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/setting/list');
    rows.value = data.list;
  } finally { loading.value = false; }
}

function openEdit(row) {
  Object.assign(form, row);
  dialog.value = true;
}

async function save() {
  await http.put(`/admin/setting/${form.key}`, { value: form.value, desc: form.desc });
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.ellipsis {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: #64748b;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  color: #334155;
}
.op-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
.op-cell :deep(.el-button) { margin-left: 0; color: #64748b; }
.op-cell :deep(.el-button:hover) { color: #0891b2; background: #ecfeff; }
</style>
