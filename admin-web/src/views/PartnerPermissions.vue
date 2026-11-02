<template>
  <div class="ppm">
    <!-- ══════════ 保存失败常驻条 ══════════
         小程序端踩过的坑：只弹 1.5 秒 toast，人以为是按钮坏了。
         这里常驻到下一次保存成功为止，并且说清「开关已经拨回去了」。 -->
    <div class="tip err" v-if="saveError">
      <IconInfo :size="15" />
      <div>
        {{ saveError }}
        <button class="tip-lk" @click="load()">重新加载</button>
      </div>
    </div>

    <!-- 权限表还没建（云开发查不存在的集合是抛错，不是返回空）：不白屏、也不装没事 -->
    <div class="tip" v-if="buildNeeded">
      <IconInfo :size="15" />
      <div>权限表还没初始化。不影响用：拨一下下面任意一个开关，会自动把这张表建好并保存。</div>
    </div>

    <!-- ══════════ 统计 ══════════ -->
    <div class="stat">
      <b>{{ count.managers }}</b><span class="unit">位社干</span>
      <div class="stat-s">
        排班可用 <i>{{ count.scheduleOn }}</i> · 审核可用 <i>{{ count.reviewOn }}</i> · 代录可用 <i>{{ count.proxyOn }}</i><br />
        单独设置 <i>{{ count.overridden }}</i> 人 · 其余跟随总开关
      </div>
    </div>

    <!-- ══════════ ① 全局总开关 ══════════ -->
    <div class="card" v-loading="loading">
      <div class="card-hd">
        <b>总开关</b><i>对全体社干生效</i>
        <span class="r">关掉后只有单独开过的人能进</span>
      </div>
      <div class="grow" v-for="m in meta" :key="m.key">
        <div class="g-main">
          <div class="g-name">{{ m.name }}</div>
          <div class="g-desc">{{ m.desc }}</div>
        </div>
        <div class="g-count">
          生效 <b>{{ effCount(m.key) }}</b> / {{ count.managers }} 人
        </div>
        <button
          class="sw"
          :class="{ on: global[m.key], busy: isBusy('g', m.key) }"
          :aria-label="m.name"
          @click="toggleGlobal(m.key)"
        ></button>
      </div>
      <div class="empty" v-if="!meta.length && !loading">没读到权限位，点上面「重新加载」再试。</div>
    </div>

    <!-- ══════════ ② 按人分发 ══════════ -->
    <div class="card">
      <div class="card-hd">
        <b>按人分发</b><i>点一下就是单独开 / 单独关</i>
        <span class="r">只列启用中的社干</span>
      </div>

      <div class="thead">
        <span>成员</span>
        <span class="c" v-for="m in meta" :key="m.key">{{ m.short || m.name }}</span>
      </div>

      <div class="prow" v-for="p in people" :key="p.personId">
        <div class="who">
          <b>{{ p.name }}<em class="ovr" v-if="isOvr(p.over)">单独设置</em></b>
          <i>{{ p.username }}<template v-if="p.department"> · {{ p.department }}</template></i>
        </div>

        <!-- 三位：主胶囊＝当前生效值（点了就翻），下面小字说清「跟随」还是「单独设过」 -->
        <div class="cell" v-for="m in meta" :key="m.key">
          <button
            class="pill"
            :class="[
              effOf(p.over)[m.key] ? 'on' : 'off',
              { busy: isBusy(p.personId, m.key) },
            ]"
            @click="togglePerson(p, m.key)"
          >
            {{ effOf(p.over)[m.key] ? '可用' : '不可用' }}
          </button>
          <span class="cnote" v-if="isSingle(p.over, m.key)">
            <em class="lf">单独设置</em>
            <button class="lk" @click="follow(p, m.key)">跟回全局</button>
          </span>
          <span class="cnote" v-else>跟随总开关</span>
        </div>
      </div>

      <div class="empty" v-if="!people.length && !loading">
        还没有社干账号。去「账号管理」里从学生名册把人拉进来。
      </div>
    </div>

    <div class="tip">
      <IconInfo :size="15" />
      <div>生效规则：单独设过用单独那格，没设过跟总开关。</div>
    </div>
  </div>
