<template>
  <div class="ppm" v-loading="loading">
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

    <!-- ══════════ ① 总开关（一位一条通道，联排） ══════════
         为什么不是一行一个开关的列表：这几位对应广播站的几个岗位动作
         （排班 / 审核 / 代录 / 密钥 / 招新），跟调音台上并排的通道一样，
         各有开关、各有电平。开启时左侧亮一条色标，关掉就灭；
         电平直接读出「几个人能用」，不用再去别处找一个「生效 N/M 人」的小字。
         ⚠️ 条数是 meta.length，不是写死 5 —— 后端加第六位时这里自动长出来。 -->
    <div class="conds">
      <section class="cond" v-for="(m, i) in meta" :key="m.key" :data-on="global[m.key] ? '1' : '0'">
        <div class="cond-top">
          <span class="cond-no">{{ pad(i + 1) }}</span>
          <span class="cond-nm">{{ m.name }}</span>
          <button
            class="sw"
            :class="{ on: global[m.key], busy: isBusy('g', m.key) }"
            :aria-label="`${m.name} 总开关`"
            :aria-pressed="!!global[m.key]"
            @click="toggleGlobal(m.key)"
          ></button>
        </div>
        <div class="cond-ds">{{ m.desc }}</div>
        <div class="cond-ft">
          <span class="cond-eff" v-if="count.managers">
            生效 <b>{{ effCount(m.key) }}</b> <s>/ {{ count.managers }}</s> 人
          </span>
          <span class="cond-eff" v-else>暂无社干</span>
          <!-- 电平：一段一个人（过 8 人按比例），亮的＝当前可用 -->
          <div class="lvl" v-if="count.managers" aria-hidden="true">
            <i v-for="n in lvlBars" :key="n" :class="{ on: n <= lvlOn(m.key) }"></i>
          </div>
        </div>
      </section>

      <div class="empty wide" v-if="!meta.length && !loading">没读到权限位，点上面「重新加载」再试。</div>
    </div>

    <!-- ══════════ ② 按人分发（一张矩阵） ══════════
         把「跟随总开关」逐格写一遍会重复 N×5 遍、信息量为零还把行高撑到 100px。
         改成靠两处表达：
           开关外面套一圈浅蓝 = 这一格单独设过，旁边才冒出 ↻ 可以跟回
           成员名右边的小胶囊 = 这一行动过哪几位（一眼看出「这个人被改过」）
         跟随态不占视觉，扫一列就知道谁被动过。 -->
    <section class="card">
      <div class="card-hd">
        <b>按人分发</b><span class="sub">点开关＝单独开 / 单独关</span>
        <span class="r">已单独设置 <b>{{ count.overridden }}</b> 人</span>
      </div>

      <div class="mtx" v-if="rows.length" :style="{ '--ncols': meta.length }">
        <div class="mrow-h">
          <span class="l">成员<i>只列启用中的社干</i></span>
          <span v-for="m in meta" :key="m.key">{{ m.short || m.name }}</span>
        </div>

        <div class="list">
          <div class="mrow" v-for="row in rows" :key="row.p.personId">
            <div class="who">
              <div class="av">{{ initial(row.p.name) }}</div>
              <div class="who-t">
                <div class="who-n">{{ row.p.name }}</div>
                <div class="who-s">
                  {{ row.p.username }}<template v-if="row.p.department"> · {{ row.p.department }}</template>
                </div>
              </div>
              <!-- 这一行动过哪几位：把成员列右半边的空白用起来，也让「改没改过」一眼可见 -->
              <span class="tag">
                <span class="t" v-if="row.ons.length">开 {{ row.ons.join('·') }}</span>
                <span class="t off" v-if="row.offs.length">关 {{ row.offs.join('·') }}</span>
                <span class="f" v-if="!row.ons.length && !row.offs.length">跟随</span>
              </span>
            </div>

            <div class="cellp" v-for="c in row.cells" :key="c.key">
              <div class="cellset">
                <span class="ring" :class="{ set: c.single }">
                  <button
                    class="mini"
                    :class="{ on: c.on, busy: isBusy(row.p.personId, c.key) }"
                    :aria-label="`${row.p.name} 的${c.long}`"
                    :aria-pressed="c.on"
                    @click="togglePerson(row.p, c.key)"
                  ></button>
                </span>
                <button
                  class="redo"
                  :class="{ show: c.single }"
                  :tabindex="c.single ? 0 : -1"
                  title="跟回总开关"
                  :aria-label="`${row.p.name} 的${c.long} 跟回总开关`"
                  @click="follow(row.p, c.key)"
                >
                  <IconRefresh :size="14" :stroke-width="2" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="empty" v-else-if="!loading">
        <b>还没有社干账号</b>
        去「账号管理」里从学生名册把人拉进来，回来这里就能分配权限。
      </div>

      <div class="card-ft" v-if="rows.length">
        <span>
          <b>生效规则</b>：单独设过就用单独那格，没设过跟总开关<span class="dot"></span>
          <b>带蓝框的格子＝单独设置过</b>，点旁边的 ↻ 跟回总开关<span class="dot"></span>拨一下就落库，没有保存按钮
        </span>
      </div>
    </section>
  </div>
