<template>
  <div class="song-settings">
    <!-- v8：子页返回入口 -->
    <div class="back-row">
      <a class="back-link" @click="$router.push('/submit')">‹ 返回投稿 & 点歌审核</a>
      <span class="micro">点歌设置 · 名额 / 提交规则 / 播出时段 / 两份注意事项</span>
    </div>

    <!-- ══════════ 名额 + 提交规则（视觉稿第 1 行：双栏） ══════════ -->
    <div class="cols">
      <!-- 名额段 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">名额</span>
          <span class="tag tag-pass">即时生效</span>
        </div>
        <div class="card" style="padding:18px 20px">
          <!-- 用量数据：视觉稿是双进度条；现状后端返回 4 条，加进去 -->
          <div class="quota-grid">
            <div class="quota-item">
              <div class="rowc" style="justify-content:space-between">
                <span class="micro">今日已用</span>
                <span>
                  <b class="num quota-num">{{ snapshot?.daily?.used ?? 0 }}</b>
                  <span class="micro">/ {{ snapshot?.daily?.limit === 0 ? '不限' : (snapshot?.daily?.limit ?? '-') }}</span>
                </span>
              </div>
              <div class="bar"><i :style="{ width: pct(snapshot?.daily) }" /></div>
            </div>
            <div class="quota-item">
              <div class="rowc" style="justify-content:space-between">
                <span class="micro">本周已用</span>
                <span>
                  <b class="num quota-num">{{ snapshot?.weekly?.used ?? 0 }}</b>
                  <span class="micro">/ {{ snapshot?.weekly?.limit === 0 ? '不限' : (snapshot?.weekly?.limit ?? '-') }}</span>
                </span>
              </div>
              <div class="bar"><i :style="{ width: pct(snapshot?.weekly) }" /></div>
            </div>
            <div class="quota-item quota-item-text">
              <span class="micro">今日自动驳回</span>
              <b class="num quota-num">{{ snapshot?.autoRejectedToday ?? 0 }}</b>
            </div>
            <div class="quota-item quota-item-text">
              <span class="micro">待审（名额已满时）</span>
              <b class="num quota-num">{{ snapshot?.pendingWhileExhausted ?? 0 }}</b>
            </div>
          </div>

          <!-- 设置 + 手动触发自动驳回（按视觉稿：字段一行 + 按钮一行，避开挤断） -->
          <div class="quota-edit">
            <!-- 字段行：每日 / 每周上限，flex:1 各占一半 -->
            <div class="quota-fields">
              <div class="field">
                <label class="field-label">每日上限</label>
                <el-input-number v-model="quotaForm.daily" :min="0" :max="999" controls-position="right" />
              </div>
              <div class="field">
                <label class="field-label">每周上限</label>
                <el-input-number v-model="quotaForm.weekly" :min="0" :max="999" controls-position="right" />
              </div>
            </div>
            <!-- 按钮行：保存（主操作）+ 执行一次自动驳回（次操作），右对齐，wrap 防挤断 -->
            <div class="quota-buttons">
              <el-button type="primary" :loading="quotaSaving" @click="saveQuota" class="btn-save">
                <IconCheck :size="15" class="btn-icon" />保存
              </el-button>
              <el-button :loading="sweeping" plain @click="sweepQuota" class="btn-sweep">
                <IconRefresh :size="15" class="btn-icon" />执行一次自动驳回
              </el-button>
            </div>
          </div>

          <div class="micro" style="margin-top:11px;line-height:1.7">
            填 <b>0</b> = 不限制。名额占满后，该周期剩余待审点歌由系统自动驳回，之后新提交的也立刻驳回。
          </div>
        </div>
      </div>

      <!-- 提交规则段 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">提交规则</span>
          <span class="tag tag-pass">即时生效</span>
        </div>
        <div class="card" style="padding:8px 20px">
          <div class="kv">
            <span class="k" style="width:132px">每人每周上限</span>
            <span class="rowc gap8">
              <el-input-number v-model="ruleForm.weeklyUserLimit" :min="0" :max="99" size="small" :controls="false" />
              <span class="micro">次 · 填 0 = 不限</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">同曲一周去重</span>
            <span class="rowc gap13">
              <el-switch v-model="ruleForm.dupBlock" :active-value="1" :inactive-value="0" />
              <span class="micro">开：同一首歌一周内只能点一次</span>
            </span>
          </div>
          <div class="kv">
            <span class="k" style="width:132px">生效范围</span>
            <span class="micro">只算点歌（文稿不受影响）；因名额已满被系统驳回的不占个人次数</span>
          </div>
          <!-- 保存：作为卡片内最后一行，与上面几行同一节律（这段之前漏了保存入口，2026-09-19 补） -->
          <div class="kv" style="border-bottom:none">
            <span class="k" style="width:132px">保存</span>
            <span class="rowc gap13">
              <el-button type="primary" size="small" :loading="ruleSaving" @click="saveRules" class="btn-save">
                <IconCheck :size="14" class="btn-icon" />保存规则
              </el-button>
              <span class="micro">改完点这里才生效 · 保存后会显示服务端真正生效的值</span>
            </span>
          </div>
        </div>
        <!-- v8 第 2369-2376 行：被拦下时用户看到什么 -->
        <div class="card" style="padding:14px 20px;margin-top:10px">
          <div class="micro" style="line-height:1.75">
            被拦下时用户看到的是：<br>
            · 「本周已经有人点过《晴天》了，换一首吧」<br>
            · 「本周点歌次数已用完（每周最多 2 次），下周再来吧」
            <span class="tag tag-pending" style="margin-left:6px">错误码 40903</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 播出时段 ══════════ -->
    <div class="sec">
      <div class="sec-head">
        <span class="sec-title">播出时段（用户只能从这儿选）</span>
        <span class="rowc gap8">
          <span class="tag tag-pass">后台发布</span>
          <span class="micro">当前来源：{{ sourceText }}</span>
        </span>
      </div>
      <div class="card" style="padding:18px 20px">
        <div class="cols" style="gap:26px">
          <!-- 左：编辑区 -->
          <div style="flex:1">
            <div class="rowc" style="justify-content:space-between;margin-bottom:13px">
              <span class="field-label">每天开放的场次（最多 6 个）</span>
              <span class="micro">格式 HH:mm，保存后自动按时间排序</span>
            </div>
            <div class="stack gap13">
              <div v-for="(t, i) in slotTimes" :key="i" class="rowc gap13 slot-edit-row">
                <!-- v8 视觉稿第 2396/2400/2404 行用裸 input，但第二版改成 el-time-select 后体验更好：
                     既能点选下拉也能手输。粒度 10 分钟，区间 06:00~22:30 -->
                <el-time-select
                  v-model="t.time"
                  start="06:00" step="00:10" end="22:30"
                  placeholder="选时段"
                  style="width:120px"
                />
                <el-select v-model="t.label" style="width:110px">
                  <el-option label="早间" value="早间" />
                  <el-option label="午间" value="午间" />
                  <el-option label="晚间" value="晚间" />
                </el-select>
                <span class="micro slot-label-hint">标签，用户看到的是「周一 09-21 · 早间 07:20」</span>
                <a class="link op-delete" :class="{ disabled: slotTimes.length <= 1 }" @click="removeSlot(i)">删除</a>
              </div>
            </div>
            <div class="rowc gap8" style="margin-top:13px">
              <el-button :disabled="slotTimes.length >= (slotConfig?.maxSlots || 6)" @click="addSlot">
                <IconPlus :size="15" class="btn-icon" />
                加一个时段{{ slotTimes.length >= (slotConfig?.maxSlots || 6) ? '（已达上限）' : '' }}
              </el-button>
              <el-button type="primary" :loading="slotSaving" @click="saveSlots">
                <IconCheck :size="15" class="btn-icon" />发布时段
              </el-button>
            </div>
            <!-- v8 方案 ④：每场名额上限（视觉稿没画，但后端已实现） -->
            <div class="slot-capacity">
              <span class="cap-label">每场名额上限</span>
              <el-input-number v-model="slotCapacity" :min="0" :max="99" />
              <span class="micro">0 = 不限。排满的场次在小程序端会划掉并提示「已排满」</span>
            </div>
            <div class="micro" style="margin-top:11px;line-height:1.7">
              留空则退回解析「开播时间」设置，再退回默认三个。
              <b>可选日期范围固定为下一周的周一到周五</b>，不在这里改。
            </div>
          </div>

          <!-- 右：用户预览 -->
          <div style="flex:1">
            <div class="rowc" style="justify-content:space-between;margin-bottom:13px">
              <span class="field-label">
                用户会看到{{ slotConfig ? `（${slotConfig.weekStart} ~ ${slotConfig.weekEnd}）` : '' }}
              </span>
              <span class="micro">与用户端同源</span>
            </div>
            <div class="stack gap13">
              <div v-for="day in weekDays" :key="day" class="rowc gap13 slot-day-row">
                <span class="micro slot-day-label">{{ day }}</span>
                <span class="rowc gap8">
                  <span v-for="slot in slotTimes" :key="slot.time" class="chip-pick on">
                    {{ slot.label }} {{ slot.time }}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 两份注意事项 ══════════ -->
    <div class="cols">
      <!-- 点歌注意事项 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">点歌注意事项</span>
          <span class="micro">
            v{{ noticeList[0].version }} · 已确认 <b class="num">{{ noticeList[0].ackedCount }}</b> 人
          </span>
        </div>
        <div class="card" style="padding:18px 20px">
          <el-input
            v-model="noticeList[0].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、点歌前请确认歌曲名与歌手填写正确。&#10;二、每人每周最多点 2 次。（留空 = 不启用）"
          />
          <div class="warnline" style="margin-top:13px">
            <IconInfo :size="14" />
            <span>内容有改动才 +1 版本，<b>所有用户需重新确认</b>；只改排版不打扰用户。</span>
          </div>
          <div class="rowc" style="justify-content:flex-end;gap:8px;margin-top:13px">
            <el-button size="small">预览用户端</el-button>
            <el-button type="primary" size="small" :loading="noticeList[0].saving" @click="saveNotice(noticeList[0])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
          </div>
        </div>
      </div>

      <!-- 文稿注意事项 -->
      <div class="sec" style="flex:1">
        <div class="sec-head">
          <span class="sec-title">文稿注意事项</span>
          <span class="rowc gap8">
            <span class="tag tag-pass">与点歌独立</span>
            <span class="micro">
              v{{ noticeList[1].version }} · 已确认 <b class="num">{{ noticeList[1].ackedCount }}</b> 人
            </span>
          </span>
        </div>
        <div class="card" style="padding:18px 20px">
          <el-input
            v-model="noticeList[1].content"
            type="textarea"
            :rows="6"
            placeholder="一行一条，例如：&#10;一、文稿须为原创，禁止抄袭转载。&#10;二、篇幅 300~1500 字，请勿提交纯图片内容。"
          />
          <div class="micro" style="margin-top:13px;line-height:1.7">
            两份内容、版本号、确认记录<b>互相独立</b>：改文稿这份不会让点歌那批人重新确认。
          </div>
          <div class="rowc" style="justify-content:flex-end;gap:8px;margin-top:13px">
            <el-button size="small">预览用户端</el-button>
            <el-button type="primary" size="small" :loading="noticeList[1].saving" @click="saveNotice(noticeList[1])">
              <IconCheck :size="14" class="btn-icon" />保存
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ 危险区（仅超管） · 视觉稿未画，后端接口已落地所以保留 ══════════ -->
    <div class="sec danger-sec" v-if="auth.isSuperAdmin">
      <div class="sec-head">
        <span class="sec-title danger-title">危险区</span>
        <span class="rowc gap8">
          <span class="tag tag-danger">仅超级管理员</span>
          <span class="micro">服务端校验（40301）</span>
        </span>
      </div>
      <div class="card dangerzone" style="padding:18px 20px">
        <div class="rowc danger-row">
          <div class="grow">
            <div class="dz-title">一键清空全部点歌数据</div>
            <div class="dz-desc">
              删除<b>全部点歌记录</b>并清零名额计数器，<b>不可恢复</b>；文稿、注意事项确认记录、学生账号一概不动。
              个人每周点歌次数随数据清空自然归零，本周名额重新可占。
            </div>
            <div class="dz-desc muted">
              普通管理员调用此接口返回 40301；按钮对普通管理员不渲染 —— 显隐只是体验，边界在服务端。
            </div>
          </div>
          <div class="dz-action">
            <el-button type="danger" :loading="purging" @click="purgeSongs">清空全部点歌数据</el-button>
            <div class="dz-hint">点击后需输入 DELETE 二次确认</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import {
  IconCheck, IconPlus, IconRefresh, IconInfo,
} from '@/components/icons';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

