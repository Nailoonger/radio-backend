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
        <!-- 新建账号只有一个入口：从学生名册选人（超管 / 社干 / 站员 三档同一套逻辑）
             ⚠️ 2026-10-31 第二版：手打账号密码那条线已撤掉 ——
                账号就是学号、密码就是学生自己那份，这样才「一个账号登录两端」。 -->
        <el-button type="primary" @click="openMember">
          <IconUserPlus :size="15" class="btn-icon" />新增账号
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
              {{ roleLabel(row.role) }}
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

        <!-- 状态：正常 / 待激活 / 已停用（v8 浅色胶囊）
             ⚠️ 原来「待激活」旁边还挂了个「需后端新增」红标——那是给开发看的备注，
                不该印在界面上（超管看到只会困惑）。说明卡 ② 已交代待激活是前端派生的。 -->
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <span class="tag" :class="row.status === 1 ? (row.lastLoginAt ? 'tag-pass' : 'tag-pending') : 'tag-mute'">
              {{ row.status === 1 ? (row.lastLoginAt ? '正常' : '待激活') : '已停用' }}
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
          <EmptyState variant="content" title="暂无账号" description="点击右上角「新增账号」从学生名册选人" />
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
        社干仅可见「内容运营」组（数据概览、投稿审核、栏目管理、公告管理、留言审核）。<br>
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
        超管墨黑实底、社干羊皮纸底，靠底色区分层级。<b>纯 CSS 渲染，无图片请求，不占后端字段</b>；
        复姓或首字符是英文时只显示该字符，不会撑破圆形。<br>
        <b>② 「待激活」状态当前由前端派生：</b><code>admin.status</code> 只有 0 禁用 / 1 启用，
        暂无第三种值。这里用 <code>lastLoginAt == null</code> 渲染「待激活」标签——
        <b>不污染后端状态机，不需迁移</b>，副作用是「账号存在但长期未登录」也会显示待激活（业务上两者等价）。<br>
        <b>③ 重置密码 = 编辑弹窗里留空不修改、填了就是新密码：</b>复用
        <code>PUT /admin/admin/:id</code> 传 <code>password</code> 字段即可（已在用）。<br>
        <b>④ 想看真实头像需三处一起改：</b><code>admin</code> 表加 <code>avatar</code> 字段 → 挂载
        <code>POST /admin/upload/avatar</code> 路由（控制器/multer 已写好但未挂）→ <code>admin/list</code> 返回该字段。
        本版不做——超管自己管自己，几乎没有头像需求。<br>
        <b>⑤ 为什么三档都只能从名册选人：</b>超管、社干、站员只是<b>权限不同</b>，
        不是三种人 —— 真正的身份都在 <code>user</code> 表（学号登录）。
        手打账号会得到一行 <code>userId</code> 为空的记录，排班、请假、考勤查不到这个人；
        更麻烦的是密码会和学生的对不上，"一个账号登录两端"就不成立了。
        所以统一走右上角「<b>新增账号</b>」：从名册选人 → 学号取自 <code>user</code> →
        <code>admin.userId</code> 回指档案 → 密码就是学生自己那份
        （接口 <code>POST /partner/accounts/import</code>）。
      </div>
    </div>

    <!-- ══════════ 新增账号（超管 / 社干 / 站员 都从学生名册选人） ══════════ -->
    <el-dialog
      v-model="memberDialog" title="新增账号" width="560px"
      :close-on-click-modal="false" @closed="resetMember"
    >
      <div class="pm-sub">
        从学生名册里选一个人，<b>学号就是登录账号、密码就是他自己的学生密码</b>——
        学生端和伙伴端用同一套凭据，不用记两份。<br>
        学生还没设过密码的，这里给他落初始密码 <code>user + 学号</code>，首次登录会引导改密。
      </div>

      <!-- 三档角色：只决定「能做什么」，不决定「是谁」 -->
      <div class="pm-role">
        <div class="pm-role-lab">这个账号的身份</div>
        <el-radio-group v-model="memberRole">
          <el-radio :value="2">站员</el-radio>
          <el-radio :value="1">社干</el-radio>
          <el-radio :value="0">超级管理员</el-radio>
        </el-radio-group>
        <div class="micro pm-role-hint">{{ ROLE_HINT[memberRole] }}</div>
      </div>

      <el-input
        v-model="candKw" placeholder="搜姓名 / 学号" clearable
        @input="onCandInput"
      >
        <template #prefix><IconSearch :size="15" /></template>
      </el-input>

      <div class="cand-list" v-loading="candLoading">
        <div
          class="cand" v-for="c in cands" :key="c.userId"
          :class="{ on: pickUserId === c.userId }"
          @click="pickUserId = c.userId"
        >
          <span class="cand-dot"></span>
          <span class="cand-t">
            <b>{{ c.name }}</b>
            <i>{{ c.username }}<template v-if="c.grade"> · {{ c.grade }}{{ c.className || '' }}</template></i>
          </span>
          <span class="cand-cur" v-if="pickUserId === c.userId">已选</span>
        </div>
        <div class="cand-empty" v-if="!cands.length && !candLoading">
          没有可加的人 —— 名册为空，或者这些人已经有后台账号了。
        </div>
      </div>

      <div class="pm-foot-note" v-if="pickedCand">
        <span>将建：<b>{{ ROLE_LABEL[memberRole] }}</b></span>
        <span>{{ pickedCand.name }} <code>{{ pickedCand.username }}</code></span>
        <span>密码 <code>{{ pickedCand.hasPwd ? '他自己的学生密码' : initPwdOf(pickedCand.username) }}</code></span>
      </div>

      <template #footer>
        <el-button @click="memberDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!pickUserId" :loading="memberSaving" @click="saveMember">
          建账号
        </el-button>
      </template>
    </el-dialog>

    <!-- ══════════ 编辑弹窗（只用于编辑已有账号；新建统一走「新增账号」从名册选人） ══════════ -->
    <el-dialog
      v-model="dialog" title="编辑账号" width="480px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="100px" :rules="rules" ref="formRef">
        <el-form-item label="账号" prop="username">
          <el-input v-model="form.username" disabled placeholder="登录用户名" />
          <div class="micro form-hint">
            账号 = 学号，建号时就定死了，这里不能改。
          </div>
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="form.nickname" placeholder="显示在管理后台与小程序里的名字" />
        </el-form-item>
        <el-form-item label="重置密码">
          <el-input
            v-model="form.password" type="password" show-password
            placeholder="留空表示不修改"
          />
          <div class="micro form-hint">
            留空 = 不修改；填了就是新密码（至少 6 位），学生端那边也同时生效。<br>
            注意：<b>改自己的密码需要旧密码</b>，请在「我的资料」里操作。
          </div>
        </el-form-item>
        <!-- v8 屏 21：本人不能改自己的角色 / 状态（自保护） -->
        <el-form-item label="角色">
          <el-radio-group v-model="form.role" :disabled="isSelfEdit">
            <el-radio :value="0">超级管理员</el-radio>
            <el-radio :value="1">社干</el-radio>
            <el-radio :value="2">站员</el-radio>
          </el-radio-group>
          <div class="micro form-hint">
            三档只是权限不同，人还是同一个人：账号是学号，密码是学生自己那份。
          </div>
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
  // 2026-10-29：站员（role=2）进 admin 表后，这里是三档而不是两档
  const want = filter.role === 'super' ? 0 : (filter.role === 'normal' ? 1 : 2);
  return rows.value.filter((r) => r.role === want);
});

