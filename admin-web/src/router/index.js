import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'Dashboard', component: () => import('@/views/Dashboard.vue'), meta: { title: '数据概览' } },
      { path: 'submit', name: 'Submit', component: () => import('@/views/SubmitList.vue'), meta: { title: '投稿审核' } },
      { path: 'program', name: 'Program', component: () => import('@/views/Program.vue'), meta: { title: '节目排期' } },
      { path: 'notice', name: 'Notice', component: () => import('@/views/Notice.vue'), meta: { title: '公告管理' } },
      { path: 'message', name: 'Message', component: () => import('@/views/Message.vue'), meta: { title: '留言审核' } },
      { path: 'member', name: 'Member', component: () => import('@/views/Member.vue'), meta: { title: '风采展示', superAdmin: true } },
      { path: 'switch', name: 'Switch', component: () => import('@/views/Switch.vue'), meta: { title: '模块开关', superAdmin: true } },
      { path: 'account', name: 'Account', component: () => import('@/views/Account.vue'), meta: { title: '账号管理', superAdmin: true } },
      { path: 'setting', name: 'Setting', component: () => import('@/views/Setting.vue'), meta: { title: '系统设置', superAdmin: true } },
    ],
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to, from, next) => {
  const auth = useAuthStore();
  if (to.meta.public) return next();
  if (!auth.isLoggedIn) return next({ name: 'Login', query: { redirect: to.fullPath } });
  if (to.meta.superAdmin && !auth.isSuperAdmin) {
    return next({ name: 'Dashboard' });
  }
  next();
});

export default router;
