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

    <div class="ppm-grid" v-loading="loading">
      <!-- ══════════ ① 总开关（左栏：一条通道一位权限） ══════════
           为什么做成「通道条」而不是三行普通开关：
           这三个位对应广播站的三个岗位动作（排班 / 审核 / 代录），
           跟调音台上三条通道一样并排、各有开关和电平。
           开启时左侧亮一条色标，关掉就灭；下面几段电平直接读出「几个人能用」，
           不用再去别处找一个「生效 4/4 人」的小字。 -->
      <section class="card">
        <div class="card-hd">
          <b>总开关</b><span class="sub">对全体社干生效</span>
        </div>

        <div class="chan" v-for="(m, i) in meta" :key="m.key" :data-on="global[m.key] ? '1' : '0'">
          <div class="chan-top">
            <span class="chan-no">{{ pad(i + 1) }}</span>
            <span class="chan-name">{{ m.name }}</span>
            <button
              class="sw"
              :class="{ on: global[m.key], busy: isBusy('g', m.key) }"
              :aria-label="`${m.name} 总开关`"
              :aria-pressed="!!global[m.key]"
              @click="toggleGlobal(m.key)"
            ></button>
          </div>
          <div class="chan-desc">{{ m.desc }}</div>
          <div class="chan-foot">
            <span class="chan-eff" v-if="count.managers">
              生效 <b>{{ effCount(m.key) }}</b> <span class="of">/ {{ count.managers }}</span> 人
            </span>
            <span class="chan-eff" v-else>暂无社干</span>
            <!-- 电平：一段一个人（过 8 人按比例），亮的＝当前可用 -->
            <div class="lvl" v-if="count.managers" aria-hidden="true">
              <i v-for="n in lvlBars" :key="n" :class="{ on: n <= lvlOn(m.key) }"></i>
            </div>
          </div>
        </div>

        <div class="empty" v-if="!meta.length && !loading">没读到权限位，点上面「重新加载」再试。</div>

        <div class="chan-note">
          <b>关掉总开关，只留单独开过的人；</b>其余看不到入口。
        </div>
      </section>

      <!-- ══════════ ② 按人分发（右栏：一张矩阵） ══════════
           v2 把「跟随总开关」那行小字全删了 —— 4 人 × 3 格会重复 12 遍，
           信息量为零还把行高撑到 100px。改成靠「外圈」表达：
             只有一只开关        = 跟随总开关
             开关外面套一圈浅蓝  = 这一格单独设过，旁边才冒出 ↻ 可以跟回
           跟随态不占视觉，扫一列就知道谁被动过。 -->
      <section class="card">
        <div class="card-hd">
          <b>按人分发</b><span class="sub">点开关＝单独开 / 单独关</span>
          <span class="r">已单独设置 <b class="num">{{ count.overridden }}</b> 人</span>
        </div>

        <div class="perm" v-if="rows.length" :style="{ '--cols': gridCols }">
          <div class="phead">
            <span class="l">成员<span class="lg">只列启用中的社干</span></span>
            <span v-for="m in meta" :key="m.key">{{ m.short || m.name }}</span>
          </div>

          <div class="prow" v-for="row in rows" :key="row.p.personId">
            <div class="who">
              <div class="av">{{ initial(row.p.name) }}</div>
              <div class="who-t">
                <div class="who-n">{{ row.p.name }}</div>
                <div class="who-s">
                  {{ row.p.username }}<template v-if="row.p.department"> · {{ row.p.department }}</template>
                </div>
              </div>
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
                  <IconRefresh :size="15" :stroke-width="2" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="empty" v-else-if="!loading">
          <b>还没有社干账号</b>
          去「账号管理」里从学生名册把人拉进来，回来这里就能分配权限。
        </div>

        <div class="card-ft" v-if="rows.length">
          <IconInfo :size="13" />
          <div>
            生效规则：单独设过用单独那格，没设过跟总开关；<b>带外圈的格子＝单独设置过</b>，点 ↻ 跟回总开关。
            拨一下就生效，没有保存按钮。
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 管理端 web · 权限管理（超管）v2
 *
 * 和小程序端 `pages-partner/permissions/` 是**同一张表、同一套接口**：
 *   GET  /partner/permissions                 全局开关 + 社干名单（含生效值）
 *   PUT  /partner/permissions                 改全局总闸       body: { schedule?, review?, proxy? }
 *   PUT  /partner/permissions/person/:id      按人设置         body: { … }（null = 跟回全局）
 *
 * ⚠️ 权限位（名称 / 说明 / 顺序）**只从接口的 meta 拿**（源头 `_kit.PERM_TEXT`）。
 *    页面里不另存一份文案 —— 加第四位开关时这页自动跟上（矩阵列数按 meta.length 算），
 *    也不会出现两端叫法不一样。
 * ⚠️ 权限不做草稿态：拨一下就落库。所以没有「保存」按钮，也不该有。
 * ⚠️ 三格各自一把小锁（`busy["<id>:<key>"]`），不是全局一把锁：
 *    全局锁会在连点第二位时把第二下静默吞掉（小程序端 2026-10-31 踩过，表现成「点不亮」）。
 * ⚠️ 保存失败必须**把开关拨回原位**再报错，否则界面在骗人。
 *
 * ── v2 只动视觉：接口 / 权限位文案 / 落库时机一行没改 ──
 * 对照 `preview/admin-partner-permissions-v2/`：左右两栏（318 总开关 / 剩余给矩阵）、
 * grid 硬控列宽（表头与格子同一套模板 ⇒ 中线对齐）、单独设置用外圈表达、行高 100 → 54px。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/utils/http';