/* ── 角色分段 + 计数 ── */
const counts = computed(() => {
  const c = { super: 0, normal: 0, member: 0 };
  rows.value.forEach((r) => {
    if (r.role === 0) c.super++;
    else if (r.role === 1) c.normal++;
    else c.member++;
  });
  return c;
});
const roleSegs = computed(() => [
  { v: 'all',    label: '全部',     n: rows.value.length },
  { v: 'super',  label: '超管',     n: counts.value.super },
  { v: 'normal', label: '社干', n: counts.value.normal },
  { v: 'member', label: '站员',     n: counts.value.member },
]);
function setRole(v) { filter.role = v; }

const ROLE_LABEL = { 0: '超级管理员', 1: '社干', 2: '站员' };
function roleLabel(r) { return ROLE_LABEL[Number(r)] || '未知'; }

/* ── 新增账号：从学生名册选人建号（超管 / 社干 / 站员 三档同一套） ──
   走 POST /partner/accounts/import（userIds 只传一个），因为云端那一版已经把该做的都做了：
   学号从 user 表取（不会打错）、已有后台账号的自动排除（不会建重）、
   admin.userId 回指学生档案（查得到是谁）、密码复用学生自己那份。
   在这里自己拼 POST /admin/admin/create 反而会漏掉 userId，落一个查不到人的野账号。 */
