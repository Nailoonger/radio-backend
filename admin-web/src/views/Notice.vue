<template>
  <div class="notice-page">
    <!-- ══════════ 置顶深色条：有置顶才渲染，无置顶整块不出现（v8） ══════════ -->
    <div class="tile-strip" v-if="pinned">
      <div class="grow">
        <div class="strip-cap"><span class="dot-live"></span>小程序首页 · 置顶第 1 条</div>
        <div class="t">{{ pinned.title }}</div>
        <div class="m">{{ fmtDate(pinned.updatedAt || pinned.createTime) }} 发布<span v-if="pinned.updatedByName || pinned.createByName"> · 由 {{ pinned.updatedByName || pinned.createByName }} 发布</span></div>
      </div>
      <div class="metrics">
        <el-button size="small" class="strip-white" @click="unpin(pinned)">取消置顶</el-button>
        <el-button size="small" class="strip-ghost" @click="openEdit(pinned)">编辑</el-button>
      </div>
    </div>

    <!-- ══════════ 工具栏 ══════════ -->
    <div class="toolbar">
      <div class="filters">
        <button class="filter" :class="{ on: tab === 0 }" @click="setTab(0)">全部 <span class="num">{{ counts.all }}</span></button>
        <button class="filter" :class="{ on: tab === 1 }" @click="setTab(1)">已发布 <span class="num">{{ counts.published }}</span></button>
        <button class="filter" :class="{ on: tab === 2 }" @click="setTab(2)">草稿 <span class="num">{{ counts.draft }}</span></button>
        <button class="filter" :class="{ on: tab === 3 }" @click="setTab(3)">置顶 <span class="num">{{ counts.top }}</span></button>
      </div>
      <div class="tail">
        <div class="search-in">
          <IconSearch :size="14" />
          <input v-model="query.keyword" placeholder="搜索公告标题" @keyup.enter="search" />
        </div>
        <el-button type="primary" class="pill-btn" @click="openEdit(null)">
          <IconPlus :size="15" class="btn-icon" />新建公告
        </el-button>
      </div>
    </div>

    <!-- ══════════ 列表 ══════════ -->
    <div class="card-flush" v-if="loading">
      <!-- v8 加载骨架：与真实行同布局（标签 22 + 标题 15 + 微标 10） -->
      <div class="sk-row" v-for="i in 4" :key="i">
        <span class="sk sk-tag"></span>
        <div class="sk-col">
          <span class="sk sk-title" style="width:38%"></span>
          <span class="sk sk-cap" style="width:24%"></span>
        </div>
        <span class="sk sk-tag"></span>
        <span class="sk" style="width:96px;height:26px;border-radius:8px"></span>
      </div>
    </div>

    <div class="card-flush" v-else-if="rows.length">
      <div class="crow" v-for="row in rows" :key="row.id">
        <span class="tag tag-top" v-if="row.isTop === 1">置顶</span>
        <div class="grow">
          <div class="strong el">{{ row.title }}</div>
          <div class="micro" style="margin-top:3px">
            {{ fmtDate(row.updatedAt || row.createTime) }}
            <span v-if="row.updatedByName || row.createByName"> · {{ row.updatedByName || row.createByName }}</span>
          </div>
        </div>
        <span class="tag" :class="row.isShow === 1 ? 'tag-pass' : 'tag-mute'">
          {{ row.isShow === 1 ? '已发布' : '草稿' }}
        </span>
        <div class="rowact">
          <el-tooltip content="查看" placement="top" :show-after="300">
            <button class="iconmini" @click="preview(row)"><IconEye :size="15" /></button>
          </el-tooltip>
          <el-tooltip content="编辑" placement="top" :show-after="300">
            <button class="iconmini" @click="openEdit(row)"><IconEdit :size="15" /></button>
          </el-tooltip>
          <el-tooltip content="置顶" placement="top" :show-after="300">
            <button class="iconmini" v-if="row.isTop !== 1" @click="pin(row)"><IconStar :size="15" /></button>
          </el-tooltip>
          <el-tooltip content="删除" placement="top" :show-after="300">
            <button class="iconmini danger" @click="remove(row)"><IconTrash :size="15" /></button>
          </el-tooltip>
        </div>
      </div>
    </div>

    <div class="card-flush" v-else>
      <EmptyState variant="content" title="暂无公告" description="点击右上角「新建公告」创建第一条公告" />
    </div>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      layout="total, prev, pager, next"
      class="pager"
      @current-change="fetch"
    />

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="dialog" :title="form.id ? '编辑公告' : '新建公告'" width="580px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="标题" required><el-input v-model="form.title" maxlength="100" /></el-form-item>
        <el-form-item label="内容" required><el-input v-model="form.content" type="textarea" :rows="6" /></el-form-item>
        <el-form-item label="置顶">
          <el-switch v-model="form.isTop" :active-value="1" :inactive-value="0" />
          <span class="micro" style="margin-left:10px">置顶的会显示在小程序首页第一条</span>
        </el-form-item>
        <el-form-item label="立即发布">
          <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 查看 -->
    <el-dialog v-model="viewVisible" :title="viewing?.title" width="580px">
      <div class="view-meta micro">{{ fmtDate(viewing?.updatedAt || viewing?.createTime) }} · {{ viewing?.isShow === 1 ? '已发布' : '草稿' }}</div>
      <div class="view-body">{{ viewing?.content }}</div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconSearch, IconPlus, IconEdit, IconTrash, IconEye, IconStar } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 20, keyword: '' });
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const tab = ref(0); // 0 全部 1 已发布 2 草稿 3 置顶
const dialog = ref(false);
const form = reactive({ id: null, title: '', content: '', isTop: 0, isShow: 1 });
const viewVisible = ref(false);
const viewing = ref(null);

