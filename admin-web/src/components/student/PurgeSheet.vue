<template>
  <SlideSheet
    v-model="inner"
    :title="`毕业清理 · ${info?.grade || grade || ''} 级`"
    :subtitle="info ? '只处理这一届的账号，其它届一概不动' : '读取试算中…'"
    width="700"
  >
    <template v-if="info">
      <!-- 顶部红警示条（常驻，原型 warnline） -->
      <div class="pg-warnline">
        <IconTrash :size="15" />
        <span><b>此操作不可恢复。</b>执行后这一届的登录态会立即作废，不等 30 秒缓存。建议先点「导出本届」留档。</span>
      </div>

      <!-- 统计条（横排一组数字，不放大卡） -->
      <div class="pg-stats">
        <span class="pg-kv"><span class="pk-hint">本届账号</span><b class="num">{{ info.total }}</b></span>
        <span class="pg-kv"><span class="pk-hint">将真删</span><b class="num pg-red">{{ info.canDelete }}</b></span>
        <span class="pg-kv"><span class="pk-hint">将停用</span><b class="num pg-amber">{{ info.withSubmit }}</b></span>
        <span class="pg-kv"><span class="pk-hint">涉及班级</span><b class="num">{{ info.classCount }}</b></span>
      </div>

      <!-- 三种做法（单选，带勾选圆钮，原型 modeCard） -->
      <div class="pg-modes">
        <button
          v-for="m in modeCards" :key="m.k" type="button"
          class="pg-mode" :class="{ on: mode === m.k }"
          @click="mode = m.k"
        >
          <span class="pm-cb" :class="{ on: mode === m.k }" aria-hidden="true">
            <IconCheck v-if="mode === m.k" :size="11" :stroke-width="3" />
          </span>
          <span class="pm-txt">
            <span class="pm-n">{{ m.t }}</span>
            <span class="pm-d">{{ m.d }}</span>
          </span>
        </button>
      </div>

      <!-- 统一确认：手打年级（原型：所有做法都要输入年级才能按下去） -->
      <div class="pg-confirm">
        <span class="pk-hint">输入 <b class="pg-strong">{{ info.grade }}</b> 确认执行</span>
        <input
          v-model="purgeConfirm"
          class="pg-input"
          :placeholder="String(info.grade)"
          spellcheck="false"
        />
      </div>
    </template>

    <template #footer>
      <span class="pk-hint">本次影响 <b class="pg-strong">{{ info?.total ?? '—' }}</b> 个账号</span>
      <span class="pf-acts">
        <button type="button" class="pf-btn pf-quiet" :disabled="busy" @click="emit('export')">先导出本届</button>
        <button type="button" class="pf-btn pf-plain" :disabled="busy" @click="inner = false">取消</button>
        <button type="button" class="pf-btn pf-danger" :disabled="!armed || busy" @click="run">
          确认清理 {{ info?.grade || grade }} 级
        </button>
      </span>
    </template>
  </SlideSheet>
</template>

<script setup>
/**
 * 毕业清理（页内弹层）—— 形态 = preview/student-admin-v3 的 purge 屏（用户拍板的标准）
 *
 * 结构：红警示条 → 一行统计（本届/将真删/将停用/涉及班级）→ 三种做法单选（safe/disable/purge）
 *   → 手打年级确认（**所有做法都要输入**，原型 753 行：「得把年级名原样输入才能按下去」）
 * footer：本次影响 N 个账号 ｜ 先导出本届（emit('export')，父组件 exportGrade）· 取消 · 确认清理 N 级（实心红）
 *
 * 与后端一致的三种模式：safe（无投稿真删、有投稿转停用）/ disable（只停用）/ purge（全删 + confirm）。
 */
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import SlideSheet from '@/components/SlideSheet.vue';
import { IconTrash, IconCheck } from '@/components/icons';
import http from '@/utils/http';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  grade: { type: [String, Number], default: '' },
});
const emit = defineEmits(['update:modelValue', 'done', 'export']);

