<template>
  <div class="login-page">
    <!-- ============ 顶部栏 ============ -->
    <header class="topbar">
      <div class="topbar-brand">
        <img src="/station-badge.png" class="topbar-logo" alt="菁悠广播站" />
        <span class="topbar-name">菁悠广播站</span>
      </div>
      <nav class="topbar-nav">
        <span class="nav-link">返回官网</span>
        <span class="nav-link">使用帮助</span>
        <span class="nav-link">小程序端</span>
        <span class="nav-link">关于我们</span>
      </nav>
    </header>

    <!-- ============ 主体 ============ -->
    <main class="main">
      <!-- 左：品牌插画 -->
      <section class="brand">
        <svg class="brand-art" viewBox="0 0 330 240" fill="none" aria-hidden="true">
          <path
            d="M150.6 90.5 A42 42 0 0 1 179.4 90.5"
            stroke="#0066CC" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.9"
          />
          <path
            d="M138 72 A64 64 0 0 1 192.1 72"
            stroke="#0066CC" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.55"
          />
          <path
            d="M124.6 54.1 A86 86 0 0 1 205.4 54.1"
            stroke="#0066CC" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.3"
          />
          <rect x="75" y="130" width="180" height="76" rx="10" stroke="#0066CC" stroke-width="2.6" />
          <circle cx="122" cy="168" r="26" stroke="#0066CC" stroke-width="2.6" />
          <circle cx="122" cy="168" r="15" stroke="#0066CC" stroke-width="2.4" stroke-opacity="0.55" />
          <circle cx="122" cy="168" r="4.5" fill="#0066CC" />
          <circle cx="200" cy="168" r="9" stroke="#0066CC" stroke-width="2.4" />
          <path d="M200 161v4" stroke="#0066CC" stroke-width="2.4" stroke-linecap="round" />
          <circle cx="232" cy="168" r="9" stroke="#0066CC" stroke-width="2.4" />
          <path d="M232 161v4" stroke="#0066CC" stroke-width="2.4" stroke-linecap="round" />
        </svg>
        <p class="brand-tagline">让每一个声音，都被听见</p>
      </section>

      <!-- 右：登录卡片 -->
      <section class="card-wrap">
        <div class="login-card">
          <div class="card-head">
            <h1 class="card-title">管理员登录</h1>
            <p class="card-sub">请使用管理员账号进入后台</p>
          </div>

          <el-form :model="form" @keyup.enter="submit">
            <div class="field">
              <label class="field-label">账号</label>
              <el-form-item>
                <el-input v-model="form.username" size="large" autocomplete="username">
                  <template #prefix>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M13.3 14v-1.4a2.8 2.8 0 0 0-2.8-2.8H5.5A2.8 2.8 0 0 0 2.7 12.6V14"
                        stroke="#9AA3AE" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
                      />
                      <circle cx="8" cy="5" r="2.6" stroke="#9AA3AE" stroke-width="1.4" />
                    </svg>
                  </template>
                </el-input>
              </el-form-item>
            </div>

            <div class="field">
              <label class="field-label">密码</label>
              <el-form-item>
                <el-input
                  v-model="form.password"
                  type="password"
                  size="large"
                  show-password
                  autocomplete="current-password"
                >
                  <template #prefix>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="3" y="7" width="10" height="7" rx="1.6" stroke="#9AA3AE" stroke-width="1.4" />
                      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="#9AA3AE" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                  </template>
                </el-input>
              </el-form-item>
            </div>

            <el-button
              type="primary"
              size="large"
              class="submit-btn"
              :loading="loading"
              @click="submit"
            >登 录</el-button>
          </el-form>

          <div class="card-divider"></div>

          <div class="card-foot">
            <label class="remember">
              <input v-model="remember" type="checkbox" class="remember-input" />
              <span class="remember-box" aria-hidden="true"></span>
              <span class="remember-text">记住账号</span>
            </label>
            <span class="help">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6" stroke="#A3A9B2" stroke-width="1.2" />
                <path
                  d="M5.5 5.6a1.6 1.6 0 0 1 3.1.6c0 1.1-1.6 1.4-1.6 2.4"
                  stroke="#A3A9B2" stroke-width="1.2" stroke-linecap="round"
                />
                <circle cx="7" cy="10.6" r="0.75" fill="#A3A9B2" />
              </svg>
              <span class="help-text">帮助</span>
            </span>
          </div>
        </div>

        <p class="hint">默认超级管理员 teacher / admin123456</p>
      </section>
    </main>

    <!-- ============ 页脚 ============ -->
    <footer class="footer">
      <nav class="footer-links">
        <span class="footer-link">关于我们</span>
        <span class="footer-link">使用帮助</span>
        <span class="footer-link">隐私保护</span>
        <span class="footer-link">小程序端</span>
      </nav>
      <p class="footer-copy">菁悠广播站 版权所有 · 校园广播中心 技术支持</p>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const REMEMBER_KEY = 'admin_remember_username';

