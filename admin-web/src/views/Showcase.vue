<template>
  <div class="showcase-page">
    <!-- ══════════ 顶部合并说明深色条 ══════════ -->
    <div class="tile-strip">
      <div class="grow">
        <div class="t">社干与部员已合并为同一个模块</div>
        <div class="m">
          共 {{ counts.all }} 人 · 展示中 {{ onShow.all }} · 已隐藏 {{ hidden.all }}
          · 小程序「风采」页按类型分两层展示
        </div>
      </div>
      <div class="metrics">
        <el-button size="small" class="strip-ghost" @click="openSort">调整排序</el-button>
        <el-button size="small" class="strip-white" @click="previewVisible = true">预览小程序</el-button>
      </div>
    </div>

    <!-- ══════════ 工具栏 ══════════ -->
    <div class="toolbar">
      <div class="segment">
        <span class="seg-ind" :style="{ width: 'calc((100% - 6px)/3)', left: `calc(3px + ${activeType} * ((100% - 6px)/3))` }"></span>
        <button class="seg-item" :class="{ on: activeType === 0 }" @click="setType(0)">全部 {{ counts.all }}</button>
        <button class="seg-item" :class="{ on: activeType === 1 }" @click="setType(1)">社干 {{ counts.cadre }}</button>
        <button class="seg-item" :class="{ on: activeType === 2 }" @click="setType(2)">部员 {{ counts.staff }}</button>
      </div>

      <div class="filters">
        <button class="filter" :class="{ on: activeFilter === 0 }" @click="activeFilter = 0">全部</button>
        <button class="filter" :class="{ on: activeFilter === 1 }" @click="activeFilter = 1">
          展示中 <span class="num">{{ typeOnShow }}</span>
        </button>
        <button class="filter" :class="{ on: activeFilter === 2 }" @click="activeFilter = 2">
          已隐藏 <span class="num">{{ typeHidden }}</span>
        </button>
      </div>

      <div class="tail">
        <div class="search-in">
          <IconSearch :size="14" />
          <input v-model="keyword" placeholder="搜索姓名 / 部门 / 栏目" @keyup.enter="fetch" />
        </div>
        <el-button size="small" @click="openImport">批量导入</el-button>
        <el-button size="small" type="primary" @click="openCreate()">
          <IconPlus :size="15" class="btn-icon" />新增成员
        </el-button>
      </div>
    </div>

    <!-- ══════════ 筛选逻辑说明 ══════════ -->
    <div class="card note">
      <div class="micro">
        <b>筛选器跟着类型走：</b>
        选「社干」时显示<b>职务</b>筛选（站长 / 副站长 / 纪检长 / 站长助理）；
        选「部员」时显示<b>部门</b>筛选（播音部 / 主持部 / 编辑部）；
        选「全部」时两者都不显示，只留搜索 —— 避免出现选了部门却筛出社干的怪结果。
      </div>
    </div>

    <!-- ══════════ 成员卡片网格 ══════════ -->
    <div class="mgrid" v-loading="loading">
      <div
        v-for="item in visibleList" :key="item.type + '-' + item.id"
        class="mcard" :class="{ 'is-hidden': Number(item.isShow) !== 1 }"
      >
        <span class="av av-56">
          <img v-if="item.avatar" :src="item.avatar" :alt="item.name" />
          <template v-else>{{ (item.name || '?').charAt(0) }}</template>
        </span>
        <div class="nm">{{ item.name }}</div>
        <div class="rowc gap8">
          <span class="tag" :class="item.type === 'cadre' ? 'tag-top' : 'tag-outline'">
            {{ item.type === 'cadre' ? '社干' : '部员' }}
          </span>
          <span class="role">{{ item.type === 'cadre' ? item.role : (item.department || item.role) }}</span>
        </div>
        <span class="tag" :class="Number(item.isShow) === 1 ? 'tag-pass' : 'tag-mute'">
          {{ Number(item.isShow) === 1 ? '展示中' : '已隐藏' }}
        </span>
        <div v-if="item.programs" class="micro el w100">负责《{{ item.programs }}》</div>
        <div v-else-if="item.grade" class="micro el w100">{{ item.grade }}</div>
        <div class="rowc gap12">
          <a class="link" @click="openEdit(item)">编辑</a>
          <a class="link" @click="toggle(item)">{{ Number(item.isShow) === 1 ? '隐藏' : '展示' }}</a>
          <a class="link danger" @click="remove(item)">删除</a>
        </div>
      </div>

      <div class="mcard add-card" @click="openCreate()">
        <span class="iconbtn"><IconPlus :size="16" /></span>
        <div class="micro">新增成员</div>
      </div>
    </div>

    <!-- ══════════ 底部两张说明卡 ══════════ -->
    <div class="cols">
      <div class="sec wide">
        <div class="sec-head"><span class="sec-title">合并规则</span></div>
        <div class="card tight">
          <div class="kv"><span class="k">数据来源</span><span>仍是两张表：<span class="mono">cadre</span> 与 <span class="mono">staff</span></span></div>
          <div class="kv"><span class="k">社干字段</span><span>姓名 · 职务 · 头像 · 显示开关（无部门）</span></div>
          <div class="kv"><span class="k">部员字段</span><span>姓名 · 部门 · 负责栏目 · 头像 · 显示开关</span></div>
          <div class="kv"><span class="k">合并方式</span><span>模块合并，<b>不是合表</b>（合表会打断小程序风采页）</span></div>
          <div class="kv"><span class="k">小程序端</span><span>保持不变：<span class="mono">/user/showcase</span> 仍返回两层结构</span></div>
        </div>
      </div>

      <div class="sec">
        <div class="sec-head">
          <span class="sec-title">后端改动</span>
          <span class="tag tag-pass">已实现</span>
        </div>
        <div class="card tight">
          <div class="kv"><span class="k">新增接口</span><span class="mono">GET /api/admin/showcase/list</span></div>
          <div class="kv"><span class="k">参数</span><span class="mono">type=cadre|staff|all · keyword</span></div>
          <div class="kv"><span class="k">返回</span><span>统一形状 <span class="mono">{id,type,name,avatar,subtitle,isShow}</span></span></div>
          <div class="kv"><span class="k">旧的接口</span><span>原样保留，不影响小程序与其它调用</span></div>
          <div class="kv"><span class="k">鉴权</span><span>超管（与原 cadre / staff 接口一致）</span></div>
        </div>
      </div>
    </div>

    <!-- ══════════ 新增 / 编辑 ══════════ -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑成员' : '新增成员'" width="520px">
      <el-form label-width="92px">
        <el-form-item label="类型">
          <el-radio-group v-model="form.type" :disabled="!!form.id">
            <el-radio value="cadre">社干</el-radio>
            <el-radio value="staff">部员</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" maxlength="32" placeholder="姓名" />
        </el-form-item>
        <el-form-item v-if="form.type === 'cadre'" label="职务" required>
          <el-select v-model="form.role" placeholder="选择职务" style="width:100%;">
            <el-option v-for="r in CADRE_ROLES" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <template v-else>
          <el-form-item label="部门" required>
            <el-select v-model="form.department" placeholder="选择部门" style="width:100%;">
              <el-option v-for="d in DEPTS" :key="d" :label="d" :value="d" />
            </el-select>
          </el-form-item>
          <el-form-item label="岗位">
            <el-input v-model="form.role" placeholder="主播 / 主持 / 编辑 / 记者…（留空按「部员」保存）" />
          </el-form-item>
          <el-form-item label="负责栏目">
            <el-input v-model="form.programs" placeholder="多个用逗号分隔，如：晚风信箱,晨间新闻速递" />
          </el-form-item>
        </template>
        <el-form-item label="年级班级">
          <el-input v-model="form.grade" placeholder="如：2024 级 1 班" />
        </el-form-item>
        <el-form-item label="照片 URL（可选）">
          <el-input v-model="form.avatar" placeholder="留空则该成员用姓名首字头像展示" />
        </el-form-item>
        <el-form-item label="座右铭">
          <el-input v-model="form.motto" maxlength="200" placeholder="选填" />
        </el-form-item>
        <el-form-item label="小程序展示">
          <el-switch v-model="form.isShow" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 批量导入 ══════════ -->
    <el-dialog v-model="importVisible" title="批量导入成员" width="580px">
      <el-radio-group v-model="importType" style="margin-bottom:10px">
        <el-radio value="cadre">社干</el-radio>
        <el-radio value="staff">部员</el-radio>
      </el-radio-group>
      <div class="micro fmt">
        每行一位，逗号分隔。<br />
        <b>社干</b>：<span class="mono">姓名, 职务, 头像URL [, 年级班级]</span><br />
        <b>部员</b>：<span class="mono">姓名, 部门, 负责栏目, 头像URL [, 岗位]</span>
      </div>
      <el-input
        v-model="importText" type="textarea" :rows="7"
        :placeholder="importType === 'cadre' ? '林晓,站长,/uploads/avatars/lin.png' : '陈默,播音部,晚风信箱,/uploads/avatars/chen.png'"
      />
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">开始导入</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 调整排序 ══════════ -->
    <el-dialog v-model="sortVisible" title="调整排序" width="560px">
      <div class="micro fmt">排在前面的在小程序里更靠前；改完点保存（会写回每条的 sort 权重）。</div>
      <div class="sort-list">
        <div class="sort-row" v-for="(it, i) in sortList" :key="it.type + '-' + it.id">
          <span class="tag" :class="it.type === 'cadre' ? 'tag-top' : 'tag-outline'">{{ it.type === 'cadre' ? '社干' : '部员' }}</span>
          <span class="sort-name">{{ it.name }}</span>
          <span class="micro">{{ it.type === 'cadre' ? it.role : it.department }}</span>
          <span class="sort-btns">
            <el-button size="small" text :disabled="i === 0" @click="move(i, -1)">↑</el-button>
            <el-button size="small" text :disabled="i === sortList.length - 1" @click="move(i, 1)">↓</el-button>
          </span>
        </div>
      </div>
      <template #footer>
        <el-button @click="sortVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSort" @click="saveSort">保存排序</el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 预览小程序 ══════════ -->
    <el-dialog v-model="previewVisible" title="小程序「风采」页效果" width="560px">
      <div class="mini">
        <div class="mini-title">广播站大家庭</div>
        <div class="mini-sec">
          <div class="mini-sec-t">社干</div>
          <div class="mini-row" v-for="p in previewCadre" :key="'c' + p.id">
            <span class="mini-av">{{ (p.name || '?').charAt(0) }}</span>
            <div>
              <div class="mini-nm">{{ p.name }}</div>
              <div class="mini-sub">{{ p.role }}</div>
            </div>
          </div>
          <div class="mini-note" v-if="!previewCadre.length">没有展示中的社干</div>
        </div>
        <div class="mini-sec">
          <div class="mini-sec-t">部门人员</div>
          <div class="mini-row" v-for="p in previewStaff" :key="'s' + p.id">
            <span class="mini-av">{{ (p.name || '?').charAt(0) }}</span>
            <div>
              <div class="mini-nm">{{ p.name }}</div>
              <div class="mini-sub">{{ p.department }}<template v-if="p.programs"> · 负责《{{ p.programs }}》</template></div>
            </div>
          </div>
          <div class="mini-note" v-if="!previewStaff.length">没有展示中的部员</div>
        </div>
        <div class="mini-note">
          这里只展示「展示中」的成员（当前 {{ onShow.all }} 人）；隐藏的不会出现在小程序。
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import { IconSearch, IconPlus } from '@/components/icons';
import { setPageHeader, clearPageHeader, setRefreshHandler, clearRefreshHandler } from '@/utils/pageHeader';