const counts = reactive({ all: 0, published: 0, draft: 0, top: 0 });
const allRows = ref([]);

/** 置顶条数据：从全量里取 isTop=1 的第一条（不受筛选影响） */
const pinned = computed(() => allRows.value.find((r) => r.isTop === 1) || null);

const fmtDate = (t) => (t ? dayjs(t).format('YYYY-MM-DD') : '—');

async function fetch() {
  loading.value = true;
  try {
    // 全量取一次做计数与置顶条（公告量小），当前页按筛选展示
    const all = await http.get('/admin/notice/list', { params: { page: 1, pageSize: 200 } });
    allRows.value = all.list || [];
    counts.all = all.total ?? allRows.value.length;
    counts.published = allRows.value.filter((r) => r.isShow === 1).length;
    counts.draft = allRows.value.filter((r) => r.isShow !== 1).length;
    counts.top = allRows.value.filter((r) => r.isTop === 1).length;

    const d = await http.get('/admin/notice/list', { params: { ...query, state: tab.value === 1 ? 1 : tab.value === 2 ? 0 : undefined } });
    let list = d.list || [];
    if (tab.value === 3) list = list.filter((r) => r.isTop === 1);
    rows.value = list;
    total.value = tab.value === 3 ? counts.top : (d.total ?? list.length);
  } finally { loading.value = false; }
}

function setTab(v) { tab.value = v; query.page = 1; fetch(); }
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, { id: row.id, title: row.title, content: row.content, isTop: row.isTop, isShow: row.isShow });
  else Object.assign(form, { id: null, title: '', content: '', isTop: 0, isShow: 1 });
  dialog.value = true;
}

function preview(row) { viewing.value = row; viewVisible.value = true; }

