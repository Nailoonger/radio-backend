<template>
  <SlideSheet
    v-model="inner"
    :title="`毕业清理 · ${info?.name || (grade + ' 级')}`"
    :subtitle="info ? `试算已完成 · 共 ${info.total} 个账号 · 这一步之后不可撤销` : '读取试算中…'"
    width="720"
  >
    <template v-if="info">
      <div class="pg-stats">
        <div class="pg-stat pg-stat--danger">
          <span class="num">{{ info.canDelete }}</span><em>将删除</em><i>没有投稿记录</i>
        </div>
        <div class="pg-stat">
          <span class="num">{{ info.withSubmit }}</span><em>将停用</em><i>有投稿记录，保留记录</i>
        </div>
        <div class="pg-stat">
          <span class="num">{{ info.classCount }}</span><em>涉及班级</em><i>整届 {{ info.total }} 个账号</i>
        </div>
      </div>

      <div class="pg-rows">
        <div class="dr"><span class="dr-k">删除</span><span class="dr-v">{{ info.canDelete }} 个账号从库里彻底移除：账号、密码、登录次数、最近登录时间一起没。这 {{ info.canDelete }} 人再也登不进来。</span></div>
        <div class="dr"><span class="dr-k">停用</span><span class="dr-v">{{ info.withSubmit }} 个账号改为「停用」。他们的投稿记录还在账号上，审核列表里能看到，不会变成一串指向空账号的记录。</span></div>
        <div class="dr"><span class="dr-k">登录态</span><span class="dr-v">执行后立即失效，学生手里的 token 下一次请求就被踢，不用等 30 秒缓存。</span></div>
        <div class="dr"><span class="dr-k">建议</span><span class="dr-v">先点「导出本届 xlsx」留一份名单再清理。已改密的学生导不出密码（哈希不可逆），这是正常的。</span></div>
      </div>

      <!-- 模式 -->
      <div class="pg-sec">选一种做法</div>
      <div class="pg-modes">
        <button
          v-for="m in MODES" :key="m.k" type="button"
          class="pg-mode" :class="{ on: mode === m.k }"
          @click="mode = m.k"
        >
          <span class="pm-n">{{ m.name }}</span>
          <span class="pm-d">{{ m.desc }}</span>
        </button>
      </div>

      <div v-if="mode === 'safe'" class="pg-warn">
        ⚠️ 如果只是想让他们登不进来、档案还没整理完，选上面「只停用，不删除」—— 那个动作以后还能撤回。
      </div>
      <div v-if="mode === 'purge'" class="pg-warn pg-warn--hard">
        ⚠️ 这一版会把有投稿记录的 {{ info.withSubmit }} 个账号也一起删掉。后台审核列表里对应的投稿还在，
        但作者会显示成「已注销账号」—— 投稿内容不去，归属没了。
      </div>

      <div v-if="mode === 'purge'" class="pg-confirm">
        <div class="pi-label">请输入年级「{{ info.grade }}」以确认</div>
        <input
          v-model="purgeConfirm"
          class="pg-input"
          :placeholder="String(info.grade)"
          spellcheck="false"
        />
        <div class="micro">输入不一致时下面的按钮保持不可点</div>
      </div>
    </template>

    <template #footer>
      <span class="micro">由 {{ operator }} 执行 · 会写入操作日志</span>
      <el-button class="ml" @click="inner = false">取消</el-button>
      <el-button
        :type="mode === 'purge' ? 'danger' : 'primary'"
        :disabled="armed === false"
        :loading="busy"
        @click="run"
      >{{ runText }}</el-button>
    </template>
  </SlideSheet>
</template>

<script setup>
/**
 * 毕业清理（页内弹层）
 *
 * 只清理**已经毕业的那一届**，所以必须先在筛选条件里选定年级才会出现入口。
 * 三种模式与后端一致：safe（无投稿真删、有投稿转停用）/ disable（只停用）/ purge（全删，需手打年级）。
 */
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import SlideSheet from '@/components/SlideSheet.vue';
import { useAuthStore } from '@/stores/auth';
import http from '@/utils/http';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  grade: { type: [String, Number], default: '' },
});
const emit = defineEmits(['update:modelValue', 'done']);

const auth = useAuthStore();
const operator = computed(() => auth.admin?.nickname || auth.admin?.username || '管理员');

