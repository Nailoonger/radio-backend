<template>
  <div class="pacc">
    <!-- ══════════ 统计（原型 .acc-stat：大数字 + 右侧一行小字） ══════════ -->
    <div class="acc-stat">
      <div class="st-main">
        <b>{{ total }}</b><span>个账号</span>
      </div>
      <div class="acc-stat-s">
        已激活 {{ activeN }} · 待激活 {{ todoN }}<template v-if="offN"> · 停用 {{ offN }}</template>
      </div>
    </div>

    <!-- ══════════ 搜索（原型 .acc-search） ══════════ -->
    <div class="acc-search">
      <input
        v-model="kw"
        class="sn-inp"
        placeholder="搜姓名 / 学号 / 部门"
        @input="onSearch"
      />
    </div>

    <!-- ══════════ 三段筛选（原型 .stabs） ══════════ -->
    <div class="stabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        :class="{ on: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}<span class="n">{{ t.n }}</span>
      </button>
    </div>

    <!-- ══════════ 账号列表（原型 .acc-list / .acc-line） ══════════ -->
    <div class="acc-list" v-loading="loading">
      <button
        class="acc-line"
        v-for="a in filtered"
        :key="a.id"
        @click="openWho(a)"
      >
        <span class="acc-line-t">
          <b>{{ a.name }}</b>
          <i>{{ a.no }}<template v-if="a.dept"> · {{ a.dept }}</template><template v-if="a.roleText"> · {{ a.roleText }}</template></i>
        </span>
        <span class="acc-bd" :class="a.stCls">{{ a.stText }}</span>
        <span class="ar">›</span>
      </button>
      <div class="pl-empty-note" v-if="!filtered.length && !loading">
        没有匹配的账号。换个关键词，或切回「全部」。
      </div>
    </div>

    <!-- ══════════ 两个批量动作（原型 sec(3)） ══════════ -->
    <div class="btnrow">
      <button class="btn ghost" @click="batchResetOpen = true">批量重置</button>
      <button class="btn ghost" @click="openImport">导入名册</button>
    </div>

    <!-- ══════════ 单账号抽屉（原型 accWhoSheet） ══════════ -->
    <div class="sheet" v-if="who">
      <div class="sheet-mask" @click="who = null"></div>
      <div class="sheet-body">
        <div class="sheet-grab"></div>
        <div class="aw-hd">
          <b>{{ who.name }}</b>
          <span class="acc-bd" :class="who.stCls">{{ who.stText }}</span>
        </div>
        <p class="aw-sub">{{ who.no }}<template v-if="who.dept"> · {{ who.dept }}</template><template v-if="who.roleText"> · {{ who.roleText }}</template></p>
        <div class="aw-pw">
          <span>初始密码</span><b>{{ initPwd(who.no) }}</b>
        </div>
        <div class="aw-acts">
          <button @click="copyPwd(who)">复制账号密码</button>
          <button @click="resetOne(who)">重置密码</button>
          <button @click="setRole(who, nextRole(who))">改为{{ roleName(nextRole(who)) }}</button>
          <button @click="toggleStatus(who)">{{ who.status === 1 ? '停用账号' : '恢复启用' }}</button>
          <button class="danger" @click="removeOne(who)">删除账号</button>
        </div>
      </div>
    </div>

    <!-- ══════════ 导入名册抽屉 ══════════ -->
    <div class="sheet" v-if="importOpen">
      <div class="sheet-mask" @click="importOpen = false"></div>
      <div class="sheet-body tall">
        <div class="sheet-grab"></div>
        <div class="aw-hd"><b>导入站员</b><span class="micro">初始密码 = user + 学号</span></div>
        <p class="aw-sub">从学生名册勾选，或直接粘贴学号（每行一个，可带姓名）。已经在伙伴端的会自动跳过。</p>

        <div class="imp-tabs">
          <button :class="{ on: impMode === 'pick' }" @click="impMode = 'pick'">从名册勾选</button>
          <button :class="{ on: impMode === 'paste' }" @click="impMode = 'paste'">粘贴学号</button>
        </div>

        <!-- 从名册勾选 -->
        <template v-if="impMode === 'pick'">
          <input v-model="candKw" class="sn-inp small" placeholder="搜姓名 / 学号" @input="loadCands" />
          <div class="cand-list" v-loading="candLoading">
            <label class="cand" v-for="c in cands" :key="c.userId">
              <input type="checkbox" :value="c.userId" v-model="picked" />
              <span class="cand-t"><b>{{ c.name }}</b><i>{{ c.username }}<template v-if="c.grade"> · {{ c.grade }}</template></i></span>
            </label>
            <div class="pl-empty-note" v-if="!cands.length && !candLoading">没有可加入的人（都已进伙伴端，或名册为空）。</div>
          </div>
        </template>

        <!-- 粘贴学号 -->
        <template v-else>
          <textarea
            v-model="pasteText"
            class="paste"
            placeholder="每行一个：20240101 或 20240101 张三"
            rows="6"
          ></textarea>
          <button class="btn ghost sm" @click="matchPaste">核对学号</button>
          <div class="match-res" v-if="matched.length || unmatched.length">
            <div class="mr-ok">匹配到 {{ matched.length }} 人</div>
            <div class="mr-bad" v-if="unmatched.length">对不上 {{ unmatched.length }} 个：{{ unmatched.join('、') }}</div>
          </div>
        </template>

        <div class="imp-foot">
          <span class="micro">已选 {{ pickedCount }} 人</span>
          <button class="btn primary" :disabled="!pickedCount || saving" @click="doImport">
            {{ saving ? '建账号中…' : '建账号' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ══════════ 批量重置抽屉 ══════════ -->
    <div class="sheet" v-if="batchResetOpen">
      <div class="sheet-mask" @click="batchResetOpen = false"></div>
      <div class="sheet-body">
        <div class="sheet-grab"></div>
        <div class="aw-hd"><b>批量重置密码</b></div>
        <p class="aw-sub">把当前筛选里的 {{ filtered.length }} 个账号密码重置成「user + 学号」。他们下次登录要重新设置。</p>
        <div class="aw-acts">
          <button class="danger" @click="doBatchReset">确认重置 {{ filtered.length }} 个</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';

const ROLE_NAME = { 0: '超管', 1: '社干', 2: '站员' };

const loading = ref(false);
const rows = ref([]);
const kw = ref('');
const tab = ref('all');

const who = ref(null);
const importOpen = ref(false);
const batchResetOpen = ref(false);

// 导入
const impMode = ref('pick');
const cands = ref([]);
const candLoading = ref(false);
const candKw = ref('');
const picked = ref([]);
const pasteText = ref('');
const matched = ref([]);
const unmatched = ref([]);
const saving = ref(false);

/** 初始密码口径：user + 学号（与后端 accounts.js 一致，别在这里改规则） */
function initPwd(no) {
  return 'user' + String(no || '').trim();
}

function mapRow(x) {
  const role = Number(x.role);
  const status = Number(x.status) === 1 ? 1 : 0;
  // 待激活 = 启用但从没登录过（lastLoginAt 为空）
  const st = status === 0 ? 'off' : (x.lastLoginAt ? 'ok' : 'warn');
  return {
    id: x.id,
    name: x.nickname || x.username || ('账号' + x.id),
    no: x.username || '',
    dept: x.department || '',
    role,
    roleText: ROLE_NAME[role] || '未知',
    status,
    st,
    stText: st === 'ok' ? '已激活' : (st === 'off' ? '停用' : '待激活'),
    stCls: st === 'ok' ? 'ok' : (st === 'off' ? 'off' : 'warn'),
  };
}

const total = computed(() => rows.value.length);
const activeN = computed(() => rows.value.filter((a) => a.st === 'ok').length);
const todoN = computed(() => rows.value.filter((a) => a.st === 'warn').length);
const offN = computed(() => rows.value.filter((a) => a.st === 'off').length);

const tabs = computed(() => [
  { key: 'all', label: '全部', n: rows.value.length },
  { key: 'todo', label: '待激活', n: todoN.value },
  { key: 'off', label: '已停用', n: offN.value },
]);

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return rows.value.filter((a) => {
    if (tab.value === 'todo' && a.st !== 'warn') return false;
    if (tab.value === 'off' && a.st !== 'off') return false;
    if (q && `${a.name} ${a.no} ${a.dept}`.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
});

async function load() {
  loading.value = true;
  try {
    const d = await http.get('/admin/admin/list', { params: { page: 1, pageSize: 200 } });
    rows.value = ((d && d.list) || []).map(mapRow);
  } catch (e) {
    ElMessage.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

let timer = null;
function onSearch() {
  clearTimeout(timer);
  timer = setTimeout(() => { /* 前端过滤，无需请求 */ }, 200);
}

function openWho(a) { who.value = a; }

function roleName(r) { return ROLE_NAME[r] || '站员'; }
/** 点一次轮转：站员 → 社干 → 超管 → 站员 */
function nextRole(a) { return a.role === 2 ? 1 : (a.role === 1 ? 0 : 2); }

async function setRole(a, role) {
  try {
    await http.put(`/admin/admin/${a.id}`, { role });
    ElMessage.success(`已改为${roleName(role)}`);
    who.value = null;
    await load();
  } catch (e) {
    ElMessage.error(e.message || '操作失败');
  }
}

async function toggleStatus(a) {
  const next = a.status === 1 ? 0 : 1;
  try {
    await http.put(`/admin/admin/${a.id}`, { status: next });
    ElMessage.success(next ? '已恢复启用' : '已停用');
    who.value = null;
    await load();
  } catch (e) {
    ElMessage.error(e.message || '操作失败');
  }
}

async function resetOne(a) {
  try {
    await ElMessageBox.confirm(
      `把 ${a.name} 的密码重置成「${initPwd(a.no)}」？他下次登录要重新设置。`,
      '重置密码', { confirmButtonText: '重置', cancelButtonText: '取消', type: 'warning' },
    );
    await http.put(`/admin/admin/${a.id}`, { password: initPwd(a.no) });
    ElMessage.success('密码已重置');
    who.value = null;
  } catch (e) {
    if (e !== 'cancel') ElMessage.error((e && e.message) || '操作失败');
  }
}

async function removeOne(a) {
  try {
    await ElMessageBox.confirm(`删除 ${a.name}（${a.no}）？删除后这个人不能再登录伙伴端。`, '删除账号',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' });
    await http.delete(`/admin/admin/${a.id}`);
    ElMessage.success('已删除');
    who.value = null;
    await load();
  } catch (e) {
    if (e !== 'cancel') ElMessage.error((e && e.message) || '操作失败');
  }
}

function copyPwd(a) {
  const text = `${a.no}\t${initPwd(a.no)}`;
  navigator.clipboard.writeText(text)
    .then(() => ElMessage.success('已复制：账号 + 初始密码'))
    .catch(() => ElMessage.warning(`复制失败，请手动记：${text}`));
}

async function doBatchReset() {
  const list = filtered.value;
  if (!list.length) return;
  try {
    await ElMessageBox.confirm(`确认重置 ${list.length} 个账号？`, '批量重置',
      { confirmButtonText: '重置', cancelButtonText: '取消', type: 'warning' });
  } catch (e) { return; }
  let ok = 0;
  for (const a of list) {
    try {
      await http.put(`/admin/admin/${a.id}`, { password: initPwd(a.no) });
      ok += 1;
    } catch (e) { /* 单个失败不中断 */ }
  }
  ElMessage.success(`重置完成：${ok} / ${list.length}`);
  batchResetOpen.value = false;
  await load();
}

// ───────── 导入 ─────────
function openImport() {
  importOpen.value = true;
  impMode.value = 'pick';
  picked.value = [];
  pasteText.value = '';
  matched.value = [];
  unmatched.value = [];
  loadCands();
}

async function loadCands() {
  candLoading.value = true;
  try {
    const d = await http.get('/partner/accounts/candidates', { params: { keyword: candKw.value.trim() } });
    cands.value = (d && d.list) || [];
  } catch (e) {
    ElMessage.error(e.message || '读取名册失败');
    cands.value = [];
  } finally {
    candLoading.value = false;
  }
}

/** 粘贴学号 → 去学生名册核对（对不上的列出来，不静默丢） */
async function matchPaste() {
  const lines = pasteText.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return;
  if (!cands.value.length) await loadCands();
  const byNo = {};
  cands.value.forEach((c) => { byNo[String(c.username)] = c; });
  const ok = [];
  const bad = [];
  lines.forEach((ln) => {
    const no = ln.split(/[\s,，\t]+/)[0];
    const hit = byNo[no];
    if (hit) ok.push(hit.userId);
    else bad.push(no);
  });
  picked.value = ok;
  matched.value = ok;
  unmatched.value = bad;
  if (ok.length) ElMessage.success(`匹配到 ${ok.length} 人`);
}

const pickedCount = computed(() => picked.value.length);

async function doImport() {
  if (!pickedCount.value) return;
  saving.value = true;
  try {
    const r = await http.post('/partner/accounts/import', { userIds: picked.value, role: 2 });
    const ok = (r && r.createdCount) || 0;
    const skip = ((r && r.skipped) || []).length;
    ElMessage.success(`建了 ${ok} 个账号${skip ? `，${skip} 个跳过` : ''}。初始密码 = user + 学号`);
    importOpen.value = false;
    await load();
    await loadCands();
  } catch (e) {
    ElMessage.error(e.message || '建账号失败');
  } finally {
    saving.value = false;
  }
}

watch(importOpen, (v) => { if (!v) picked.value = []; });

onMounted(load);
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════
   样式照 v151 `accounts` 屏（v139 重做版）逐值搬，1px = 1px：
     .acc-stat b 34/600 ls-1 #0066CC · span 12.5 muted
     .acc-search margin 0 0 12px；.sn-inp 高 40 radius 9999
     .stabs 文字 tab + 方块数字 + 蓝下划线
     .acc-line min-height 62 padding 12/14 border-bottom 1px #F2F2F5
     .acc-bd fs 10.5 pad 3/8 radius 9999（ok/warn/off 三色）
     .btn 13px 圆角 / 46px 高（**不是药丸**）
   ══════════════════════════════════════════════════════════ */
.pacc { padding: 18px 16px 24px; max-width: 820px; }

/* 统计 */
.acc-stat { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px; }
.acc-stat .st-main { display: flex; align-items: baseline; gap: 6px; }
.acc-stat b { font-size: 34px; font-weight: 600; letter-spacing: -1px; color: #0066CC; line-height: 1; }
.acc-stat .st-main span { font-size: 12.5px; color: #76767E; }
.acc-stat-s { margin-left: auto; font-size: 12px; color: #76767E; text-align: right; line-height: 1.5; }

/* 搜索 */
.acc-search { margin: 0 0 12px; }
.sn-inp {
  width: 100%; height: 40px; padding: 0 14px; box-sizing: border-box;
  border: 1px solid #E7E9EE; border-radius: 9999px; background: #fff;
  font-size: 13px; color: #1D1D1F; outline: none; font-family: inherit;
}
.sn-inp:focus { border-color: #0066CC; }
.sn-inp.small { height: 36px; margin-bottom: 10px; }

/* 三段筛选（.stabs） */
.stabs {
  display: flex; align-items: stretch;
  border-bottom: 1px solid #E3E3E8; margin: 2px 0 12px;
}
.stabs button {
  flex: 1; min-width: 0; background: none; border: 0; font-family: inherit; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 11px 4px 13px; font-size: 13px; color: #76767E; position: relative;
}
.stabs button .n {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 6px; background: #E8E8ED;
  color: #76767E; font-size: 11.5px; font-weight: 500; line-height: 20px; text-align: center;
  display: inline-flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums;
}
.stabs button.on { color: #0066CC; font-weight: 600; }
.stabs button.on .n { background: #EAF3FD; color: #0066CC; }
.stabs button.on::after {
  content: ''; position: absolute; left: 50%; transform: translateX(-50%); bottom: -1px;
  width: calc(100% - 16px); max-width: 86px; height: 2px; border-radius: 2px; background: #0066CC;
}

/* 列表 */
.acc-list { background: #fff; border-radius: 18px; padding: 0 16px; }
.acc-line {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 62px; padding: 12px 0;
  background: none; border: 0; border-bottom: 1px solid #F2F2F5; font-family: inherit;
  text-align: left; cursor: pointer;
}
.acc-line:last-child { border-bottom: 0; }
.acc-line:hover { background: #FAFAFB; }
.acc-line-t { flex: 1; min-width: 0; }
.acc-line-t b { display: block; font-size: 15px; font-weight: 500; color: #1D1D1F; line-height: 1.35; }
.acc-line-t i {
  display: block; font-style: normal; font-size: 11.5px; color: #76767E; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.acc-bd { flex: none; font-size: 10.5px; padding: 3px 8px; border-radius: 9999px; line-height: 1.2; }
.acc-bd.ok { background: #EAF7EF; color: #1E8E4E; }
.acc-bd.warn { background: #FFF4DD; color: #8A5A12; }
.acc-bd.off { background: #F0F0F3; color: #8A8A90; }
.acc-line .ar { font-size: 16px; color: #C7C7CC; flex: none; }
.pl-empty-note { padding: 26px 0; text-align: center; font-size: 12.5px; color: #8A8A90; }

/* 批量动作 */
.btnrow { display: flex; gap: 10px; margin-top: 14px; }
.btn {
  flex: 1; min-height: 46px; padding: 0 18px; border-radius: 13px; border: 0;
  font-size: 14px; font-weight: 500; font-family: inherit; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
}
.btn.ghost { background: #fff; color: #0066CC; border: 1px solid #E7E9EE; }
.btn.primary { background: #0066CC; color: #fff; }
.btn.sm { flex: none; min-height: 36px; font-size: 13px; padding: 0 14px; margin-bottom: 8px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }

/* 抽屉 */
.sheet { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: flex-end; justify-content: center; }
.sheet-mask { position: absolute; inset: 0; background: rgba(0, 0, 0, .3); }
.sheet-body {
  position: relative; width: 100%; max-width: 560px; background: #fff;
  border-radius: 20px 20px 0 0; padding: 14px 20px 22px; max-height: 82vh; overflow-y: auto;
}
.sheet-body.tall { max-height: 86vh; }
.sheet-grab { width: 36px; height: 4px; border-radius: 2px; background: #E3E3E8; margin: 0 auto 14px; }
.aw-hd { display: flex; align-items: center; gap: 10px; padding: 6px 0 4px; }
.aw-hd b { font-size: 22px; font-weight: 600; letter-spacing: -.4px; color: #1D1D1F; }
.aw-sub { margin: 6px 0 14px; font-size: 12.5px; color: #76767E; line-height: 1.6; }
.aw-pw {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; background: #F5F5F7; border-radius: 12px; font-size: 12.5px; color: #76767E;
}
.aw-pw b { font-size: 14px; color: #1D1D1F; font-variant-numeric: tabular-nums; }
.aw-acts { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.aw-acts button {
  min-height: 46px; border-radius: 13px; border: 1px solid #E7E9EE; background: #fff;
  color: #1D1D1F; font-size: 14px; font-family: inherit; cursor: pointer;
}
.aw-acts button:hover { border-color: #0066CC; color: #0066CC; }
.aw-acts button.danger { color: #C0392B; border-color: #F5D5D1; }

/* 导入 */
.imp-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.imp-tabs button {
  flex: 1; min-height: 36px; border-radius: 10px; border: 1px solid #E7E9EE; background: #fff;
  font-size: 13px; color: #76767E; font-family: inherit; cursor: pointer;
}
.imp-tabs button.on { background: #EAF3FD; border-color: #CFE3F8; color: #0066CC; font-weight: 600; }
.cand-list { max-height: 34vh; overflow-y: auto; border: 1px solid #F0F0F3; border-radius: 12px; }
.cand { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #F5F5F7; cursor: pointer; }
.cand:last-child { border-bottom: 0; }
.cand-t b { display: block; font-size: 14px; font-weight: 500; color: #1D1D1F; }
.cand-t i { display: block; font-style: normal; font-size: 11.5px; color: #76767E; margin-top: 2px; }
.paste {
  width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #E7E9EE;
  border-radius: 12px; font-size: 13px; font-family: inherit; color: #1D1D1F; outline: none;
}
.paste:focus { border-color: #0066CC; }
.match-res { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.mr-ok { font-size: 12.5px; color: #1E8E4E; }
.mr-bad { font-size: 12.5px; color: #C0392B; line-height: 1.5; }
.imp-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.imp-foot .btn { flex: none; min-width: 140px; }
.micro { font-size: 12px; color: #76767E; }
</style>