</template>

<script setup>
/**
 * 管理端 web · 权限管理 v4
 *
 * 和小程序端 `pages-partner/permissions/` 是**同一张表、同一套接口**：
 *   GET  /partner/permissions                 全局开关 + 社干名单（含生效值）
 *   PUT  /partner/permissions                 改全局总闸       body: { schedule?, review?, … }
 *   PUT  /partner/permissions/person/:id      按人设置         body: { … }（null = 跟回全局）
 *
 * ⚠️ 权限位（名称 / 说明 / 顺序）**只从接口的 meta 拿**（源头 `_kit.PERM_TEXT`）。
 *    页面里不另存一份文案 —— 加第六位开关时这页自动跟上（通道条、矩阵列数都按 meta.length 算），
 *    也不会出现两端叫法不一样。
 * ⚠️ 权限不做草稿态：拨一下就落库。所以没有「保存」按钮，也不该有。
 * ⚠️ 每格各自一把小锁（`busy["<id>:<key>"]`），不是全局一把锁：
 *    全局锁会在连点第二位时把第二下静默吞掉（小程序端 2026-10-31 踩过，表现成「点不亮」）。
 * ⚠️ 保存失败必须**把开关拨回原位**再报错，否则界面在骗人。
 *
 * ── v4 只动视觉：接口 / 权限位文案 / 落库时机一行没改 ──
 * 对照 `preview/admin-partner-permissions-v4/`：
 *   ① 顶部 KPI 带删掉 —— 「X 位权限 / N 个社干 / 被单独设置」这些数在每个通道条和卡头里都已经有了，
 *      再摆一条就是同一件事说两遍，还白吃掉 60px 高度。
 *   ② 右栏 332px 说明栏删掉 —— 「生效规则」并回卡片脚注，「谁被单独设置」矩阵里已有胶囊。
 *   ③ 总开关由左栏竖排改成顶部联排（一屏内先看全 5 位），矩阵独占整行 ⇒ 权限列不再被挤成一条缝。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { IconInfo, IconRefresh } from '@/components/icons';
import { setPageHeader, clearPageHeader } from '@/utils/pageHeader';

const loading = ref(false);
const saveError = ref('');
const buildNeeded = ref(false);
const global = ref({ schedule: true, review: true, proxy: true });
const meta = ref([]);
const people = ref([]);

/**
 * 权限位的键序：**只从接口 meta 派生**，别在这里写死数组。
 *
 * ⚠️⚠️ 原来写死 `['schedule','review','proxy']`，2026-11-07 后端加了第四位 `clubkey`（社团密钥）之后
 *    这一页就悄悄坏了：总开关还归 `global[m.key]` 能拨，「按人」那一列却全灭 ——
 *    因为 `effOf()` 只算三个键 ⇒ 第四位永远取到 undefined ⇒ 开关恒 off、点了也不亮，
 *    「生效 N 人」永远算 0。界面不报错，看着像「没人有这个权限」。
 *    `_kit.PERM_TEXT` 是唯一源头，这里跟着 meta 走，加第五位同样自动跟上。
 */
const KEYS = computed(() => meta.value.map((m) => m.key));

/** 「保存中」标记的存储：key = `g:<key>` 或 `<personId>:<key>` */
const busy = reactive({});
const bkey = (a, k) => `${a}:${k}`;
const isBusy = (a, k) => !!busy[bkey(a, k)];
function markBusy(a, k, v) {
  if (v) busy[bkey(a, k)] = true;
  else delete busy[bkey(a, k)];
}

