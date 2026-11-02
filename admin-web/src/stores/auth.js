import { defineStore } from 'pinia';
import http from '@/utils/http';

/**
 * `ensureFresh` 的实例级状态（不进 store.state：它不该被持久化，也不该出现在 devtools 里）
 *   freshAt   —— 上次和服务端对账成功的时间
 *   pending   —— 正在进行的那次对账（路由守卫 + 轮询会撞在同一个 tick 里）
 */
let freshAt = 0;
let freshPending = null;
const FRESH_TTL = 5000;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('admin_token') || '',
    admin: JSON.parse(localStorage.getItem('admin_info') || 'null'),
  }),
  getters: {
    isSuperAdmin: (s) => s.admin?.role === 0,
    isLoggedIn: (s) => !!s.token,
  },
  actions: {
    async login(username, password) {
      const data = await http.post('/admin/login', { username, password });
      this.token = data.token;
      this.admin = data.admin;
      localStorage.setItem('admin_token', data.token);
      localStorage.setItem('admin_info', JSON.stringify(data.admin));
      freshAt = Date.now();          // 刚登录拿到的就是最新的，别马上再对一次
      return data.admin;
    },
    async fetchProfile() {
      const data = await http.get('/admin/profile');
      this.admin = data;
      localStorage.setItem('admin_info', JSON.stringify(data));
      freshAt = Date.now();
      return data;
    },
    /**
     * 和服务器对一次账 —— 修 2026-11-02 陛下报的「账号管理里切角色不实时同步」
     *
     * 原来只有 `login()` / 手动 `fetchProfile()` 会更新 `admin`，所以：
     *   超管在「账号管理」把某人改成社干（或社干升成超管）后，
     *   那个人那边从 localStorage 读的还是旧 role ⇒ 菜单、路由守卫（`meta.superAdmin`）、
     *   顶栏身份全是旧的，必须重新登录才变 —— 这就是「权限错乱」的前端那一半。
     *
     * 现在由路由守卫（每次跳转）和 MainLayout（30 秒轮询）调它：
     * 角色一变就写回 store + localStorage，菜单和守卫立刻跟着变，**不用重新登录**
     * （后端 `lib/auth.requireAdmin` 也改成以库为准，token 里的旧 role 不再作数）。
     *
     * @param {boolean} force 跳过 5 秒 TTL（轮询用）
     * @returns {Promise<{changed:boolean, from:number|null, to:number|null, admin:object|null}>}
     */
    async ensureFresh(force = false) {
      const idle = { changed: false, from: this.admin?.role ?? null, to: this.admin?.role ?? null, admin: this.admin };
      if (!this.token) return idle;
      if (!force && freshAt && Date.now() - freshAt < FRESH_TTL) return idle;
      if (freshPending) return freshPending;

      freshPending = (async () => {
        try {
          const data = await http.get('/admin/profile');
          const prev = this.admin || {};
          const changed = Number(prev.role) !== Number(data.role);
          this.admin = { ...prev, ...data };
          localStorage.setItem('admin_info', JSON.stringify(this.admin));
          freshAt = Date.now();
          return { changed, from: prev.role ?? null, to: data.role ?? null, admin: this.admin };
        } catch (e) {
          // 网络抖动 / 401（http 拦截器已清 token 跳登录）都不阻断页面，保持旧值
          return idle;
        } finally {
          freshPending = null;
        }
      })();
      return freshPending;
    },
    logout() {
      this.token = '';
      this.admin = null;
      freshAt = 0;
      freshPending = null;
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
    },
    async changePassword(oldPassword, newPassword) {
      return http.put('/admin/change-password', { oldPassword, newPassword });
    },
  },
});