const savedUsername = localStorage.getItem(REMEMBER_KEY) || 'teacher';
const form = reactive({ username: savedUsername, password: 'admin123456' });
const remember = ref(Boolean(localStorage.getItem(REMEMBER_KEY)));
const loading = ref(false);

async function submit() {
  loading.value = true;
  try {
    await auth.login(form.username, form.password);

    if (remember.value) localStorage.setItem(REMEMBER_KEY, form.username);
    else localStorage.removeItem(REMEMBER_KEY);

    const redirect = route.query.redirect || '/dashboard';
    router.push(redirect);
  } catch {
    /* 响应拦截器已提示 */
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
/* ==================== 页面基底 ==================== */
.login-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  /* 对角淡渐变：左上浅蓝 → 右下近白，为玻璃卡片提供可透的底色 */
  background: linear-gradient(135deg, #e1ecf8 0%, #fbfdfe 100%);
  background-attachment: fixed;
}

/* ==================== 顶部栏 ==================== */
.topbar {
  flex-shrink: 0;
  height: 64px;
  padding: 0 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.topbar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar-logo {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.topbar-name {
  font-size: 15px;
  font-weight: 600;
  color: #1d1d1f;
  letter-spacing: -0.1px;
}
.topbar-nav {
  display: flex;
  align-items: center;
  gap: 26px;
}
.nav-link {
  font-size: 12px;
  color: #787d85;
}

/* ==================== 主体 ==================== */
.main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 84px;
  padding: 24px 20px;
}

/* ==================== 品牌插画区 ==================== */
.brand {
  width: 330px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
}
.brand-art {
  width: 330px;
  height: 240px;
  display: block;
}
.brand-tagline {
  margin: 0;
  font-size: 15px;
  color: #6b7280;
  letter-spacing: 0.2px;
}

/* ==================== 卡片容器 ==================== */
.card-wrap {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

/* ==================== 玻璃登录卡片 ==================== */
.login-card {
  position: relative;
  width: 100%;
  padding: 40px 40px 36px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.68);
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.55),
    0 4px 10px -4px rgba(15, 28, 46, 0.045),
    0 12px 28px -8px rgba(15, 28, 46, 0.04),
    0 24px 56px -12px rgba(15, 28, 46, 0.03);
}

/* 渐变描边：上沿受光发白、下沿收暗 */
.login-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.06) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}

/* 卡片标题区 */
.card-head {
  margin-bottom: 20px;
}
.card-title {
  margin: 0 0 7px;
  font-size: 22px;
  font-weight: 600;
  color: #141519;
  letter-spacing: -0.3px;
  line-height: 1.3;
}
.card-sub {
  margin: 0;
  font-size: 13px;
  color: #6e7178;
  line-height: 1.4;
}

/* 字段 */
.field + .field {
  margin-top: 16px;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  margin-bottom: 8px;
}
.field :deep(.el-form-item) {
  margin-bottom: 0;
}
.field :deep(.el-input__wrapper) {
  padding: 4px 14px;
  border-radius: 10px;
}

/* 登录按钮：整宽实心蓝 */
button.submit-btn {
  width: 100%;
  height: 46px;
  margin-top: 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 6px;
  background: #2f6be8;
  border: none;
  box-shadow: 0 8px 18px -6px rgba(47, 107, 232, 0.45);
}
button.submit-btn:hover {
  background: #2a60d4;
  transform: none;
}
button.submit-btn:active {
  background: #2556bd;
}

/* 卡片底部分隔线 */
.card-divider {
  height: 1px;
  margin: 20px 0;
  background: rgba(10, 26, 46, 0.09);
}

/* 记住账号 / 帮助 */
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.remember {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  user-select: none;
}
.remember-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.remember-box {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1.2px solid rgba(10, 26, 46, 0.24);
  flex-shrink: 0;
  transition: background-color 0.15s, border-color 0.15s;
}
.remember-input:checked + .remember-box {
  background: #0066cc;
  border-color: #0066cc;
  box-shadow: inset 0 0 0 2.5px #ffffff;
}
.remember-input:focus-visible + .remember-box {
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.3);
}
.remember-text {
  font-size: 12px;
  color: #6b7280;
}
.help {
  display: flex;
  align-items: center;
  gap: 5px;
}
.help-text {
  font-size: 12px;
  color: #787d85;
}

/* 默认账号提示 */
.hint {
  margin: 0;
  font-size: 12px;
  color: #8a9199;
}

/* ==================== 页脚 ==================== */
.footer {
  flex-shrink: 0;
  padding: 26px 20px 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.footer-links {
  display: flex;
  align-items: center;
  gap: 22px;
}
.footer-link {
  font-size: 12px;
  color: #8a9199;
}
.footer-copy {
  margin: 0;
  font-size: 11.5px;
  color: #a6adb5;
}

/* ==================== 窄屏适配 ==================== */
@media (max-width: 900px) {
  .main { gap: 40px; }
  .brand { display: none; }
  .topbar { padding: 0 24px; }
}
</style>
