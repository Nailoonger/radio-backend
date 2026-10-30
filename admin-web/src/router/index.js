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
      // v8：点歌设置不是独立模块，是「投稿 & 点歌审核」里的子页面（列表右上角入口进入）
      { path: 'submit/settings', name: 'SongSettings', component: () => import('@/views/SongSettings.vue'), meta: { title: '点歌设置' } },
      { path: 'program', name: 'Program', component: () => import('@/views/Program.vue'), meta: { title: '节目排期' } },
      { path: 'notice', name: 'Notice', component: () => import('@/views/Notice.vue'), meta: { title: '公告管理' } },
      { path: 'message', name: 'Message', component: () => import('@/views/Message.vue'), meta: { title: '留言审核' } },
      { path: 'recruitment', name: 'Recruitment', component: () => import('@/views/Recruitment.vue'), meta: { title: '招新管理' } },
      { path: 'student', name: 'Student', component: () => import('@/views/StudentAccounts.vue'), meta: { title: '学生账号', superAdmin: true } },
      { path: 'showcase', name: 'Showcase', component: () => import('@/views/Showcase.vue'), meta: { title: '风采展示', superAdmin: true } },
      { path: 'cadre', name: 'Cadre', component: () => import('@/views/Cadre.vue'), meta: { title: '风采展示 - 社干', superAdmin: true } },
      { path: 'staff', name: 'Staff', component: () => import('@/views/Staff.vue'), meta: { title: '风采展示 - 部门人员', superAdmin: true } },
      { path: 'switch', name: 'Switch', component: () => import('@/views/Switch.vue'), meta: { title: '模块开关', superAdmin: true } },
      { path: 'account', name: 'Account', component: () => import('@/views/Account.vue'), meta: { title: '账号管理', superAdmin: true } },
      /**
       * ⚠️ 伙伴端那组路由（/partner/*，9 条）已摘掉 —— 2026-10-31 陛下明确要求
       *    「管理端 web 的伙伴端先删掉，我还没喊你做」。
       *
       * 这里只摘路由、**不删文件**（Partner*.vue 全在 src/views/ 里原样保留），
       * 与小程管端退役时同一处置口径：拿掉入口，不销毁成果。
       * 要恢复就把这 9 行加回来，页面本身一行都不用改。
       */
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