</template>

<script setup>
/**
 * 管理端 web · 权限管理（超管）v1
 *
 * 和小程序端 `pages-partner/permissions/` 是**同一张表、同一套接口**：
 *   GET  /partner/permissions                 全局开关 + 社干名单（含生效值）
 *   PUT  /partner/permissions                 改全局总闸       body: { schedule?, review?, proxy? }
 *   PUT  /partner/permissions/person/:id      按人设置         body: { … }（null = 跟回全局）
 *
 * ⚠️ 权限位（名称 / 说明 / 顺序）**只从接口的 meta 拿**（源头 `_kit.PERM_TEXT`）。
 *    页面里不另存一份文案 —— 加第四位开关时这页自动跟上，也不会出现两端叫法不一样。
 * ⚠️ 权限不做草稿态：拨一下就落库。所以没有「保存」按钮，也不该有。
 * ⚠️ 三格各自一把小锁（`busy["<id>:<key>"]`），不是全局一把锁：
 *    全局锁会在连点第二位时把第二下静默吞掉（小程序端 2026-10-31 踩过，表现成「点不亮」）。
 * ⚠️ 保存失败必须**把开关拨回原位**再报错，否则界面在骗人。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { IconInfo } from '@/components/icons';
import { setPageHeader, clearPageHeader } from '@/utils/pageHeader';

/** 权限位的键序（与后端 `_kit.PERM_KEYS` 同序；只用来兜默认值，文案一律吃接口 meta） */
const KEYS = ['schedule', 'review', 'proxy'];
const BLANK_OVER = { schedule: null, review: null, proxy: null };

const loading = ref(false);
const saveError = ref('');
const buildNeeded = ref(false);
const global = ref({ schedule: true, review: true, proxy: true });
const meta = ref([]);
const people = ref([]);

/** 按格 / 按全局位的「保存中」标记：key = `g:<key>` 或 `<personId>:<key>` */
const busy = reactive({});
const bkey = (a, k) => `${a}:${k}`;
const isBusy = (a, k) => !!busy[bkey(a, k)];
function markBusy(a, k, v) {
  if (v) busy[bkey(a, k)] = true;
  else delete busy[bkey(a, k)];
}

/* ---------------- 生效值计算（与后端 effectivePerm 同一口径，别自己发明第三版） ---------------- */
function effOf(over) {
  const o = over || BLANK_OVER;
  const g = global.value || {};
  const out = {};
  KEYS.forEach((k) => {
    const v = o[k];
    out[k] = (v === true || v === false) ? v : !!g[k];
  });
  return out;
}
/** 这一位是不是「单独设过」 */
const isSingle = (over, k) => !!over && (over[k] === true || over[k] === false);
/** 这一行有没有任何一位单独设过 */
function isOvr(over) {
  return KEYS.some((k) => isSingle(over, k));
}

/* ---------------- 统计（本地算，拨完立刻准） ---------------- */
const count = computed(() => {
  const list = people.value;
  const on = (k) => list.filter((p) => effOf(p.over)[k]).length;
  return {
    managers: list.length,
    scheduleOn: on('schedule'),
    reviewOn: on('review'),
    proxyOn: on('proxy'),
    overridden: list.filter((p) => isOvr(p.over)).length,
  };
});
const effCount = (k) => people.value.filter((p) => effOf(p.over)[k]).length;