const HEADER_TITLE = '风采展示';

const CADRE_ROLES = ['站长', '副站长', '纪检长', '站长助理'];
const DEPTS = ['播音部', '主持部', '编辑部'];

const loading = ref(false);
const list = ref([]);
const counts = reactive({ all: 0, cadre: 0, staff: 0 });
const onShow = reactive({ all: 0, cadre: 0, staff: 0 });
const hidden = reactive({ all: 0, cadre: 0, staff: 0 });

const activeType = ref(0);     // 0 全部 1 社干 2 部员
const activeFilter = ref(0);   // 0 全部 1 展示中 2 已隐藏
const keyword = ref('');

const typeKey = computed(() => (activeType.value === 1 ? 'cadre' : activeType.value === 2 ? 'staff' : 'all'));
const typeOnShow = computed(() => (activeType.value === 1 ? onShow.cadre : activeType.value === 2 ? onShow.staff : onShow.all));
const typeHidden = computed(() => (activeType.value === 1 ? hidden.cadre : activeType.value === 2 ? hidden.staff : hidden.all));

const previewCadre = computed(() => list.value.filter((i) => i.type === 'cadre' && Number(i.isShow) === 1));
const previewStaff = computed(() => list.value.filter((i) => i.type === 'staff' && Number(i.isShow) === 1));

