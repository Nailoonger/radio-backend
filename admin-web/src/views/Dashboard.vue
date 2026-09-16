<template>
  <div>
    <!-- 统计卡：4 个分组，每组 2 张 -->
    <el-row :gutter="16">
      <el-col :span="6" v-for="g in groups" :key="g.title">
        <div class="stat-group">
          <div class="group-title">
            <span class="group-bar" :class="`bar-${g.tone}`"></span>
            {{ g.title }}
          </div>
          <div class="stat-pair">
            <div
              v-for="k in g.items"
              :key="k.label"
              class="stat-card"
            >
              <div class="stat-pill" :class="`pill-${g.tone}`">
                <component :is="k.icon" :size="18" />
              </div>
              <div class="stat-body">
                <template v-if="loading">
                  <div class="sk sk-label"></div>
                  <div class="sk sk-value"></div>
                </template>
                <template v-else>
                  <div class="stat-label">{{ k.label }}</div>
                  <div class="stat-value">{{ k.value }}</div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-card class="block">
      <template #header>
        <div class="card-head">
          <IconTrend :size="17" class="card-head-icon" />
          <span class="card-header">近 7 天投稿趋势</span>
        </div>
      </template>
      <div v-if="loading" class="chart-sk">
        <div class="sk sk-chart"></div>
      </div>
      <div v-show="!loading" ref="chartRef" class="chart-box"></div>
    </el-card>

    <el-row :gutter="16" class="block">
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-head">
              <IconTrophy :size="17" class="card-head-icon" />
              <span class="card-header">热门点歌 Top10</span>
            </div>
          </template>
          <el-table v-loading="loading" :data="topSongs" stripe size="small">
            <el-table-column label="#" type="index" width="56" align="center" />
            <el-table-column label="歌曲" prop="songName" min-width="160" show-overflow-tooltip />
            <el-table-column label="歌手" prop="singer" width="120" show-overflow-tooltip />
            <el-table-column label="点播次数" prop="count" width="100" align="right" />
            <template #empty>
              <EmptyState variant="content" title="暂无点歌数据" description="等小程序端有用户点歌后，这里会自动统计" />
            </template>
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>
            <div class="card-head">
              <IconInfo :size="17" class="card-head-icon" />
              <span class="card-header">系统信息</span>
            </div>
          </template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="后端地址">
              <span class="mono">{{ baseURL }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="登录身份">
              {{ auth.admin?.nickname }}（{{ auth.admin?.role === 0 ? '超管' : '社员' }}）
            </el-descriptions-item>
            <el-descriptions-item label="上次登录">{{ auth.admin?.lastLoginAt || '首次' }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';
import * as echarts from 'echarts';
import {
  IconArticle, IconSpark, IconClock, IconChat,
  IconMic, IconMegaphone, IconUsers, IconUserPlus,
  IconTrend, IconTrophy, IconInfo,
} from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';

const auth = useAuthStore();
const baseURL = import.meta.env.VITE_API_BASE;
const loading = ref(true);
const overview = ref({});
const trend = ref([]);
const topSongs = ref([]);
const chartRef = ref(null);
let chart = null;

const cards = computed(() => {
  const s = overview.value.submit || {};
  const m = overview.value.message || {};
  const c = overview.value.content || {};
  const u = overview.value.user || {};
  return {
    submitTotal: s.total ?? 0,
    submitPending: s.pending ?? 0,
    submitApproved: s.approved ?? 0,
    submitToday: s.today ?? 0,
    messageTotal: m.total ?? 0,
    messagePending: m.pending ?? 0,
    programTotal: c.program ?? 0,
    noticeTotal: c.notice ?? 0,
    userTotal: u.total ?? 0,
    userToday: u.today ?? 0,
  };
});

// 4 个分组：投稿 / 互动 / 内容 / 用户
const groups = computed(() => [
  {
    title: '投稿数据',
    tone: 'cyan',
    items: [
      { label: '投稿总数', value: cards.value.submitTotal, icon: IconArticle },
      { label: '今日新增', value: cards.value.submitToday, icon: IconSpark },
    ],
  },
  {
    title: '审核任务',
    tone: 'amber',
    items: [
      { label: '投稿待审', value: cards.value.submitPending, icon: IconClock },
      { label: '留言待审', value: cards.value.messagePending, icon: IconChat },
    ],
  },
  {
    title: '内容运营',
    tone: 'blue',
    items: [
      { label: '节目数', value: cards.value.programTotal, icon: IconMic },
      { label: '公告数', value: cards.value.noticeTotal, icon: IconMegaphone },
    ],
  },
  {
    title: '用户活跃',
    tone: 'emerald',
    items: [
      { label: '注册用户', value: cards.value.userTotal, icon: IconUsers },
      { label: '今日注册', value: cards.value.userToday, icon: IconUserPlus },
    ],
  },
]);

async function load() {
  loading.value = true;
  try {
    const [ov, tr, ts] = await Promise.all([
      http.get('/admin/stats/overview'),
      http.get('/admin/stats/submit-trend', { params: { days: 7 } }),
      http.get('/admin/stats/top-songs'),
    ]);
    overview.value = ov;
    trend.value = tr.list || [];
    topSongs.value = ts.list || [];
    await nextTick();
    renderChart();
  } finally { loading.value = false; }
}

function renderChart() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['全部', '点歌', '文稿'], top: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: '#64748b' } },
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trend.value.map(t => t.date.slice(5)), axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#94a3b8' }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { color: '#94a3b8' } },
    series: [
      {
        name: '全部', type: 'line', smooth: true,
        data: trend.value.map(t => t.count),
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(6, 182, 212, 0.22)' },
          { offset: 1, color: 'rgba(6, 182, 212, 0.01)' },
        ])},
        lineStyle: { color: '#06b6d4', width: 3 },
        itemStyle: { color: '#06b6d4' },
      },
      {
        name: '点歌', type: 'line', smooth: true,
        data: trend.value.map(t => t.song),
        lineStyle: { color: '#3b82f6', width: 2 },
        itemStyle: { color: '#3b82f6' },
      },
      {
        name: '文稿', type: 'line', smooth: true,
        data: trend.value.map(t => t.article),
        lineStyle: { color: '#6366f1', width: 2 },
        itemStyle: { color: '#6366f1' },
      },
    ],
  });
}