/* ---------------- 读取 ---------------- */
async function load() {
  loading.value = true;
  saveError.value = '';
  try {
    const d = await http.get('/partner/permissions');
    global.value = (d && d.global) || { schedule: true, review: true, proxy: true };
    meta.value = (d && d.meta) || [];
    people.value = ((d && d.people) || []).map((x) => ({
      personId: x.personId,
      name: x.name,
      username: x.username || '',
      department: x.department || '',
      over: { ...BLANK_OVER, ...(x.over || {}) },
    }));
    buildNeeded.value = !!(d && d.buildNeeded);
  } catch (e) {
    saveError.value = `加载失败：${(e && e.message) || '未知原因'}`;
  } finally {
    loading.value = false;
  }
}

/* ---------------- 改全局总闸 ---------------- */
async function toggleGlobal(key) {
  if (isBusy('g', key)) return;
  const prev = !!global.value[key];
  global.value = { ...global.value, [key]: !prev };
  markBusy('g', key, true);
  try {
    const d = await http.put('/partner/permissions', { [key]: !prev });
    if (d && d.global) global.value = d.global;
    saveError.value = '';
    buildNeeded.value = false;
  } catch (e) {
    global.value = { ...global.value, [key]: prev };   // 失败必须拨回去
    saveError.value = `保存失败：${(e && e.message) || '未知原因'}。开关已经拨回原来的位置。`;
    ElMessage.error((e && e.message) || '没保存成功');
  } finally {
    markBusy('g', key, false);
  }
}

/* ---------------- 按人拨一位 ---------------- */
function togglePerson(p, key) {
  if (isBusy(p.personId, key)) return;
  // 拨一下 = 显式设成「和当前生效值相反」；想跟回全局要点下面那行小字
  const next = !effOf(p.over)[key];
  savePerson(p.personId, { [key]: next });
}

/** 撤销这一位的单独设置，跟回全局 */
function follow(p, key) {
  if (isBusy(p.personId, key)) return;
  savePerson(p.personId, { [key]: null });
}

async function savePerson(personId, patch) {
  const key = Object.keys(patch)[0];
  const row = people.value.find((x) => Number(x.personId) === Number(personId));
  if (!row) return;
  const prevOver = { ...row.over };

  // 乐观更新：手指/鼠标下那一格立刻变，别等接口
  row.over = { ...row.over, ...patch };
  markBusy(personId, key, true);
  try {
    const d = await http.put(`/partner/permissions/person/${personId}`, patch);
    if (d && d.over) row.over = { ...BLANK_OVER, ...d.over };   // 以服务端为准
    saveError.value = '';
    buildNeeded.value = false;
  } catch (e) {
    row.over = prevOver;                                       // 失败回正
    saveError.value = `保存失败：${(e && e.message) || '未知原因'}。这一格已经恢复原样。`;
    ElMessage.error((e && e.message) || '没保存成功');
  } finally {
    markBusy(personId, key, false);
  }
}

onMounted(() => {
  setPageHeader({ subtitle: '社干能不能进排班工作台 / 审核 / 代录' });
  load();
});
onBeforeUnmount(clearPageHeader);
</script>

<style scoped>
/* 视觉口径照 v8：白卡 18px 圆角、accent #0066CC、文字 13.5/11.5，无深色块 */
.ppm { padding: 18px 16px 26px; max-width: 900px; }