/** 状态筛选在前端做（24 人量级，一次取全） */
const visibleList = computed(() => list.value.filter((it) => {
  if (activeFilter.value === 1) return Number(it.isShow) === 1;
  if (activeFilter.value === 2) return Number(it.isShow) !== 1;
  return true;
}));

async function fetch() {
  loading.value = true;
  try {
    const d = await http.get('/admin/showcase/list', {
      params: { type: typeKey.value, keyword: keyword.value || undefined, pageSize: 200 },
    });
    list.value = d.list || [];
    const c = d.counts || {};
    const s = d.onShow || {};
    Object.assign(counts, { all: c.all || 0, cadre: c.cadre || 0, staff: c.staff || 0 });
    // 老版本后端可能没返回 all / hidden，这里兜底自己算，避免出现「展示中 0」
    Object.assign(onShow, {
      cadre: s.cadre || 0,
      staff: s.staff || 0,
      all: s.all != null ? s.all : (s.cadre || 0) + (s.staff || 0),
    });
    const h = d.hidden || {};
    Object.assign(hidden, {
      cadre: h.cadre != null ? h.cadre : (counts.cadre - onShow.cadre),
      staff: h.staff != null ? h.staff : (counts.staff - onShow.staff),
      all: h.all != null ? h.all : (counts.all - onShow.all),
    });
    // 顶栏副标题用同一套口径（v8 Topbar）
    setPageHeader({
      title: HEADER_TITLE,
      subtitle: `共 ${counts.all} 人 · 展示中 ${onShow.all} · 已隐藏 ${hidden.all}`,
    });
  } finally { loading.value = false; }
}