/** 用量进度条宽度：0 或未设上限时按 0% 处理 */
function pct(s) {
  if (!s || !s.limit) return '0%';
  const r = Math.min((Number(s.used) || 0) / Number(s.limit), 1);
  return `${Math.round(r * 100)}%`;
}

/* ─────────── 名额 ─────────── */
const quotaForm = reactive({ daily: 0, weekly: 0 });
const snapshot = ref(null);
const quotaSaving = ref(false);
const sweeping = ref(false);

async function fetchQuota() {
  snapshot.value = await http.get('/admin/submit/quota');
  quotaForm.daily = snapshot.value?.daily?.limit ?? 0;
  quotaForm.weekly = snapshot.value?.weekly?.limit ?? 0;
}
async function saveQuota() {
  // 同 saveRules：清空 = undefined = 键被丢 = 后端保留旧值，必须拦住
  const d = Number(quotaForm.daily);
  const w = Number(quotaForm.weekly);
  if (!Number.isFinite(d) || !Number.isFinite(w)) {
    ElMessage.warning('请填写每日 / 每周名额（0 表示不限）');
    return;
  }
  quotaSaving.value = true;
  try {
    snapshot.value = await http.put('/admin/submit/quota', {
      daily: Math.max(0, Math.floor(d)), weekly: Math.max(0, Math.floor(w)),
    });
    quotaForm.daily = snapshot.value?.daily?.limit ?? 0;
    quotaForm.weekly = snapshot.value?.weekly?.limit ?? 0;
    ElMessage.success('名额已更新');
  } finally { quotaSaving.value = false; }
}
async function sweepQuota() {
  sweeping.value = true;
  try {
    const data = await http.post('/admin/submit/quota/sweep');
    snapshot.value = data?.snapshot || snapshot.value;
    const rejected = (data?.daily || 0) + (data?.weekly || 0);
    ElMessage.success(`已执行自动驳回，本轮处理 ${rejected} 条`);
  } finally { sweeping.value = false; }
}