/* 统计 */
.stat { display: flex; align-items: baseline; gap: 10px; margin: 0 0 16px; }
.stat b { font-size: 34px; font-weight: 600; letter-spacing: -1px; color: #0066cc; line-height: 1; }
.stat .unit { font-size: 12.5px; color: #76767e; }
.stat-s { margin-left: auto; font-size: 12px; color: #76767e; text-align: right; line-height: 1.5; }
.stat-s i { font-style: normal; color: #1d1d1f; font-weight: 500; font-variant-numeric: tabular-nums; }

/* 卡片 */
.card { background: #fff; border: 1px solid #eeeef2; border-radius: 18px; margin-bottom: 18px; overflow: hidden; }
.card-hd { display: flex; align-items: baseline; gap: 9px; padding: 15px 18px 11px; }
.card-hd b { font-size: 14px; font-weight: 600; color: #1d1d1f; }
.card-hd i { font-style: normal; font-size: 11.5px; color: #76767e; }
.card-hd .r { margin-left: auto; font-size: 11.5px; color: #8a8a90; }

/* 全局总闸 */
.grow { display: flex; align-items: center; gap: 14px; padding: 13px 18px; border-top: 1px solid #f0f0f0; }
.g-main { flex: 1; min-width: 0; }
.g-name { font-size: 13.5px; font-weight: 500; color: #1d1d1f; }
.g-desc { font-size: 11.5px; color: #76767e; margin-top: 3px; }
.g-count { font-size: 11.5px; color: #76767e; margin-right: 12px; font-variant-numeric: tabular-nums; }
.g-count b { color: #0066cc; font-weight: 600; }

/* 开关 40×24（自绘，不用 el-switch：尺寸和 v8 原型对不上） */
.sw {
  width: 40px; height: 24px; border-radius: 9999px; background: #e5e5ea; border: 0; padding: 0;
  position: relative; cursor: pointer; flex: none; transition: background 0.18s;
}
.sw::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); transition: transform 0.18s;
}
.sw.on { background: #0066cc; }
.sw.on::after { transform: translateX(16px); }
.sw.busy { opacity: 0.5; pointer-events: none; }

/* 按人表 */
.thead, .prow {
  display: grid; grid-template-columns: minmax(0, 1fr) 122px 122px 122px;
  align-items: center; gap: 10px;
}
.thead { padding: 9px 18px; border-top: 1px solid #f0f0f0; border-bottom: 1px solid #f0f0f0; }
.thead span { font-size: 10.5px; color: #76767e; letter-spacing: 0.3px; }
.thead span.c { text-align: center; }
.prow { padding: 11px 18px; border-bottom: 1px solid #f5f5f7; }
.prow:last-child { border-bottom: 0; }
.prow:hover { background: #fafafb; }
.who { min-width: 0; }
.who b { display: block; font-size: 13.5px; font-weight: 500; color: #1d1d1f; line-height: 1.35; }
.who i {
  display: block; font-style: normal; font-size: 11px; color: #76767e; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.who .ovr {
  display: inline-block; font-style: normal; font-size: 9.5px; font-weight: 500;
  color: #0066cc; background: #e6f0fa; border-radius: 9999px; padding: 1px 6px;
  margin-left: 6px; vertical-align: 1px;
}

/* 单格：胶囊 + 一行小字 */
.cell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pill {
  width: 100%; max-width: 96px; height: 28px; border-radius: 9999px; border: 1px solid transparent;
  font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.14s, color 0.14s, border-color 0.14s;
}
.pill.on { background: #e6f0fa; color: #0066cc; border-color: #cfe3f8; }
.pill.off { background: #f0f0f3; color: #8a8a90; }
.pill:hover { border-color: #0066cc; }
.pill.busy { opacity: 0.5; pointer-events: none; }
.cnote { font-size: 10px; color: #76767e; line-height: 1; height: 12px; white-space: nowrap; }
.cnote .lf { font-style: normal; color: #9a9aa2; }
.cnote .lk {
  background: none; border: 0; padding: 0; font-family: inherit; font-size: 10px;
  color: #0066cc; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}

/* 提示条 */
.tip {
  display: flex; gap: 9px; align-items: flex-start; padding: 11px 14px;
  background: #f5f5f7; border-radius: 12px; font-size: 12px; color: #333; line-height: 1.6;
}
.tip :deep(svg) { flex: none; margin-top: 1px; color: #76767e; }
.tip.err { background: #fde8e8; color: #b42318; margin-bottom: 16px; }
.tip.err :deep(svg) { color: #b42318; }
.tip-lk {
  background: none; border: 0; padding: 0; margin-left: 4px; font-family: inherit;
  font-size: 12px; color: #b42318; text-decoration: underline; cursor: pointer;
}
.empty { padding: 30px 18px; text-align: center; font-size: 12.5px; color: #8a8a90; }
</style>
