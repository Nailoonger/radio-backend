/* ============================================================
   伙伴端管理 · 静态预览专用构建
   ------------------------------------------------------------
   ⚠️ 与生产配置（vite.config.js）完全分开：
      · 入口是 partner-preview.html，产物进 preview/partner-admin-v1
      · 把 '@/utils/http' 换成 src/preview/httpMock.js（假数据）
      · 把 '@/stores/auth' 换成 src/preview/authMock.js（超管身份）
   生产构建一行不受影响 —— 这个配置文件不参与 npm run build。
   ============================================================ */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import path from 'path';
import fs from 'fs';

/**
 * 入口放在 `_pv/index.html`（避免和生产的 index.html 撞名），
 * 但产物会把目录层级带出来成 `_pv/index.html`，引用变成 `../assets/`。
 * 这里在打包结束时把它提到产物根、并把 `../assets/` 改回 `./assets/` ——
 * ⚠️ 不然从子路径打开就是白屏（陛下「看不到」的那次就是这个）。
 */
function flattenEntry() {
  const out = path.resolve(__dirname, 'dist-partner-preview/partner-admin-v1');
  return {
    name: 'flatten-preview-entry',
    closeBundle() {
      const src = path.join(out, '_pv', 'index.html');
      if (!fs.existsSync(src)) return;
      const html = fs.readFileSync(src, 'utf8').replace(/\.\.\/assets\//g, './assets/');
      fs.writeFileSync(path.join(out, 'index.html'), html);
      fs.rmSync(path.join(out, '_pv'), { recursive: true, force: true });
      // eslint-disable-next-line no-console
      console.log('[preview] 入口已提到产物根：index.html（相对路径 ./assets/）');
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
    flattenEntry(),
  ],
  resolve: {
    // ⚠️ 顺序要紧：plugin-alias 命中第一个「相等 or 前缀」就返回，
    //    把 '@' 写在前面会把 '@/utils/http' 吃掉（实测：假接口没生效，页面报「请先登录」）。
    alias: {
      '@/utils/http': path.resolve(__dirname, 'src/preview/httpMock.js'),
      '@/stores/auth': path.resolve(__dirname, 'src/preview/authMock.js'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // ⚠️ base 必须是 './'：产物要用相对路径引用 assets。
  //    写成默认 '/assets/...' 的话，一旦不是从站点根打开就全部 404 → 白屏（实测踩到）。
  base: './',
  build: {
    outDir: 'dist-partner-preview/partner-admin-v1',
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, '_pv/index.html') },
  },
});