/* ---------------- 生效值计算（与后端 effectivePerm 同一口径，别自己发明第三版） ---------------- */
function effOf(over) {
  const o = over || {};
  const g = global.value || {};
  const out = {};
  KEYS.value.forEach((k) => {
    const v = o[k];
    out[k] = (v === true || v === false) ? v : !!g[k];
  });
  return out;
}
/** 这一位是不是「单独设过」 */
const isSingle = (over, k) => !!over && (over[k] === true || over[k] === false);
/** 这一行有没有任何一位单独设过 */
function isOvr(over) {
  return KEYS.value.some((k) => isSingle(over, k));
}

/* ---------------- 统计（本地算，拨完立刻准） ---------------- */
const count = computed(() => ({
  managers: people.value.length,
  overridden: people.value.filter((p) => isOvr(p.over)).length,
}));
const effCount = (k) => people.value.filter((p) => effOf(p.over)[k]).length;

/**
 * 电平段数：一段一个人，但**最多 8 段** —— 社干一多（十个八个）一排小方块会把通道条撑爆，
 * 而且段数多到那个量级已经读不出差别了。超过 8 人按比例压缩，数字仍看「生效 N / M 人」。
 */
const LVL_MAX = 8;
const lvlBars = computed(() => Math.max(1, Math.min(count.value.managers, LVL_MAX)));
function lvlOn(k) {
  const total = count.value.managers;
  if (!total) return 0;
  return Math.round((effCount(k) / total) * lvlBars.value);
}

/* ---------------- 渲染用的行模型：模板里不调函数，一次算好 ---------------- */
const rows = computed(() =>
  people.value.map((p) => {
    const eff = effOf(p.over);
    const ons = [];
    const offs = [];
    meta.value.forEach((m) => {
      if (!isSingle(p.over, m.key)) return;
      (eff[m.key] ? ons : offs).push(m.short || m.name);
    });
    return {
      p,
      ons,
      offs,
      cells: meta.value.map((m) => ({
        key: m.key,
        long: m.name,
        on: !!eff[m.key],
        single: isSingle(p.over, m.key),
      })),
    };
  })
);

const pad = (n) => String(n).padStart(2, '0');
const initial = (name) => String(name || '?').slice(0, 1);

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
      over: { ...(x.over || {}) },
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
  // 拨一下 = 显式设成「和当前生效值相反」；想跟回全局要点旁边那个 ↻
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
    if (d && d.over) row.over = { ...d.over };   // 以服务端为准
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
  setPageHeader({ subtitle: '总开关管全体，按人设置管例外' });
  load();
});
onBeforeUnmount(clearPageHeader);
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   权限管理 v4 —— 视觉口径照 `preview/admin-partner-permissions-v4/`
   白卡 16/18px、唯一强调色 --accent、全浅色（本页不出任何深色块）。

   布局：顶部通道条联排（一条一位权限）+ 下面一整行矩阵卡。
   矩阵：grid 而不是 table。`table-layout:fixed` 下只给部分列定宽，
         多出来的宽度会被平均灌给所有列（招募页 2026-11-16 同一个坑），
         表现就是开关散在每列中间、跟表头对不上。
   ⚠️ 列数（--ncols）由 meta 内联给，列宽（--who-w / --col-w）留在 CSS 里吃断点 ——
      内联样式压不过媒体查询，全内联就会在窄屏互相打架（v4 预览踩过）。
   ══════════════════════════════════════════════════════════ */
.ppm { max-width: 1760px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }

/* ── 常驻条 ── */
.tip {
  display: flex; gap: 9px; align-items: flex-start; padding: 10px 13px;
  background: var(--parchment); border-radius: var(--r-input);
  font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.6;
}
.tip :deep(svg) { flex: none; margin-top: 1px; color: var(--muted-2); }
.tip.err { background: var(--red-bg); color: var(--red-fg); }
.tip.err :deep(svg) { color: var(--red-fg); }
.tip-lk {
  border: 0; background: none; padding: 0; margin-left: 3px; font: inherit;
  font-size: var(--fs-sm); color: var(--red-fg); text-decoration: underline;
  text-underline-offset: 2px; cursor: pointer;
}

