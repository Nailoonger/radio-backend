<template>
  <div class="setting-page">
    <div class="cols">
      <!-- ══════════ 左：广播站信息表单 ══════════ -->
      <div class="sec wide">
        <div class="sec-head">
          <span class="sec-title">广播站信息</span>
          <span class="micro">KV 存储 · 保存后立即同步到小程序</span>
        </div>

        <div class="form" v-loading="loading">
          <div class="field">
            <label class="field-label">广播站名称 <em>*</em></label>
            <input v-model="form.station_name" class="input" maxlength="30" placeholder="如：菁悠广播站" />
          </div>
          <div class="field">
            <label class="field-label">口号 <em>*</em></label>
            <input v-model="form.station_slogan" class="input" maxlength="30" placeholder="如：菁菁校园情，悠悠广播声" />
          </div>
          <div class="field">
            <label class="field-label">广播站介绍 <em>*</em></label>
            <textarea v-model="form.station_intro" class="textarea" rows="5" maxlength="200"
              placeholder="会显示在小程序「关于」页"></textarea>
            <span class="hint">{{ form.station_intro.length }} / 200 字 · 「关于」页按 4 行展示，超出截断</span>
          </div>
          <div class="cols inner">
            <div class="field grow">
              <label class="field-label">开播时间 <em>*</em></label>
              <input v-model="form.broadcast_schedule" class="input" maxlength="30" placeholder="07:20 / 12:20 / 17:30" />
            </div>
            <div class="field grow">
              <label class="field-label">联系方式 <em>*</em></label>
              <input v-model="form.contact" class="input" maxlength="30" placeholder="广播站办公室（行政楼 302）" />
            </div>
          </div>
        </div>
      </div>

      <!-- ══════════ 右：同步说明 ══════════ -->
      <div class="sec">
        <div class="sec-head"><span class="sec-title">同步预览</span></div>
        <div class="card tight">
          <div class="kv"><span class="k">生效位置</span><span>小程序「关于」页</span></div>
          <div class="kv"><span class="k">接口</span><span class="mono">GET /api/user/setting/list</span></div>
          <div class="kv"><span class="k">缓存</span><span class="num">无 · 实时读取</span></div>
          <div class="kv"><span class="k">最近修改</span><span class="num">{{ lastSavedText || '—' }}</span></div>
        </div>

        <div class="card pad">
          <div class="strong">键 → 出现在小程序的哪一处</div>
          <div class="card-white">
            <div class="kv"><span class="k mono kwide">station_name</span><span>「关于」页 · 站名</span></div>
            <div class="kv"><span class="k mono kwide">station_slogan</span><span>「关于」页 · 口号</span></div>
            <div class="kv"><span class="k mono kwide">station_intro</span><span>「关于」页 · 广播站介绍段落</span></div>
            <div class="kv"><span class="k mono kwide">broadcast_schedule</span><span>「关于」页 · 开播时间一行</span></div>
            <div class="kv"><span class="k mono kwide">contact</span><span>「关于」页 · 联系方式一行</span></div>
          </div>
          <div class="micro more">
            点歌名额、注意事项、播出时段等键在「投稿 &amp; 点歌审核」页管理；
            小程序「关于」页只读上面这五个键，改完保存即生效、无缓存。
          </div>
        </div>

        <div class="card pad">
          <div class="strong rules-t">校验规则</div>
          <div class="micro">
            名称 / 口号 / 开播时间 / 联系方式：必填，≤ 30 字<br />
            广播站介绍：≤ 200 字（「关于」页按 4 行展示，超出截断）<br />
            开播时间：自由文本，建议「07:20 / 12:20 / 17:30」这种写法
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 底部保存条 ══════════ -->
    <div class="toolbar">
      <span class="micro">{{ lastSavedText ? `上次保存：${lastSavedText}` : '还没有保存记录' }}</span>
      <div class="tail">
        <el-button class="bb-plain" @click="reset">放弃更改</el-button>
        <el-button type="primary" class="save-btn" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';

/** 五个键：key / 中文名 / 是否必填 / 上限字数 */
const FIELDS = [
  { key: 'station_name',        desc: '广播站名称', max: 30 },
  { key: 'station_slogan',      desc: '口号',       max: 30 },
  { key: 'station_intro',       desc: '广播站介绍', max: 200 },
  { key: 'broadcast_schedule',  desc: '开播时间',   max: 30 },
  { key: 'contact',             desc: '联系方式',   max: 30 },
];

const loading = ref(true);
const saving = ref(false);
const form = reactive(Object.fromEntries(FIELDS.map((f) => [f.key, ''])));
const snapshot = ref('');   // 打开时的原始值，用于「放弃更改」
const lastSavedText = ref('');

