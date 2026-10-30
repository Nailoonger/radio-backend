<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ onCount }}</b><span>条硬约束生效中</span></div>
      <div class="pv-stat-s">
        生成班表时<b>硬约束优先</b>：到上限的人不再进候选池，宁可留缺岗也不硬凑。<br />
        只有超级管理员能改。
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note" v-if="!err && !isSuper">你在看的是当前规则。改规则需要超级管理员账号。</div>

    <div class="pv-h">两条约束<span class="pv-h-s">值域 1 ~ 14 场</span></div>

    <div class="pv-card pad">
      <div class="pv-kv" v-for="(it, i) in items" :key="it.key">
        <span class="k">{{ it.name }}</span>
        <span class="v">
          <label class="pv-sw">
            <input type="checkbox" v-model="it.on" :disabled="!isSuper" />
            <span>启用</span>
          </label>
        </span>
        <span class="v" style="flex: none; width: 132px;">
          <input
            class="pv-inp sm num" type="number" min="1" max="14"
            v-model.number="it.value" :disabled="!isSuper || !it.on"
          />
        </span>
        <span class="pv-micro">{{ it.unit }}</span>
      </div>
    </div>

    <div class="pv-note" v-if="!err">
      「每天最多场次」按<b>同一天</b>算；「每周最多场次」按<b>同一周（周一到周五）</b>算。<br />
      关掉某条 = 这一条不限制（等于 99 场）。生成时如果凑不齐，班表上会留<b>缺岗</b>，不会硬塞人。
    </div>

    <div class="pv-btnrow">
      <button class="pv-btn ghost" :disabled="!isSuper" @click="load">重新读取</button>
      <button class="pv-btn primary" :disabled="!isSuper || saving" @click="save">{{ saving ? '保存中…' : '保存规则' }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const isSuper = computed(() => !!auth.isSuperAdmin);

const err = ref('');
const loadError = ref('');
const items = ref([]);
const saving = ref(false);

const onCount = computed(() => items.value.filter((x) => x.on).length);

async function load() {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/rules');
    items.value = (d.items || d.defaults || []).map((x) => ({
      key: x.key, name: x.name, value: Number(x.value) || 1, on: x.on !== false, unit: x.unit || '场',
    }));
  } catch (e) {
    loadError.value = `排班规则读取失败：${e.message || '请重试'}`;
  }
}

async function save() {
  const bad = items.value.find((x) => !Number.isInteger(x.value) || x.value < 1 || x.value > 14);
  if (bad) {
    ElMessage.warning(`${bad.name}需在 1 ~ 14 之间`);
    return;
  }
  saving.value = true;
  try {
    const d = await http.put('/partner/rules', { items: items.value });
    items.value = (d.items || items.value).map((x) => ({
      key: x.key, name: x.name, value: Number(x.value) || 1, on: x.on !== false, unit: x.unit || '场',
    }));
    ElMessage.success('规则已保存，下次生成班表生效');
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.pv-inp.num { width: 92px; padding: 0 10px; }
</style>