function setType(v) { activeType.value = v; activeFilter.value = 0; fetch(); }

async function toggle(item) {
  await http.put(`/admin/showcase/${item.type}/${item.id}/toggle`);
  ElMessage.success(Number(item.isShow) === 1 ? '已隐藏，小程序不再展示' : '已展示');
  await fetch();
}

/* ── 新增 / 编辑 ── */
const formVisible = ref(false);
const saving = ref(false);
const form = reactive({
  id: null, type: 'cadre', name: '', role: '', department: '', programs: '',
  grade: '', avatar: '', motto: '', isShow: 1,
});

function openCreate(type) {
  const t = type || (activeType.value === 2 ? 'staff' : 'cadre');
  Object.assign(form, {
    id: null, type: t, name: '', role: '', department: '', programs: '',
    grade: '', avatar: '', motto: '', isShow: 1,
  });
  formVisible.value = true;
}
function openEdit(item) {
  Object.assign(form, {
    id: item.id, type: item.type, name: item.name, role: item.role || '',
    department: item.department || '', programs: item.programs || '',
    grade: item.grade || '', avatar: item.avatar || '', motto: item.motto || '',
    isShow: Number(item.isShow) === 1 ? 1 : 0,
  });
  formVisible.value = true;
}

async function save() {
  if (!form.name.trim()) return ElMessage.warning('请填写姓名');
  if (form.type === 'cadre' && !form.role) return ElMessage.warning('请选择职务');
  if (form.type === 'staff' && !form.department) return ElMessage.warning('请选择部门');
  // 照片可选（2026-09-19）：留空 = 用姓名首字头像兜底，后端与各端均已支持
  const avatar = form.avatar.trim();
  const payload = form.type === 'cadre'
    ? { name: form.name, role: form.role, grade: form.grade, avatar, motto: form.motto, isShow: form.isShow }
    : {
        name: form.name, role: form.role || '部员', department: form.department,
        programs: form.programs, grade: form.grade, avatar,
        motto: form.motto, isShow: form.isShow,
      };
  saving.value = true;
  try {
    if (form.id) await http.put(`/admin/${form.type}/${form.id}`, payload);
    else await http.post(`/admin/${form.type}/create`, payload);
    ElMessage.success(form.id ? '已保存' : '已新增');
    formVisible.value = false;
    await fetch();
  } finally { saving.value = false; }
}