const isDirty = computed(() => JSON.stringify(form) !== snapshot.value);

async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/setting/list');
    const byKey = new Map((data.list || []).map((r) => [r.key, r]));
    FIELDS.forEach((f) => {
      form[f.key] = byKey.get(f.key)?.value || '';
    });
    snapshot.value = JSON.stringify(form);
    // 用这些键里最新的 updateTime 当「最近修改」
    const times = FIELDS.map((f) => byKey.get(f.key)?.updateTime).filter(Boolean).sort();
    if (times.length) {
      const by = FIELDS.map((f) => byKey.get(f.key)).filter((r) => r?.updateTime === times[times.length - 1])[0];
      lastSavedText.value = `${dayjs(times[times.length - 1]).format('YYYY-MM-DD HH:mm')}${by?.updateByName ? `（${by.updateByName}）` : ''}`;
    }
  } finally { loading.value = false; }
}

function reset() {
  if (!isDirty.value) return;
  Object.assign(form, JSON.parse(snapshot.value));
  ElMessage.info('已还原为上次保存的值');
}

async function save() {
  for (const f of FIELDS) {
    const v = (form[f.key] || '').trim();
    if (!v) return ElMessage.warning(`请填写「${f.desc}」`);
    if (v.length > f.max) return ElMessage.warning(`「${f.desc}」不能超过 ${f.max} 字`);
  }
  saving.value = true;
  try {
    // 逐键 upsert（PUT /admin/setting/:key）
    await Promise.all(FIELDS.map((f) => http.put(`/admin/setting/${f.key}`, { value: (form[f.key] || '').trim(), desc: f.desc })));
    ElMessage.success('已保存，小程序「关于」页立即生效');
    snapshot.value = JSON.stringify(form);
    lastSavedText.value = `${dayjs().format('YYYY-MM-DD HH:mm')}（刚刚）`;
  } finally { saving.value = false; }
}

onMounted(fetch);
</script>

<style scoped>
.setting-page { display: flex; flex-direction: column; gap: 22px; }
.cols { display: flex; gap: 18px; align-items: flex-start; }
.cols > * { min-width: 0; flex: 1; }
.cols.inner { gap: 18px; margin: 0; }
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec.wide { flex: 1.35; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); }
.strong { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.75; }

/* 表单卡：沿用小程序投稿页（羊皮纸底 + 白输入框 + 12px 圆角） */
.form {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 18px 20px;
  display: flex; flex-direction: column; gap: 15px;
}
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field.grow { flex: 1; }
.field-label { font-size: var(--fs-sm); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.field-label em { color: var(--red-fg); font-style: normal; }
.input, .textarea {
  width: 100%; box-sizing: border-box;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  padding: 9px 13px;
  font-family: inherit; font-size: var(--fs-md); color: var(--ink);
  outline: none;
  transition: border-color 0.16s var(--ease);
}
.input:focus, .textarea:focus { border-color: var(--accent); }
.textarea { resize: vertical; line-height: 1.7; }
.hint { font-size: var(--fs-xs); color: var(--muted); }

.card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); }
.card.tight { padding: 8px 20px; }
.card.pad { padding: 14px 18px; }
.card-white { background: var(--parchment); border-radius: 10px; padding: 4px 14px; margin-top: 10px; }
.kv {
  display: flex; align-items: baseline; font-size: var(--fs-md); line-height: 1.6;
  padding: 8px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.card-white .kv:last-child { border-bottom: none; }
.card.tight .kv:last-child { border-bottom: none; }
.kv .k { width: 96px; flex: none; color: var(--muted); font-size: var(--fs-sm); }
.kv .k.kwide { width: 132px; font-size: var(--fs-xs); }
.mono { font-family: var(--mono); color: var(--ink-2); }
.num { font-variant-numeric: tabular-nums; }
.more { margin-top: 10px; }
.rules-t { margin-bottom: 8px; }

.toolbar {
  display: flex; align-items: center; gap: 13px;
  border-top: 1px solid var(--hairline); padding-top: 18px;
}
.tail { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* 底部按钮按 v8：放弃＝透明灰字；保存＝强调色胶囊 */
.toolbar .bb-plain.el-button { background: transparent !important; border: none !important; color: var(--muted) !important; border-radius: var(--r-pill); }
.toolbar .bb-plain.el-button:hover { color: var(--ink) !important; }
.toolbar .save-btn.el-button {
  background: var(--accent) !important; background-image: none !important;
  border: none !important; border-radius: var(--r-pill);
  font-weight: 600; padding: 0 22px; height: 36px;
}
</style>