import { IconInfo, IconRefresh } from '@/components/icons';
import { setPageHeader, clearPageHeader } from '@/utils/pageHeader';

/** 权限位的键序（与后端 `_kit.PERM_KEYS` 同序；只用来兜默认值，文案一律吃接口 meta） */

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
 * 电平段数：一段一个人，但**最多 8 段** —— 社干一多（十个八个）一排小方块会把左栏撑爆，
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
    return {
      p,
      cells: meta.value.map((m) => ({
        key: m.key,
        long: m.name,
        on: !!eff[m.key],
        single: isSingle(p.over, m.key),
      })),
    };
  })
);

/**
 * 矩阵列模板：成员列吃剩余宽度，权限列定宽 —— 表头与格子共用同一套，永远对得齐。
 * 三位时 148px 最舒展；四位（现有就是四位）收成 118px，否则右栏被挤得成员名只剩两个字。
 */
const gridCols = computed(() => `minmax(0, 1fr) repeat(${meta.value.length}, var(--colw, 170px))`);

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
  setPageHeader({ subtitle: '社干能不能进排班工作台 / 审核 / 代录' });
  load();
});
onBeforeUnmount(clearPageHeader);
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   权限管理 v2 —— 视觉口径照 `preview/admin-partner-permissions-v2/`
   白卡 18px、唯一强调色 --accent、全浅色（本页不出任何深色块）。

   布局：左右两栏（318 总开关 / 剩余给矩阵），两卡等高靠 grid 的 stretch，
         卡内用 margin-top:auto 把注脚兜到底 —— 底边齐，不留空膛。
   矩阵：grid 而不是 table。`table-layout:fixed` 下只给部分列定宽，
         多出来的宽度会被平均灌给所有列（招募页 2026-11-16 同一个坑），
         表现就是开关散在每列中间、跟表头对不上。
   ══════════════════════════════════════════════════════════ */
.ppm { max-width: 1440px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }

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

/* ── 两栏 ── */
.ppm-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: stretch; }

/* ── 卡片 ── */
.card {
  display: flex; flex-direction: column;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-card); overflow: hidden;
}
.card-hd { display: flex; align-items: baseline; gap: 8px; padding: 15px 18px 0; flex-wrap: wrap; }
.card-hd b { font-size: 16px; font-weight: 600; letter-spacing: var(--ls-tight-sm); color: var(--ink); }
.card-hd .sub { font-size: var(--fs-xs); color: var(--muted-2); }
.card-hd .r { margin-left: auto; font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); }
.card-hd .r b { font-size: var(--fs-xs); font-weight: 600; color: var(--ink-2); }

/* ══════════ 左栏：总开关（通道条） ══════════ */
/* 通道吃掉左栏剩余高度，但封顶 150 —— 再高内容就散成三截了 */
.chan {
  position: relative; flex: 1; max-height: 150px;
  display: flex; flex-direction: column; justify-content: center;
  padding: 15px 18px 14px 20px; border-top: 1px solid var(--divider);
}
.card > .chan:first-of-type { margin-top: 16px; }
/* 开启态左侧色标：关掉就灭，跟开关同向 */
.chan::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 3px; height: 54px;
  border-radius: 0 3px 3px 0; background: transparent; transition: background .18s var(--ease);
}
.chan[data-on='1']::before { background: var(--accent); }