async function remove(item) {
  await ElMessageBox.confirm(`删除「${item.name}」？小程序风采页会同时移除。`, '删除成员', {
    type: 'warning', confirmButtonText: '删除',
  });
  await http.delete(`/admin/${item.type}/${item.id}`);
  ElMessage.success('已删除');
  await fetch();
}

/* ── 批量导入（逐行创建，失败行给原因） ── */
const importVisible = ref(false);
const importing = ref(false);
const importType = ref('cadre');
const importText = ref('');

function openImport() {
  importType.value = activeType.value === 2 ? 'staff' : 'cadre';
  importText.value = '';
  importVisible.value = true;
}

async function doImport() {
  const lines = importText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return ElMessage.warning('请至少填写一行');
  importing.value = true;
  let ok = 0;
  const fails = [];
  try {
    for (let i = 0; i < lines.length; i += 1) {
      const c = lines[i].split(/[,，]/).map((s) => s.trim());
      const no = i + 1;
      try {
        if (importType.value === 'cadre') {
          const [name, role, avatar, grade] = c;
          if (!name || !role || !avatar) { fails.push(`第 ${no} 行：应为「姓名, 职务, 头像URL」`); continue; }
          await http.post('/admin/cadre/create', { name, role, avatar, grade: grade || '', isShow: 1 });
        } else {
          const [name, department, programs, avatar, role] = c;
          if (!name || !department || !avatar) { fails.push(`第 ${no} 行：应为「姓名, 部门, 负责栏目, 头像URL」`); continue; }
          await http.post('/admin/staff/create', {
            name, department, programs: programs || '', avatar, role: role || '部员', isShow: 1,
          });
        }
        ok += 1;
      } catch (e) {
        fails.push(`第 ${no} 行：${(e && e.message) || '创建失败'}`);
      }
    }
    if (ok) ElMessage.success(`导入完成：成功 ${ok} 行${fails.length ? `，失败 ${fails.length} 行` : ''}`);
    if (fails.length) ElMessage.warning(fails.slice(0, 3).join('；'));
    if (ok) { importText.value = ''; importVisible.value = false; await fetch(); }
  } finally { importing.value = false; }
}

/* ── 调整排序（sort 大者靠前） ── */
const sortVisible = ref(false);
const savingSort = ref(false);
const sortList = ref([]);
function openSort() { sortList.value = list.value.slice(); sortVisible.value = true; }
function move(i, dir) {
  const arr = sortList.value.slice();
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  sortList.value = arr;
}
async function saveSort() {
  savingSort.value = true;
  try {
    const n = sortList.value.length;
    for (let i = 0; i < n; i += 1) {
      const it = sortList.value[i];
      await http.put(`/admin/${it.type}/${it.id}`, { sort: n - i });
    }
    ElMessage.success('排序已保存');
    sortVisible.value = false;
    await fetch();
  } finally { savingSort.value = false; }
}