const inner = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const MODES = [
  { k: 'safe', name: '按规则清理', desc: '没有投稿记录的真删；有投稿记录的改为停用（默认）' },
  { k: 'disable', name: '只停用，不删除', desc: '整届都不删，只把登录关掉；以后还能撤回' },
  { k: 'purge', name: '连投稿记录一起删', desc: '整届全部移除，需手打年级二次确认，不可撤销' },
];

const info = ref(null);
const mode = ref('safe');
const purgeConfirm = ref('');
const busy = ref(false);

const armed = computed(() => {
  if (!info.value) return false;
  if (mode.value !== 'purge') return true;
  return purgeConfirm.value.trim() === String(info.value.grade);
});

const runText = computed(() => {
  const n = info.value?.total || 0;
  if (mode.value === 'disable') return `只停用 ${n} 个账号`;
  if (mode.value === 'purge') return `确认删除 ${n} 个账号`;
  return `删除 ${info.value?.canDelete || 0} 个账号`;
});

async function load() {
  info.value = null;
  mode.value = 'safe';
  purgeConfirm.value = '';
  if (!props.grade) return;
  try {
    info.value = await http.get(`/admin/student/grade/${props.grade}`);
  } catch (e) {
    ElMessage.error(e?.message || '试算失败');
  }
}

async function run() {
  if (!info.value || armed.value === false) return;
  busy.value = true;
  try {
    const payload = mode.value === 'purge'
      ? { mode: 'purge', confirm: purgeConfirm.value.trim() }
      : { mode: mode.value };
    const d = await http.delete(`/admin/student/grade/${info.value.grade}`, { data: payload });
    ElMessage.success(
      mode.value === 'disable'
        ? `已停用 ${d.disabled} 个账号`
        : `已删除 ${d.deleted} 个账号${d.disabled ? `，停用 ${d.disabled} 个` : ''}`
    );
    inner.value = false;
    emit('done', d);
  } catch (e) {
    ElMessage.error(e?.message || '清理失败');
  } finally {
    busy.value = false;
  }
}

watch(inner, (v) => { if (v) load(); });
</script>

<style scoped>
.pg-stats { display: flex; gap: 12px; margin-bottom: 16px; }
.pg-stat {
  flex: 1; min-width: 0;
  padding: 14px 16px; border-radius: 16px;
  background: var(--parchment);
  display: flex; flex-direction: column; gap: 3px;
}
.pg-stat--danger { background: var(--tile); }
.pg-stat span { font-size: var(--fs-3xl); font-weight: 600; line-height: 1; letter-spacing: var(--ls-tight); }
.pg-stat em { font-style: normal; font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.pg-stat i { font-style: normal; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.pg-stat--danger span { color: #fff; }
.pg-stat--danger em { color: #fff; }
.pg-stat--danger i { color: rgba(255, 255, 255, 0.62); }

.pg-rows { display: flex; flex-direction: column; gap: 10px; }
.dr { display: flex; gap: 10px; font-size: var(--fs-md); line-height: 1.7; }
.dr-k { flex: none; width: 44px; color: var(--muted-2); font-size: var(--fs-sm); padding-top: 2px; }
.dr-v { color: var(--ink-2); }

.pg-sec {
  margin: 18px 0 8px; font-size: var(--fs-xs); font-weight: 600;
  color: var(--muted-2); letter-spacing: var(--ls-wide-sm);
}
.pg-modes { display: flex; flex-direction: column; gap: 8px; }
.pg-mode {
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  padding: 11px 14px; border-radius: 14px; cursor: pointer;
  border: 1px solid var(--hairline); background: var(--canvas);
  font-family: inherit;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.pg-mode:hover { border-color: var(--soft); }
.pg-mode.on { border-color: var(--accent); background: var(--acc-bg); }
.pm-n { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.pg-mode.on .pm-n { color: var(--accent); }
.pm-d { font-size: var(--fs-sm); color: var(--muted); line-height: 1.6; }

.pg-warn {
  margin-top: 12px; padding: 11px 14px; border-radius: 12px;
  background: var(--amber-bg); color: var(--amber-fg);
  font-size: var(--fs-sm); line-height: 1.7;
}
.pg-warn--hard { background: var(--red-bg); color: var(--red-fg); }

.pg-confirm { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.pg-input {
  height: 40px; padding: 0 13px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-input); outline: none; box-sizing: border-box;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink); width: 100%;
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}
.pg-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1); }
.pi-label { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.ml { margin-left: auto; }
</style>