/* ─────────── 提交规则 ─────────── */
const ruleForm = reactive({ weeklyUserLimit: 2, dupBlock: 1 });
const ruleSaving = ref(false);

async function fetchRules() {
  const data = await http.get('/admin/submit/rules');
  ruleForm.weeklyUserLimit = data.weeklyUserLimit;
  ruleForm.dupBlock = data.dupBlock;
}
async function saveRules() {
  // ⚠️ el-input-number 被「清空」时是 undefined：JSON.stringify 会丢掉这个键，
  // 后端就保留旧值，但页面照样弹「已更新」——管理员以为改成 0 了其实没改（2026-09-19 实际踩过）。
  // 所以这里必须拦住：要填就填明确的数字，0 = 不限。
  const n = Number(ruleForm.weeklyUserLimit);
  if (!Number.isFinite(n) || ruleForm.weeklyUserLimit === null || ruleForm.weeklyUserLimit === undefined || ruleForm.weeklyUserLimit === '') {
    ElMessage.warning('请填写每人每周点歌次数（0 表示不限）');
    return;
  }
  ruleSaving.value = true;
  try {
    const data = await http.put('/admin/submit/rules', {
      weeklyUserLimit: Math.max(0, Math.floor(n)), dupBlock: ruleForm.dupBlock,
    });
    // 用服务端真正落库的值回填，页面显示的就是生效中的配置
    if (data) {
      ruleForm.weeklyUserLimit = data.weeklyUserLimit;
      ruleForm.dupBlock = data.dupBlock;
    }
    ElMessage.success(
      data?.weeklyUserLimit === 0
        ? '规则已更新：每人每周点歌不限次数，立即生效'
        : `规则已更新：每人每周最多 ${data?.weeklyUserLimit} 次，立即生效`
    );
  } finally { ruleSaving.value = false; }
}

