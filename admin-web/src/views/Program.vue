<template>
  <div class="program-page">
    <!-- ══════════ 本周 7 天条（沿用小程序「节目单」的日期分组） ══════════ -->
    <div class="weekstrip">
      <div class="day" v-for="d in week" :key="d.date" :class="{ on: d.isToday }">
        <div class="w">{{ d.label }}<template v-if="d.isToday"> · 今天</template></div>
        <div class="d num">{{ d.dayNum }}</div>
        <div class="n">{{ d.count ? d.count + ' 档' : '暂无' }}</div>
      </div>
    </div>

    <!-- ══════════ 工具栏 ══════════ -->
    <div class="toolbar">
      <div class="filters">
        <button class="filter" :class="{ on: tab === 0 }" @click="setTab(0)">全部 <span class="num">{{ counts.all }}</span></button>
        <button class="filter" :class="{ on: tab === 1 }" @click="setTab(1)">直播中 <span class="num">{{ counts.live }}</span></button>
        <button class="filter" :class="{ on: tab === 2 }" @click="setTab(2)">已展示 <span class="num">{{ counts.shown }}</span></button>
        <button class="filter" :class="{ on: tab === 3 }" @click="setTab(3)">已隐藏 <span class="num">{{ counts.hidden }}</span></button>
      </div>
      <div class="tail">
        <div class="search-in">
          <IconSearch :size="14" />
          <input v-model="query.keyword" placeholder="搜索栏目 / 主持人" @keyup.enter="search" />
        </div>
        <el-button type="primary" class="pill-btn" @click="openEdit(null)">
          <IconPlus :size="15" class="btn-icon" />新建栏目
        </el-button>
      </div>
    </div>

    <!-- ══════════ 节目列表 ══════════ -->
    <div class="card-flush" v-if="loading">
      <div class="sk-row" v-for="i in 4" :key="i">
        <span class="sk" style="width:104px;height:14px"></span>
        <div class="sk-col">
          <span class="sk sk-title" style="width:30%"></span>
          <span class="sk sk-cap" style="width:42%"></span>
        </div>
        <span class="sk sk-tag"></span>
        <span class="sk" style="width:64px;height:26px;border-radius:8px"></span>
      </div>
    </div>

    <div class="card-flush" v-else-if="rows.length">
      <div
        class="crow" v-for="row in rows" :key="row.id"
        :class="{ dark: row.isLive === 1 }"
      >
        <span class="time num" :class="{ sub: row.isLive !== 1 }">{{ row.broadcastTime || '时间待定' }}</span>
        <div class="grow">
          <div class="rowc">
            <span class="strong el">{{ row.title }}</span>
            <span class="tag tag-live" v-if="row.isLive === 1">直播中</span>
          </div>
          <div class="micro el" style="margin-top:3px">
            {{ row.host ? '主持人 ' + row.host : '主持人未定 · 待分配' }}
            <template v-if="row.desc"> · {{ row.desc }}</template>
          </div>
        </div>
        <span class="tag" v-if="row.isLive !== 1" :class="row.isShow === 1 ? 'tag-pass' : 'tag-mute'">
          {{ row.isShow === 1 ? '已展示' : '已隐藏' }}
        </span>
        <div class="rowact">
          <template v-if="row.isLive === 1">
            <el-button size="small" class="end-btn" @click="toggleLive(row, false)">结束直播</el-button>
            <el-button size="small" class="ghost-btn" @click="openEdit(row)">编辑</el-button>
          </template>
          <template v-else>
            <el-tooltip content="编辑" placement="top" :show-after="300">
              <button class="iconmini" @click="openEdit(row)"><IconEdit :size="15" /></button>
            </el-tooltip>
            <el-tooltip content="删除" placement="top" :show-after="300">
              <button class="iconmini danger" @click="remove(row)"><IconTrash :size="15" /></button>
            </el-tooltip>
          </template>
        </div>
      </div>
    </div>

    <div class="card-flush" v-else>
      <EmptyState variant="content" title="暂无节目" description="点击右上角「新建栏目」创建第一档节目" />
    </div>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      layout="total, prev, pager, next"
      class="pager"
      @current-change="fetch"
    />

    <!-- ══════════ 待处理：缺主持人的节目 ══════════ -->
    <div class="sec" v-if="noHost.length">
      <div class="sec-head">
        <span class="sec-title">待处理</span>
        <span class="micro">共 {{ noHost.length }} 条</span>
      </div>
      <div class="card-flush">
        <div class="crow" v-for="row in noHost" :key="'h' + row.id">
          <span class="av">!</span>
          <div class="grow">
            <div class="strong el">「{{ row.title }}」还没有主持人</div>
            <div class="micro" style="margin-top:3px">节目会在小程序「本周节目单」中显示为「主持人未定」</div>
          </div>
          <a class="link" @click="openEdit(row)">去分配</a>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="dialog" :title="form.id ? '编辑节目' : '新建栏目'" width="560px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="节目名" required><el-input v-model="form.title" /></el-form-item>
        <el-form-item label="主持人"><el-input v-model="form.host" placeholder="留空则小程序显示「主持人未定」" /></el-form-item>
        <el-form-item label="播出时间" required>
          <el-input v-model="form.broadcastTime" placeholder="如 周一 12:30-13:00" />
        </el-form-item>
        <el-form-item label="具体日期">
          <el-date-picker v-model="form.broadcastDate" type="date" value-format="YYYY-MM-DD" style="width:100%;" />
        </el-form-item>
        <el-form-item label="简介"><el-input v-model="form.desc" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="封面 URL"><el-input v-model="form.cover" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" /></el-form-item>
        <el-form-item label="是否展示">
          <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconSearch, IconPlus, IconEdit, IconTrash } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const query = reactive({ page: 1, pageSize: 20, keyword: '' });
