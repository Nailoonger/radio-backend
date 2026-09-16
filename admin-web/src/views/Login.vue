<template>
  <div class="login-page">
    <!-- 背景层：双光晕 + 声波弧线 -->
    <div class="bg-glow bg-glow--tl" aria-hidden="true"></div>
    <div class="bg-glow bg-glow--br" aria-hidden="true"></div>
    <svg class="bg-wave" viewBox="0 0 560 560" fill="none" aria-hidden="true">
      <circle cx="280" cy="280" r="278" stroke="currentColor" stroke-opacity="0.26" />
      <circle cx="280" cy="280" r="222" stroke="currentColor" stroke-opacity="0.34" />
      <circle cx="280" cy="280" r="166" stroke="currentColor" stroke-opacity="0.42" />
      <circle cx="280" cy="280" r="110" stroke="currentColor" stroke-opacity="0.52" />
    </svg>

    <!-- 登录卡片：左表单 / 右品牌区 -->
    <div class="login-card">
      <!-- 左栏：登录表单 -->
      <div class="login-form">
        <div class="form-inner">
          <!-- 头部：站标 + 站名 -->
          <div class="brand-row">
            <img src="/station-badge.png" class="logo-img" alt="菁悠广播站" />
            <div class="brand-text">
              <div class="brand-name">菁悠广播站</div>
              <div class="brand-sub">JING YOU GUANG BO ZHAN</div>
            </div>
          </div>

          <div class="form-title">欢迎登录</div>
          <div class="form-tip">请使用管理员账号进入后台</div>

          <el-form :model="form" @keyup.enter="submit">
            <div class="field">
              <label class="field-label">账号</label>
              <el-form-item>
                <el-input v-model="form.username" placeholder="账号" size="large" :prefix-icon="User" />
              </el-form-item>
            </div>
            <div class="field">
              <label class="field-label">密码</label>
              <el-form-item>
                <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password :prefix-icon="Lock" />
              </el-form-item>
            </div>
            <el-button type="primary" size="large" class="submit-btn" :loading="loading" @click="submit">登 录</el-button>
          </el-form>

          <div class="hint">
            <IconInfo :size="15" />
            <span>默认超级管理员：teacher / admin123456</span>
          </div>
        </div>
      </div>

      <!-- 右栏：品牌区 + 功能清单 -->
      <div class="brand-panel">
        <div class="panel-inner">
          <!-- 头部 -->
          <div class="panel-head">
            <img src="/station-badge.png" class="panel-logo" alt="菁悠广播站" />
            <div class="panel-head-text">
              <div class="panel-title">菁悠广播站</div>
              <div class="panel-sub">校园广播内容管理平台</div>
            </div>
          </div>

          <div class="panel-divider"></div>

          <div class="panel-lead">登录后可管理以下全部模块</div>

          <!-- 功能清单 -->
          <ul class="feature-list">
            <li v-for="item in features" :key="item.title" class="feature-item">
              <span class="feature-icon">
                <component :is="item.icon" :size="20" />
              </span>
              <span class="feature-text">
                <span class="feature-title">{{ item.title }}</span>
                <span class="feature-desc">{{ item.desc }}</span>
              </span>
            </li>
          </ul>

          <!-- 底部信息 -->
          <div class="panel-foot">
            <IconMegaphone :size="15" />
            <span>菁悠广播站 · 校园广播中心技术支持</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { User, Lock } from '@element-plus/icons-vue';
import {
  IconInfo,
  IconMegaphone,
  IconCheck,
  IconCalendar,
  IconChat,
  IconTrend,
} from '@/components/icons';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const form = reactive({ username: 'teacher', password: 'admin123456' });
const loading = ref(false);

const features = [
  { icon: IconCheck, title: '投稿审核', desc: '歌曲与文章投稿的审核发布' },
  { icon: IconCalendar, title: '节目排期', desc: '栏目档期与播出时段编排' },
  { icon: IconChat, title: '听众留言', desc: '点歌与留言的审核回复' },
  { icon: IconTrend, title: '数据看板', desc: '收听与互动数据总览' },
];

async function submit() {
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    const redirect = route.query.redirect || '/dashboard';
    router.push(redirect);
  } catch { /* 拦截器已提示 */ }
  finally { loading.value = false; }
}
</script>

<style scoped>
/* ============ 页面基底 ============ */
.login-page {
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  background: #fbfbfd;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
}

/* 双光晕：左上大、右下小，对角呼应 */
.bg-glow {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.bg-glow--tl {
  width: 1240px;
  height: 1240px;
  left: -420px;
  top: -420px;
  background: radial-gradient(circle, rgba(0, 102, 204, 1) 0%, rgba(0, 102, 204, 0) 100%);
  opacity: 0.10;
}
.bg-glow--br {
  width: 700px;
  height: 700px;
  right: -170px;
  bottom: -160px;
  background: radial-gradient(circle, rgba(0, 102, 204, 1) 0%, rgba(0, 102, 204, 0) 100%);
  opacity: 0.07;
}

/* 声波扩散弧线（右下角） */
.bg-wave {
  position: absolute;
  right: -70px;
  bottom: -80px;
  width: 560px;
  height: 560px;
  color: #0066cc;
  pointer-events: none;
}

/* ============ 登录卡片 ============ */
.login-card {
  position: relative;
  display: flex;
  width: 960px;
  max-width: 100%;
  background: #ffffff;
  border-radius: 28px;
  box-shadow:
    0 18px 48px -8px rgba(10, 26, 46, 0.10),
    0 4px 12px rgba(10, 26, 46, 0.06);
  overflow: hidden;
  z-index: 1;
}

/* ============ 左栏：表单 ============ */
.login-form {
  width: 440px;
  flex-shrink: 0;
  padding: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.form-inner {
  width: 100%;
}

/* 头部：站标 + 站名 */
.brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 26px;
}
.logo-img {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
}
.brand-name {
  font-size: 17px;
  font-weight: 600;
  color: #1d1d1f;
  letter-spacing: -0.2px;
  line-height: 1.3;
}
.brand-sub {
  font-size: 10px;
  font-weight: 500;
  color: #86868b;
  letter-spacing: 1px;
  line-height: 1.3;
}

.form-title {
  font-size: 30px;
  font-weight: 700;
  color: #1d1d1f;
  letter-spacing: -0.5px;
  margin-bottom: 8px;
}
.form-tip {
  font-size: 14px;
  color: #86868b;
  margin-bottom: 26px;
}

/* 表单字段 */
.field {
  margin-bottom: 2px;
}
.field-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: #1d1d1f;
  margin-bottom: 8px;
}

