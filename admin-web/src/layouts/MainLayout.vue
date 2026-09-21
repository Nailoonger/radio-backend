<template>
  <el-container class="layout">
    <el-aside width="232px" class="aside">
      <!-- 品牌 -->
      <div class="logo">
        <img src="/station-logo.jpg" class="logo-img" alt="菁悠广播站" />
        <div class="logo-text">
          <div class="brand">菁悠广播站</div>
          <div class="brand-sub">管理后台</div>
        </div>
      </div>

      <!-- 菜单搜索 -->
      <div class="menu-search">
        <IconSearch :size="15" />
        <input
          ref="searchInputRef"
          v-model="keyword"
          class="menu-search-input"
          placeholder="搜索菜单"
          @keydown.esc="closeSearch"
        />
        <kbd v-if="!keyword">Ctrl K</kbd>
        <button v-else class="menu-search-clear" title="清空" @click="keyword = ''">
          <IconClose :size="13" />
        </button>
      </div>

      <!-- 导航 -->
      <nav class="nav">
        <template v-for="group in filteredGroups" :key="group.title">
          <div v-if="group.items.length" class="nav-group">
            <div class="nav-group-title">{{ group.title }}</div>
            <a
              v-for="item in group.items"
              :key="item.path"
              class="nav-item"
              :class="{ on: route.path === item.path || route.path.startsWith(item.path + '/') }"
              @click="go(item.path)"
            >
              <component :is="item.icon" :size="18" />
              <span class="nav-text">{{ item.title }}</span>
              <em v-if="badgeOf(item.path)" class="nav-badge">{{ badgeOf(item.path) }}</em>
            </a>
          </div>
        </template>

        <div v-if="!hasResult" class="nav-empty">
          <IconSearch :size="20" />
          <span>没有匹配的菜单</span>
        </div>
      </nav>

      <!-- 底部账号 -->
      <div class="account">
        <span class="account-avatar">{{ avatar }}</span>
        <div class="account-info">
          <div class="account-name">{{ auth.admin?.nickname || auth.admin?.username || '管理员' }}</div>
          <div class="account-role">{{ auth.isSuperAdmin ? '超级管理员' : '普通管理员' }}</div>
        </div>
        <el-dropdown trigger="click" @command="onCommand">
          <button class="account-more" title="账号操作">
            <IconChevronDown :size="15" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="password">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </el-aside>

    <el-container class="right">
      <el-header class="header">
        <div class="header-left">
          <div class="header-title">
            {{ pageHeader.title || route.meta.title || '管理后台' }}
          </div>
          <div class="header-sub" v-if="pageHeader.subtitle">{{ pageHeader.subtitle }}</div>
        </div>

        <!-- 页头右上角动作容器：页面级按钮（如学生账号的「更多操作/名册导入」）
             用 Teleport 从各页面塞进来；其他页面此容器为空，不占位置 -->
        <div id="ph-actions" class="header-actions"></div>

        <div class="header-right">
          <!-- 全局搜索：投稿 / 公告 / 学生账号（v8 顶栏那颗搜索框） -->
          <div class="gsearch" :class="{ on: searchOpen }">
            <IconSearch :size="15" />
            <input
              v-model="searchKey"
              placeholder="搜索投稿 / 公告 / 用户"
              @input="onSearchInput"
              @focus="searchOpen = true"
              @blur="closeSearchSoon"
              @keyup.enter="runSearch"
            />
            <span class="kbd">Enter</span>

            <div class="gsearch-pop" v-if="searchOpen && searchKey.trim()">
              <div class="gs-group" v-if="results.submit.length">
                <div class="gs-t">投稿</div>
                <div class="gs-item" v-for="r in results.submit" :key="'s' + r.id" @mousedown.prevent="goSubmit(r)">
                  <span class="gs-strong">{{ r.type === 1 ? r.songName : r.articleTitle }}</span>
                  <span class="micro">{{ r.nickname || '' }}</span>
                </div>
              </div>
              <div class="gs-group" v-if="results.notice.length">
                <div class="gs-t">公告</div>
                <div class="gs-item" v-for="r in results.notice" :key="'n' + r.id" @mousedown.prevent="goNotice(r)">
                  <span class="gs-strong">{{ r.title }}</span>
                </div>
              </div>
              <div class="gs-group" v-if="results.student.length">
                <div class="gs-t">学生账号</div>
                <div class="gs-item" v-for="r in results.student" :key="'u' + r.id" @mousedown.prevent="goStudent(r)">
                  <span class="gs-strong">{{ r.nickname || r.username }}</span>
                  <span class="micro mono">{{ r.username }}</span>
                </div>
              </div>
              <div class="gs-empty" v-if="searching">搜索中…</div>
              <div class="gs-empty" v-else-if="!hasSearchResult">没有匹配的结果</div>
            </div>
          </div>

          <button class="icon-btn" title="刷新当前页" @click="doRefresh">
            <IconRefresh :size="16" />
          </button>
        </div>
      </el-header>

      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>

    <el-dialog v-model="passwordDialog" title="修改密码" width="420px">
      <el-form :model="pwForm" label-width="90px">
        <el-form-item label="原密码">
          <el-input v-model="pwForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwForm.newPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialog = false">取消</el-button>
        <el-button type="primary" :loading="pwLoading" @click="submitPassword">确认</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup>