const rows = ref([]);
const allRows = ref([]);
const total = ref(0);
const loading = ref(false);
const tab = ref(0); // 0 全部 1 直播中 2 已展示 3 已隐藏
const dialog = ref(false);
const form = reactive({ id: null, title: '', host: '', broadcastTime: '', broadcastDate: '', desc: '', cover: '', sort: 0, isShow: 1 });

const counts = reactive({ all: 0, live: 0, shown: 0, hidden: 0 });

/** 本周周一到周日 + 每天档数（按 broadcastDate 归日） */
const week = computed(() => {
  const today = dayjs().format('YYYY-MM-DD');
  const monday = dayjs().startOf('week').add(1, 'day'); // dayjs 周日起始，周一 = +1
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = monday.add(i, 'day');
    const date = d.format('YYYY-MM-DD');
    return {
      label: names[i],
      dayNum: d.date(),
      date,
      isToday: date === today,
      count: allRows.value.filter((r) => r.broadcastDate === date).length,
    };
  });
});

/** 缺主持人的节目（未隐藏的才算待处理） */
const noHost = computed(() => allRows.value.filter((r) => !r.host && r.isShow === 1));

async function fetch() {
  loading.value = true;
  try {
    const all = await http.get('/admin/program/list', { params: { page: 1, pageSize: 200 } });
    allRows.value = all.list || [];
    counts.all = all.total ?? allRows.value.length;
    counts.live = allRows.value.filter((r) => r.isLive === 1).length;
    counts.shown = allRows.value.filter((r) => r.isShow === 1 && r.isLive !== 1).length;
    counts.hidden = allRows.value.filter((r) => r.isShow !== 1).length;

    const d = await http.get('/admin/program/list', { params: query });
    let list = d.list || [];
    if (tab.value === 1) list = list.filter((r) => r.isLive === 1);
    if (tab.value === 2) list = list.filter((r) => r.isShow === 1 && r.isLive !== 1);
    if (tab.value === 3) list = list.filter((r) => r.isShow !== 1);
    rows.value = list;
    total.value = d.total ?? list.length;
  } finally { loading.value = false; }
}

function setTab(v) { tab.value = v; query.page = 1; fetch(); }
function search() { query.page = 1; fetch(); }

function openEdit(row) {
  if (row) Object.assign(form, row);
  else Object.assign(form, { id: null, title: '', host: '', broadcastTime: '', broadcastDate: '', desc: '', cover: '', sort: 0, isShow: 1 });
  dialog.value = true;
}

async function save() {
  if (!form.title.trim() || !form.broadcastTime.trim()) return ElMessage.warning('请填写节目名和播出时间');
  if (form.id) await http.put(`/admin/program/${form.id}`, form);
  else await http.post('/admin/program/create', form);
  ElMessage.success('已保存');
  dialog.value = false;
  fetch();
}

async function remove(row) {
  await ElMessageBox.confirm(`删除「${row.title}」？小程序节目单会同时移除。`, '删除节目', { type: 'warning', confirmButtonText: '删除' });
  await http.delete(`/admin/program/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

async function toggleLive(row, val) {
  await http.put(`/admin/program/${row.id}/live`, { isLive: val ? 1 : 0 });
  ElMessage.success(val ? '已设为正在直播' : '已结束直播');
  fetch();
}

onMounted(fetch);
</script>

<style scoped>
.program-page { display: flex; flex-direction: column; gap: 18px; }
.grow { flex: 1; min-width: 0; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowc { display: flex; align-items: center; gap: 8px; min-width: 0; }
.btn-icon { margin-right: 4px; vertical-align: -2px; }

/* ══════════ 本周 7 天条 ══════════ */
.weekstrip { display: flex; gap: 8px; }
.day {
  flex: 1; text-align: center; padding: 10px 0 9px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-card);
}
.day.on { background: var(--ink); border-color: var(--ink); }
.day .w { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.day .d { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); margin-top: 2px; }
.day .n { font-size: var(--fs-xs); color: var(--muted-2); margin-top: 1px; }
.day.on .w, .day.on .n { color: rgba(255, 255, 255, 0.72); }
.day.on .d { color: #fff; }

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

/* ══════════ 列表行（直播中＝深色卡） ══════════ */
.card-flush { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.crow { display: flex; align-items: center; gap: 14px; padding: 13px 20px; }
.crow + .crow { border-top: 1px solid var(--divider); }
.crow.dark { background: var(--tile); border-color: var(--tile); }
.time { width: 150px; flex: none; font-weight: 600; color: var(--ink); font-size: var(--fs-md); }
.time.sub { color: var(--muted); font-weight: 500; }
.strong { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.crow.dark .strong { color: #fff; }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.7; }
.crow.dark .micro { color: #ccc; }

.tag { display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); flex: none; }
.tag-live { background: var(--live); color: #fff; }
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
.end-btn.el-button { background: #fff !important; background-image: none !important; border: none !important; color: var(--accent) !important; font-weight: 600; border-radius: var(--r-pill); }
.ghost-btn.el-button,
.ghost-btn.el-button:hover { background: transparent !important; background-image: none !important; border: 1px solid var(--accent-dark) !important; color: var(--accent-dark) !important; border-radius: var(--r-pill); }

/* 待处理 */
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); }
.av {
  width: 32px; height: 32px; border-radius: 50%; flex: none;
  background: var(--red-bg); color: var(--red-fg);
  display: inline-flex; align-items: center; justify-content: center; font-weight: 600;
}
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; }
.link:hover { text-decoration: underline; }

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

.pager { margin-top: 4px; justify-content: flex-end; }
</style>
