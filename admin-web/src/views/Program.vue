<template>
  <div class="program-page">
    <!-- ══════════ 本周 7 天条（常规栏目按 weekdays 归日，特别档按自己的日期） ══════════ -->
    <div class="weekstrip">
      <div class="day" v-for="d in week" :key="d.date" :class="{ on: d.isToday }">
        <div class="w">{{ d.label }}<template v-if="d.isToday"> · 今天</template></div>
        <div class="d num">{{ d.dayNum }}</div>
        <div class="n">{{ d.count ? d.count + ' 档' : '暂无' }}</div>
      </div>
    </div>

    <!-- ══════════ 工具栏 ══════════ -->
    <div class="toolbar">
      <div class="filters">
        <button class="filter" :class="{ on: tab === 0 }" @click="setTab(0)">全部 <span class="num">{{ counts.all }}</span></button>
        <button class="filter" :class="{ on: tab === 1 }" @click="setTab(1)">直播中 <span class="num">{{ counts.live }}</span></button>
        <button class="filter" :class="{ on: tab === 2 }" @click="setTab(2)">已展示 <span class="num">{{ counts.shown }}</span></button>
        <button class="filter" :class="{ on: tab === 3 }" @click="setTab(3)">已隐藏 <span class="num">{{ counts.hidden }}</span></button>
      </div>
      <div class="tail">
        <div class="search-in">
          <IconSearch :size="14" />
          <input v-model="query.keyword" placeholder="搜索栏目 / 主持人" @keyup.enter="search" />
        </div>
        <!-- 播出编排：改每天几个时段、每段几档；改完所有栏目时间自动跟着走 -->
        <el-tooltip content="改每天有哪几个时段、每个时段几档" placement="top" :show-after="300">
          <el-button class="pill-btn" @click="openCfg">播出编排</el-button>
        </el-tooltip>
        <el-button type="primary" class="pill-btn" @click="openEdit(null)">
          <IconPlus :size="15" class="btn-icon" />新建栏目
        </el-button>
      </div>
    </div>

    <!-- ══════════ 节目列表 ══════════ -->
    <div class="card-flush" v-if="loading">
      <div class="sk-row" v-for="i in 4" :key="i">
        <span class="sk" style="width:104px;height:14px"></span>
        <div class="sk-col">
          <span class="sk sk-title" style="width:30%"></span>
          <span class="sk sk-cap" style="width:42%"></span>
        </div>
        <span class="sk sk-tag"></span>
        <span class="sk" style="width:64px;height:26px;border-radius:8px"></span>
      </div>
    </div>

    <div class="card-flush" v-else-if="rows.length">
      <div
        class="crow" v-for="row in rows" :key="row.id"
        :class="{ dark: row.isLive === 1 }"
      >
        <!-- 时间列：周几 + 哪个时段的第几档 + 推算出的起止 -->
        <div class="time">
          <div class="l1">
            <span class="el">{{ whenText(row) }}</span>
            <!-- ⚠️ 必须连 slotIndex 一起判：改造前录入的老栏目没有档位，
                 只判 isSpecial 会留下一个空的灰色小方块（min-width 16px） -->
            <span class="cn" v-if="row.isSpecial !== 1 && row.slotIndex">{{ row.slotIndex }}</span>
          </div>
          <div class="l2">{{ timeText(row) }}</div>
        </div>
        <div class="grow">
          <div class="rowc">
            <span class="strong el">{{ row.title }}</span>
            <span class="tag tag-live" v-if="row.isLive === 1">直播中</span>
            <span class="tag tag-sp" v-if="row.isSpecial === 1">特别档</span>
          </div>
          <div class="micro el" style="margin-top:3px">
            {{ row.host ? '主持人 ' + row.host : '主持人未定 · 待分配' }}
            <template v-if="row.desc"> · {{ row.desc }}</template>
          </div>
        </div>
        <span class="tag" v-if="row.isLive !== 1" :class="row.isShow === 1 ? 'tag-pass' : 'tag-mute'">
          {{ row.isShow === 1 ? '已展示' : '已隐藏' }}
        </span>
        <div class="rowact">
          <template v-if="row.isLive === 1">
            <el-button size="small" class="end-btn" @click="toggleLive(row, false)">结束直播</el-button>
            <el-button size="small" class="ghost-btn" @click="openEdit(row)">编辑</el-button>
          </template>
          <template v-else>
            <el-tooltip content="编辑" placement="top" :show-after="300">
              <button class="iconmini" @click="openEdit(row)"><IconEdit :size="15" /></button>
            </el-tooltip>
            <el-tooltip content="删除" placement="top" :show-after="300">
              <button class="iconmini danger" @click="remove(row)"><IconTrash :size="15" /></button>
            </el-tooltip>
          </template>
        </div>
      </div>
    </div>

    <div class="card-flush" v-else>
      <EmptyState variant="content" title="暂无节目" description="点击右上角「新建栏目」创建第一档节目" />
    </div>

    <el-pagination
      v-model:current-page="query.page"
      v-model:page-size="query.pageSize"
      :total="total"
      layout="total, prev, pager, next"
      class="pager"
      @current-change="fetch"
    />

    <!-- ══════════ 待处理：缺主持人的节目 ══════════ -->
    <div class="sec" v-if="noHost.length">
      <div class="sec-head">
        <span class="sec-title">待处理</span>
        <span class="micro">共 {{ noHost.length }} 条</span>
      </div>
      <div class="card-flush">
        <div class="crow" v-for="row in noHost" :key="'h' + row.id">
          <span class="av">!</span>
          <div class="grow">
            <div class="strong el">「{{ row.title }}」还没有主持人</div>
            <div class="micro" style="margin-top:3px">节目会在小程序「本周节目单」中显示为「主持人未定」</div>
          </div>
          <a class="link" @click="openEdit(row)">去分配</a>
        </div>
      </div>
    </div>

    <!-- ══════════ 新建 / 编辑 ══════════ -->
    <el-dialog v-model="dialog" :title="form.id ? '编辑栏目' : '新建栏目'" width="580px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="节目名" required><el-input v-model="form.title" /></el-form-item>
        <el-form-item label="主持人"><el-input v-model="form.host" placeholder="留空则小程序显示「主持人未定」" /></el-form-item>

        <el-form-item label="档期类型" required>
          <div class="kinds">
            <button type="button" class="k" :class="{ on: form.isSpecial === 0 }" @click="form.isSpecial = 0">常规栏目</button>
            <button type="button" class="k" :class="{ on: form.isSpecial === 1 }" @click="form.isSpecial = 1">特别节目档</button>
            <span class="k-hint">{{ form.isSpecial === 0 ? '每周固定循环播出' : '只在某一天播的专场' }}</span>
          </div>
        </el-form-item>

        <el-form-item label="播出安排" required v-if="form.isSpecial === 0">
          <div class="slotbox">
            <div class="grp">
              <div class="grp-cap"><span class="grp-name">每周哪天</span><span class="grp-hint">可多选</span></div>
              <div class="days">
                <button
                  type="button" v-for="d in 7" :key="d"
                  :class="{ on: form.weekdays.includes(d) }"
                  @click="toggleDay(d)"
                >周{{ '一二三四五六日'[d - 1] }}</button>
              </div>
            </div>

            <div class="grp">
              <div class="grp-cap">
                <span class="grp-name">哪个时段</span>
                <span class="grp-hint">与点歌共用一套</span>
                <a class="cfg-link" @click="openCfg">编排时段 / 档数 →</a>
              </div>
              <div class="slots">
                <button
                  type="button" v-for="s in slots" :key="s.label"
                  :class="{ on: form.slotLabel === s.label }"
                  @click="pickSlot(s)"
                >
                  <span class="nm">{{ s.label }}</span>
                  <span class="mt">{{ s.start }}-{{ s.end }} · {{ s.count }} 档</span>
                </button>
              </div>
            </div>

            <div class="grp">
              <div class="grp-cap">
                <span class="grp-name">第几档</span>
                <span class="grp-hint">{{ ordHint }}</span>
              </div>
              <div class="ords">
                <button
                  type="button" v-for="t in curTicks" :key="t.index"
                  :class="{ on: form.slotIndex === t.index, taken: isTaken(t.index) }"
                  @click="form.slotIndex = t.index"
                >
                  <span class="o">第 {{ t.index }} 档</span>
                  <span class="tm">{{ t.start }}</span>
                </button>
              </div>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="播出日期" required v-if="form.isSpecial === 1">
          <el-date-picker v-model="form.broadcastDate" type="date" value-format="YYYY-MM-DD" style="width:100%;" />
          <div class="sub">只在这一天播一次，播完不会自动出现在下周节目单</div>
        </el-form-item>

        <el-form-item label="播出时间" v-if="form.isSpecial === 1">
          <el-input v-model="form.broadcastTime" placeholder="如 19:00-20:30" />
        </el-form-item>

        <el-form-item label="简介"><el-input v-model="form.desc" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="封面">
          <ImageUpload v-model="form.cover" shape="rect" :max-edge="900" :budget-bytes="70 * 1024"
            :disabled="!canUploadCover" :allow-url="canUploadCover"
            :hint="canUploadCover ? 'jpg/png/webp，16:9 横图最好；选填' : '封面由超管上传'" />
        </el-form-item>
        <el-form-item label="是否展示">
          <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>

      <!-- 结果预览：直接给小程序节目单里的样子 -->
      <div class="out">
        <div class="out-cap">小程序「本周节目单」里会这样出现</div>
        <template v-if="form.isSpecial === 1">
          <div class="out-item" v-if="form.broadcastDate">
            <span class="wd">{{ fmtDate(form.broadcastDate) }}</span>
            <span class="tm">{{ form.broadcastTime || '时间待定' }}</span>
            <span class="nm">《{{ form.title || '节目名' }}》</span>
          </div>
          <div class="out-warn" v-else>先选播出日期</div>
        </template>
        <template v-else>
          <div class="out-item" v-for="d in form.weekdays.slice().sort((a, b) => a - b)" :key="d">
            <span class="wd">周{{ '一二三四五六日'[d - 1] }}</span>
            <span class="tm">{{ form.slotLabel }} {{ curTickText }}</span>
            <span class="nm">《{{ form.title || '节目名' }}》</span>
          </div>
          <div class="out-warn" v-if="!form.weekdays.length">先选周几，否则这档节目不会出现在任何一天</div>
        </template>
        <div class="out-tip" v-if="clashTip">{{ clashTip }}</div>
      </div>

      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 播出编排 ══════════ -->
    <el-dialog v-model="cfgDialog" width="672px">
      <template #header>
        <div class="cfg-dlg-hd">
          <span class="t">播出编排</span>
          <span class="only">超管可改</span>
        </div>
      </template>

      <p class="cfg-lead">
        每天有哪几个时段、每个时段分几档 —— 都在这里定。<br>
        新建栏目时的「第几档」按这里的配置生成，不写死。
      </p>

      <div class="cfg-head">
        <span class="c1">时段</span><span class="c2">起点</span><span class="c3">终点</span><span class="c4">分几档</span>
      </div>

      <div class="cfg-rows">
        <div class="cfg-blk" v-for="(s, i) in cfgForm" :key="i">
          <div class="cfgr">
            <span class="c1"><el-input v-model="s.label" maxlength="4" placeholder="午间" :disabled="!canEditCfg" /></span>
            <span class="c2"><el-time-select v-model="s.start" start="06:00" step="00:05" end="23:00" :disabled="!canEditCfg" /></span>
            <span class="c3"><el-time-select v-model="s.end" start="06:00" step="00:05" end="23:30" :disabled="!canEditCfg" /></span>
            <span class="c4">
              <el-input-number v-model="s.count" :min="1" :max="maxCount" size="small" :disabled="!canEditCfg" />
              <span class="unit">档</span>
            </span>
            <span class="del" :class="{ disabled: !canEditCfg || cfgForm.length <= 1 }" @click="delSlot(i)">删除</span>
          </div>
          <div class="tickline">
            <span class="times">{{ ticksOf(s).map(t => t.start).join(' · ') || '—' }}</span>
            <span class="dur" v-if="ticksOf(s).length">共 {{ minutesOf(s) }} 分钟</span>
          </div>
        </div>
      </div>

      <div class="cfg-add">
        <el-button :disabled="!canEditCfg || cfgForm.length >= maxSlots" @click="addSlot">
          <IconPlus :size="14" class="btn-icon" />加一个时段
        </el-button>
        <span class="micro">最多 {{ maxSlots }} 个时段</span>
      </div>

      <div class="cfg-note">
        <div class="li"><i>·</i><span>每档时长由「起点 → 终点 ÷ 档数」自动算：午间 12:10-12:30 三档 = 12:10 / 12:17 / 12:24。</span></div>
        <div class="li"><i>·</i><span>改档数或时间后，<b>已排好的栏目不会被删</b>，但档位不存在了的会标红提示你重新分配。</span></div>
      </div>

      <template #footer>
        <div class="cfg-ft">
          <span class="sum">{{ cfgForm.length }} 个时段、{{ cfgTotal }} 个档位</span>
          <el-button @click="cfgDialog = false">取消</el-button>
          <el-button type="primary" :loading="cfgSaving" :disabled="!canEditCfg" @click="saveCfg">保存编排</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { IconSearch, IconPlus, IconEdit, IconTrash } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';
