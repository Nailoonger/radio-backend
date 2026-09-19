<template>
  <div class="acct-page">
    <!-- ══════════ 工具栏（v8：独立一行；页面标题只在顶栏出现一次，不在这里重复） ══════════ -->
    <div class="toolbar">
      <div class="seg">
        <button
          v-for="r in roleSegs" :key="r.v"
          class="seg-item" :class="{ on: filter.role === r.v }"
          @click="setRole(r.v)"
        >{{ r.label }} <em class="num">{{ r.n }}</em></button>
      </div>
      <div class="tb-right">
        <el-input
          v-model="query.keyword" placeholder="搜索账号 / 昵称" clearable style="width:230px;"
          @keyup.enter="search"
        >
          <template #prefix><IconSearch :size="15" /></template>
        </el-input>
        <el-button type="primary" @click="openEdit()">
          <IconUserPlus :size="15" class="btn-icon" />新建账号
        </el-button>
      </div>
    </div>

    <!-- ══════════ 列表 ══════════ -->
    <!-- 加载 = v8 表格行骨架（头像圆 + 姓名条 + 次要列 + 状态位），老的转圈已删 -->
    <div class="table-card" v-if="loading">
      <div class="sk-row" v-for="i in 5" :key="i">
        <span class="sk sk-av" style="width:32px;height:32px"></span>
        <span class="sk sk-title" :style="{ width: 22 + (i % 3) * 6 + '%' }"></span>
        <span class="sk sk-text" style="width:14%"></span>
        <span class="sk sk-text" style="width:16%"></span>
        <span class="sk sk-tag" style="width:64px;margin-left:auto"></span>
      </div>
    </div>

    <div class="table-card" v-else>
      <el-table :data="filteredRows" @row-dblclick="openEdit">
        <!-- v8：账号列 — 32px 首字圆头像（超管墨黑实底 / 普管白底描边）+ 昵称 -->
        <el-table-column label="账号" min-width="180">
          <template #default="{ row }">
            <div class="user-cell">
              <span
                class="av"
                :class="[isSelf(row) ? 'av-dark' : 'av-soft', row.status === 0 ? 'av-mute' : '']"
              >{{ initialOf(row) }}</span>
              <span class="strong" :class="{ 'is-mute': row.status === 0 }">{{ row.nickname || row.username }}</span>
            </div>
          </template>
        </el-table-column>

        <!-- 用户名 -->
        <el-table-column label="用户名" width="150">
          <template #default="{ row }"><span class="mono">{{ row.username }}</span></template>
        </el-table-column>

        <!-- 角色：超管墨黑胶囊 / 普管白底描边（绝不用第二种彩色） -->
        <el-table-column label="角色" width="140">
          <template #default="{ row }">
            <span class="tag" :class="row.role === 0 ? 'tag-top' : 'tag-outline'">
              {{ row.role === 0 ? '超级管理员' : '普通管理员' }}
            </span>
          </template>
        </el-table-column>

        <!-- 最近登录 -->
        <el-table-column label="最近登录" width="180">
          <template #default="{ row }">
            <span v-if="row.lastLoginAt" class="c-time">{{ fmt(row.lastLoginAt) }}</span>
            <span v-else class="micro">从未登录</span>
          </template>
        </el-table-column>

        <!-- 状态：正常 / 待激活 / 已停用（v8 浅色胶囊；待激活旁加 ano-new 红标） -->
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <span class="state-cell">
              <span class="tag" :class="row.status === 1 ? (row.lastLoginAt ? 'tag-pass' : 'tag-pending') : 'tag-mute'">
                {{ row.status === 1 ? (row.lastLoginAt ? '正常' : '待激活') : '已停用' }}
              </span>
              <span v-if="row.status === 1 && !row.lastLoginAt" class="ano ano-new">需后端新增</span>
            </span>
          </template>
        </el-table-column>

        <!-- 操作 -->
        <el-table-column label="操作" width="220" fixed="right" align="right">
          <template #default="{ row }">
            <!-- v8 屏 21：本人行不显示任何按钮，避免误改自己；只留「本人」灰色微标 -->
            <div v-if="isSelf(row)" class="op-cell">
              <span class="micro op-self">本人</span>
            </div>
            <div v-else class="op-cell">
              <button class="btn-plain" @click="openEdit(row)">编辑</button>
              <button class="btn-plain" v-if="row.status === 1" @click="toggleStatus(row, 0)">停用</button>
              <button class="btn-plain" v-else @click="toggleStatus(row, 1)">启用</button>
              <button class="iconmini" title="删除" @click="remove(row)">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"></path><path d="M9.4 7V4.8h5.2V7"></path><path d="M6.6 7l1 12.4h8.8L17.4 7"></path></svg>
              </button>
            </div>
          </template>
        </el-table-column>

        <template #empty>
          <EmptyState variant="content" title="暂无账号" description="点击右上角「新建账号」创建第一个管理员" />
        </template>
      </el-table>
    </div>

    <!-- ══════════ 权限说明（v8 屏 21 末段两张说明卡其一） ══════════ -->
    <div class="card explain">
      <div class="explain-head">
        <span class="strong">权限说明</span>
        <span class="tag tag-mid">边界在后端</span>
      </div>
      <div class="micro explain-body">
        超级管理员可见「系统管理」整组菜单（学生账号、风采展示、模块开关、账号管理、系统设置）；<br>
        普通管理员仅可见「内容运营」组（数据概览、投稿审核、栏目管理、公告管理、留言审核）。<br>
        超管账号有自保护逻辑——<b>不能删除自己</b>，系统也会确保至少保留一位超管。
      </div>
    </div>

    <!-- ══════════ 头像从哪来 + 待激活 / 重置密码 · 接口说明（v8 屏 21 第二张说明卡） ══════════ -->
    <div class="card explain explain-warn">
      <div class="explain-head">
        <span class="strong">头像从哪里来、以及两处对不上的地方</span>
        <span class="tag tag-mid">前端生成 · v8 设计</span>
      </div>
      <div class="micro explain-body">
        <b>① 头像机制（不需要后端）：</b>表格里那个「林 / 苏 / 周」圆圈，取的是
        <code>nickname || username</code> 的<b>第一个字</b>，放进 32px 圆形里，底色只用两种——
        超管墨黑实底、普通管理员羊皮纸底，靠底色区分层级。<b>纯 CSS 渲染，无图片请求，不占后端字段</b>；
        复姓或首字符是英文时只显示该字符，不会撑破圆形。<br>
        <b>② 「待激活」状态当前由前端派生：</b><code>admin.status</code> 只有 0 禁用 / 1 启用，
        暂无第三种值。这里用 <code>lastLoginAt == null</code> 渲染「待激活」标签——
        <b>不污染后端状态机，不需迁移</b>，副作用是「账号存在但长期未登录」也会显示待激活（业务上两者等价）。<br>
        <b>③ 重置密码 = 编辑弹窗里留空不修改、填了就是新密码：</b>复用
        <code>PUT /admin/admin/:id</code> 传 <code>password</code> 字段即可（已在用）。<br>
        <b>④ 想看真实头像需三处一起改：</b><code>admin</code> 表加 <code>avatar</code> 字段 → 挂载
        <code>POST /admin/upload/avatar</code> 路由（控制器/multer 已写好但未挂）→ <code>admin/list</code> 返回该字段。
        本版不做——超管自己管自己，几乎没有头像需求。
      </div>
    </div>

    <!-- ══════════ 编辑弹窗（新增 / 编辑共用） ══════════ -->
    <el-dialog
      v-model="dialog" :title="form.id ? '编辑账号' : '新建账号'" width="480px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="100px" :rules="rules" ref="formRef">
        <el-form-item label="账号" prop="username">
          <el-input v-model="form.username" :disabled="!!form.id" placeholder="登录用户名" />
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="form.nickname" placeholder="显示在管理后台与小程序里的名字" />
        </el-form-item>
        <el-form-item :label="form.id ? '重置密码' : '密码'" :prop="form.id ? '' : 'password'">
          <el-input
            v-model="form.password" type="password" show-password
            :placeholder="form.id ? '留空表示不修改' : '至少 6 位'"
          />
          <div v-if="form.id" class="micro form-hint">
            留空 = 不修改；填了就是新密码（至少 6 位）。注意：<b>改自己的密码需要旧密码</b>，
            请在「我的资料」里操作。
          </div>
        </el-form-item>
        <!-- v8 屏 21：本人不能改自己的角色 / 状态（自保护） -->
        <el-form-item label="角色">
          <el-radio-group v-model="form.role" :disabled="isSelfEdit">
            <el-radio :value="0">超级管理员</el-radio>
            <el-radio :value="1">普通管理员</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch
            v-model="form.status"
            :active-value="1" :inactive-value="0"
            :disabled="isSelfEdit"
            active-text="启用" inactive-text="停用"
          />
          <div v-if="isSelfEdit" class="micro form-hint">不能停用 / 改角色自己</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import dayjs from 'dayjs';
