<template>
  <el-card>
    <el-form inline>
      <el-form-item label="搜索">
        <el-input v-model="query.keyword" placeholder="姓名/岗位/部门/年级" clearable style="width:200px;" @keyup.enter="search" />
      </el-form-item>
      <el-form-item label="部门">
        <el-select v-model="query.department" clearable placeholder="全部" style="width:140px;">
          <el-option v-for="d in knownDepartments" :key="d" :label="d" :value="d" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">
          <IconSearch :size="15" class="btn-icon" />查询
        </el-button>
      </el-form-item>
      <el-form-item style="margin-left:auto;">
        <el-button type="primary" @click="openEdit()">
          <IconPlus :size="15" class="btn-icon" />新增成员
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="头像" width="76" align="center">
        <template #default="{ row }">
          <el-avatar :src="row.avatar" :size="40" shape="circle" />
        </template>
      </el-table-column>
      <el-table-column label="姓名" prop="name" width="100" show-overflow-tooltip />
      <el-table-column label="部门" width="104" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.department" size="small" type="success" effect="light">{{ row.department }}</el-tag>
          <span v-else class="c-muted">未分</span>
        </template>
      </el-table-column>
      <el-table-column label="岗位" prop="role" width="100" show-overflow-tooltip />
      <el-table-column label="年级" prop="grade" width="120" show-overflow-tooltip />
      <el-table-column label="栏目" prop="programs" min-width="180" show-overflow-tooltip />
      <el-table-column label="排序" prop="sort" width="70" align="right" />
      <el-table-column label="展示" width="80" align="center">
        <template #default="{ row }">
          <StatusTag :status="row.isShow===1 ? 1 : 3" :label="row.isShow===1?'展示':'隐藏'" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right" align="right">
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
        <EmptyState variant="content" title="暂无部门成员" description="点击右上角「新增成员」添加" />
      </template>
    </el-table>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      :page-sizes="[10, 20, 50]"
      layout="total, sizes, prev, pager, next"
      class="pager"
      @current-change="fetch"
      @size-change="fetch"
    />
  </el-card>

  <el-dialog v-model="dialog" :title="form.id?'编辑成员':'新增成员'" width="560px" destroy-on-close>
    <el-form :model="form" label-width="84px" :rules="rules" ref="formRef">
      <el-form-item label="头像" prop="avatar">
        <el-upload class="avatar-uploader" :show-file-list="false" :http-request="uploadAvatar"
          :before-upload="beforeAvatarUpload" accept="image/jpeg,image/png,image/webp">
          <img v-if="form.avatar" :src="form.avatar" class="avatar-preview" />
          <el-icon v-else class="avatar-uploader-icon"><IconPlus :size="24" /></el-icon>
        </el-upload>
        <div class="hint">支持 jpg/png/webp，≤ 2MB</div>
        <el-input v-model="form.avatar" placeholder="或粘贴图片 URL" style="margin-top:8px;" />
      </el-form-item>
      <el-form-item label="姓名" prop="name">
        <el-input v-model="form.name" maxlength="32" show-word-limit />
      </el-form-item>
      <el-form-item label="部门" prop="department">
        <el-select v-model="form.department" allow-create filterable placeholder="选择或输入部门" style="width:100%;">
          <el-option v-for="d in knownDepartments" :key="d" :label="d" :value="d" />
        </el-select>
      </el-form-item>
      <el-form-item label="岗位" prop="role">
        <el-select v-model="form.role" allow-create filterable placeholder="选择或输入新岗位" style="width:100%;">
          <el-option v-for="r in knownRoles" :key="r" :label="r" :value="r" />
        </el-select>
      </el-form-item>
      <el-form-item label="年级班级">
        <el-input v-model="form.grade" maxlength="32" placeholder="如 高三(2)班" />
      </el-form-item>
      <el-form-item label="负责栏目">
        <el-input v-model="form.programs" maxlength="200" placeholder="多个栏目用逗号分隔" show-word-limit />
      </el-form-item>
      <el-form-item label="个人寄语">
        <el-input v-model="form.motto" type="textarea" :rows="3" maxlength="200" show-word-limit />
      </el-form-item>
      <el-form-item label="排序权重">
        <el-input-number v-model="form.sort" :min="0" :max="9999" />
        <span class="hint" style="margin-left:12px;">数值大者靠前</span>
      </el-form-item>
      <el-form-item label="是否展示">
        <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import {
  IconSearch, IconPlus, IconEdit, IconTrash,
} from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';

const knownDepartments = ['播音部', '主持部', '编辑部'];
const knownRoles = ['主播', '主持', '编辑', '记者', '技术员'];

const query = reactive({ page: 1, pageSize: 20, keyword: '', department: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const dialog = ref(false); const saving = ref(false);
const formRef = ref(null);
const form = reactive({
  id: null, name: '', role: '', department: '', grade: '', programs: '',
  avatar: '', motto: '', sort: 0, isShow: 1,
});
const rules = {
  name: [{ required: true, message: '请填写姓名', trigger: 'blur' }],
  role: [{ required: true, message: '请选择或填写岗位', trigger: 'change' }],
  department: [{ required: true, message: '请选择或填写部门', trigger: 'change' }],
  avatar: [{ required: true, message: '请上传头像或填写 URL', trigger: 'change' }],
};

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/staff/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, row);
  else Object.assign(form, {
    id: null, name: '', role: '', department: '', grade: '', programs: '',
    avatar: '', motto: '', sort: 0, isShow: 1,
  });
  dialog.value = true;
}

async function save() {
  try { await formRef.value.validate(); } catch { return; }
  saving.value = true;
  try {
    if (form.id) await http.put(`/admin/staff/${form.id}`, form);
    else await http.post('/admin/staff/create', form);
    ElMessage.success('已保存');
    dialog.value = false;
    fetch();
  } catch { /* 拦截器已提示 */ }
  finally { saving.value = false; }
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除「${row.name}」？`, '提示', { type: 'warning' });
  await http.delete(`/admin/staff/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

function beforeAvatarUpload(file) {
  const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  const lt2M = file.size / 1024 / 1024 < 2;
  if (!ok) ElMessage.error('仅支持 jpg/png/webp');
  if (!lt2M) ElMessage.error('文件超过 2MB');
  return ok && lt2M;
}

async function uploadAvatar(option) {
  const fd = new FormData();
  fd.append('file', option.file);
  try {
    const data = await http.post('/admin/upload/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    form.avatar = data.url;
    ElMessage.success('上传成功');
  } catch { /* 拦截器已提示 */ }
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }
.c-muted { color: var(--muted); }
.op-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
.op-cell :deep(.el-button) { margin-left: 0; color: var(--muted); }
.op-cell :deep(.el-button:hover) { color: var(--accent); background: #ecfeff; }
.op-delete { color: var(--muted); }
.op-delete:hover { color: var(--red-fg); background: #fef2f2; }
.avatar-uploader :deep(.el-upload) {
  border: 1px dashed #d1d5db;
  border-radius: 8px;
  cursor: pointer;
  width: 100px;
  height: 100px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.avatar-uploader :deep(.el-upload:hover) { border-color: var(--accent); }
.avatar-uploader-icon { font-size: 28px; color: var(--muted); }
.avatar-preview { width: 100px; height: 100px; object-fit: cover; }
.hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
</style>