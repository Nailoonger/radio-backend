<template>
  <el-container class="layout">
    <el-aside width="212px" class="aside">
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
              :class="{ on: route.path === item.path }"
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
        <div class="header-title">
          <span class="brand-bar"></span>
          {{ route.meta.title || '管理后台' }}
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
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '@/utils/http';
import {
  IconTrend, IconArticle, IconCalendar, IconMegaphone, IconChat,
  IconStar, IconSwitch, IconUsers, IconSettings,
  IconSearch, IconClose, IconChevronDown,
} from '@/components/icons';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const avatar = computed(() => (auth.admin?.nickname || auth.admin?.username || '管').charAt(0).toUpperCase());

/* ---------------- 菜单结构 ---------------- */
const NAV_GROUPS = [
  {
    title: '内容运营',
    items: [
      { path: '/dashboard', title: '数据概览', icon: IconTrend },
      { path: '/submit', title: '投稿审核', icon: IconArticle, badgeKey: 'submitPending' },
      { path: '/program', title: '栏目管理', icon: IconCalendar },
      { path: '/notice', title: '公告管理', icon: IconMegaphone },
      { path: '/message', title: '留言审核', icon: IconChat, badgeKey: 'messagePending' },
    ],
  },
  {
    title: '系统管理',
    items: [
      { path: '/member', title: '风采展示', icon: IconStar, superAdmin: true },
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

/* ══════════ 侧栏：浅色磨砂（方案 A） ══════════ */
.aside {
  position: relative;
  background: #fff;
  border-right: 1px solid #e8edf3;
  display: flex;
  flex-direction: column;
  box-shadow: 1px 0 12px rgba(15, 23, 42, 0.03);
}
/* 青蓝柔光层：品牌色以「光」的形式存在，而非底色 */
.aside::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(at 12% 8%, rgba(6, 182, 212, 0.13) 0px, transparent 52%),
    radial-gradient(at 88% 92%, rgba(99, 102, 241, 0.11) 0px, transparent 52%),
    linear-gradient(168deg, #fbfdff 0%, #f5f8fd 55%, #f3f5fc 100%);
}
.aside > * { position: relative; z-index: 1; }

.logo {
  display: flex; align-items: center; gap: 11px;
  padding: 19px 18px 17px;
  flex-shrink: 0;
}
.logo-img {
  width: 38px; height: 38px;
  border-radius: 11px;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: 0 3px 10px rgba(6, 182, 212, 0.24), 0 0 0 1px rgba(255, 255, 255, 0.9);
}
.brand { font-size: 14.5px; font-weight: 600; color: #0f172a; letter-spacing: -0.1px; }
.brand-sub { font-size: 10.5px; color: #94a3b8; margin-top: 2px; letter-spacing: 0.4px; }

/* 菜单搜索 */
.menu-search {
  margin: 0 14px 14px;
  display: flex; align-items: center; gap: 8px;
  height: 35px; padding: 0 11px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e8edf3;
  border-radius: 9px;
  color: #94a3b8;
  flex-shrink: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.menu-search:focus-within {
  border-color: #a5f3fc;
  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.1);
}
.menu-search-input {
  flex: 1; min-width: 0;
  border: none; outline: none; background: transparent;
  font-size: 12.5px; font-family: inherit; color: #334155;
}
.menu-search-input::placeholder { color: #94a3b8; }
.menu-search kbd {
  font-size: 10px; font-family: inherit;
  padding: 2px 5px; border-radius: 4px;
  background: #f1f5f9; color: #94a3b8; border: 1px solid #e8edf3;
  white-space: nowrap;
}
.menu-search-clear {
  border: none; background: transparent; cursor: pointer;
  color: #94a3b8; padding: 2px; display: flex; border-radius: 4px;
}
.menu-search-clear:hover { color: #475569; background: #f1f5f9; }

/* 导航 */
.nav { flex: 1; overflow-y: auto; padding: 0 10px 10px; }
.nav-group { margin-bottom: 6px; }
.nav-group-title {
  font-size: 10.5px; font-weight: 600; color: #94a3b8;
  letter-spacing: 0.7px; padding: 9px 10px 6px;
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  height: 39px; padding: 0 10px; margin-bottom: 2px;
  border-radius: 9px;
  color: #475569; font-size: 13.5px;
  cursor: pointer; user-select: none;
  transition: background 0.15s, color 0.15s;
}
.nav-item :deep(svg) { color: #94a3b8; transition: color 0.15s; }
.nav-item:hover { background: rgba(6, 182, 212, 0.07); color: #0e7490; }
.nav-item:hover :deep(svg) { color: #0891b2; }
.nav-item.on {
  background: linear-gradient(135deg, rgba(6, 182, 212, 0.13), rgba(99, 102, 241, 0.12));
  color: #0e7490; font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(6, 182, 212, 0.2);
}
.nav-item.on :deep(svg) { color: #0891b2; }
.nav-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-badge {
  font-style: normal;
  font-size: 10.5px; font-weight: 600;
  min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 9.5px;
  background: #ef4444; color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.nav-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 32px 10px; color: #94a3b8; font-size: 12px;
}

/* 底部账号 */
.account {
  margin: 10px; padding: 11px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e8edf3;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
  display: flex; align-items: center; gap: 10px;
  flex-shrink: 0;
}
.account-avatar {
  width: 31px; height: 31px; border-radius: 9px;
  background: linear-gradient(135deg, #06b6d4, #6366f1);
  color: #fff; font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.account-info { flex: 1; min-width: 0; }
.account-name {
  font-size: 12.5px; font-weight: 600; color: #0f172a;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.account-role { font-size: 10.5px; color: #94a3b8; margin-top: 1px; }
.account-more {
  border: none; background: transparent; cursor: pointer;
  color: #94a3b8; padding: 3px; border-radius: 6px;
  display: flex; flex-shrink: 0; transition: 0.15s;
  align-items: center;
}
.account-more:hover { color: #475569; background: #f1f5f9; }

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
</style>
