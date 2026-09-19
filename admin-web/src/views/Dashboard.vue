<template>
  <div class="dash">
    <!-- ══════════ 深色 hero：正在直播（v8 数据概览主卡） ══════════ -->
    <!-- 三种状态：有直播（红点主态）/ 无直播（灰点降级，正文换下一档）/ 一档节目都没有（引导卡） -->
    <div class="tile" v-if="!loading && hasProgram">
      <div class="rowc" style="gap:26px;align-items:center;flex-wrap:wrap">
        <div class="stack" style="flex:1;min-width:0;gap:13px">
          <div class="tile-status">
            <span class="dot" :class="live ? 'dot-live' : 'dot-idle'"></span>
            {{ live ? `正在直播 · ${live.timeRange || ''}` : '今天没有直播安排' }}
          </div>
          <div class="tile-title">{{ live ? live.title : '下一档：见节目单' }}</div>
          <div class="tile-meta">
            {{ live ? `${live.host || '主持人待定'}${live.program ? ' · ' + live.program : ''}` : '可在「栏目管理」里排期下一档节目' }}
          </div>
          <div class="tile-actions">
            <button class="btn btn-white btn-sm" @click="go('/program')">查看节目</button>
            <button class="btn btn-ghost btn-sm" @click="go('/program')">排期管理</button>
          </div>
        </div>
        <div class="rowc" style="gap:0;flex-wrap:wrap">
          <div class="tile-metric">
            <div class="k">今日投稿</div>
            <div class="v num">{{ n(ov.submit?.today) }}</div>
            <div class="d">待审 {{ n(ov.submit?.pending) }}</div>
          </div>
          <div class="tile-metric">
            <div class="k">待审核</div>
            <div class="v num">{{ n(ov.submit?.pending) + n(ov.message?.pending) }}</div>
            <div class="d">投稿 {{ n(ov.submit?.pending) }} · 留言 {{ n(ov.message?.pending) }}</div>
          </div>
          <div class="tile-metric">
            <div class="k">今日新增用户</div>
            <div class="v num">{{ n(ov.user?.today) }}</div>
            <div class="d">累计 {{ n(ov.user?.total) }} 人</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 一档节目都没有（新站点）：不空着，换引导卡 -->
    <div class="tile" v-else-if="!loading">
      <div class="stack" style="gap:13px">
        <div class="tile-status"><span class="dot dot-idle"></span>还没有节目安排</div>
        <div class="tile-title">从第一档节目开始</div>
        <div class="tile-meta">到「栏目管理」新建节目并排期，这里就会显示正在直播 / 下一档</div>
        <div class="tile-actions">
          <button class="btn btn-white btn-sm" @click="go('/program')">新建第一档节目</button>
        </div>
      </div>
    </div>

    <!-- hero 骨架（深色卡内的 on-dark 骨架） -->
    <div class="tile" v-else>
      <div class="stack" style="width:100%;gap:13px">
        <span class="sk on-dark sk-cap" style="width:24%"></span>
        <span class="sk on-dark" style="height:26px;width:38%"></span>
        <span class="sk on-dark sk-cap" style="width:44%"></span>
        <div class="rowc" style="gap:10px;margin-top:4px">
          <span class="sk on-dark sk-btn" style="width:104px"></span>
          <span class="sk on-dark sk-btn" style="width:104px"></span>
        </div>
      </div>
    </div>

    <!-- ══════════ 今日数据（v8：4 张羊皮纸 KPI） ══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">今日数据</span>
        <a class="link" @click="go('/submit')">查看完整报表</a>
      </div>
      <div class="kpis">
        <div class="kpi" v-for="k in kpis" :key="k.k">
          <template v-if="!loading">
            <div class="k">{{ k.k }}</div>
            <div class="v num">{{ k.v }}</div>
            <div class="d"><span class="kpi-accentdot" v-if="k.dot"></span>{{ k.d }}</div>
          </template>
          <div class="sk-block" v-else>
            <span class="sk sk-cap" style="width:52%"></span>
            <span class="sk" style="height:30px;width:60%"></span>
            <span class="sk sk-cap" style="width:44%"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 近 7 天投稿趋势 ══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">近 7 天投稿趋势</span>
        <div class="legend">
          <span><i style="background:var(--accent)"></i>全部</span>
          <span><i style="background:#7a7a7a"></i>点歌</span>
          <span><i style="background:#c7c7cc"></i>文稿</span>
        </div>
      </div>
      <div class="card chart-card">
        <!-- 图表骨架：v8 统计卡+图表骨架（一排高矮不一的柱） -->
        <div class="sk-chart" v-if="loading">
          <i style="height:42%"></i><i style="height:68%"></i><i style="height:54%"></i>
          <i style="height:82%"></i><i style="height:60%"></i><i style="height:92%"></i><i style="height:74%"></i>
        </div>
        <div v-show="!loading" ref="chartRef" class="chart-box"></div>
      </div>
    </div>

    <!-- ══════════ Top 5 + 系统信息（双栏） ══════════ -->
    <div class="cols">
      <div class="sec" style="flex:1.1">
        <div class="sec-head">
          <span class="sec-title">热门点歌 Top 5</span>
          <a class="link" @click="go('/submit')">全部 {{ n(ov.submit?.total) }} 条</a>
        </div>
        <div class="card-flush">
          <template v-if="!loading">
            <div class="crow" v-for="(t, i) in top5" :key="t.songName">
              <span class="rank num">{{ i + 1 }}</span>
              <span class="grow strong el">{{ t.songName }}</span>
              <span class="sub el">{{ t.singer }}</span>
              <span class="num micro cnt">{{ t.count }} 次</span>
            </div>
            <div class="crow" v-if="!top5.length">
              <span class="micro">暂无点歌数据 · 等小程序端有用户点歌后自动统计</span>
            </div>
          </template>
          <template v-else>
            <div class="sk-row" v-for="i in 5" :key="i">
              <span class="sk" style="width:20px;height:14px"></span>
              <span class="sk sk-title" style="width:38%"></span>
              <span class="sk sk-text" style="width:22%"></span>
              <span class="sk sk-tag" style="width:52px;margin-left:auto"></span>
            </div>
          </template>
        </div>
      </div>

      <div class="sec" style="flex:1">
        <div class="sec-head"><span class="sec-title">系统信息</span></div>
        <div class="card kv-card">
          <div class="kv"><span class="k">后端地址</span><span class="mono">{{ baseURL }}</span></div>
          <div class="kv">
            <span class="k">登录身份</span>
            <span>{{ auth.admin?.nickname || auth.admin?.username }}（{{ auth.isSuperAdmin ? '超管' : '社员' }}）</span>
          </div>
          <div class="kv"><span class="k">上次登录</span><span class="num">{{ auth.admin?.lastLoginAt || '首次登录' }}</span></div>
          <div class="kv">
            <span class="k">模块状态</span>
            <span class="rowc gap8">
              <span class="tag" :class="switchOn('submit_song') ? 'tag-pass' : 'tag-mute'">点歌{{ switchOn('submit_song') ? '开启' : '关闭' }}</span>
              <span class="tag" :class="switchOn('submit_article') ? 'tag-pass' : 'tag-mute'">文稿{{ switchOn('submit_article') ? '开启' : '关闭' }}</span>
              <span class="tag" :class="switchOn('message') ? 'tag-pass' : 'tag-mute'">留言{{ switchOn('message') ? '开启' : '关闭' }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';
import * as echarts from 'echarts';

const auth = useAuthStore();
const router = useRouter();
const baseURL = import.meta.env.VITE_API_BASE;
const loading = ref(true);
const ov = ref({});
const trend = ref([]);
const topSongs = ref([]);
const live = ref(null);
const switches = ref({});
const chartRef = ref(null);
let chart = null;

const n = (v) => Number(v) || 0;
const hasProgram = computed(() => n(ov.value.content?.program) > 0);
const top5 = computed(() => (topSongs.value || []).slice(0, 5));

function switchOn(key) {
  const list = switches.value?.list || switches.value || [];
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((s) => s.key === key);
  return !hit || hit.value !== 'off'; // 缺行视为开（与 switchService 口径一致）
}

const kpis = computed(() => {
  const s = ov.value.submit || {};
  const m = ov.value.message || {};
  return [
    { k: '投稿总数', v: n(s.total), d: `今日新增 ${n(s.today)}` },
    { k: '今日投稿', v: n(s.today), d: `待审 ${n(s.pending)} 条还在排队`, dot: n(s.pending) > 0 },
    { k: '待审投稿', v: n(s.pending), d: '含点歌与文稿，先到先审', dot: n(s.pending) > 0 },
    { k: '待审留言', v: n(m.pending), d: n(m.pending) > 0 ? '来自节目评论区' : '暂无待审', dot: n(m.pending) > 0 },
  ];
});

function go(path) { router.push(path); }

async function load() {
  loading.value = true;
  try {
    const [o, tr, ts, sw] = await Promise.all([
      http.get('/admin/stats/overview'),
      http.get('/admin/stats/submit-trend', { params: { days: 7 } }),
      http.get('/admin/stats/top-songs'),
      http.get('/admin/switch/list').catch(() => ({})),
    ]);
    ov.value = o || {};
    trend.value = tr.list || [];
    topSongs.value = ts.list || [];
    switches.value = sw || {};
    // 正在直播（小程序端同源数据）；拿不到就保持安静，不影响其它卡
    http.get('/user/program/current').then((p) => { live.value = p || null; }).catch(() => {});
  } finally {
    // ⚠️ 先撤骨架再画图：容器还处于 v-show 隐藏时初始化 echarts 会得到 0 尺寸（画出来是空白）
    loading.value = false;
    await nextTick();
    renderChart();
  }
}

function renderChart() {
  if (!chartRef.value) return;
  chart = echarts.init(chartRef.value);
  chart.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 16, bottom: 30 },
    xAxis: { type: 'category', data: trend.value.map(t => t.date.slice(5)), axisLine: { lineStyle: { color: '#e0e0e0' } }, axisLabel: { color: '#7a7a7a' }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#efeff1' } }, axisLabel: { color: '#7a7a7a' } },
    series: [
      {
        name: '全部', type: 'line', smooth: true,
        data: trend.value.map(t => t.count),
        // v8：唯一强调色给「全部」，其余退成中性灰；面积只用强调色的极淡填充
        areaStyle: { color: 'rgba(0, 102, 204, 0.08)' },
        lineStyle: { color: '#0066cc', width: 2.6 },
        itemStyle: { color: '#0066cc', borderColor: '#fff', borderWidth: 2 },
        symbolSize: 7,
      },
      {
        name: '点歌', type: 'line', smooth: true,
        data: trend.value.map(t => t.song),
        lineStyle: { color: '#7a7a7a', width: 2 },
        itemStyle: { color: '#7a7a7a' },
        symbol: 'none',
      },
      {
        name: '文稿', type: 'line', smooth: true,
        data: trend.value.map(t => t.article),
        lineStyle: { color: '#c7c7cc', width: 2 },
        itemStyle: { color: '#c7c7cc' },
        symbol: 'none',
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
.dash { display: flex; flex-direction: column; gap: 26px; }

/* ---------- 布局原子（v8 同名约定） ---------- */
.rowc { display: flex; align-items: center; }
.stack { display: flex; flex-direction: column; }
.gap8 { gap: 8px; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; min-width: 0; }
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.cols { display: flex; gap: 18px; align-items: flex-start; }
.cols > * { min-width: 0; }
.card { background: var(--parchment); border-radius: var(--r-card); }

/* ---------- 深色 hero ---------- */
.tile {
  background: var(--tile); color: #fff;
  border-radius: var(--r-tile); padding: 22px 24px;
  display: flex; flex-direction: column; gap: 13px;
}
.tile-status {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--fs-xs); font-weight: 500;
  color: #ccc; letter-spacing: var(--ls-wide-sm);
}
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot-live { background: var(--live); animation: livePulse 1.6s var(--ease) infinite; }
.dot-idle { background: #8e8e93; }
@keyframes livePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 69, 58, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(255, 69, 58, 0.12); }
}
@media (prefers-reduced-motion: reduce) { .dot-live { animation: none; } }
.tile-title { font-size: var(--fs-3xl); font-weight: 600; letter-spacing: var(--ls-tight); line-height: var(--lh-3xl); }
.tile-meta { font-size: var(--fs-sm); color: #ccc; letter-spacing: var(--ls-wide); }
.tile-actions { display: flex; gap: 8px; margin-top: 4px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 36px; padding: 0 18px; border-radius: var(--r-pill);
  font-size: var(--fs-md); font-weight: 500; line-height: 1;
  cursor: pointer; border: none; font-family: inherit; white-space: nowrap;
}
.btn-sm { height: 30px; padding: 0 14px; font-size: var(--fs-sm); }
.btn-white { background: #fff; color: var(--accent); font-weight: 600; }
.btn-ghost { background: transparent; color: var(--accent-dark); border: 1px solid var(--accent-dark); }
.btn-ghost:hover { background: rgba(41, 151, 255, 0.1); }
.tile-metric {
  padding-left: 26px; border-left: 1px solid rgba(255, 255, 255, 0.14);
  min-width: 118px;
}
.tile-metric .k { font-size: var(--fs-xs); color: #a1a1a6; letter-spacing: var(--ls-wide-sm); }
.tile-metric .v { font-size: var(--fs-num); font-weight: 600; line-height: var(--lh-num); margin-top: 3px; }
.tile-metric .d { font-size: var(--fs-xs); color: #8e8e93; margin-top: 2px; }

/* ---------- KPI（羊皮纸，无投影无图标） ---------- */
.kpis { display: flex; gap: 13px; flex-wrap: wrap; }
.kpi {
  flex: 1; min-width: 180px;
  background: var(--parchment); border-radius: var(--r-card);
  padding: 17px 18px; min-height: 96px;
}
.kpi .k { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.kpi .v { font-size: var(--fs-num); font-weight: 600; line-height: var(--lh-num); margin-top: 6px; color: var(--ink); letter-spacing: var(--ls-tight-sm); }
.kpi .d { font-size: var(--fs-xs); color: var(--muted); margin-top: 3px; letter-spacing: var(--ls-wide); }
.kpi-accentdot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: 1px; }

/* ---------- 图表卡 / 图例 ---------- */
.chart-card { padding: 18px 20px 8px; }
.chart-box { height: 280px; }
.legend { display: flex; gap: 18px; align-items: center; }
.legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.legend span { font-size: var(--fs-xs); color: var(--muted); }

/* ---------- Top5（card-flush 行） ---------- */
.card-flush { background: var(--parchment); border-radius: var(--r-card); padding: 6px 0; overflow: hidden; }
.crow { display: flex; align-items: center; gap: 13px; padding: 13px 20px; transition: background 0.16s; }
.crow + .crow { border-top: 1px solid rgba(0, 0, 0, 0.055); }
.crow:hover { background: rgba(255, 255, 255, 0.72); }
.rank { width: 20px; flex: none; color: var(--soft); font-weight: 600; }
.strong { font-weight: 600; color: var(--ink); font-size: var(--fs-md); }
.sub { font-size: var(--fs-sm); color: var(--muted); max-width: 40%; }
.cnt { width: 52px; text-align: right; flex: none; }

/* ---------- 系统信息（kv 行） ---------- */
.kv-card { padding: 8px 20px; }
.kv { display: flex; align-items: center; font-size: var(--fs-md); line-height: var(--lh-md); padding: 9px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.05); }
.kv:last-child { border-bottom: none; }
.kv .k { width: 88px; flex: none; color: var(--muted); font-size: var(--fs-sm); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--fs-sm); color: var(--ink-2); }
.num { font-variant-numeric: tabular-nums; }

/* ---------- 标签 ---------- */
.tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px;
  border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm);
}
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }

/* ---------- 加载骨架（v8：底色 --divider + 白色扫光，深色卡上换半透明白） ---------- */
.sk {
  position: relative; overflow: hidden; flex: none;
  border-radius: 6px; background: var(--divider); display: inline-block;
}
.sk::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: skSweep 1.4s var(--ease) infinite;
}
.sk.on-dark { background: rgba(255, 255, 255, 0.14); }
@keyframes skSweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .sk::after { animation: none; background: none; } }
.sk-cap { height: 10px; }
.sk-btn { height: 30px; border-radius: var(--r-pill); }
.sk-block { display: flex; flex-direction: column; gap: 11px; }
.sk-row { display: flex; align-items: center; gap: 13px; padding: 13px 20px; }
.sk-row + .sk-row { border-top: 1px solid rgba(0, 0, 0, 0.05); }
.sk-chart {
  display: flex; align-items: flex-end; gap: 10px;
  height: 280px; padding-top: 8px;
}
.sk-chart i { flex: 1; border-radius: 6px 6px 0 0; background: var(--divider); display: block; }
</style>