/* ─────────── 播出时段 ─────────── */
const slotTimes = ref([]);
const slotConfig = ref(null);
const slotCapacity = ref(0);
const slotSaving = ref(false);

const SOURCE_LABEL = {
  custom: '你发布的',
  schedule: '播出台词解析',
  default: '默认时段',
};
const sourceText = computed(() => SOURCE_LABEL[slotConfig.value?.source] || '—');

/** 视觉稿右侧预览：根据 slotConfig.weekStart 算下一周周一~周五 */
const weekDays = computed(() => {
  const start = slotConfig.value?.weekStart;
  if (!start) return ['周一', '周二', '周三', '周四', '周五'];
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return ['周一', '周二', '周三', '周四', '周五'];
  return Array.from({ length: 5 }, (_, i) => {
    const cur = new Date(d);
    cur.setDate(d.getDate() + i);
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    const wk = ['周一', '周二', '周三', '周四', '周五'][i];
    return `${wk} ${mm}-${dd}`;
  });
});

async function fetchSlots() {
  // GET 走 /admin/submit/timeslots（/submit/slots 只注册了 PUT，GET 会被 /submit/:id 吃掉）
  slotConfig.value = await http.get('/admin/submit/timeslots');
  slotTimes.value = (slotConfig.value?.times || []).map((t) => ({ time: t.time, label: t.label || '' }));
  slotCapacity.value = slotConfig.value?.capacity ?? 0;
}
function addSlot() {
  slotTimes.value.push({ time: '', label: '午间' });
}
function removeSlot(i) {
  slotTimes.value.splice(i, 1);
}
async function saveSlots() {
  const times = slotTimes.value
    .map((t) => ({ time: (t.time || '').trim(), label: t.label }))
    .filter((t) => t.time);
  if (!times.length) return ElMessage.warning('至少要有一个时段');
  const cap = Number(slotCapacity.value);
  if (!Number.isFinite(cap)) return ElMessage.warning('请填写每场名额（0 表示不限）');
  slotSaving.value = true;
  try {
    slotConfig.value = await http.put('/admin/submit/slots', { times, capacity: Math.max(0, Math.floor(cap)) });
    slotTimes.value = (slotConfig.value?.times || []).map((t) => ({ time: t.time, label: t.label || '' }));
    slotCapacity.value = slotConfig.value?.capacity ?? 0;
    ElMessage.success('已发布，用户端立即生效');
  } finally { slotSaving.value = false; }
}

