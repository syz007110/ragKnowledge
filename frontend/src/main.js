import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import './assets/styles/design-tokens.css';
import './assets/styles/global.css';

import App from './App.vue';
import router from './router';
import { i18n } from './i18n';

createApp(App).use(router).use(ElementPlus).use(i18n).mount('#app');