import ImageUpload from '@/components/ImageUpload.vue';
import { useAuthStore } from '@/stores/auth';

const WEEK_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const query = reactive({ page: 1, pageSize: 200, keyword: '' });
const auth = useAuthStore();
const canUploadCover = computed(() => !!auth.isSuperAdmin);
const canEditCfg = computed(() => !!auth.isSuperAdmin);

const rows = ref([]);
const allRows = ref([]);
const total = ref(0);
const loading = ref(false);
const tab = ref(0);
const dialog = ref(false);

const form = reactive({
  id: null, title: '', host: '',
  isSpecial: 0,
  weekdays: [1],
  slotLabel: '午间',
  slotIndex: 1,
  broadcastDate: '',
  broadcastTime: '',
  desc: '', cover: '', sort: 0, isShow: 1,
});

const counts = reactive({ all: 0, live: 0, shown: 0, hidden: 0 });

/* ─────────── 播出编排 ─────────── */
const slots = ref([]);           // 服务端下发（含 ticks）
const maxSlots = ref(6);
const maxCount = ref(6);
const cfgDialog = ref(false);
const cfgForm = ref([]);
const cfgSaving = ref(false);
const cfgTotal = computed(() => cfgForm.value.reduce((a, b) => a + (Number(b.count) || 0), 0));

