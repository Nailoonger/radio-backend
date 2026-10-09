// 取证用 vite 配置：只挂真实 Recruitment.vue（真组件 + 真 scoped CSS），
// 仅把「接口 / 登录态 / 页头」三处外部依赖替成假数据，其余一律走真代码。
// 不属于业务链路，只在需要给陛下看真实渲染时临时启用。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

const mock = (name) => path.resolve(__dirname, '_shot-recruitment/mock', name);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    // 顺序有讲究：具体路径必须排在 '@' 兜底之前。
    alias: [
      { find: '@/api/recruitment', replacement: mock('api.js') },
      { find: '@/stores/auth', replacement: mock('auth.js') },
      { find: '@/utils/pageHeader', replacement: mock('pageHeader.js') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  // 只扫取证入口；否则 admin-web 下那堆历史构建目录的 index.html 会一起进来拖垮依赖预打包。
  optimizeDeps: { entries: ['_shot-recruitment.html'] },
});