/* ══════════ ① 总开关：通道条联排 ══════════ */
.conds { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.cond {
  position: relative; background: var(--canvas);
  border: 1px solid var(--hairline); border-radius: 16px;
  padding: 14px 16px 13px 18px;
  display: flex; flex-direction: column; gap: 7px;
  transition: border-color .18s var(--ease);
}
/* 开启态左侧色标：关掉就灭，跟开关同向 */
.cond::before {
  content: ''; position: absolute; left: 0; top: 16px; bottom: 16px; width: 3px;
  border-radius: 0 3px 3px 0; background: transparent; transition: background .18s var(--ease);
}
.cond[data-on='1']::before { background: var(--accent); }

.cond-top { display: flex; align-items: center; gap: 8px; }
/* 编号与名称坐同一条基线：小字号若居中会显得"飘"半个字高 */
.cond-no {
  font-family: var(--mono); font-size: var(--fs-2xs); color: #adaeb5;
  letter-spacing: .5px; font-variant-numeric: tabular-nums;
}
.cond-nm { font-size: 15px; font-weight: 600; letter-spacing: -.2px; color: var(--ink); }
.cond-ds { font-size: 12.5px; line-height: 1.5; color: var(--muted-2); }
.cond-ft { display: flex; align-items: center; gap: 9px; margin-top: auto; padding-top: 4px; }
.cond-eff { font-size: 12.5px; color: var(--muted-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cond-eff b { color: var(--ink); font-weight: 600; }
/* 「/ 4 人」里那个斜杠只是分隔，不该跟数字一样黑 */
.cond-eff s { text-decoration: none; color: var(--soft); }

/* 电平：一段一个人，亮的＝当前可用（广播机架信号表的读法） */
.lvl { display: flex; gap: 3px; align-items: center; }
.lvl i {
  display: block; width: 13px; height: 5px; border-radius: 2px;
  background: #e9e9ee; transition: background .18s var(--ease);
}
.lvl i.on { background: var(--accent); }

/* 开关 44×26（自绘，不用 el-switch：尺寸和原型对不上） */
.sw {
  width: 44px; height: 26px; margin-left: auto; flex: none;
  border: 0; padding: 0; border-radius: var(--r-pill); background: #e5e5ea;
  position: relative; cursor: pointer; transition: background .18s var(--ease);
}
.sw::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .18);
  transition: transform .18s var(--ease);
}
.sw.on { background: var(--accent); }
.sw.on::after { transform: translateX(18px); }
.sw.busy { opacity: .45; pointer-events: none; }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* ══════════ ② 按人矩阵 ══════════ */
.card {
  display: flex; flex-direction: column;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-card); overflow: hidden;
}
.card-hd { display: flex; align-items: baseline; gap: 9px; padding: 16px 20px 14px; flex-wrap: wrap; }
.card-hd b { font-size: 16.5px; font-weight: 600; letter-spacing: var(--ls-tight-sm); color: var(--ink); }
.card-hd .sub { font-size: var(--fs-xs); color: var(--muted-2); }
.card-hd .r { margin-left: auto; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); }
.card-hd .r b { font-size: var(--fs-xs); font-weight: 600; color: var(--ink-2); }

/* 列模板：成员列吃权重，权限列等分。列数由 --ncols 内联给，最小宽度留在这里吃断点 */
.mtx { display: flex; flex-direction: column; }
.mrow-h, .mrow {
  display: grid;
  grid-template-columns: minmax(var(--who-w), 1.3fr) repeat(var(--ncols), minmax(var(--col-w), 1fr));
  align-items: center; padding: 0 20px;
}
.mtx { --who-w: 280px; --col-w: 96px; }
.mrow-h {
  padding-top: 10px; padding-bottom: 10px; background: #fcfcfd;
  border-top: 1px solid var(--divider); border-bottom: 1px solid var(--divider);
  font-size: var(--fs-sm); font-weight: 500; color: var(--muted-2); letter-spacing: var(--ls-wide);
  text-align: center;
}
.mrow-h .l { text-align: left; color: var(--ink-2); font-weight: 500; }
.mrow-h .l i { font-style: normal; font-weight: 400; color: var(--muted-2); margin-left: 5px; font-size: var(--fs-2xs); }

/* 成员列与第一列开关之间的一条竖线：每行各自一段左边框，行与行相接就成了连续的一条 */
.mrow-h > span:nth-child(2), .mrow > .cellp:nth-child(2) { border-left: 1px solid var(--divider); }