const memberDialog = ref(false);
const memberSaving = ref(false);
const cands = ref([]);
const candLoading = ref(false);
const candKw = ref('');
const pickUserId = ref(null);
/** 这个账号的身份：2 站员 / 1 社干 / 0 超管。默认站员——误建超管代价最大，别给默认高权限 */
const memberRole = ref(2);
let candTimer = null;

/** 三档角色各自意味着什么（只在弹窗里给人看，权限真闸在后端） */
const ROLE_HINT = {
  2: '站员：能看班表、填可排时间、请假、投稿互动，不能审稿批假。',
  1: '社干：内容运营那一组菜单都能用（审稿、公告、留言、栏目、招新）。',
  0: '超级管理员：多一整个「系统管理」组，能管账号、开关、系统设置。',
};

const pickedCand = computed(() => cands.value.find((c) => c.userId === pickUserId.value) || null);

/** 初始密码口径：user + 学号（与云端 services/adminAccount 一致，别在这里改规则） */
function initPwdOf(no) { return 'user' + String(no || '').trim(); }

function openMember() {
  pickUserId.value = null;
  candKw.value = '';
  memberRole.value = 2;       // 每次打开都回到最小权限，不记住上次的选择
  memberDialog.value = true;
  loadCands();
}
function resetMember() {
  pickUserId.value = null;
  cands.value = [];
  candKw.value = '';
}
async function loadCands() {
  candLoading.value = true;
  try {
    const d = await http.get('/partner/accounts/candidates', {
      params: { keyword: candKw.value.trim() },
    });
    cands.value = Array.isArray(d?.list) ? d.list : [];
  } catch (e) {
    cands.value = [];
    ElMessage.error(e?.message || '学生名册加载失败');
  } finally { candLoading.value = false; }
}
/** 输入防抖：别每敲一个字就打一次名册 */
function onCandInput() {
  clearTimeout(candTimer);
  candTimer = setTimeout(loadCands, 220);
}

/** 建完之后切到对应的角色档，让人立刻看得见刚建的人 */
const TAB_OF_ROLE = { 0: 'super', 1: 'normal', 2: 'member' };

async function saveMember() {
  if (!pickUserId.value) return ElMessage.warning('请先选一个人');
  memberSaving.value = true;
  try {
    const r = await http.post('/partner/accounts/import', {
      userIds: [pickUserId.value], role: memberRole.value,
    });
    const ok = (r?.created || [])[0];
    const bad = (r?.skipped || [])[0];
    if (!ok) {
      // 常见于「刚被别人建过」——后端按 skipped 回报，不整体失败
      ElMessage.warning(bad?.reason || '没有建成，请刷新后重试');
      await loadCands();
      return;
    }
    // 后端只在学生原本没有密码时才落初始密码；有的话就是他自己那份，不显示也不该显示
    const pwdTip = ok.initPassword
      ? `初始密码 ${ok.initPassword}（首次登录会引导改密）`
      : '密码就是他的学生密码';
    ElMessage.success(`已建${ROLE_LABEL[ok.role] || ''} ${ok.name}（${ok.username}），${pwdTip}`);
    memberDialog.value = false;
    filter.role = TAB_OF_ROLE[Number(ok.role)] || 'all';
    await fetch();
  } catch (e) {
    ElMessage.error(e?.message || '建账号失败');
  } finally { memberSaving.value = false; }
}

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