import { useAuthStore } from '@/stores/auth';
import { IconSearch, IconUserPlus } from '@/components/icons';
import EmptyState from '@/components/EmptyState.vue';
import { setPageHeader, clearPageHeader } from '@/utils/pageHeader';

const auth = useAuthStore();

/* ── 数据 ── */
const rows = ref([]);          // 服务端返回的列表
const total = ref(0);
const loading = ref(false);
const saving = ref(false);

const query = reactive({ page: 1, pageSize: 50, keyword: '' });
const filter = reactive({ role: 'all' });   // 全部 / super / normal

/** 服务端 keyword 命中；role 在前端做二次过滤（避免每次切角色都打接口） */
const filteredRows = computed(() => {
  if (filter.role === 'all') return rows.value;
  const want = filter.role === 'super' ? 0 : 1;
  return rows.value.filter((r) => r.role === want);
});

/* ── 角色分段 + 计数 ── */
const counts = computed(() => {
  const c = { super: 0, normal: 0 };
  rows.value.forEach((r) => { r.role === 0 ? c.super++ : c.normal++; });
  return c;
});
const roleSegs = computed(() => [
  { v: 'all',    label: '全部',     n: rows.value.length },
  { v: 'super',  label: '超管',     n: counts.value.super },
  { v: 'normal', label: '普通管理员', n: counts.value.normal },
]);
function setRole(v) { filter.role = v; }