async function save() {
  if (!form.title.trim() || !form.content.trim()) return ElMessage.warning('请填写标题和内容');
  if (form.id) await http.put(`/admin/notice/${form.id}`, form);
  else await http.post('/admin/notice/create', form);
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

/** 置顶 / 取消置顶：带上原字段整条更新，避免后端必填校验拦下 */
async function setTop(row, isTop) {
  await http.put(`/admin/notice/${row.id}`, { title: row.title, content: row.content, isTop, isShow: row.isShow });
  ElMessage.success(isTop ? '已置顶，小程序首页第一条已更新' : '已取消置顶');
  fetch();
}
const pin = (row) => setTop(row, 1);
const unpin = (row) => setTop(row, 0);

async function remove(row) {
  await ElMessageBox.confirm(`删除「${row.title}」？小程序端会同时移除。`, '删除公告', { type: 'warning', confirmButtonText: '删除' });
  await http.delete(`/admin/notice/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.notice-page { display: flex; flex-direction: column; gap: 18px; }
.grow { flex: 1; min-width: 0; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowc { display: flex; align-items: center; gap: 8px; }
.btn-icon { margin-right: 4px; vertical-align: -2px; }

/* ══════════ 置顶深色条 ══════════ */
.tile-strip {
  display: flex; align-items: center; gap: 26px;
  background: var(--tile); border-radius: var(--r-tile);
  padding: 16px 24px; color: #fff;
}
.strip-cap { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); color: #ccc; letter-spacing: 0.6px; }
.dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--live); flex: none; }
.tile-strip .t { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.3px; margin-top: 5px; }
.tile-strip .m { font-size: var(--fs-sm); color: #ccc; letter-spacing: var(--ls-wide); margin-top: 4px; }
.metrics { margin-left: auto; display: flex; gap: 10px; align-items: center; flex: none; }
.tile-strip .strip-white.el-button { background: #fff !important; background-image: none !important; border: none !important; color: var(--accent) !important; font-weight: 600; border-radius: var(--r-pill); }
.tile-strip .strip-ghost.el-button,
.tile-strip .strip-ghost.el-button:hover { background: transparent !important; background-image: none !important; border: 1px solid var(--accent-dark) !important; color: var(--accent-dark) !important; border-radius: var(--r-pill); }

/* ══════════ 工具栏 ══════════ */
.toolbar { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
.tail { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.search-in {
  display: flex; align-items: center; gap: 8px;
  height: 36px; width: 210px; padding: 0 14px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); color: var(--soft);
}
.search-in input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-family: inherit; font-size: var(--fs-sm); color: var(--ink); }
.search-in input::placeholder { color: var(--soft); }
.filters { display: inline-flex; gap: 8px; }
.filter {
  height: 30px; padding: 0 14px; cursor: pointer;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--ink-2);
}
.filter:hover { border-color: var(--soft); }
.filter.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.filter .num { opacity: 0.7; margin-left: 3px; }
.pill-btn.el-button { border-radius: var(--r-pill); }

/* ══════════ 列表行 ══════════ */
.card-flush { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.crow { display: flex; align-items: center; gap: 14px; padding: 13px 20px; }
.crow + .crow { border-top: 1px solid var(--divider); }
.strong { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.7; }

.tag { display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); flex: none; }
.tag-top { background: var(--ink); color: #fff; }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }

.rowact { display: flex; align-items: center; gap: 4px; flex: none; }
.iconmini {
  width: 28px; height: 28px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.iconmini:hover { background: var(--parchment); color: var(--ink); }
.iconmini.danger:hover { background: var(--red-bg); color: var(--red-fg); }

/* ══════════ v8 加载骨架 ══════════ */
.sk { position: relative; overflow: hidden; flex: none; border-radius: 6px; background: var(--divider); }
.sk::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: skSweep 1.4s var(--ease) infinite;
}
@keyframes skSweep { to { transform: translateX(100%); } }
.sk-tag { height: 22px; border-radius: var(--r-pill); }
.sk-title { height: 15px; }
.sk-cap { height: 10px; }
.sk-row { display: flex; align-items: center; gap: 13px; padding: 13px 20px; }
.sk-row + .sk-row { border-top: 1px solid rgba(0, 0, 0, 0.05); }
.sk-col { display: flex; flex-direction: column; gap: 9px; flex: 1; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .sk::after { animation: none; background: none; } }

/* 查看弹窗 */
.view-meta { margin-bottom: 12px; }
.view-body { font-size: var(--fs-md); color: var(--ink-2); line-height: 1.9; white-space: pre-wrap; }

.pager { margin-top: 4px; justify-content: flex-end; }
</style>
