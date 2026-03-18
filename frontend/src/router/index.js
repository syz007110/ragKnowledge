import { createRouter, createWebHistory } from 'vue-router';
import Login from '../views/Login.vue';
import KBWorkspace from '../views/KBWorkspace.vue';
import KBDetail from '../views/KBDetail.vue';
import KBSettings from '../views/KBSettings.vue';
import KBRecycleBin from '../views/KBRecycleBin.vue';
import { isAuthenticated, isAdmin } from '../utils/auth';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: Login,
    meta: { guestOnly: true }
  },
  {
    path: '/workspace',
    name: 'kb-workspace',
    component: KBWorkspace,
    meta: { requiresAuth: true }
  },
  {
    path: '/knowledge/:id',
    name: 'kb-detail',
    component: KBDetail,
    meta: { requiresAuth: true }
  },
  {
    path: '/recycle-bin',
    name: 'kb-recycle-bin',
    component: KBRecycleBin,
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/tags',
    name: 'kb-settings',
    component: KBSettings,
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/',
    redirect: '/workspace'
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/workspace'
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach((to, from, next) => {
  const authed = isAuthenticated();
  if (to.meta.requiresAuth && !authed) {
    next('/login');
    return;
  }
  if (to.meta.guestOnly && authed) {
    next('/workspace');
    return;
  }
  if (to.meta.requiresAdmin && !isAdmin()) {
    next('/workspace');
    return;
  }
  next();
});

export default router;