/* ── 头像 / 角色 / 时间 ── */
function initialOf(row) {
  const s = (row.nickname || row.username || '?').trim();
  return s.charAt(0) || '?';
}
function fmt(t) { return t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—'; }
function isSelf(row) { return row && row.id === auth.admin?.id; }
const isSelfEdit = computed(() => !!form.id && form.id === auth.admin?.id);

/* ── 接口 ── */
async function fetch() {
  loading.value = true;
  try {
    const data = await http.get('/admin/admin/list', { params: query });
    rows.value = Array.isArray(data?.list) ? data.list : [];
    total.value = data?.total ?? rows.value.length;
    // v8 顶栏：标题只出现一次，统计（共 N 个后台账号 · 超管 X 人）放进副标题
    setPageHeader({
      title: '账号管理',
      subtitle: `共 ${total.value} 个后台账号 · 超管 ${counts.value.super} 人`,
    });
  } finally { loading.value = false; }
}
function search() { query.page = 1; fetch(); }

/* ── 编辑弹窗 ── */
const dialog = ref(false);
const formRef = ref(null);
const form = reactive({ id: null, username: '', nickname: '', password: '', role: 1, status: 1 });

const rules = {
  username: [{ required: true, message: '请填写账号', trigger: 'blur' }],
  password: [{ required: true, message: '请填写密码', trigger: 'blur' }],
};

function openEdit(row) {
  if (row) {
    Object.assign(form, {
      id: row.id, username: row.username, nickname: row.nickname || '',
      password: '', role: row.role, status: row.status,
    });
  } else {
    Object.assign(form, { id: null, username: '', nickname: '', password: '', role: 1, status: 1 });
  }
  dialog.value = true;
}

async function save() {
  // 表单校验（新增时强制要求密码）
  await formRef.value?.validate().catch(() => {});
  if (!form.username) return ElMessage.warning('请填写账号');
  if (!form.id && !form.password) return ElMessage.warning('请填写密码');
  if (form.password && form.password.length < 6) return ElMessage.warning('密码至少 6 位');

  saving.value = true;
  try {
    if (form.id) {
      await http.put(`/admin/admin/${form.id}`, {
        nickname: form.nickname,
        password: form.password || undefined,    // 留空 = 不改
        role: form.role,
        status: form.status,
      });
    } else {
      await http.post('/admin/admin/create', {
        username: form.username,
        password: form.password,
        nickname: form.nickname || undefined,
        role: form.role,
        status: form.status,                     // 新建直接落启用
      });
    }
    ElMessage.success('已保存');
    dialog.value = false;
    await fetch();
  } finally { saving.value = false; }
}

/* ── 启停切换 / 删除（前端自保护：本人不能动；后端 requireSuperAdmin 是真闸） ── */
async function toggleStatus(row, next) {
  if (isSelf(row)) return ElMessage.warning('不能停用 / 启用自己');
  try {
    await http.put(`/admin/admin/${row.id}`, { status: next ? 1 : 0 });
    ElMessage.success(next ? '已启用' : '已停用');
    await fetch();
  } catch (e) {
    // 后端会兜底返回「系统至少保留一个超管」之类的 40301 文案
    ElMessage.error(e?.message || '操作失败');
  }
}

async function remove(row) {
  if (isSelf(row)) return ElMessage.warning('不能删除自己');
  try {
    await ElMessageBox.confirm(
      `确认删除管理员「${row.nickname || row.username}」？此操作不可恢复。`,
      '危险操作', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch { return; }
  try {
    await http.delete(`/admin/admin/${row.id}`);
    ElMessage.success('已删除');
    await fetch();
  } catch (e) {
    ElMessage.error(e?.message || '删除失败');
  }
}

onMounted(fetch);
onBeforeUnmount(clearPageHeader);
</script>

<style scoped>
.acct-page { display: flex; flex-direction: column; gap: 16px; }

/* ══════════ 工具栏 ══════════ */
.toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.seg {
  display: inline-flex; gap: 4px; padding: 4px;
  background: var(--parchment); border-radius: var(--r-pill);
}
.seg-item {
  border: none; background: transparent; cursor: pointer;
  height: 30px; padding: 0 16px; border-radius: var(--r-pill);
  font-size: var(--fs-md); font-family: inherit; color: var(--muted);
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.seg-item:hover { color: var(--ink); }
.seg-item.on { background: var(--canvas); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
.seg-item em { font-style: normal; opacity: 0.55; margin-left: 4px; font-variant-numeric: tabular-nums; }
.tb-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.btn-icon { margin-right: 5px; vertical-align: -2px; }

/* ══════════ 列表 ══════════ */
.user-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.strong { font-weight: 600; color: var(--ink); }
.strong.is-mute { color: var(--muted); }

/* v8 头像：32px 首字圆（默认白底描边，本人行墨黑实底） */
.av {
  width: 32px; height: 32px; border-radius: 50%;
  flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; line-height: 1;
}
.av-dark { background: var(--ink); color: #fff; }
.av-soft { background: var(--canvas); color: var(--ink-2); border: 1px solid var(--hairline); }
.av-mute { opacity: 0.5; }

.mono {
  font-family: var(--mono);
  font-size: 12.5px; color: var(--ink-2);
}
.c-time { color: var(--ink-2); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); }

/* v8 状态列：浅色胶囊 + 待激活行附加 ano-new 红标 */
.state-cell { display: inline-flex; align-items: center; gap: 6px; }
.ano {
  display: inline-flex; align-items: center; height: 19px; padding: 0 7px;
  border-radius: var(--r-pill);
  font-size: var(--fs-2xs); font-weight: 600; letter-spacing: var(--ls-wide);
  vertical-align: 1px; white-space: nowrap;
}
.ano-new  { background: var(--red-bg); color: var(--red-fg); }

/* 标签体系（v8：浅色胶囊） */
.tag {
  display: inline-flex; align-items: center; height: 23px; padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs); font-weight: 500; line-height: 1;
  letter-spacing: 0.2px; white-space: nowrap;
}
.tag-top { background: var(--ink); color: #fff; }
.tag-outline { background: var(--canvas); color: var(--ink-2); border: 1px solid var(--hairline); }
.tag-pass { background: var(--green-bg); color: var(--green-fg); }
.tag-pending { background: var(--amber-bg); color: var(--amber-fg); }
.tag-mute { background: var(--divider); color: var(--muted-2); }
.tag-mid { background: var(--parchment); color: var(--muted); font-weight: 600; }

/* 操作列：plain 文字按钮 + iconmini 删除（v8 屏 21 同款） */
.op-cell { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; }
.op-self { color: var(--soft); }
.btn-plain {
  border: none; background: transparent; cursor: pointer;
  color: var(--muted); font-size: var(--fs-sm); font-family: inherit;
  padding: 4px 10px; border-radius: var(--r-pill);
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}
.btn-plain:hover { color: var(--ink); background: var(--parchment); }
.iconmini {
  width: 28px; height: 28px; border: none; background: transparent; cursor: pointer;
  border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--muted); transition: background 0.16s, color 0.16s;
}
.iconmini:hover { background: var(--red-bg); color: var(--red-fg); }

/* ══════════ 表格卡（v8 card-flush：羊皮纸底 + 圆角，表格透明融入） ══════════ */
.table-card {
  background: var(--parchment);
  border-radius: var(--r-card);
  padding: 6px 0;
  overflow: hidden;
}
.table-card :deep(.el-table) {
  background: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: transparent;
  --el-table-row-hover-bg-color: rgba(255, 255, 255, 0.72);
  --el-table-border-color: rgba(0, 0, 0, 0.05);
}
.table-card :deep(.el-table__inner-wrapper::before) { display: none; }
.table-card :deep(.el-table th.el-table__cell) { background: transparent; }

/* ══════════ 加载骨架（v8 表格行：头像圆+姓名条+次要列+状态位） ══════════ */
.sk {
  position: relative; overflow: hidden; flex: none;
  border-radius: 6px; background: var(--divider); display: inline-block;
}
.sk::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: skSweep 1.4s var(--ease) infinite;
}
@keyframes skSweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .sk::after { animation: none; background: none; } }
.sk-row { display: flex; align-items: center; gap: 13px; padding: 14px 18px; }
.sk-row + .sk-row { border-top: 1px solid var(--divider); }
.sk-av { border-radius: 50%; }
.sk-text { height: 12px; }
.sk-title { height: 15px; }
.sk-tag { height: 23px; border-radius: var(--r-pill); }

/* ══════════ 说明卡 ══════════ */
.explain { padding: 14px 18px; }
.explain-warn { border-color: #f3d6d6; background: #fffafa; }
.explain-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.explain-body { line-height: 1.85; color: var(--ink-2); }
.explain-body b { color: var(--ink); }
.explain-body code {
  font-family: var(--mono); font-size: 11.5px;
  background: var(--parchment); padding: 1px 6px; border-radius: 4px;
  color: var(--ink-2);
}

/* 弹窗提示 */
.form-hint { margin-top: 4px; line-height: 1.55; }
</style>