/* ─────────── 注意事项 ─────────── */
const noticeList = ref([
  { type: 'song', label: '点歌注意事项', content: '', version: 0, ackedCount: 0, saving: false },
  { type: 'article', label: '文稿注意事项', content: '', version: 0, ackedCount: 0, saving: false },
]);

async function fetchNotices() {
  const data = await http.get('/admin/submit/notice');
  noticeList.value.forEach((nt) => {
    const one = data?.[nt.type];
    if (one) {
      nt.content = one.content;
      nt.version = one.version;
      nt.ackedCount = one.ackedCount;
    }
  });
}
async function saveNotice(nt) {
  nt.saving = true;
  try {
    const data = await http.put('/admin/submit/notice', { content: nt.content, type: nt.type });
    nt.version = data.version;
    nt.ackedCount = data.ackedCount;
    if (data.bumped) ElMessage.success(`${data.label}已保存，版本号 +1（所有用户需重新确认）`);
    else ElMessage.success('内容没有变化，版本号保持不变');
  } finally { nt.saving = false; }
}

/* ─────────── 危险区：一键清空点歌数据 ─────────── */
const purging = ref(false);

async function purgeSongs() {
  const { value } = await ElMessageBox.prompt(
    '将删除全部点歌记录并清零名额计数器，不可恢复；文稿与注意事项确认记录不受影响。请输入 DELETE 确认。',
    '清空全部点歌数据',
    {
      type: 'error',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
      inputPattern: /^DELETE$/,
      inputErrorMessage: '请原样输入 DELETE',
    }
  );
  purging.value = true;
  try {
    const data = await http.delete('/admin/submit/songs', { data: { confirm: value } });
    ElMessage.success(`已清空 ${data?.deletedSongs ?? 0} 条点歌数据，文稿不受影响`);
    await Promise.allSettled([fetchQuota(), fetchNotices()]);
  } finally { purging.value = false; }
}

onMounted(() => {
  fetchQuota().catch(() => {});
  fetchRules().catch(() => {});
  fetchSlots().catch(() => {});
  fetchNotices().catch(() => {});
});
</script>

<style scoped>
.song-settings {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* v8 子页返回入口 */
.back-row { display: flex; align-items: baseline; gap: 12px; }
.back-link {
  font-size: var(--fs-md); font-weight: 600; color: var(--accent);
  cursor: pointer;
}
.back-link:hover { text-decoration: underline; }

/* ══════════ 视觉稿通用件（来自 preview/admin-ui-v8） ══════════ */
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title {
  font-size: var(--fs-xl); font-weight: 600;
  letter-spacing: var(--ls-tight-sm); line-height: var(--lh-xl);
}
.danger-title { color: var(--red-fg); }

.cols { display: flex; gap: 18px; align-items: flex-start; }
.cols > * { min-width: 0; }
.grow { flex: 1; min-width: 0; }

.card {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-card);
}
.rowc { display: flex; align-items: center; }
.stack { display: flex; flex-direction: column; }
.gap8 { gap: 8px; }
.gap13 { gap: 13px; }

.kv {
  display: flex;
  align-items: center;
  font-size: var(--fs-md);
  line-height: var(--lh-md);
  padding: 13px 0;
  border-bottom: 1px solid var(--divider);
}
.kv:last-child { border-bottom: none; }
.kv .k {
  width: 132px; flex: none;
  color: var(--muted);
  font-size: var(--fs-sm);
}