const inner = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const info = ref(null);
const mode = ref('safe');
const purgeConfirm = ref('');
const busy = ref(false);

/** 三张模式卡的文案 = 原型逐字（数字嵌在描述里，随试算变） */
const modeCards = computed(() => {
  const i = info.value;
  if (!i) return [];
  return [
    { k: 'safe', t: 'safe · 默认', d: `无投稿记录的 ${i.canDelete} 个真删；有投稿记录的 ${i.withSubmit} 个改为停用` },
    { k: 'disable', t: 'disable · 只停用', d: `${i.total} 个全部改为停用，一个都不删 —— 留着以后复查` },
    { k: 'purge', t: 'purge · 全删（危险）', d: `${i.total} 个全部真删，含 ${i.withSubmit} 个有投稿记录的人 —— 作者名会从审核列表里消失` },
  ];
});

/** 原型式统一确认：手打年级原样输入才可执行（safe/disable/purge 一视同仁） */
const armed = computed(() => {
  if (!info.value) return false;
  return purgeConfirm.value.trim() === String(info.value.grade);
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
  if (!info.value || !armed.value || busy.value) return;
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
/* 红警示条（常驻） */
.pg-warnline {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 12px 14px; border-radius: 12px; margin-bottom: 12px;
  background: var(--red-bg); color: var(--red-fg);
  font-size: var(--fs-sm); line-height: 1.7;
}
.pg-warnline svg { flex: none; margin-top: 3px; }

/* 统计条：一行四组「hint + 数字」 */
.pg-stats {
  display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
  padding: 12px 15px; border-radius: 12px; margin-bottom: 12px;
  background: var(--parchment);
}
.pg-kv { display: flex; align-items: center; gap: 8px; }
.pk-hint { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.pg-stats b { font-size: 17px; font-weight: 600; }
.pg-red { color: var(--red-fg); }
.pg-amber { color: var(--amber-fg); }
.pg-strong { color: var(--ink); font-weight: 600; }

/* 模式单选卡：勾选圆钮 + 标题/描述 */
.pg-modes { display: flex; flex-direction: column; gap: 9px; }
.pg-mode {
  display: flex; align-items: center; gap: 11px; text-align: left;
  padding: 13px 15px; border-radius: 12px; cursor: pointer; font-family: inherit;
  border: 1px solid var(--hairline); background: var(--canvas);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.pg-mode:hover { border-color: var(--soft); }
.pg-mode.on { border-color: var(--accent); background: var(--acc-bg); }
.pm-cb {
  flex: none; width: 20px; height: 20px; border-radius: 50%;
  border: 1.5px solid var(--hairline); background: var(--canvas);
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}
.pm-cb.on { background: var(--accent); border-color: var(--accent); }
.pm-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pm-n { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.pg-mode.on .pm-n { color: var(--accent); }
.pm-d { font-size: var(--fs-sm); color: var(--muted); line-height: 1.6; }

/* 手打年级确认 */
.pg-confirm { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.pg-input {
  height: 40px; padding: 0 13px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-input); outline: none; box-sizing: border-box;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink); width: 100%;
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}
.pg-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1); }

/* footer：自绘按钮（原型 btn-quiet / btn-plain / btn-danger-fill） */
.pf-acts { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.pf-btn {
  height: 34px; padding: 0 14px; border-radius: 980px; cursor: pointer; font-family: inherit;
  font-size: var(--fs-sm); font-weight: 500; border: 1px solid transparent;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s var(--ease);
}
.pf-btn:active { transform: scale(0.96); }
.pf-btn:disabled { opacity: 0.45; pointer-events: none; }
.pf-quiet { background: var(--parchment); color: var(--ink-2); }
.pf-quiet:hover { background: var(--hairline); }
.pf-plain { background: var(--canvas); border-color: var(--hairline); color: var(--ink-2); }
.pf-plain:hover { border-color: var(--soft); color: var(--ink); }
.pf-danger { background: var(--red-fg); color: #fff; font-weight: 600; }
.pf-danger:hover { filter: brightness(1.06); }
</style>
