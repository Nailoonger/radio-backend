import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/dist/locale/zh-cn.mjs';
import 'element-plus/dist/index.css';
import '../styles/theme.css';
import '../styles/partner.css';
import PartnerPreview from './PartnerPreview.vue';

createApp(PartnerPreview).use(createPinia()).use(ElementPlus, { locale: zhCn }).mount('#app');
