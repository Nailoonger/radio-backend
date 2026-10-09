// 把「真组件 + 假接口」的取证壳构建成一份自包含静态页（双击即开，file:// 可用）。
// 与 vite.shot.config.js 的差别：base 相对、单文件 iife、输出到临时目录（再由脚本内联）。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

const mock = (name) => path.resolve(__dirname, '_shot-recruitment/mock', name);

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: [
      { find: '@/api/recruitment', replacement: mock('api.js') },
      { find: '@/stores/auth', replacement: mock('auth.js') },
      { find: '@/utils/pageHeader', replacement: mock('pageHeader.js') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, '_preview-recruitment-build'),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    // 单文件 iife：file:// 下 type="module" 会被 CORS 拦，必须是普通脚本。
    rollupOptions: {
      input: path.resolve(__dirname, '_shot-recruitment.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
