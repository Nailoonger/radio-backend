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
    // 二进制流（xlsx 下载等）不走 {code:0} 解包，直接返回 Blob
    if (resp.config.responseType === 'blob') return resp.data;
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
    // 40301 = 仅超级管理员可操作（权限边界在服务端，前端只负责把文案说人话）
    if (body?.code === 40301 || status === 403) {
      ElMessage.error(body?.message || '仅超级管理员可操作');
      return Promise.reject(err);
    }
    ElMessage.error(body?.message || err.message || '网络异常');
    return Promise.reject(err);
  }
);

export default http;