.chan-top { display: flex; align-items: baseline; gap: 8px; }
/* 编号与名称坐同一条基线：小字号若居中会显得"飘"半个字高 */
.chan-no {
  font-family: var(--mono); font-size: var(--fs-2xs); color: #adaeb5;
  letter-spacing: .5px; font-variant-numeric: tabular-nums;
}
.chan-name { font-size: 15px; font-weight: 600; letter-spacing: -.1px; color: var(--ink); }
.chan-desc { margin-top: 4px; font-size: 12.5px; color: var(--muted-2); line-height: 1.45; }
.chan-foot { display: flex; align-items: center; gap: 9px; margin-top: 9px; }
.chan-eff { font-size: 12.5px; color: var(--muted-2); font-variant-numeric: tabular-nums; }
.chan-eff b { color: var(--ink); font-weight: 600; }
.chan-eff .of { color: var(--soft); }

/* 电平：一段一个人，亮的＝当前可用（广播机架信号表的读法） */
.lvl { display: flex; gap: 3px; align-items: center; }
.lvl i {
  display: block; width: 12px; height: 5px; border-radius: 2px;
  background: #e9e9ee; transition: background .18s var(--ease);
}
.lvl i.on { background: var(--accent); }

.chan-note {
  margin-top: auto; border-top: 1px solid var(--divider); padding: 12px 20px 14px;
  font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.65;
}
.chan-note b { color: var(--ink-2); font-weight: 500; }

/* 开关 40×24（自绘，不用 el-switch：尺寸和 v8 原型对不上） */
.sw {
  width: 46px; height: 28px; margin-left: auto; align-self: center; flex: none;
  border: 0; padding: 0; border-radius: var(--r-pill); background: #e5e5ea;
  position: relative; cursor: pointer; transition: background .18s var(--ease);
}
.sw::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .18);
  transition: transform .18s var(--ease);
}
.sw.on { background: var(--accent); }
.sw.on::after { transform: translateX(18px); }
.sw.busy { opacity: .45; pointer-events: none; }
.sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* ══════════ 右栏：按人矩阵 ══════════ */
/* 矩阵吃掉卡内剩余高度，行均分 —— 否则 4 行数据后面会留一个 170px 的洞 */
.perm { --colw: 170px; flex: 1; min-height: 0; display: flex; flex-direction: column; margin-top: 12px; }
.phead, .prow {
  display: grid; grid-template-columns: var(--cols);
  align-items: center; padding: 0 18px;
}
.phead {
  padding-top: 11px; padding-bottom: 11px; background: #fcfcfd;
  border-top: 1px solid var(--divider); border-bottom: 1px solid var(--divider);
  font-size: var(--fs-sm); font-weight: 500; color: var(--muted-2); letter-spacing: var(--ls-wide);
  text-align: center;
}
.phead .l { text-align: left; }
.phead .lg { margin-left: 4px; font-weight: 400; letter-spacing: 0; color: var(--muted-2); }

.prow { flex: 1; min-height: 96px; padding-top: 20px; padding-bottom: 20px; border-bottom: 1px solid #f5f5f7; transition: background .14s var(--ease); }
.prow:last-child { border-bottom: 0; }
.prow:hover { background: #fafafb; }

.who { display: flex; align-items: center; gap: 10px; min-width: 0; padding-right: 12px; text-align: left; }
.av {
  flex: none; width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--acc-bg); color: var(--accent);
  font-size: 13px; font-weight: 600;
}
.who-t { min-width: 0; }
.who-n { font-size: 14.5px; font-weight: 500; letter-spacing: -.1px; line-height: 1.3; color: var(--ink); }
.who-s {
  margin-top: 2px; font-size: 12.5px; color: var(--muted-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums;
}

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

/* 迷你开关 34×20 */
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
  position: absolute; left: calc(50% + 32px); top: 50%; transform: translateY(-50%);
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
  margin-top: auto; border-top: 1px solid var(--divider); padding: 12px 20px 14px;
  display: flex; gap: 7px; align-items: flex-start; background: #fcfcfd;
  font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.6;
}
.card-ft :deep(svg) { flex: none; margin-top: 2px; color: var(--soft); }
.card-ft b { color: var(--ink-2); font-weight: 500; }

.empty { flex: 1; padding: 34px 18px; text-align: center; font-size: var(--fs-sm); color: var(--muted-2); line-height: 1.7; }
.empty b { display: block; margin-bottom: 3px; font-size: var(--fs-md); font-weight: 500; color: var(--ink); }

/* ── 视口收缩分三档：先缩列宽，最后才塌成单栏 ──
   两栏要塞下 360 左栏 + 成员列 + 四列权限；1440 笔记本的内容区只有 1168，
   硬撑两栏会挤成一条缝，所以那时才改单栏。 */
@media (max-width: 1608px) {
  .perm { --colw: 140px; }
}
@media (max-width: 1448px) {
  .ppm { height: auto; max-width: 900px; }
  .ppm-grid { flex: none; grid-template-columns: minmax(0, 1fr); }
  .perm { --colw: 170px; }
}
</style>
