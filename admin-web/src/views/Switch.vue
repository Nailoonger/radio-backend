<template>
  <div class="switch-page">
    <!-- ══════════ 功能模块 ══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">功能模块</span>
        <span class="rowc gap8">
          <span class="tag tag-mute">仅超管可改</span>
          <span class="micro">{{ switches.length }} 个模块 · 当前开启 {{ onCount }} 个</span>
        </span>
      </div>

      <div class="card-flush" v-loading="loading">
        <div class="crow" v-for="s in switches" :key="s.key">
          <span class="modico"><component :is="s.icon" :size="17" /></span>
          <div class="grow">
            <div class="strong">{{ s.desc }}</div>
            <div class="micro">对应 {{ s.key }} · {{ s.hint }}</div>
          </div>
          <span class="tag" :class="s.value === 'on' ? 'tag-pass' : 'tag-reject'">
            {{ s.value === 'on' ? '开启中' : '已关闭' }}
          </span>
          <el-switch
            v-model="s.value"
            active-value="on"
            inactive-value="off"
            :loading="s.saving"
            class="sw"
            @change="(v) => toggle(s, v)"
          />
        </div>
      </div>
    </div>

    <!-- ══════════ 开关口径（后端真实行为，与 switchService 一致） ══════════ -->
    <div class="cols">
      <div class="sec wide">
        <div class="sec-head"><span class="sec-title">开关口径</span></div>
        <div class="card tight">
          <div class="kv"><span class="k">生效范围</span><span>只拦截写入接口（投稿 / 留言）</span></div>
          <div class="kv"><span class="k">读取接口</span><span>不受影响，学生仍能看到历史内容</span></div>
          <div class="kv"><span class="k">关闭后表现</span><span>写入返回 <span class="mono">40302 MODULE_DISABLED</span></span></div>
          <div class="kv"><span class="k">缓存时间</span><span class="num">30 秒</span></div>
          <div class="kv"><span class="k">最近修改</span><span class="num">{{ lastModified || '—' }}</span></div>
        </div>
        <p class="state-note">
          后端没有开关操作日志表（system_switch 只存「最后一次是谁改的」），
          所以这里只显示最近一次修改；改动都会写后台操作日志。
        </p>
      </div>

      <div class="sec">
        <div class="sec-head"><span class="sec-title">改前想一下</span></div>
        <div class="card tight">
          <div class="micro tip">
            关「点歌投稿 / 文稿投稿」会直接影响当天名额使用——已提交的不受影响，只是不能再投。<br />
            关「节目留言 / 风采展示」属于整块下线，小程序入口仍在，但内容不可新增 / 显示维护中。<br />
            开关改动<b>立即生效</b>（服务端 30 秒缓存），不需要重启、不需要发版。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconMusic, IconArticle, IconChat, IconStar, IconSettings } from '@/components/icons';

// 4 个模块的展示元数据（key / 名称 / 小程序端表现 / 图标），顺序即展示顺序
const META = [
  { key: 'submit_song',    desc: '点歌投稿', hint: '小程序「投稿」页点歌分段',        icon: IconMusic },
  { key: 'submit_article', desc: '文稿投稿', hint: '小程序「投稿」页文稿分段',        icon: IconArticle },
  { key: 'message',        desc: '节目留言', hint: '关闭后节目详情页留言框隐藏',      icon: IconChat },
  { key: 'member',         desc: '风采展示', hint: '关闭后小程序「风采」tab 显示维护中', icon: IconStar },
];

const switches = ref([]);
const loading = ref(true);
const onCount = computed(() => switches.value.filter((s) => s.value === 'on').length);
const lastModified = computed(() => {
  const withTime = switches.value.filter((s) => s.updatedAt);
  if (!withTime.length) return '—';
  const last = withTime.reduce((a, b) => (String(b.updatedAt) > String(a.updatedAt) ? b : a));
  const who = last.updatedBy ? ` · ${last.updatedBy}` : '';
  return `${dayjs(last.updatedAt).format('YYYY-MM-DD HH:mm')}${who}`;
});

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/switch/list');
    const byKey = new Map((data.list || []).map((r) => [r.key, r]));
    switches.value = META.map((m) => ({
      ...m,
      value: byKey.get(m.key)?.value || 'off',
      updatedAt: byKey.get(m.key)?.updateTime || '',
      updatedBy: byKey.get(m.key)?.updatedByName || '',
      saving: false,
    })).concat(
      // 后端注册了但展示元数据没覆盖的开关（兜底，不丢功能）
      (data.list || [])
        .filter((r) => !META.some((m) => m.key === r.key))
        .map((r) => ({ key: r.key, desc: r.desc || r.key, hint: '系统开关', icon: IconSettings, value: r.value, updatedAt: r.updateTime || '', updatedBy: r.updatedByName || '', saving: false })),
    );
  } finally { loading.value = false; }
}

async function toggle(s, val) {
  s.saving = true;
  try {
    const data = await http.put(`/admin/switch/${s.key}`, { value: val });
    s.value = data.value;
    s.updatedAt = data.updatedAt || dayjs().format();
    s.updatedBy = data.updatedBy || '';
    ElMessage.success(`${s.desc} 已${val === 'on' ? '启用' : '关闭'}，立即生效`);
  } catch {
    s.value = val === 'on' ? 'off' : 'on'; // 失败回滚
  } finally { s.saving = false; }
}

onMounted(fetch);
</script>

<style scoped>
.switch-page { display: flex; flex-direction: column; gap: 20px; }
.rowc { display: flex; align-items: center; }
.gap8 { gap: 8px; }
.grow { flex: 1; min-width: 0; }

.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); }

.card-flush { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.crow {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 20px;
}
.crow + .crow { border-top: 1px solid var(--divider); }
.strong { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.7; }

.modico {
  width: 34px; height: 34px; flex: none;
  border-radius: 50%; background: var(--parchment);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-2);
}

/* 标签：开启＝绿，关闭＝红（关闭态用红标签而非红卡片，避免整行发红） */
.tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px;
  border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm);
  flex: none;
}
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-reject { background: var(--red-bg); color: var(--red-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }

/* 开关 ON＝强调色（唯一允许着色的控件） */
.sw :deep(.el-switch__core) { border-radius: var(--r-pill); }
.sw.el-switch.is-checked :deep(.el-switch__core) { background: var(--accent); border-color: var(--accent); }

.cols { display: flex; gap: 18px; align-items: stretch; }
.cols > * { min-width: 0; flex: 1; }
.sec.wide { flex: 1.1; }
.card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); }
.card.tight { padding: 8px 20px; }
.kv {
  display: flex; align-items: baseline; font-size: var(--fs-md); line-height: 1.6;
  padding: 9px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.kv:last-child { border-bottom: none; }
.kv .k { width: 96px; flex: none; color: var(--muted); font-size: var(--fs-sm); }
.mono { font-family: var(--mono); font-size: var(--fs-sm); color: var(--ink-2); }
.num { font-variant-numeric: tabular-nums; }

.state-note { font-size: var(--fs-xs); color: var(--muted); line-height: 1.8; margin: 0 2px; }
.tip b { color: var(--ink-2); }
</style>
