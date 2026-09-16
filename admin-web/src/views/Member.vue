<template>
  <el-card>
    <el-form inline>
      <el-form-item label="搜索">
        <el-input v-model="query.keyword" placeholder="姓名/职务/年级" clearable style="width:200px;" @keyup.enter="search" />
      </el-form-item>
      <el-form-item label="职务">
        <el-select v-model="query.role" clearable placeholder="全部" style="width:140px;">
          <el-option v-for="r in knownRoles" :key="r" :label="r" :value="r" />
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
      <el-table-column label="职务" width="104" align="center">
        <template #default="{ row }">
          <el-tag size="small" type="info" effect="light">{{ row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="年级班级" prop="grade" width="136" show-overflow-tooltip />
      <el-table-column label="栏目" prop="programs" min-width="190" show-overflow-tooltip />
      <el-table-column label="寄语" prop="motto" min-width="160" show-overflow-tooltip />
      <el-table-column label="排序" prop="sort" width="72" align="right" />
      <el-table-column label="展示" width="88" align="center">
        <template #default="{ row }">
          <el-switch :model-value="row.isShow===1" @change="(v)=>toggle(row, v)" />
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
        <EmptyState variant="content" title="暂无成员" description="点击右上角「新增成员」添加风采展示成员" />
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

  <!-- 新增 / 编辑 弹窗 -->
  <el-dialog v-model="dialog" :title="form.id ? '编辑成员' : '新增成员'" width="640px" destroy-on-close>
    <el-form :model="form" label-width="100px" :rules="rules" ref="formRef">
      <el-form-item label="头像" prop="avatar">
        <el-upload
          class="avatar-uploader"
          :show-file-list="false"
          :http-request="uploadAvatar"
          :before-upload="beforeAvatarUpload"
          accept="image/jpeg,image/png,image/webp"
        >
          <img v-if="form.avatar" :src="form.avatar" class="avatar-preview" />
          <IconPlus v-else :size="24" class="avatar-uploader-icon" />
        </el-upload>
        <div class="hint">支持 jpg/png/webp，≤ 2MB；或直接粘贴图片 URL</div>
        <el-input v-model="form.avatar" placeholder="或粘贴图片 URL" style="margin-top:8px;" />
      </el-form-item>
      <el-form-item label="姓名" prop="name">
        <el-input v-model="form.name" maxlength="32" show-word-limit />
      </el-form-item>
      <el-form-item label="职务" prop="role">
        <el-select v-model="form.role" allow-create filterable placeholder="选择或输入新职务" style="width:100%;">
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
import { IconSearch, IconPlus, IconEdit, IconTrash } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';
import http from '@/utils/http';

const knownRoles = ['站长', '副站长', '纪检长', '站长助理', '站员'];
const baseURL = import.meta.env.VITE_API_BASE || '/api';

const query = reactive({ page: 1, pageSize: 20, keyword: '', role: '' });
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const dialog = ref(false);
const saving = ref(false);
const formRef = ref(null);
const form = reactive({
  id: null, name: '', role: '', grade: '', programs: '', avatar: '', motto: '', sort: 0, isShow: 1,
});
const rules = {
  name: [{ required: true, message: '请填写姓名', trigger: 'blur' }],
  role: [{ required: true, message: '请选择或填写职务', trigger: 'change' }],
  avatar: [{ required: true, message: '请上传头像或填写 URL', trigger: 'change' }],
};

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/member/list', { params: query });
    rows.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, row);
  else Object.assign(form, { id: null, name: '', role: '', grade: '', programs: '', avatar: '', motto: '', sort: 0, isShow: 1 });
  dialog.value = true;
}

async function save() {
  try {
    await formRef.value.validate();
  } catch { return; }
  saving.value = true;
  try {
    if (form.id) await http.put(`/admin/member/${form.id}`, form);
    else await http.post('/admin/member/create', form);
    ElMessage.success('已保存');
    dialog.value = false;
    fetch();
  } catch { /* 拦截器已提示 */ }
  finally { saving.value = false; }
}

async function toggle(row, val) {
  await http.put(`/admin/member/${row.id}/toggle`, { isShow: val ? 1 : 0 });
  ElMessage.success('已更新');
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除「${row.name}」？`, '提示', { type: 'warning' });
  await http.delete(`/admin/member/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

// ---------- 上传 ----------
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
    // 后端返回 /uploads/avatars/...；Vite dev 已代理 /uploads → http://localhost:3000/uploads
    // 直接用相对 URL 即可，不要再拼 baseURL
    form.avatar = data.url;
    ElMessage.success('上传成功');
  } catch { /* 拦截器已提示 */ }
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }

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
.avatar-uploader :deep(.el-upload:hover) {
  border-color: #06b6d4;
}
.avatar-uploader-icon {
  font-size: 28px;
  color: #94a3b8;
}
.avatar-preview {
  width: 100px;
  height: 100px;
  object-fit: cover;
  display: block;
}
.hint {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 6px;
}
</style>
