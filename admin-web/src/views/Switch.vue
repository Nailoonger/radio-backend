<template>
  <div>
    <el-alert
      type="info"
      :closable="false"
      title="模块开关"
      description="关闭某个模块后，小程序端入口仍可见，但点击 / 提交时会提示「该模块暂时关闭」。读取接口（列表/详情）不受影响。"
      class="page-alert"
    />

    <el-row :gutter="16">
      <el-col :span="12" v-for="s in switches" :key="s.key">
        <el-card class="switch-card" :class="`tone-${s.tone}`" v-loading="loading">
          <div class="switch-head">
            <div class="switch-pill" :class="`pill-${s.tone}`">
              <component :is="s.icon" :size="19" />
            </div>
            <div class="switch-meta">
              <div class="switch-name">{{ s.desc }}</div>
              <div class="switch-key">{{ s.key }}</div>
            </div>
            <el-switch
              v-model="s.value"
              active-value="on"
              inactive-value="off"
              :loading="s.saving"
              @change="(v) => toggle(s, v)"
              size="large"
            />
          </div>
          <div class="switch-foot">
            <StatusTag :status="s.value === 'on' ? 1 : 2" :label="s.value === 'on' ? '已启用' : '已关闭'" />
            <span class="switch-time" v-if="s.updatedAt">
              最近更新：{{ fmtTime(s.updatedAt) }}
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconMusic, IconArticle, IconChat, IconStar, IconSettings } from '@/components/icons';
import StatusTag from '@/components/StatusTag.vue';

// 4 个模块的展示元数据（key / 描述 / 图标 / 配色）
const META = {
  submit_song:    { desc: '点歌投稿', icon: IconMusic, tone: 'cyan' },
  submit_article: { desc: '文稿投稿', icon: IconArticle, tone: 'blue' },
  message:        { desc: '节目留言', icon: IconChat, tone: 'amber' },
  member:         { desc: '风采展示', icon: IconStar, tone: 'emerald' },
};

const switches = ref([]);
const loading = ref(true);

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/switch/list');
    switches.value = data.list.map((row) => ({
      ...row,
      ...(META[row.key] || { desc: row.key, icon: IconSettings, tone: 'cyan' }),
      saving: false,
    }));
  } finally {
    loading.value = false;
  }
}

async function toggle(s, val) {
  s.saving = true;
  try {
    const data = await http.put(`/admin/switch/${s.key}`, { value: val });
    s.value = data.value;
    s.updatedAt = data.updatedAt;
    ElMessage.success(`${s.desc} 已${val === 'on' ? '启用' : '关闭'}`);
  } catch {
    // 失败回滚
    s.value = val === 'on' ? 'off' : 'on';
  } finally {
    s.saving = false;
  }
}

function fmtTime(t) { return dayjs(t).format('YYYY-MM-DD HH:mm'); }

onMounted(fetch);
</script>

<style scoped>
.page-alert { margin-bottom: 20px; }

.switch-card {
  position: relative;
  overflow: hidden;
  margin-bottom: 16px;
  transition: transform 0.2s, box-shadow 0.2s;
}
.switch-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08) !important;
}
.switch-card::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 4px;
}
.switch-card.tone-cyan::before { background: linear-gradient(180deg, #06b6d4, #0891b2); }
.switch-card.tone-blue::before { background: linear-gradient(180deg, #3b82f6, #2563eb); }
.switch-card.tone-amber::before { background: linear-gradient(180deg, #f59e0b, #d97706); }
.switch-card.tone-emerald::before { background: linear-gradient(180deg, #10b981, #059669); }

.switch-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.switch-pill {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.pill-cyan { background: linear-gradient(135deg, #06b6d4, #0891b2); box-shadow: 0 3px 8px rgba(6, 182, 212, 0.3); }
.pill-blue { background: linear-gradient(135deg, #3b82f6, #2563eb); box-shadow: 0 3px 8px rgba(59, 130, 246, 0.3); }
.pill-amber { background: linear-gradient(135deg, #f59e0b, #d97706); box-shadow: 0 3px 8px rgba(245, 158, 11, 0.3); }
.pill-emerald { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 3px 8px rgba(16, 185, 129, 0.3); }

.switch-meta {
  flex: 1;
  min-width: 0;
}
.switch-name {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
}
.switch-key {
  font-size: 12px;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  margin-top: 3px;
}
.switch-foot {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}
.switch-time {
  font-size: 12px;
  color: #94a3b8;
}
</style>