import { computed, ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import {
  IconTrend, IconArticle, IconCalendar, IconMegaphone, IconChat,
  IconStar, IconSwitch, IconUsers, IconSettings, IconMusic, IconUserPlus,
  IconSearch, IconClose, IconChevronDown, IconRefresh,
} from '@/components/icons';
import { pageHeader, triggerRefresh } from '@/utils/pageHeader';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/* ---------------- 顶栏：副标题 / 全局搜索 / 刷新 ---------------- */
const searchOpen = ref(false);
const searchKey = ref('');
const searching = ref(false);
const results = reactive({ submit: [], notice: [], student: [] });
let searchTimer = null;

const hasSearchResult = computed(() => results.submit.length + results.notice.length + results.student.length > 0);

function closeSearchSoon() { setTimeout(() => { searchOpen.value = false; }, 160); }

/** 输入即搜（300ms 防抖），命中三类数据各取前 4 条 */
function onSearchInput() {
  clearTimeout(searchTimer);
  const kw = searchKey.value.trim();
  if (!kw) {
    results.submit = []; results.notice = []; results.student = [];
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(async () => {
    try {
      const [s, n, u] = await Promise.all([
        http.get('/admin/submit/list', { params: { page: 1, pageSize: 4, keyword: kw } }).catch(() => ({ list: [] })),
        http.get('/admin/notice/list', { params: { page: 1, pageSize: 4, keyword: kw } }).catch(() => ({ list: [] })),
        http.get('/admin/student/list', { params: { page: 1, pageSize: 4, keyword: kw } }).catch(() => ({ list: [] })),
      ]);
      results.submit = s.list || [];
      results.notice = n.list || [];
      results.student = u.list || [];
    } finally { searching.value = false; }
  }, 300);
}

function runSearch() {
  const kw = searchKey.value.trim();
  if (!kw) return;
  searchOpen.value = false;
  router.push({ path: '/submit', query: { keyword: kw } });
}

function goSubmit(r) { searchOpen.value = false; router.push({ path: '/submit', query: { keyword: r.type === 1 ? r.songName : r.articleTitle } }); }
function goNotice(r) { searchOpen.value = false; router.push({ path: '/notice', query: { keyword: r.title } }); }
function goStudent(r) { searchOpen.value = false; router.push({ path: '/student', query: { keyword: r.username } }); }

function doRefresh() { triggerRefresh(); }

const avatar = computed(() => (auth.admin?.nickname || auth.admin?.username || '管').charAt(0).toUpperCase());

/* ---------------- 菜单结构 ---------------- */
const NAV_GROUPS = [
  {
    title: '内容运营',
    items: [
      { path: '/dashboard', title: '数据概览', icon: IconTrend },
      { path: '/submit', title: '投稿 & 点歌审核', icon: IconArticle, badgeKey: 'submitPending' },
      { path: '/program', title: '栏目管理', icon: IconCalendar },
      { path: '/notice', title: '公告管理', icon: IconMegaphone },
      { path: '/message', title: '留言审核', icon: IconChat, badgeKey: 'messagePending' },
    ],
  },
  {
    title: '系统管理',
    items: [
      { path: '/student', title: '学生账号', icon: IconUserPlus, superAdmin: true },
      // v8：社干 + 部员合成一个「风采展示」，页内用分段切换（不再并排两个菜单）
      { path: '/showcase', title: '风采展示', icon: IconStar, superAdmin: true },
      { path: '/switch', title: '模块开关', icon: IconSwitch, superAdmin: true },
      { path: '/account', title: '账号管理', icon: IconUsers, superAdmin: true },
      { path: '/setting', title: '系统设置', icon: IconSettings, superAdmin: true },
    ],
  },
];

const keyword = ref('');
const searchInputRef = ref(null);

// 先按权限过滤
const visibleGroups = computed(() =>
  NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.superAdmin || auth.isSuperAdmin),
  }))
);

// 再按搜索词过滤
const filteredGroups = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return visibleGroups.value;
  return visibleGroups.value.map((g) => ({
    ...g,
    items: g.items.filter((it) => it.title.toLowerCase().includes(kw)),
  }));
});

const hasResult = computed(() => filteredGroups.value.some((g) => g.items.length));