function onResize() { chart?.resize(); }

onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.block { margin-top: 20px; }

/* ---------- 分组标题 ---------- */
.stat-group { margin-bottom: 8px; }
.group-title {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 10px;
  letter-spacing: 0.3px;
}
.group-bar {
  display: inline-block;
  width: 4px;
  height: 14px;
  border-radius: 2px;
  margin-right: 8px;
}
.bar-cyan { background: linear-gradient(180deg, #22d3ee, #0891b2); }
.bar-amber { background: linear-gradient(180deg, #fbbf24, #d97706); }
.bar-blue { background: linear-gradient(180deg, #60a5fa, #2563eb); }
.bar-emerald { background: linear-gradient(180deg, #34d399, #059669); }

.stat-pair { display: flex; gap: 10px; }

/* ---------- 统计卡：白底 + 彩色图标胶囊 ---------- */
.stat-card {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 76px;
  padding: 14px 14px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #e8edf5;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}
.stat-card:hover {
  transform: translateY(-2px);
  border-color: #dbe4f0;
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
}
.stat-pill {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.pill-cyan { background: linear-gradient(135deg, #06b6d4, #0891b2); box-shadow: 0 3px 8px rgba(6, 182, 212, 0.28); }
.pill-amber { background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 3px 8px rgba(245, 158, 11, 0.28); }
.pill-blue { background: linear-gradient(135deg, #3b82f6, #2563eb); box-shadow: 0 3px 8px rgba(59, 130, 246, 0.28); }
.pill-emerald { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 3px 8px rgba(16, 185, 129, 0.28); }

.stat-body { flex: 1; min-width: 0; }
.stat-label {
  font-size: 12px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: #0f172a;
  margin-top: 3px;
  line-height: 1.1;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
}

/* ---------- 卡片标题 ---------- */
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-head-icon { color: #64748b; flex-shrink: 0; }
.card-header {
  font-weight: 600;
  color: #0f172a;
  font-size: 14px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  color: #334155;
}

/* ---------- 骨架屏 ---------- */
.chart-box { height: 280px; }
.chart-sk { height: 280px; display: flex; align-items: flex-end; }
.sk {
  border-radius: 6px;
  background: linear-gradient(90deg, #eef2f7 25%, #f6f9fc 37%, #eef2f7 63%);
  background-size: 400% 100%;
  animation: sk-shine 1.4s ease infinite;
}
.sk-label { width: 56px; height: 10px; }
.sk-value { width: 44px; height: 20px; margin-top: 8px; }
.sk-chart { width: 100%; height: 100%; border-radius: 8px; }
@keyframes sk-shine {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}
</style>
