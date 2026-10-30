<template>
  <div class="pv">
    <div class="pv-stat">
      <div class="pv-stat-n"><b>{{ counts.pending || 0 }}</b><span>条待批</span></div>
      <div class="pv-stat-s">
        累计已批准 {{ counts.approved || 0 }} · 已驳回 {{ counts.rejected || 0 }}
      </div>
    </div>

    <div class="pv-note err" v-if="loadError">{{ loadError }}</div>
    <div class="pv-note" v-if="!err">
      一条请假 = <b>一个场次</b>（如「周三 · 午间」），不按整天关。<br />
      批准只改请假状态，<b>不立刻动班表</b>；班表上那一格空出来是下次生成时按已批请假过滤的结果。
    </div>

    <div class="pv-tabs">
      <button :class="{ on: tab === 'pending' }" @click="tab = 'pending'">
        待批<span class="n">{{ list.length }}</span>
      </button>
      <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部周<span class="n">{{ list.length }}</span></button>
    </div>

    <div class="pv-card">
      <div class="pv-line" v-for="l in list" :key="l.id" @click="open(l)">
        <span class="pv-line-t">
          <b>{{ l.personName }} · {{ l.slot }}</b>
          <i>{{ l.weekStart }} 那一周 · {{ l.day }} · 事由：{{ l.reason || '（没写）' }}</i>
        </span>
        <span class="pv-bd" :class="bdCls(l.status)">{{ l.statusText }}</span>
        <span class="ar">›</span>
      </div>
      <div class="pv-empty" v-if="!list.length">没有待批的请假。</div>
    </div>

    <!-- ══════ 处理一条 ══════ -->
    <div class="pv-sheet" v-if="cur">
      <div class="pv-mask" @click="cur = null"></div>
      <div class="pv-sheet-body tall">
        <div class="pv-grab"></div>
        <div class="pv-sh-hd">
          <b>{{ cur.personName }}</b>
          <span class="pv-bd warn">{{ cur.slot }}</span>
        </div>
        <p class="pv-sh-sub">{{ cur.weekStart }} 那一周 · {{ cur.day }} · {{ fmtDate(cur.createTime) }} 提交</p>

        <div class="pv-kv"><span class="k">请假事由</span><span class="v">{{ cur.reason || '（没写）' }}</span></div>

        <!-- 影响预览 -->
        <div class="pv-h">批了他，班表会怎样<span class="pv-h-r">只读推演，不会动数据</span></div>
        <div class="pv-card pad" v-if="impact">
          <div class="pv-kv" v-if="impact.willEmpty">
            <span class="k">会空出</span>
            <span class="v">{{ dayCn(impact.willEmpty.dayName) }} · {{ impact.willEmpty.slot }}（原 {{ impact.willEmpty.personName }}）</span>
          </div>
          <div class="pv-kv" v-else><span class="k">会空出</span><span class="v">这一周班表上本来就没有他 —— 班表不受影响</span></div>
          <div class="pv-kv">
            <span class="k">这一格</span>
            <span class="v">应到 {{ impact.slot.need }} 人 · 批后剩 {{ impact.slot.filled }} 人<template v-if="impact.slot.timeText"> · {{ impact.slot.timeText }}</template></span>
          </div>
          <div class="pv-kv">
            <span class="k">能补的人</span>
            <span class="v">
              <template v-if="impact.candidateCount">{{ impact.candidateCount }} 人可补（本周上限 {{ impact.limits.weekMax }} 场 / 当天上限 {{ impact.limits.dayMax }} 场）</template>
              <template v-else>没有人能补 —— 批了就是缺岗</template>
            </span>
          </div>
        </div>
        <div class="pv-empty" v-else-if="impactErr">{{ impactErr }}</div>
        <div class="pv-empty" v-else>推演中…</div>

        <template v-if="impact && impact.candidates && impact.candidates.length">
          <div class="pv-h">候选人<span class="pv-h-s">带原因，不再是「谁都能补」</span></div>
          <div class="pv-card">
            <div class="pv-line static" v-for="c in impact.candidates.slice(0, 12)" :key="c.personId">
              <span class="pv-line-t">
                <b>{{ c.name }}</b>
                <i>{{ c.department || '未填部门' }} · 本周 {{ c.weekShifts }} 场 · 当天 {{ c.dayShifts }} 场<template v-if="c.blocked"> · {{ c.blocked }}</template></i>
              </span>
              <span class="pv-bd" :class="c.ok ? 'ok' : 'off'">{{ c.ok ? '可补' : '不可' }}</span>
            </div>
          </div>
        </template>

        <div class="pv-h">驳回理由<span class="pv-h-s">批准不用写，驳回必填</span></div>
        <textarea class="pv-ta" v-model="rejectReason" rows="2" maxlength="200" placeholder="驳回时写清楚为什么"></textarea>

        <div class="pv-btnrow">
          <button class="pv-btn primary" :disabled="busy" @click="review(true)">{{ busy ? '处理中…' : '批准' }}</button>
          <button class="pv-btn danger" :disabled="busy" @click="review(false)">驳回</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';

const DAY = { 周一: '周一', 周二: '周二', 周三: '周三', 周四: '周四', 周五: '周五' };

const err = ref('');
const loadError = ref('');
const tab = ref('pending');
const list = ref([]);
const counts = reactive({ pending: 0, approved: 0, rejected: 0 });
const cur = ref(null);
const impact = ref(null);
const impactErr = ref('');
const rejectReason = ref('');
const busy = ref(false);

const bdCls = (s) => ({ 0: 'warn', 1: 'ok', 2: 'err' }[Number(s)] || 'off');
const dayCn = (d) => DAY[d] || d || '当天';
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  err.value = '';
  loadError.value = '';
  try {
    const d = await http.get('/partner/leave/pending');
    list.value = d.list || [];
    counts.pending = (d.counts && d.counts.pending) || 0;
    counts.approved = (d.counts && d.counts.approved) || 0;
    counts.rejected = (d.counts && d.counts.rejected) || 0;
  } catch (e) {
    loadError.value = `请假列表读取失败：${e.message || '请重试'}`;
  }
}

async function open(l) {
  cur.value = l;
  impact.value = null;
  impactErr.value = '';
  rejectReason.value = '';
  try {
    impact.value = await http.get(`/partner/leave/${l.id}/impact`);
  } catch (e) {
    impactErr.value = `影响预览没拉到：${e.message || ''}`;
  }
}

async function review(approve) {
  if (!approve && String(rejectReason.value || '').trim().length < 1) {
    ElMessage.warning('驳回要写理由');
    return;
  }
  busy.value = true;
  try {
    await http.put(`/partner/leave/${cur.value.id}/review`, {
      approve, reason: String(rejectReason.value || '').trim(),
    });
    ElMessage.success(approve ? '已批准' : '已驳回');
    cur.value = null;
    await load();
  } catch (e) {
    ElMessage.error(e.message || '处理失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>