/** 与后端 programSlotService.slotTicks 完全同构（服务端为准，这里只是让界面即时响应） */
function ticksOf(s) {
  const toMin = (h) => {
    const p = String(h || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  };
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const toHHMM = (m) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  const a = toMin(s.start);
  const b = toMin(s.end);
  const total = b - a;
  const n = Math.max(1, parseInt(s.count, 10) || 1);
  if (total <= 0) return [];
  const dur = Math.max(1, Math.round(total / n));
  const out = [];
  for (let i = 0; i < n; i++) {
    const st = Math.min(a + i * dur, b - 1);
    const en = i === n - 1 ? b : Math.min(st + dur, b);
    out.push({ index: i + 1, start: toHHMM(st), end: toHHMM(en), text: toHHMM(st) + '-' + toHHMM(en) });
  }
  return out;
}
function minutesOf(s) {
  const toMin = (h) => {
    const p = String(h || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  };
  return Math.max(0, toMin(s.end) - toMin(s.start));
}

const curSlot = computed(() => slots.value.find((s) => s.label === form.slotLabel) || null);
const curTicks = computed(() => (curSlot.value ? curSlot.value.ticks : []));
const curTick = computed(() => curTicks.value.find((t) => t.index === form.slotIndex) || null);
const curTickText = computed(() => (curTick.value ? curTick.value.text : '时间待定'));

const ordHint = computed(() => {
  const s = curSlot.value;
  if (!s) return '';
  return '虚线的是已排；' + s.label + '共 ' + s.count + ' 档';
});

/** 这个档位在所选某一天是否已经排了别的栏目 */
function isTaken(index) {
  return form.weekdays.some((d) =>
    allRows.value.some((r) =>
      r.isSpecial !== 1 &&
      Number(r.id) !== Number(form.id) &&
      String(r.weekdays || '').split(',').indexOf(String(d)) >= 0 &&
      r.slotLabel === form.slotLabel &&
      Number(r.slotIndex) === Number(index)
    )
  );
}

const clashTip = computed(() => {
  if (form.isSpecial === 1) return '';
  if (!form.weekdays.length) return '';
  const hitDays = form.weekdays.filter((d) =>
    allRows.value.some((r) =>
      r.isSpecial !== 1 &&
      Number(r.id) !== Number(form.id) &&
      String(r.weekdays || '').split(',').indexOf(String(d)) >= 0 &&
      r.slotLabel === form.slotLabel &&
      Number(r.slotIndex) === Number(form.slotIndex)
    )
  );
  if (!hitDays.length) return '';
  return WEEK_CN.map((n, i) => (hitDays.includes(i + 1) ? n : '')).filter(Boolean).join('、') +
    ' 的 ' + form.slotLabel + '第 ' + form.slotIndex + ' 档 已经排了别的栏目，保存会撞档。';
});

/* ─────────── 列表 ─────────── */
/** 周几文案：连续 3 天以上压成「周一至周五」 */
function weekdayText(v) {
  const arr = String(v || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
  if (!arr.length) return '未排期';
  if (arr.length >= 3) {
    const seq = arr.every((v2, i) => i === 0 || v2 === arr[i - 1] + 1);
    if (seq) return WEEK_CN[arr[0] - 1] + '至' + WEEK_CN[arr[arr.length - 1] - 1];
  }
  return arr.map((n) => WEEK_CN[n - 1]).join(' · ');
}

function fmtDate(str) {
  const p = String(str || '').split('-');
  if (p.length !== 3) return str || '';
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  if (isNaN(d.getTime())) return str;
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${+p[1]} 月 ${+p[2]} 日 ${w}`;
}

/** 时间列第一行：常规→周几；特别档→日期 */
function whenText(row) {
  if (row.isSpecial === 1) return fmtDate(row.broadcastDate);
  return weekdayText(row.weekdays);
}

/** 时间列第二行：时段 + 起止（后端已按当前编排算好，直接用） */
function timeText(row) {
  const t = String(row.broadcastTime || '').trim();
  if (row.isSpecial === 1) return t || '时间待定';
  return (row.slotLabel ? row.slotLabel + ' ' : '') + (t || '待定');
}

/** 本周周一到周日 + 每天档数 */
const week = computed(() => {
  const today = dayjs().format('YYYY-MM-DD');
  const monday = dayjs().startOf('week').add(1, 'day');
  return Array.from({ length: 7 }, (_, i) => {
    const d = monday.add(i, 'day');
    const date = d.format('YYYY-MM-DD');
    const wd = i + 1;
    const count = allRows.value.filter((r) => {
      if (r.isSpecial === 1) return String(r.broadcastDate || '').slice(0, 10) === date;
      return String(r.weekdays || '').split(',').indexOf(String(wd)) >= 0;
    }).length;
    return { label: WEEK_CN[i], dayNum: d.date(), date, isToday: date === today, count };
  });
});

const noHost = computed(() => allRows.value.filter((r) => !r.host && r.isShow === 1));

async function fetch() {
  loading.value = true;
  try {
    const d = await http.get('/admin/program/list', { params: { page: 1, pageSize: 200 } });
    allRows.value = d.list || [];
    counts.all = d.total ?? allRows.value.length;
    counts.live = allRows.value.filter((r) => r.isLive === 1).length;
    counts.shown = allRows.value.filter((r) => r.isShow === 1 && r.isLive !== 1).length;
    counts.hidden = allRows.value.filter((r) => r.isShow !== 1).length;

    let list = allRows.value.slice();
    if (tab.value === 1) list = list.filter((r) => r.isLive === 1);
    if (tab.value === 2) list = list.filter((r) => r.isShow === 1 && r.isLive !== 1);
    if (tab.value === 3) list = list.filter((r) => r.isShow !== 1);

    const kw = String(query.keyword || '').trim();
    if (kw) list = list.filter((r) => String(r.title || '').includes(kw) || String(r.host || '').includes(kw));

    rows.value = list;
    total.value = list.length;
  } finally { loading.value = false; }
}

function setTab(v) { tab.value = v; query.page = 1; fetch(); }
function search() { query.page = 1; fetch(); }

/* ─────────── 编排读写 ─────────── */
async function fetchSlots() {
  try {
    const d = await http.get('/admin/program/slots');
    slots.value = d.list || [];
    maxSlots.value = d.maxSlots || 6;
    maxCount.value = d.maxCount || 6;
  } catch (e) {
    slots.value = [];
  }
}

function openCfg() {
  cfgForm.value = slots.value.map((s) => ({ label: s.label, start: s.start, end: s.end, count: s.count }));
  if (!cfgForm.value.length) cfgForm.value = [{ label: '午间', start: '12:10', end: '12:30', count: 3 }];
  cfgDialog.value = true;
}

function addSlot() {
  if (cfgForm.value.length >= maxSlots.value) return;
  cfgForm.value.push({ label: '新时段', start: '20:00', end: '20:30', count: 2 });
}

function delSlot(i) {
  if (cfgForm.value.length <= 1) return;
  cfgForm.value.splice(i, 1);
}

async function saveCfg() {
  cfgSaving.value = true;
  try {
    await http.put('/admin/program/slots', { list: cfgForm.value });
    ElMessage.success('编排已保存');
    cfgDialog.value = false;
    await fetchSlots();
    // 编排变了 ⇒ 每条栏目的 broadcastTime 都要重算，列表必须重拉
    await fetch();
  } catch (e) {
    /* http 层已提示 */
  } finally { cfgSaving.value = false; }
}

/* ─────────── 新建 / 编辑 ─────────── */
function toggleDay(d) {
  const i = form.weekdays.indexOf(d);
  if (i >= 0) form.weekdays.splice(i, 1);
  else form.weekdays.push(d);
}

function pickSlot(s) {
  form.slotLabel = s.label;
  if (form.slotIndex > s.count) form.slotIndex = s.count;
}

function openEdit(row) {
  if (row) {
    Object.assign(form, {
      id: row.id,
      title: row.title || '',
      host: row.host || '',
      isSpecial: Number(row.isSpecial) === 1 ? 1 : 0,
      weekdays: String(row.weekdays || '').split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 7),
      slotLabel: row.slotLabel || (slots.value[0] ? slots.value[0].label : '午间'),
      slotIndex: Number(row.slotIndex) || 1,
      broadcastDate: String(row.broadcastDate || '').slice(0, 10),
      broadcastTime: row.broadcastTime || '',
      desc: row.desc || '',
      cover: row.cover || '',
      sort: row.sort || 0,
      isShow: row.isShow === undefined ? 1 : row.isShow,
    });
    // 老数据（改造前录入的）没有 weekdays：把它的日期换算成周几，避免存一次就丢
    if (form.isSpecial === 0 && !form.weekdays.length && form.broadcastDate) {
      const wd = new Date(form.broadcastDate + 'T00:00:00').getDay();
      form.weekdays = [wd === 0 ? 7 : wd];
    }
  } else {
    Object.assign(form, {
      id: null, title: '', host: '', isSpecial: 0,
      weekdays: [1],
      slotLabel: slots.value[0] ? slots.value[0].label : '午间',
      slotIndex: 1,
      broadcastDate: '', broadcastTime: '',
      desc: '', cover: '', sort: 0, isShow: 1,
    });
  }
  dialog.value = true;
}

async function save() {
  if (!form.title.trim()) return ElMessage.warning('请填写节目名');
  if (form.isSpecial === 0) {
    if (!form.weekdays.length) return ElMessage.warning('请选择每周哪几天播出');
    if (!form.slotLabel) return ElMessage.warning('请选择播出时段');
    if (!form.slotIndex) return ElMessage.warning('请选择第几档');
  } else {
    if (!form.broadcastDate) return ElMessage.warning('请选择播出日期');
  }

  const payload = {
    title: form.title.trim(),
    host: form.host,
    isSpecial: form.isSpecial,
    weekdays: form.weekdays.join(','),
    slotLabel: form.slotLabel,
    slotIndex: form.slotIndex,
    broadcastDate: form.broadcastDate,
    broadcastTime: form.broadcastTime,
    desc: form.desc,
    cover: form.cover,
    sort: form.sort,
    isShow: form.isShow,
  };

  try {
    if (form.id) await http.put(`/admin/program/${form.id}`, payload);
    else await http.post('/admin/program/create', payload);
    ElMessage.success('已保存');
    dialog.value = false;
    fetch();
  } catch (e) {
    /* http 层已提示 */
  }
}

async function remove(row) {
  await ElMessageBox.confirm(`删除「${row.title}」？小程序节目单会同时移除。`, '删除节目', { type: 'warning', confirmButtonText: '删除' });
  await http.delete(`/admin/program/${row.id}`);
  ElMessage.success('已删除');
  fetch();
}

async function toggleLive(row, val) {
  await http.put(`/admin/program/${row.id}/live`, { isLive: val ? 1 : 0 });
  ElMessage.success(val ? '已设为正在直播' : '已结束直播');
  fetch();
}

onMounted(async () => {
  await fetchSlots();
  await fetch();
});
</script>

<style scoped>
.program-page { display: flex; flex-direction: column; gap: 18px; }
.grow { flex: 1; min-width: 0; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowc { display: flex; align-items: center; gap: 8px; min-width: 0; }
.btn-icon { margin-right: 4px; vertical-align: -2px; }

/* ══════════ 本周 7 天条 ══════════ */
.weekstrip { display: flex; gap: 8px; }
.day {
  flex: 1; text-align: center; padding: 10px 0 9px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-card);
}
.day.on { background: var(--ink); border-color: var(--ink); }
.day .w { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); }
.day .d { font-size: var(--fs-2xl); font-weight: 600; color: var(--ink); margin-top: 2px; }
.day .n { font-size: var(--fs-xs); color: var(--muted-2); margin-top: 1px; }
.day.on .w, .day.on .n { color: rgba(255, 255, 255, 0.72); }
.day.on .d { color: #fff; }

/* ══════════ 工具栏 ══════════ */
.toolbar { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
.tail { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.search-in {
  display: flex; align-items: center; gap: 8px;
  height: 36px; width: 210px; padding: 0 14px;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); color: var(--soft);
}
.search-in input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-family: inherit; font-size: var(--fs-sm); color: var(--ink); }
.search-in input::placeholder { color: var(--soft); }
.filters { display: inline-flex; gap: 8px; }
.filter {
  height: 30px; padding: 0 14px; cursor: pointer;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--ink-2);
}
.filter:hover { border-color: var(--soft); }
.filter.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.filter .num { opacity: 0.7; margin-left: 3px; }
.pill-btn.el-button { border-radius: var(--r-pill); }

/* ══════════ 列表行 ══════════ */
.card-flush { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); overflow: hidden; }
.crow { display: flex; align-items: center; gap: 14px; padding: 13px 20px; }
.crow + .crow { border-top: 1px solid var(--divider); }
.crow.dark { background: var(--tile); border-color: var(--tile); }
.time { width: 168px; flex: none; }
.time .l1 { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--ink); font-size: var(--fs-md); min-width: 0; }
.time .l1 .cn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; height: 16px; padding: 0 3px; border-radius: 4px; flex: none;
  background: var(--divider); color: var(--ink-2);
  font-size: 10.5px; font-family: var(--mono); font-weight: 600;
}
.time .l2 { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted-2); margin-top: 3px; letter-spacing: 0.4px; }
.crow.dark .time .l1 { color: #fff; }
.crow.dark .time .l1 .cn { background: rgba(255, 255, 255, 0.16); color: #fff; }
.crow.dark .time .l2 { color: #ccc; }
.strong { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.crow.dark .strong { color: #fff; }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.7; }
.crow.dark .micro { color: #ccc; }

.tag { display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: var(--r-pill); font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm); flex: none; }
.tag-live { background: var(--live); color: #fff; }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }
.tag-sp { background: var(--amber-bg); color: var(--amber-fg); }

.rowact { display: flex; align-items: center; gap: 4px; flex: none; }
.iconmini {
  width: 28px; height: 28px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: var(--muted);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.iconmini:hover { background: var(--parchment); color: var(--ink); }
.iconmini.danger:hover { background: var(--red-bg); color: var(--red-fg); }
.end-btn.el-button { background: #fff !important; background-image: none !important; border: none !important; color: var(--accent) !important; font-weight: 600; border-radius: var(--r-pill); }
.ghost-btn.el-button,
.ghost-btn.el-button:hover { background: transparent !important; background-image: none !important; border: 1px solid var(--accent-dark) !important; color: var(--accent-dark) !important; border-radius: var(--r-pill); }

/* 待处理 */
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); }
.av {
  width: 32px; height: 32px; border-radius: 50%; flex: none;
  background: var(--red-bg); color: var(--red-fg);
  display: inline-flex; align-items: center; justify-content: center; font-weight: 600;
}
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; }
.link:hover { text-decoration: underline; }

/* ══════════ 播出安排（弹窗内） ══════════ */
.kinds { display: flex; align-items: center; gap: 8px; }
.kinds .k {
  height: 32px; padding: 0 16px; cursor: pointer;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
}
.kinds .k.on { background: var(--acc-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.k-hint { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); }

.slotbox { width: 100%; padding: 13px 14px 14px; background: var(--parchment); border: 1px solid var(--divider); border-radius: var(--r-input); }
.grp + .grp { margin-top: 12px; }
.grp-cap { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
.grp-name { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.grp-hint { font-size: 11px; color: var(--soft); letter-spacing: var(--ls-wide); }
.cfg-link { margin-left: auto; font-size: var(--fs-xs); color: var(--accent); cursor: pointer; }
.cfg-link:hover { text-decoration: underline; }

.days { display: flex; gap: 6px; }
.days button {
  flex: 1; min-width: 0; height: 32px; padding: 0; cursor: pointer;
  border: 1px solid var(--hairline); background: var(--canvas); border-radius: var(--r-pill);
  font-family: inherit; font-size: var(--fs-md); color: var(--ink-2);
}
.days button:hover { border-color: var(--soft); }
.days button.on { background: var(--acc-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }

.slots { display: flex; gap: 6px; }
.slots button {
  flex: 1; min-width: 0; height: 44px; padding: 0; cursor: pointer; line-height: 1.3;
  border: 1px solid var(--hairline); background: var(--canvas); border-radius: 10px;
  font-family: inherit; font-size: var(--fs-sm); color: var(--ink-2);
}
.slots button .nm { display: block; font-size: var(--fs-sm); }
.slots button .mt { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--muted-2); margin-top: 2px; }
.slots button:hover { border-color: var(--soft); }
.slots button.on { background: var(--acc-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.slots button.on .mt { color: var(--accent); }

.ords { display: flex; gap: 6px; flex-wrap: wrap; }
.ords button {
  flex: 1; min-width: 0; height: 40px; padding: 0; cursor: pointer; line-height: 1.25;
  border: 1px solid var(--hairline); background: var(--canvas); border-radius: 10px;
  font-family: inherit; font-size: var(--fs-sm); color: var(--ink-2);
}
.ords button .o { display: block; font-size: var(--fs-sm); }
.ords button .tm { display: block; font-family: var(--mono); font-size: 11px; color: var(--muted-2); margin-top: 2px; }
.ords button:hover { border-color: var(--soft); }
.ords button.on { background: var(--acc-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.ords button.on .tm { color: var(--accent); }
.ords button.taken { border-style: dashed; border-color: var(--soft); color: var(--muted-2); }
.ords button.taken .tm { color: var(--soft); }
.ords button.taken.on { border-style: solid; border-color: var(--accent); color: var(--accent); }
.ords button.taken.on .tm { color: var(--accent); }

.sub { font-size: var(--fs-xs); color: var(--muted-2); margin-top: 5px; letter-spacing: var(--ls-wide); }

/* 结果预览 */
.out { margin-top: 2px; padding: 12px 14px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-input); }
.out-cap { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide-sm); margin-bottom: 7px; }
.out-item { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: var(--fs-sm); color: var(--ink); }
.out-item + .out-item { border-top: 1px dashed var(--divider); }
.out-item .wd { font-weight: 600; min-width: 52px; }
.out-item .tm { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted-2); }
.out-item .nm { color: var(--muted-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.out-warn { font-size: var(--fs-sm); color: var(--red-fg); }
.out-tip { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--divider); font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.7; letter-spacing: var(--ls-wide); }

/* ══════════ 播出编排弹窗 ══════════ */
.cfg-dlg-hd { display: flex; align-items: center; gap: 10px; }
.cfg-dlg-hd .t { font-size: var(--fs-lg); font-weight: 600; letter-spacing: var(--ls-tight-sm); }
.cfg-dlg-hd .only {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
  border-radius: var(--r-pill); background: var(--amber-bg); color: var(--amber-fg);
  font-size: 11px; letter-spacing: 0.4px;
}
.cfg-lead { font-size: var(--fs-sm); color: var(--muted-2); line-height: 1.75; margin: 0 0 14px; letter-spacing: var(--ls-wide); }
.cfg-head { display: flex; align-items: center; padding: 0 10px; margin-bottom: 7px; }
.cfg-head span { font-size: 11px; color: var(--muted-2); letter-spacing: var(--ls-wide-sm); }
.cfg-head .c1 { width: 96px; }
.cfg-head .c2 { width: 132px; }
.cfg-head .c3 { width: 132px; }
.cfg-head .c4 { width: 104px; }

.cfg-rows { border: 1px solid var(--hairline); border-radius: var(--r-input); overflow: hidden; }
.cfg-blk + .cfg-blk { border-top: 1px solid var(--divider); }
.cfgr { display: flex; align-items: center; gap: 12px; padding: 11px 10px 8px; }
.cfgr .c1 { width: 96px; flex: none; }
.cfgr .c2 { width: 132px; flex: none; }
.cfgr .c3 { width: 132px; flex: none; }
.cfgr .c4 { width: 104px; flex: none; display: flex; align-items: center; gap: 5px; }
.cfgr .unit { font-size: var(--fs-xs); color: var(--muted-2); }
.cfgr .del { margin-left: auto; font-size: var(--fs-sm); color: var(--muted); cursor: pointer; letter-spacing: var(--ls-wide); }
.cfgr .del:hover { color: var(--red-fg); }
.cfgr .del.disabled { color: var(--soft); cursor: not-allowed; }

.tickline { display: flex; align-items: center; gap: 9px; padding: 0 10px 11px; }
.tickline .times { font-family: var(--mono); font-size: var(--fs-xs); color: var(--ink-2); letter-spacing: 0.4px; }
.tickline .dur { font-size: 11px; color: var(--muted-2); letter-spacing: var(--ls-wide); }

.cfg-add { display: flex; align-items: center; gap: 11px; margin-top: 11px; }
.cfg-add .micro { font-size: 11px; color: var(--muted-2); }

.cfg-note {
  margin-top: 14px; padding: 12px 14px; background: var(--parchment);
  border-radius: var(--r-input); font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.85;
}
.cfg-note .li { display: flex; gap: 7px; }
.cfg-note .li + .li { margin-top: 4px; }
.cfg-note .li i { font-style: normal; color: var(--soft); flex: none; }
.cfg-note b { color: var(--ink); font-weight: 600; }

.cfg-ft { display: flex; align-items: center; gap: 10px; }
.cfg-ft .sum { margin-right: auto; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); }

/* ══════════ v8 加载骨架 ══════════ */
.sk { position: relative; overflow: hidden; flex: none; border-radius: 6px; background: var(--divider); }
.sk::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: skSweep 1.4s var(--ease) infinite;
}
@keyframes skSweep { to { transform: translateX(100%); } }
.sk-tag { height: 22px; border-radius: var(--r-pill); }
.sk-title { height: 15px; }
.sk-cap { height: 10px; }
.sk-row { display: flex; align-items: center; gap: 13px; padding: 13px 20px; }
.sk-row + .sk-row { border-top: 1px solid rgba(0, 0, 0, 0.05); }
.sk-col { display: flex; flex-direction: column; gap: 9px; flex: 1; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .sk::after { animation: none; background: none; } }

.pager { margin-top: 4px; justify-content: flex-end; }
</style>