/* ── 编辑弹窗（只编辑已有账号；新建走 openMember 从名册选人） ── */
const dialog = ref(false);
const formRef = ref(null);
const form = reactive({ id: null, username: '', nickname: '', password: '', role: 1, status: 1 });

const rules = {
  username: [{ required: true, message: '请填写账号', trigger: 'blur' }],
  password: [{ required: true, message: '请填写密码', trigger: 'blur' }],
};

function openEdit(row) {
  // ⚠️ 没有 row = 想新建 → 一律走名册，不再有手打表单
  if (!row) return openMember();
  Object.assign(form, {
    id: row.id, username: row.username, nickname: row.nickname || '',
    password: '', role: row.role, status: row.status,
  });
  dialog.value = true;
}

async function save() {
  // 表单校验（密码留空 = 不改，所以只在填了的时候校验长度）
  await formRef.value?.validate().catch(() => {});
  if (!form.username) return ElMessage.warning('请填写账号');
  if (form.password && form.password.length < 6) return ElMessage.warning('密码至少 6 位');

  saving.value = true;
  try {
    await http.put(`/admin/admin/${form.id}`, {
      nickname: form.nickname,
      password: form.password || undefined,    // 留空 = 不改
      role: form.role,
      status: form.status,
    });
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

/* ══════════ 新增站员弹窗（从名册选人） ══════════ */
.pm-sub {
  font-size: var(--fs-sm); color: var(--ink-2); line-height: 1.75;
  margin-bottom: 12px;
}
.pm-sub b { color: var(--ink); }
.pm-sub code, .pm-foot-note code {
  font-family: var(--mono); font-size: 11.5px;
  background: var(--parchment); padding: 1px 6px; border-radius: 4px; color: var(--ink-2);
  white-space: nowrap;   /* 「user + 学号」不许断成两行 */
}

/* 角色选择：一行说明 + 三档单选。
   ⚠️ 不另起配色，选中态仍然交给 Element 的 --accent；这里只管留白与分隔 */
.pm-role {
  margin: 0 0 12px;
  padding: 10px 14px 8px;
  background: var(--parchment);
  border-radius: 12px;
}
.pm-role-lab {
  font-size: var(--fs-2xs); font-weight: 600; letter-spacing: var(--ls-wide);
  color: var(--muted); margin-bottom: 2px;
}
.pm-role-hint {
  margin-top: 2px; line-height: 1.55; color: var(--ink-2);
}

/* 候选人列表：白底描边行，选中一行蓝底蓝边（不用实心蓝，5 行会糊成一片） */
.cand-list {
  margin-top: 10px; max-height: 320px; overflow-y: auto;
  border: 1px solid var(--hairline); border-radius: 12px;
  background: var(--canvas);
}
.cand {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; cursor: pointer;
  border-bottom: 1px solid var(--divider);
  transition: background 0.14s var(--ease);
}
.cand:last-child { border-bottom: none; }
.cand:hover { background: var(--parchment); }
.cand.on { background: rgba(0, 102, 204, 0.07); }
/* 单选圆点：空心 → 选中时内圈填蓝 */
.cand-dot {
  width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;
  box-shadow: inset 0 0 0 1.5px var(--hairline);
  transition: box-shadow 0.14s var(--ease);
}
.cand.on .cand-dot { box-shadow: inset 0 0 0 5px var(--accent); }
.cand-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cand-t b { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.cand-t i {
  font-style: normal; font-family: var(--mono);
  font-size: 11.5px; color: var(--muted);
}
.cand-cur {
  flex: none; font-size: var(--fs-2xs); font-weight: 600;
  color: var(--accent); letter-spacing: var(--ls-wide);
}
.cand-empty {
  padding: 26px 14px; text-align: center;
  font-size: var(--fs-sm); color: var(--muted);
}

/* 底部将要建成的账号摘要 */
.pm-foot-note {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  margin-top: 12px; padding: 10px 14px;
  background: var(--parchment); border-radius: 12px;
  font-size: var(--fs-sm); color: var(--ink-2);
}
.pm-foot-note b { color: var(--ink); }

</style>