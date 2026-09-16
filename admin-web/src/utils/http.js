import axios from 'axios';
import { ElMessage } from 'element-plus';
import router from '@/router';

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    if (body?.code === 0) return body.data;
    // 业务错误：抛出，让调用方决定如何提示
    const err = new Error(body?.message || '请求失败');
    err.code = body?.code;
    err.httpStatus = resp.status;
    return Promise.reject(err);
  },
  (err) => {
    const status = err.response?.status;
    const body = err.response?.data;
    if (status === 401) {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
      if (router.currentRoute.value.name !== 'Login') {
        router.push({ name: 'Login' });
      }
    }
    ElMessage.error(body?.message || err.message || '网络异常');
    return Promise.reject(err);
  }
);

export default http;