onMounted(() => {
  setRefreshHandler(fetch);
  fetch();
});
onBeforeUnmount(() => {
  clearRefreshHandler(fetch);
  clearPageHeader();
});
</script>

<style scoped>
.showcase-page { display: flex; flex-direction: column; gap: 20px; }
.grow { flex: 1; min-width: 0; }

/* ══════════ 顶部深色条 ══════════ */
.tile-strip {
  display: flex; align-items: center; gap: 26px;
  background: var(--tile); border-radius: var(--r-tile);
  padding: 16px 24px; color: #fff;
}
.tile-strip .t { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.3px; line-height: var(--lh-xl); }
.tile-strip .m { font-size: var(--fs-sm); color: #ccc; letter-spacing: var(--ls-wide); margin-top: 3px; }
.metrics { margin-left: auto; display: flex; gap: 10px; align-items: center; }
/* v8 权威配方（preview/admin-ui-v8/admin-ui-v8.html）：
   .btn-ghost = 透明底 + 强调蓝描边与蓝字；.btn-white = 纯白底 + 强调蓝字。
   必须连 .el-button 一起限定，否则被全局 .el-button--default 的 !important 压掉（实测会变灰底、与背景糊在一起）。 */
.tile-strip .strip-ghost.el-button,
.tile-strip .strip-ghost.el-button:hover {
  background: transparent !important;
  background-image: none !important;
  border: 1px solid var(--accent-dark) !important;
  color: var(--accent-dark) !important;
  box-shadow: none !important;
}
.tile-strip .strip-ghost.el-button:hover { background: rgba(41, 151, 255, 0.1) !important; }
.tile-strip .strip-white.el-button,
.tile-strip .strip-white.el-button:hover {
  background: #fff !important;
  background-image: none !important;
  border: none !important;
  color: var(--accent) !important;
  box-shadow: none !important;
  font-weight: 600;
}
/* 两个胶囊同规格：高 30 / 圆角胶囊 / 同一字号 */
.tile-strip .metrics :deep(.el-button) { height: 30px; padding: 0 14px; border-radius: var(--r-pill); font-size: var(--fs-md); }

/* ══════════ 工具栏 ══════════ */
.toolbar { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
.tail { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.search-in {
  display: flex; align-items: center; gap: 8px;
  height: 36px; width: 230px; padding: 0 14px;
  background: #fff; border: 1px solid var(--hairline);
  border-radius: var(--r-pill);
  color: var(--soft); font-size: var(--fs-sm);
}
.search-in input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-family: inherit; font-size: var(--fs-sm); color: var(--ink);
}
.search-in input::placeholder { color: var(--soft); }

.segment { position: relative; display: flex; width: 268px; background: var(--divider); border-radius: var(--r-pill); padding: 3px; }
.seg-ind {
  position: absolute; top: 3px; bottom: 3px;
  border-radius: var(--r-pill); background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  transition: left 0.24s var(--ease);
}
.seg-item {
  position: relative; z-index: 1; flex: 1; text-align: center;
  padding: 6px 0; border: none; background: transparent; cursor: pointer;
  border-radius: var(--r-pill);
  font-size: var(--fs-sm); font-family: inherit; color: var(--muted);
  transition: color 0.24s var(--ease);
}
.seg-item.on { color: var(--ink); font-weight: 600; }

.filters { display: inline-flex; gap: 8px; }
.filter {
  height: 30px; padding: 0 14px; cursor: pointer;
  border: 1px solid var(--hairline); background: #fff;
  border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--ink-2);
}
.filter:hover { border-color: var(--soft); }
.filter.on { background: var(--ink); border-color: var(--ink); color: #fff; font-weight: 600; }
.filter .num { opacity: 0.7; margin-left: 3px; }

/* ══════════ 说明卡 / 成员网格 ══════════ */
.card { background: var(--canvas); border: 1px solid var(--hairline); border-radius: var(--r-card); }
.card.note { padding: 13px 18px; }
.card.tight { padding: 8px 20px; }
.micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); line-height: 1.75; }