/* ---------------- 待办红点 ---------------- */
const pending = ref({ submitPending: 0, messagePending: 0 });

function badgeOf(path) {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((it) => it.path === path);
  if (!item?.badgeKey) return 0;
  return pending.value[item.badgeKey] || 0;
}

async function loadPending() {
  if (!auth.isLoggedIn) return;
  try {
    const data = await http.get('/admin/stats/overview');
    pending.value = {
      submitPending: data?.submit?.pending ?? 0,
      messagePending: data?.message?.pending ?? 0,
    };
  } catch { /* 静默失败，红点不显示即可 */ }
}

/* ---------------- 导航 ---------------- */
function go(path) {
  if (route.path !== path) router.push(path);
}

/* ---------------- 账号操作 ---------------- */
const passwordDialog = ref(false);
const pwLoading = ref(false);
const pwForm = ref({ oldPassword: '', newPassword: '' });

function onCommand(cmd) {
  if (cmd === 'logout') {
    ElMessageBox.confirm('确认退出登录？', '提示', { type: 'warning' }).then(() => {
      auth.logout();
      router.push({ name: 'Login' });
    }).catch(() => {});
  } else if (cmd === 'password') {
    pwForm.value = { oldPassword: '', newPassword: '' };
    passwordDialog.value = true;
  }
}

async function submitPassword() {
  if (!pwForm.value.oldPassword || !pwForm.value.newPassword) {
    return ElMessage.warning('请填写完整');
  }
  if (pwForm.value.newPassword.length < 6) {
    return ElMessage.warning('新密码不能少于 6 位');
  }
  pwLoading.value = true;
  try {
    await auth.changePassword(pwForm.value.oldPassword, pwForm.value.newPassword);
    ElMessage.success('密码已修改，请重新登录');
    auth.logout();
    router.push({ name: 'Login' });
  } catch { /* 拦截器已提示 */ }
  finally { pwLoading.value = false; }
}

/* ---------------- 快捷键 Ctrl/Cmd + K ---------------- */
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInputRef.value?.focus();
  }
}
function closeSearch() {
  keyword.value = '';
  searchInputRef.value?.blur();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  loadPending();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.layout { height: 100vh; }

/* ══════════ 侧栏（v8 .rail：232px 白底，选中＝墨黑胶囊，无渐变无柔光） ══════════ */
.aside {
  background: var(--canvas);
  border-right: 1px solid var(--hairline);
  display: flex;
  flex-direction: column;
  padding: 18px 14px 14px;
}

.logo {
  display: flex; align-items: center; gap: 11px;
  padding: 0 6px 16px;
  flex-shrink: 0;
}
.logo-img {
  width: 36px; height: 36px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px var(--hairline);
}
.brand { font-size: var(--fs-md); font-weight: 600; color: var(--ink); letter-spacing: -0.2px; }
.brand-sub { font-size: var(--fs-2xs); color: var(--muted); margin-top: 1px; letter-spacing: var(--ls-wide-sm); }

/* 菜单搜索 */
.menu-search {
  display: flex; align-items: center; gap: 8px;
  height: 34px; padding: 0 11px;
  background: var(--parchment);
  border: none; border-radius: 10px;
  color: var(--soft);
  flex-shrink: 0;
  margin-bottom: 16px;
  transition: background 0.16s, box-shadow 0.16s;
}
.menu-search:focus-within {
  background: var(--canvas);
  box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px rgba(0, 102, 204, 0.1);
}
.menu-search-input {
  flex: 1; min-width: 0;
  border: none; outline: none; background: transparent;
  font-size: var(--fs-sm); font-family: inherit; color: var(--ink);
}
.menu-search-input::placeholder { color: var(--soft); }
.menu-search kbd {
  font-size: var(--fs-2xs); font-family: inherit;
  padding: 1px 5px; border-radius: 5px;
  background: var(--canvas); color: var(--muted); border: 1px solid var(--hairline);
  white-space: nowrap;
}
.menu-search-clear {
  border: none; background: transparent; cursor: pointer;
  color: var(--muted); padding: 2px; display: flex; border-radius: 4px;
}
.menu-search-clear:hover { color: var(--ink); }

/* 导航 */
.nav { flex: 1; min-height: 0; overflow-y: auto; padding: 0 2px 10px; }
.nav-group { margin-bottom: 2px; }
.nav-group-title {
  font-size: var(--fs-2xs); font-weight: 600; color: var(--soft);
  letter-spacing: 0.9px; padding: 12px 8px 7px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 11px; margin-bottom: 2px;
  border-radius: 11px;
  color: var(--ink-2); font-size: var(--fs-md);
  cursor: pointer; user-select: none;
  transition: background 0.16s, color 0.16s;
}
.nav-item :deep(svg) { color: var(--muted); transition: color 0.16s; flex-shrink: 0; }
.nav-item:hover { background: var(--parchment); color: var(--ink); }
.nav-item:hover :deep(svg) { color: var(--ink); }
.nav-item.on { background: var(--ink); color: #fff; font-weight: 600; }
.nav-item.on :deep(svg) { color: #fff; }
.nav-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-badge {
  font-style: normal;
  font-size: var(--fs-2xs); font-weight: 600;
  min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--ink); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.nav-item.on .nav-badge { background: #fff; color: var(--ink); }
.nav-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 32px 10px; color: var(--soft); font-size: var(--fs-sm);
}

/* 底部账号（v8 .rail-account：羊皮纸圆角块，头像＝墨底姓圆） */
.account {
  padding: 9px 10px;
  border-radius: 13px;
  background: var(--parchment);
  border: none;
  display: flex; align-items: center; gap: 8px;
  flex-shrink: 0;
}
.account-avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--ink); color: #fff; font-size: var(--fs-sm); font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.account-info { flex: 1; min-width: 0; }
.account-name {
  font-size: var(--fs-sm); font-weight: 600; color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-role { font-size: var(--fs-2xs); color: var(--muted); margin-top: 1px; }
.account-more {
  border: none; background: transparent; cursor: pointer;
  color: var(--soft); padding: 3px; border-radius: 6px;
  display: flex; flex-shrink: 0; transition: 0.15s;
  align-items: center;
}
.account-more:hover { color: var(--ink); }

/* ══════════ 右侧 ══════════ */
.right { min-width: 0; }

.header {
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.6);
  height: 60px;
  flex-shrink: 0;
  box-shadow: 0 2px 12px rgba(15, 23, 42, 0.04);
}
.header-title {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  display: flex; align-items: center; gap: 10px;
}
.brand-bar {
  display: inline-block;
  width: 4px; height: 18px;
  border-radius: 2px;
  background: var(--brand-gradient);
}

.main {
  background: transparent;
  padding: 20px;
}

/* 滚动条 */
.nav::-webkit-scrollbar { width: 5px; }
.nav::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.35); border-radius: 3px; }

