import { defineStore } from 'pinia';

/**
 * 预览用 auth —— 只为让「仅超管」的判断在预览里成立。
 * 生产走真的 src/stores/auth.js（读 localStorage + /admin/profile）。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: 'preview-token',
    admin: { id: 1, username: 'admin', nickname: '陈老师', role: 0 },
  }),
  getters: {
    isSuperAdmin: (s) => s.admin?.role === 0,
    isLoggedIn: (s) => !!s.token,
  },
  actions: { logout() {} },
});
