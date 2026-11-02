import { createRouter, createWebHistory } from 'vue-router';
import { ElMessage } from 'element-plus';
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

/**
 * 路由守卫（2026-11-02 改异步）
 *
 * ⚠️ 为什么要 `await ensureFresh()`：
 *    原来只读 localStorage 里的 `admin.role`。超管在「账号管理」把某人降权/升权后，
 *    那个人那边一直是旧角色 —— 降权的人还能点进系统管理，升权的人看不到菜单，
 *    必须重新登录才变（陛下报的「切换账号角色无法实时同步、导致权限错乱」）。
 *    这里每次跳转前和服务器对一次账（store 里有 5 秒 TTL，不会每跳一次都打接口），
 *    角色一变 store 就更新，菜单与下面的 superAdmin 判定立刻跟着变。
 * ⚠️ 对账失败不阻断导航：`.catch(() => null)` 之后按本地旧角色继续（断网也能用后台）。
 */
router.beforeEach(async (to, from, next) => {
  const auth = useAuthStore();
  if (to.meta.public) return next();
  if (!auth.isLoggedIn) return next({ name: 'Login', query: { redirect: to.fullPath } });

  const fresh = await auth.ensureFresh().catch(() => null);

  if (to.meta.superAdmin && !auth.isSuperAdmin) {
    // 角色刚被改掉：明说一句，别让人以为是页面坏了
    if (fresh && fresh.changed) {
      ElMessage.warning('你的权限已被调整，系统管理那组菜单已收起');
    }
    return next({ name: 'Dashboard' });
  }
  next();
});

export default router;