.field-label {
  font-size: var(--fs-sm); font-weight: 500;
  color: var(--muted);
  letter-spacing: var(--ls-wide);
}

.bar {
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--divider);
  overflow: hidden;
  margin-top: 9px;
}
.bar i {
  display: block; height: 100%;
  border-radius: var(--r-pill);
  background: var(--accent);
  transition: width 0.3s var(--ease);
}

.chip-pick {
  height: 28px; padding: 0 12px;
  border-radius: var(--r-pill);
  background: #fff;
  border: 1px solid var(--hairline);
  font-size: var(--fs-sm);
  color: var(--ink-2);
  display: inline-flex; align-items: center;
}
.chip-pick.on {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  background: #f4f9ff;
}

.warnline {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: var(--fs-xs);
  color: var(--red-fg);
  background: var(--red-bg);
  border-radius: 10px;
  padding: 10px 12px;
  line-height: 1.6;
}
.warnline :deep(svg) { flex-shrink: 0; margin-top: 2px; }

/* 视觉稿小标签：pass / danger（与 el-tag 区分，不走 Element 主题） */
.tag {
  display: inline-flex; align-items: center; height: 22px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  letter-spacing: var(--ls-wide-sm);
  background: var(--divider);
  color: var(--muted-2);
}
.tag-pass {
  background: #e6f0fa;
  color: var(--accent);
}
.tag-danger {
  background: var(--red-bg);
  color: var(--red-fg);
}
.tag-pending {
  background: var(--amber-bg);
  color: var(--amber-fg);
}

.num { font-variant-numeric: tabular-nums; }
.micro {
  font-size: var(--fs-xs);
  color: var(--muted-2);
  letter-spacing: var(--ls-wide-sm);
}

/* ══════════ 名额段：用量数据 2×2 网格 ══════════ */
.quota-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 26px;
  margin-bottom: 16px;
}
.quota-item { display: flex; flex-direction: column; gap: 2px; }
.quota-item-text {
  display: flex; flex-direction: row; justify-content: space-between; align-items: baseline;
  gap: 8px;
}
.quota-num {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--ink);
}
/* 名额段编辑区：字段行 + 按钮行（避免挤断） */
.quota-edit {
  display: flex; flex-direction: column; gap: 13px;
  margin-top: 4px;
}
.quota-fields {
  display: flex; gap: 18px;
}
.quota-fields > .field { flex: 1; min-width: 0; }
.quota-fields :deep(.el-input-number) { width: 100%; }
.quota-buttons {
  display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end;
}
.quota-buttons .btn-save { min-width: 96px; }
.quota-buttons .btn-sweep { min-width: 156px; }

/* ══════════ 时段段：编辑行 / 每场名额上限 ══════════ */
.slot-edit-row {
  align-items: center;
}
.slot-label-hint {
  color: var(--muted-2);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-delete {
  margin-left: auto;
  flex: none;
}
.op-delete.disabled {
  color: var(--soft);
  cursor: not-allowed;
  pointer-events: none;
}
/* 用户预览：日期列等宽，与时段编辑行节奏一致 */
.slot-day-row {
  align-items: center;
  min-height: 28px;
}
.slot-day-label {
  width: 86px;
  flex: none;
}
.slot-capacity {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--divider);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.cap-label {
  font-size: var(--fs-md);
  color: var(--ink-2);
}

/* ══════════ 危险区 ══════════ */
.danger-sec .sec-title { color: var(--red-fg); }
.dangerzone {
  border-color: #f0c4c0;
  background: linear-gradient(180deg, #fff 0%, #fff8f7 100%);
}
.danger-row { gap: 24px; align-items: flex-start; }
.dz-title {
  font-size: var(--fs-md); font-weight: 600;
  color: var(--red-fg);
}
.dz-desc {
  margin-top: 6px;
  font-size: var(--fs-sm);
  color: var(--ink-2);
  line-height: 1.7;
}
.dz-desc.muted {
  color: var(--muted);
  font-size: var(--fs-xs);
  margin-top: 8px;
}
.dz-action {
  flex-shrink: 0;
  text-align: right;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
}
.dz-hint {
  font-size: var(--fs-xs);
  color: var(--red-fg);
}

/* 按钮：图标与文字对齐（与现状其它 view 保持一致） */
.btn-icon { margin-right: 5px; vertical-align: -2px; }
</style>
