import { defineStore } from 'pinia';
import http from '@/utils/http';

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
      return data.admin;
    },
    async fetchProfile() {
      const data = await http.get('/admin/profile');
      this.admin = data;
      localStorage.setItem('admin_info', JSON.stringify(data));
      return data;
    },
    logout() {
      this.token = '';
      this.admin = null;
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
    },
    async changePassword(oldPassword, newPassword) {
      return http.put('/admin/change-password', { oldPassword, newPassword });
    },
  },
});
