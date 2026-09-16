<template>
  <router-view />
</template>

<script setup>
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { onMounted } from 'vue';

const auth = useAuthStore();

// 启动时尝试恢复登录态
onMounted(async () => {
  if (auth.token && !auth.admin) {
    try { await auth.fetchProfile(); } catch { auth.logout(); }
  }
});
</script>
