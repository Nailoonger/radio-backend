<template>
  <el-card>
    <el-form inline>
      <el-form-item label="状态">
        <el-select v-model="query.status" placeholder="全部" clearable style="width:120px;">
          <el-option label="待审核" :value="0" />
          <el-option label="已通过" :value="1" />
          <el-option label="已驳回" :value="2" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键词">
        <el-input v-model="query.keyword" placeholder="昵称或内容" clearable style="width:180px;" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">
          <IconSearch :size="15" class="btn-icon" />查询
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" stripe>
      <el-table-column label="用户" width="150">
        <template #default="{ row }">
          <div class="user-cell">
            <el-avatar :size="24">{{ (row.nickname||'?').charAt(0) }}</el-avatar>
            <span class="c-ellipsis">{{ row.nickname || '匿名' }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="内容" prop="content" min-width="240" show-overflow-tooltip />
      <el-table-column label="关联节目" width="110" align="center">
        <template #default="{ row }">
          <span class="c-muted">{{ row.programId || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="106" align="center">
        <template #default="{ row }">
          <StatusTag :status="row.status" />
        </template>
      </el-table-column>
      <el-table-column label="提交时间" width="152">
        <template #default="{ row }">
          <span class="c-time">{{ fmt(row.createTime) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="118" fixed="right" align="right">
        <template #default="{ row }">
          <div class="op-cell">
            <el-tooltip content="通过" placement="top" :show-after="300">
              <el-button v-if="row.status!==1" size="small" text circle class="op-approve" @click="approve(row)">
                <IconCheck :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="驳回" placement="top" :show-after="300">
              <el-button v-if="row.status!==2" size="small" text circle class="op-reject" @click="reject(row)">
                <IconClose :size="16" />
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
        <EmptyState variant="review" title="暂无留言" description="小程序端有新的节目留言时，会出现在这里" />
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

  <el-dialog v-model="rejectVisible" title="驳回理由" width="420px">
    <el-input v-model="rejectReason" type="textarea" :rows="4" placeholder="请填写驳回理由" />
    <template #footer>
      <el-button @click="rejectVisible=false">取消</el-button>
      <el-button type="danger" @click="confirmReject">确认</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconSearch, IconCheck, IconClose, IconTrash } from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 10, status: '', keyword: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const rejectVisible = ref(false); const rejectReason = ref(''); const currentReject = ref(null);

const fmt = (t) => dayjs(t).format('YYYY-MM-DD HH:mm');

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/message/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

async function approve(row) {
  await http.put(`/admin/message/${row.id}/approve`);
  ElMessage.success('已通过');
  fetch();
}
function reject(row) {
  currentReject.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}
async function confirmReject() {
  if (!rejectReason.value.trim()) return ElMessage.warning('请填写驳回理由');
  await http.put(`/admin/message/${currentReject.value.id}/reject`, { reason: rejectReason.value });
  ElMessage.success('已驳回');
  rejectVisible.value = false;
  fetch();
}
async function remove(row) {
  await ElMessageBox.confirm('确认删除？', '提示', { type: 'warning' });
  await http.delete(`/admin/message/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }

.user-cell {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.c-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-muted { color: #94a3b8; font-variant-numeric: tabular-nums; }
.c-time { color: #475569; font-variant-numeric: tabular-nums; font-size: 13px; }

.op-cell {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}
.op-cell :deep(.el-button) { margin-left: 0; }
.op-approve { color: #10b981; }
.op-approve:hover { color: #059669; background: #ecfdf5; }
.op-reject { color: #f59e0b; }
.op-reject:hover { color: #d97706; background: #fffbeb; }
.op-delete { color: #94a3b8; }
.op-delete:hover { color: #dc2626; background: #fef2f2; }
</style>