.list { display: flex; flex-direction: column; }
.mrow { min-height: 92px; border-bottom: 1px solid #f4f4f6; transition: background .14s var(--ease); }
.mrow:last-child { border-bottom: 0; }
.mrow:hover { background: #fafafb; }

.who { display: flex; align-items: center; gap: 11px; min-width: 0; padding-right: 18px; text-align: left; }
.av {
  flex: none; width: 38px; height: 38px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--acc-bg); color: var(--accent);
  font-size: 14px; font-weight: 600;
}
.who-t { min-width: 0; flex: 1; }
.who-n { font-size: 15.5px; font-weight: 500; letter-spacing: -.2px; line-height: 1.25; color: var(--ink); }
.who-s {
  margin-top: 3px; font-size: var(--fs-xs); color: var(--muted-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums;
}

/* 右对齐的差异标记：把成员列右半边的空白用起来，也让「这一行被动过没有」一眼可见 */
.tag { flex: none; display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.tag .t {
  font-size: var(--fs-2xs); line-height: 1.6; padding: 0 8px; border-radius: var(--r-pill);
  background: var(--acc-bg); color: var(--accent); white-space: nowrap;
}
.tag .t.off { background: var(--parchment); color: var(--muted); }
.tag .f { font-size: var(--fs-2xs); color: var(--soft); letter-spacing: .2px; }

.cellp { display: flex; justify-content: center; }
/* cellset 里只有 ring 参与布局 ⇒ 迷你开关严格落在列中心。
   ↻ 若也参与 flex，会把开关整体推左半个钮宽，跟表头文字对不上（v2 踩过）。 */
.cellset { display: inline-flex; align-items: center; position: relative; }

/* 外圈＝这一格单独设过。跟随态留位不显形，列宽不跳 */
.ring {
  display: inline-flex; align-items: center; padding: 5px;
  border: 1px solid transparent; border-radius: var(--r-pill);
  transition: border-color .18s var(--ease), background .18s var(--ease);
}
.ring.set { border-color: #a9d0f2; background: #f2f8ff; }

/* 迷你开关 42×24 */
.mini {
  width: 42px; height: 24px; flex: none; border: 0; padding: 0;
  border-radius: var(--r-pill); background: #e5e5ea; position: relative;
  cursor: pointer; transition: background .16s var(--ease);
}
.mini::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .16);
  transition: transform .16s var(--ease);
}
.mini.on { background: var(--accent); }
.mini.on::after { transform: translateX(18px); }
.mini.busy { opacity: .45; pointer-events: none; }
.mini:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* ↻ 跟回总开关：只有单独设过才显形 */
.redo {
  position: absolute; left: calc(50% + 30px); top: 50%; transform: translateY(-50%);
  width: 24px; height: 24px; border: 0; border-radius: 50%; padding: 0;
  display: grid; place-items: center;
  background: none; color: var(--accent); cursor: pointer;
  opacity: 0; pointer-events: none; transition: opacity .14s var(--ease), background .14s var(--ease);
}
.redo.show { opacity: 1; pointer-events: auto; }
.redo.show:hover { background: var(--acc-bg); }
.redo.show:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; opacity: 1; }

/* 卡脚注 / 空态 */
.card-ft {
  border-top: 1px solid var(--divider); padding: 11px 20px 12px; background: #fcfcfd;
  font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.65;
}
.card-ft b { color: var(--ink-2); font-weight: 500; }
.card-ft .dot {
  display: inline-block; width: 5px; height: 5px; border-radius: 50%;
  background: var(--soft); margin: 0 7px; vertical-align: 2px;
}

.empty { padding: 34px 18px; text-align: center; font-size: var(--fs-sm); color: var(--muted-2); line-height: 1.7; }
.empty b { display: block; margin-bottom: 4px; font-size: var(--fs-md); font-weight: 500; color: var(--ink); }
.empty.wide { grid-column: 1 / -1; }

/* ── 视口收窄：先缩列宽，通道条再降档 ──
   1920 内容区 1648、1440 只有 1168；通道条 5 条并排每条 222px 仍够放下「编号+名称+开关」。
   ⚠️ 成员列的最小宽度要按「学号 + 部门 + 右边两字胶囊」一起算，不是只算学号：
      1440 下量出来 240px 时，带胶囊的那几行学号会被压成 `202430825083 · …`
      （招新页 2026-11-16 同一个坑），所以这里给到 300px，把权限列的富余让出来。 */
@media (max-width: 1500px) {
  .mtx { --who-w: 300px; --col-w: 84px; }
}
/* 1200 以下 5 条并排每条只剩 170px，名称与开关开始挤 ⇒ 降到 2 条一行；
   成员列也放不下了，行内那两字胶囊先撤（单独设置过没有，看格子外圈和 ↻ 一样能看出来） */
@media (max-width: 1200px) {
  .conds { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mtx { --who-w: 236px; --col-w: 76px; }
  .tag { display: none; }
}
</style>