.mgrid { display: flex; gap: 13px; flex-wrap: wrap; min-height: 120px; }
.mcard {
  width: calc((100% - 39px) / 4);
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 18px;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  text-align: center;
  transition: opacity 0.16s var(--ease);
}
.mcard.is-hidden { opacity: 0.62; }
.mcard .nm { font-size: var(--fs-md); font-weight: 600; letter-spacing: -0.2px; }
.mcard .role { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide); }
.mgrid .micro { font-size: var(--fs-xs); color: var(--muted-2); letter-spacing: var(--ls-wide); }
.mcard.add-card {
  background: transparent; border: 1px dashed var(--hairline);
  justify-content: center; cursor: pointer;
}
.mcard.add-card:hover { border-color: var(--soft); background: var(--parchment); }
.iconbtn {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--parchment);
  display: flex; align-items: center; justify-content: center; color: var(--ink-2);
}
.mcard.add-card .iconbtn { background: var(--divider); }
.w100 { width: 100%; }

.av {
  border-radius: 50%; background: var(--ink); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; overflow: hidden; flex: none;
}
.av img { width: 100%; height: 100%; object-fit: cover; }
.av-56 { width: 56px; height: 56px; font-size: 19px; }

/* 标签体系：社干＝墨黑实心，部员＝描边（v8 不引入第二种彩色） */
.tag {
  display: inline-flex; align-items: center; height: 22px; padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs); letter-spacing: var(--ls-wide-sm);
}
.tag-top { background: var(--ink); color: #fff; }
.tag-outline { border: 1px solid var(--hairline); color: var(--muted-2); }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }

.rowc { display: flex; align-items: center; }
.gap8 { gap: 8px; }
.gap12 { gap: 12px; }
.el { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { font-size: var(--fs-sm); color: var(--accent); font-weight: 500; cursor: pointer; }
.link:hover { text-decoration: underline; }
.link.danger { color: var(--red-fg); }

/* ══════════ 底部说明 ══════════ */
.cols { display: flex; gap: 18px; align-items: stretch; }
.cols > * { min-width: 0; flex: 1; }
.sec { display: flex; flex-direction: column; gap: 13px; }
.sec.wide { flex: 1.2; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 13px; }
.sec-title { font-size: var(--fs-xl); font-weight: 600; letter-spacing: var(--ls-tight-sm); line-height: var(--lh-xl); }
.kv {
  display: flex; font-size: var(--fs-md); line-height: 1.6;
  padding: 9px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.kv .k { width: 88px; flex: none; color: var(--muted); font-size: var(--fs-sm); }
.kv:last-child { border-bottom: none; }
.mono { font-family: var(--mono); font-size: var(--fs-sm); color: var(--ink-2); }

/* ══════════ 弹窗内部 ══════════ */
.fmt { margin-bottom: 10px; }
.sort-list { max-height: 46vh; overflow: auto; }
.sort-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--divider); }
.sort-name { font-size: var(--fs-md); color: var(--ink); min-width: 72px; }
.sort-btns { margin-left: auto; display: flex; gap: 2px; }

.mini { background: var(--parchment); border-radius: var(--r-card); padding: 18px; }
.mini-title { font-size: var(--fs-xl); font-weight: 600; color: var(--ink); margin-bottom: 14px; }
.mini-sec { margin-bottom: 14px; }
.mini-sec-t { font-size: var(--fs-xs); color: var(--muted); letter-spacing: var(--ls-wide-sm); margin-bottom: 8px; }
.mini-row {
  display: flex; align-items: center; gap: 12px;
  background: var(--canvas); border-radius: 14px; padding: 12px 16px; margin-bottom: 8px;
}
.mini-av {
  width: 40px; height: 40px; border-radius: 50%; flex: none;
  background: var(--ink); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-md); font-weight: 600;
}
.mini-nm { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.mini-sub { font-size: var(--fs-xs); color: var(--muted); margin-top: 2px; }
.mini-note { font-size: var(--fs-xs); color: var(--muted-2); line-height: 1.7; }
</style>