/* Element Plus 输入框统一为设计稿风格 */
:deep(.el-form-item) {
  margin-bottom: 18px;
}
:deep(.el-input__wrapper) {
  background-color: #f5f5f7 !important;
  border-radius: 12px;
  box-shadow: none !important;
  padding: 4px 14px;
  height: 48px;
  transition: background-color 0.2s, box-shadow 0.2s;
}
:deep(.el-input__wrapper:hover) {
  background-color: #eef0f3 !important;
}
:deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff !important;
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.35) !important;
}
:deep(.el-input__inner) {
  font-size: 15px;
  color: #1d1d1f;
}
:deep(.el-input__inner::placeholder) {
  color: #a1a1a6;
}

/* 登录按钮：品牌蓝药丸（覆盖 Element Plus 默认渐变） */
.submit-btn {
  width: 100% !important;
  height: 50px;
  margin-top: 4px;
  border: none !important;
  border-radius: 980px !important;
  background-color: #0066cc !important;
  background-image: none !important;
  box-shadow: none !important;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #ffffff !important;
  transition: background-color 0.2s;
}
.submit-btn:hover,
.submit-btn:focus {
  background-color: #0055aa !important;
  background-image: none !important;
}
.submit-btn:active {
  background-color: #004a94 !important;
  background-image: none !important;
}
.submit-btn.is-loading,
.submit-btn.is-loading::before {
  background-color: #0055aa !important;
}

/* 提示条 */
.hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
  padding: 12px;
  background: #f5f5f7;
  border-radius: 10px;
  font-size: 12px;
  color: #6e6e73;
}
.hint :deep(.app-icon) {
  color: #86868b;
  flex-shrink: 0;
}

/* ============ 右栏：品牌区 ============ */
.brand-panel {
  flex: 1;
  min-width: 0;
  background: #eff3f8;
  padding: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* 头部 */
.panel-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.panel-logo {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: #ffffff;
  object-fit: cover;
  flex-shrink: 0;
  box-shadow: 0 4px 16px rgba(29, 29, 31, 0.08);
}
.panel-title {
  font-size: 24px;
  font-weight: 700;
  color: #1d1d1f;
  letter-spacing: -0.4px;
}
.panel-sub {
  font-size: 14px;
  color: #86868b;
  margin-top: 5px;
}

.panel-divider {
  height: 1px;
  background: rgba(29, 29, 31, 0.08);
  margin: 22px 0;
}

.panel-lead {
  font-size: 12px;
  color: #86868b;
  letter-spacing: 0.4px;
  margin-bottom: 16px;
}

/* 功能清单 */
.feature-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.feature-item {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 10px;
  border-radius: 12px;
}
.feature-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: #0066cc;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.feature-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.feature-title {
  font-size: 14px;
  font-weight: 500;
  color: #1d1d1f;
}
.feature-desc {
  font-size: 12px;
  color: #86868b;
}

/* 底部信息条 */
.panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
  padding: 14px;
  background: #ffffff;
  border-radius: 10px;
  font-size: 11px;
  color: #86868b;
}
.panel-foot :deep(.app-icon) {
  color: #0066cc;
  flex-shrink: 0;
}

/* ============ 响应式 ============ */
@media (max-width: 860px) {
  .login-card {
    width: 100%;
    max-width: 440px;
  }
  .brand-panel {
    display: none;
  }
  .login-form {
    width: 100%;
    padding: 40px 28px;
  }
  .bg-wave {
    display: none;
  }
}
</style>

<!-- 非 scoped：强制覆盖 Element Plus 按钮默认渐变皮肤 -->
<style>
.login-page .submit-btn.el-button--primary,
.login-page .submit-btn.el-button--primary:hover,
.login-page .submit-btn.el-button--primary:focus,
.login-page .submit-btn.el-button--primary:active {
  background-color: #0066cc !important;
  background-image: none !important;
  border-color: #0066cc !important;
  box-shadow: none !important;
  color: #ffffff !important;
  border-radius: 980px !important;
}
.login-page .submit-btn.el-button--primary:hover,
.login-page .submit-btn.el-button--primary:focus {
  background-color: #0055aa !important;
  border-color: #0055aa !important;
}
.login-page .submit-btn.el-button--primary:active {
  background-color: #004a94 !important;
  border-color: #004a94 !important;
}
/* 加载态：去掉 EP 的遮罩变淡效果 */
.login-page .submit-btn.el-button--primary.is-loading::before {
  background-color: transparent !important;
}
</style>
