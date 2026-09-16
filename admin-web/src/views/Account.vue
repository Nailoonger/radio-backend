<template>
  <el-card>
    <el-form inline>
      <el-form-item>
        <el-input v-model="query.keyword" placeholder="账号或昵称" clearable style="width:200px;" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">
          <IconSearch :size="15" class="btn-icon" />查询
        </el-button>
      </el-form-item>
      <el-form-item style="margin-left:auto;">
        <el-button type="primary" @click="openEdit()">
          <IconUserPlus :size="15" class="btn-icon" />新增管理员
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="ID" prop="id" width="70" align="center" />
      <el-table-column label="账号" prop="username" width="136" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="mono">{{ row.username }}</span>
        </template>
      </el-table-column>
      <el-table-column label="昵称" prop="nickname" width="140" show-overflow-tooltip />
      <el-table-column label="角色" width="104" align="center">
        <template #default="{ row }">
          <el-tag :type="row.role===0?'danger':'success'" size="small" effect="light">{{ row.role===0?'超管':'社员' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="88" align="center">
        <template #default="{ row }">
          <el-switch :model-value="row.status===1" @change="(v)=>toggleStatus(row, v)" />
        </template>
      </el-table-column>
      <el-table-column label="上次登录" width="152">
        <template #default="{ row }">
          <span class="c-time">{{ row.lastLoginAt ? dayjs(row.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</span>
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
        <EmptyState variant="content" title="暂无管理员" description="点击右上角「新增管理员」创建账号" />
      </template>
    </el-table>
  </el-card>

  <el-dialog v-model="dialog" :title="form.id?'编辑管理员':'新增管理员'" width="480px">
    <el-form :model="form" label-width="100px">
      <el-form-item label="账号" required>
        <el-input v-model="form.username" :disabled="!!form.id" />
      </el-form-item>
      <el-form-item label="昵称">
        <el-input v-model="form.nickname" />
      </el-form-item>
      <el-form-item :label="form.id?'重置密码':'密码'" :required="!form.id">
        <el-input v-model="form.password" type="password" show-password :placeholder="form.id?'留空表示不修改':'至少 6 位'" />
      </el-form-item>
      <el-form-item label="角色" required>
        <el-radio-group v-model="form.role">
          <el-radio :value="0">超级管理员</el-radio>
          <el-radio :value="1">普通管理员</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="状态">
        <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
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
import { IconSearch, IconUserPlus, IconEdit, IconTrash } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 20, keyword: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const dialog = ref(false);
const form = reactive({ id: null, username: '', nickname: '', password: '', role: 1, status: 1 });

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/admin/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, row, { password: '' });
  else Object.assign(form, { id: null, username: '', nickname: '', password: '', role: 1, status: 1 });
  dialog.value = true;
}

async function save() {
  if (!form.username) return ElMessage.warning('请填写账号');
  if (!form.id && !form.password) return ElMessage.warning('请填写密码');
  if (form.password && form.password.length < 6) return ElMessage.warning('密码至少 6 位');
  if (form.id) {
    await http.put(`/admin/admin/${form.id}`, {
      nickname: form.nickname, password: form.password || undefined,
      role: form.role, status: form.status,
    });
  } else {
    await http.post('/admin/admin/create', {
      username: form.username, password: form.password,
      nickname: form.nickname, role: form.role,
    });
  }
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

async function toggleStatus(row, val) {
  await http.put(`/admin/admin/${row.id}`, { status: val ? 1 : 0 });
  ElMessage.success('已更新');
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除管理员「${row.username}」？`, '提示', { type: 'warning' });
  await http.delete(`/admin/admin/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  color: #334155;
}
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