/* ══════════════════════════════════════════════════════════
   顶栏（v8：白底 + 细分隔线，标题/副标题在左，搜索/刷新在右）
   ══════════════════════════════════════════════════════════ */
.header {
  background: var(--canvas);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-bottom: 1px solid var(--hairline);
  box-shadow: none;
}
/* v8 顶栏：标题 + 副标题 在左，页头动作组 + 全局搜索 + 刷新 在右 */
.header-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.header-sub { font-size: var(--fs-sm); color: var(--muted); letter-spacing: var(--ls-wide); }
.header-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
.header-right { margin-left: 12px; display: flex; align-items: center; gap: 12px; }

.gsearch {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  height: 36px; width: 258px; padding: 0 12px;
  background: var(--parchment);
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  color: var(--soft);
}
.gsearch.on { background: var(--canvas); border-color: var(--accent); }
.gsearch input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  font-family: inherit; font-size: var(--fs-sm); color: var(--ink);
}
.gsearch input::placeholder { color: var(--soft); }
.gsearch .kbd {
  font-size: var(--fs-2xs); color: var(--muted);
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: 6px; padding: 1px 6px;
}
.gsearch-pop {
  position: absolute; top: 42px; left: 0; right: 0; z-index: 30;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.32);
  padding: 8px;
  max-height: 60vh; overflow: auto;
}
.gs-group + .gs-group { border-top: 1px solid var(--divider); margin-top: 6px; padding-top: 6px; }
.gs-t { font-size: var(--fs-xs); color: var(--muted-2); padding: 4px 8px; letter-spacing: var(--ls-wide-sm); }
.gs-item {
  display: flex; align-items: baseline; gap: 8px;
  padding: 7px 8px; border-radius: 8px; cursor: pointer;
}
.gs-item:hover { background: var(--parchment); }
.gs-strong {
  font-size: var(--fs-md); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px;
}
.gs-empty { font-size: var(--fs-sm); color: var(--muted); padding: 10px 8px; text-align: center; }
.mono { font-family: var(--mono); }

.icon-btn {
  width: 36px; height: 36px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--hairline); background: var(--canvas);
  border-radius: var(--r-pill); cursor: pointer; color: var(--ink-2);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}
.icon-btn:hover { border-color: var(--soft); background: var(--parchment); }
.header-title { color: var(--ink); font-size: var(--fs-xl); letter-spacing: var(--ls-tight-sm); }
.brand-bar { background: var(--ink); }
/* v8：内容区底色是 --canvas（纯白 #ffffff），不是羊皮纸灰；
   羊皮纸（--parchment）只用于卡片内部的次级块，两者混用会让白色胶囊/卡片糊进背景。 */
.main { background: var(--canvas); }
</style>
