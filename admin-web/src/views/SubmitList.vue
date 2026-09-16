<template>
  <el-card>
    <el-form inline :model="query" @submit.prevent="search">
      <el-form-item label="状态">
        <el-select v-model="query.status" placeholder="全部" clearable style="width:120px;">
          <el-option label="待审核" :value="0" />
          <el-option label="已通过" :value="1" />
          <el-option label="已驳回" :value="2" />
        </el-select>
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="query.type" placeholder="全部" clearable style="width:120px;">
          <el-option label="点歌" :value="1" />
          <el-option label="文稿" :value="2" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键词">
        <el-input v-model="query.keyword" placeholder="歌名/歌手/标题" clearable style="width:180px;" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="search">
          <IconSearch :size="15" class="btn-icon" />查询
        </el-button>
      </el-form-item>

      <el-form-item style="margin-left:auto;">
        <el-button :disabled="!selection.length" @click="batchApprove">
          <IconCheck :size="15" class="btn-icon" />批量通过
        </el-button>
        <el-button :disabled="!selection.length" type="danger" plain @click="batchReject">
          <IconClose :size="15" class="btn-icon" />批量驳回
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" @selection-change="(rows)=>selection=rows" stripe>
      <el-table-column type="selection" width="46" />
      <el-table-column label="类型" width="72" align="center">
        <template #default="{ row }">
          <el-tag :type="row.type===1?'success':'warning'" size="small" effect="light">
            {{ row.type===1 ? '点歌' : '文稿' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="内容" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="content-cell">
            <component :is="row.type===1 ? IconMusic : IconArticle" :size="15" class="content-icon" :class="row.type===1 ? 'ic-song' : 'ic-article'" />
            <template v-if="row.type===1">
              <span class="c-strong">{{ row.songName }}</span>
              <span class="c-sep">-</span>
              <span class="c-muted">{{ row.singer }}</span>
            </template>
            <template v-else>
              <span class="c-strong">{{ row.articleTitle }}</span>
            </template>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="提交人" width="140">
        <template #default="{ row }">
          <div class="user-cell">
            <el-avatar :size="24">{{ (row.nickname||'?').charAt(0) }}</el-avatar>
            <span class="c-ellipsis">{{ row.nickname || '匿名' }}</span>
          </div>
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
      <el-table-column label="操作" width="152" fixed="right" align="right">
        <template #default="{ row }">
          <div class="op-cell">
            <el-tooltip content="详情" placement="top" :show-after="300">
              <el-button size="small" text circle @click="openDetail(row)">
                <IconEye :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="通过" placement="top" :show-after="300">
              <el-button v-if="row.status !== 1" size="small" text circle class="op-approve" @click="approve(row)">
                <IconCheck :size="16" />
              </el-button>
            </el-tooltip>
            <el-tooltip content="驳回" placement="top" :show-after="300">
              <el-button v-if="row.status !== 2" size="small" text circle class="op-reject" @click="reject(row)">
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
        <EmptyState variant="review" title="暂无投稿" description="小程序端有新的点歌或文稿投稿时，会出现在这里" />
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

  <!-- 详情 -->
  <el-dialog v-model="detailVisible" title="投稿详情" width="560px">
    <template v-if="detail">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="类型">{{ detail.type===1?'点歌':'文稿' }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.type===1" label="歌曲">{{ detail.songName }} - {{ detail.singer }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.type===1" label="祝福语">{{ detail.wishContent || '-' }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.type===2" label="标题">{{ detail.articleTitle }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.type===2" label="内容"><div class="pre-wrap">{{ detail.articleContent }}</div></el-descriptions-item>
        <el-descriptions-item label="希望播出时间">{{ detail.wantBroadcastTime || '-' }}</el-descriptions-item>
        <el-descriptions-item label="提交人">{{ detail.nickname }}（{{ detail.openid }}）</el-descriptions-item>
        <el-descriptions-item label="提交时间">{{ fmt(detail.createTime) }}</el-descriptions-item>
        <el-descriptions-item label="审核状态">
          <div class="status-line">
            <StatusTag :status="detail.status" />
            <span v-if="detail.rejectReason" class="reject-reason">{{ detail.rejectReason }}</span>
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </template>
  </el-dialog>

  <!-- 驳回弹窗 -->
  <el-dialog v-model="rejectVisible" title="驳回理由" width="420px">
    <el-input v-model="rejectReason" type="textarea" :rows="4" placeholder="请填写驳回理由" />
    <template #footer>
      <el-button @click="rejectVisible=false">取消</el-button>
      <el-button type="danger" @click="confirmReject">确认驳回</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import {
  IconSearch, IconCheck, IconClose, IconEye, IconTrash,
  IconMusic, IconArticle,
} from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 10, status: '', type: '', keyword: '' });
const rows = ref([]); const total = ref(0); const loading = ref(false);
const selection = ref([]);
const detail = ref(null); const detailVisible = ref(false);
const rejectVisible = ref(false); const rejectReason = ref(''); const currentReject = ref(null);

const fmt = (t) => dayjs(t).format('YYYY-MM-DD HH:mm');

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/submit/list', { params: query });
    rows.value = data.list; total.value = data.total;
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

async function openDetail(row) {
  detail.value = await http.get(`/admin/submit/${row.id}`);
  detailVisible.value = true;
}

async function approve(row) {
  await http.put(`/admin/submit/${row.id}/approve`);
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
  await http.put(`/admin/submit/${currentReject.value.id}/reject`, { reason: rejectReason.value });
  ElMessage.success('已驳回');
  rejectVisible.value = false;
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm('确认删除该投稿？', '提示', { type: 'warning' });
  await http.delete(`/admin/submit/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

async function batchApprove() {
  await http.post('/admin/submit/batch', { ids: selection.value.map(r=>r.id), action: 'approve' });
  ElMessage.success('批量通过完成');
  selection.value = []; fetch();
}
async function batchReject() {
  const { value: reason } = await ElMessageBox.prompt('请输入驳回理由', '批量驳回', { inputValidator: v => v ? true : '不能为空' });
  await http.post('/admin/submit/batch', { ids: selection.value.map(r=>r.id), action: 'reject', reason });
  ElMessage.success('批量驳回完成');
  selection.value = []; fetch();
}

onMounted(fetch);
</script>

<style scoped>
.btn-icon { margin-right: 5px; vertical-align: -2px; }
.pager { margin-top: 16px; justify-content: flex-end; }

.content-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.content-icon { flex-shrink: 0; }
.ic-song { color: #0891b2; }
.ic-article { color: #4f46e5; }
.c-strong { font-weight: 600; color: #0f172a; }
.c-sep { color: #cbd5e1; }
.c-muted { color: #64748b; }
.c-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-time {
  color: #475569;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.user-cell {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

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

.pre-wrap { white-space: pre-wrap; }
.status-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.reject-reason { color: #dc2626; font-size: 13px; }
</style>
