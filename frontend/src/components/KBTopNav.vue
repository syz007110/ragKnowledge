<template>
  <header class="kb-header">
    <div class="header-left">
      <router-link to="/workspace" class="brand" @click.stop="">
        <span class="brand-mark">▲</span>
        <span class="brand-title">{{ t('nav.brand') }}</span>
      </router-link>
      <nav v-if="!breadcrumbOnly" class="menu">
        <button
          class="menu-item"
          :class="{ active: activeTab === 'workspace' }"
          @click="$router.push('/workspace')"
        >
          {{ t('nav.workspace') }}
        </button>
      </nav>
      <slot v-else name="breadcrumb" />
    </div>

    <div class="header-right">
      <!-- 语言切换（与登录页一致） -->
      <el-dropdown trigger="click" @command="handleLanguageChange">
        <el-button text class="lang-btn">
          <Earth theme="outline" size="20" fill="#333" class="lang-icon" />
          <span class="lang-text">{{ localeLabel }}</span>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="zh-CN">
              <span class="lang-item-content">
                <span class="lang-emoji">🇨🇳</span>
                <span>中文</span>
                <el-icon v-if="currentLocale === 'zh-CN'" class="lang-check"><Check /></el-icon>
              </span>
            </el-dropdown-item>
            <el-dropdown-item command="en-US">
              <span class="lang-item-content">
                <span class="lang-emoji">🇺🇸</span>
                <span>English</span>
                <el-icon v-if="currentLocale === 'en-US'" class="lang-check"><Check /></el-icon>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <div class="divider" />
      <!-- 用户头像下拉：仅管理员显示“设置”，所有人显示退出登录 -->
      <el-dropdown trigger="click" @command="handleUserCommand">
        <button class="user-btn">
          <span class="avatar">{{ userInitials }}</span>
          <span class="username">{{ username }}</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-if="isAdmin"
              command="settings"
              class="dropdown-item-normal"
            >
              <el-icon><Setting /></el-icon>
              {{ t('nav.settings') }}
            </el-dropdown-item>
            <el-dropdown-item
              :divided="isAdmin"
              command="logout"
              class="dropdown-item-danger"
            >
              <el-icon><SwitchButton /></el-icon>
              {{ t('common.logout') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { clearAuth, getUser, isAdmin as checkIsAdmin } from '../utils/auth';
import { useI18n } from 'vue-i18n';
import { getLocale, setLocale } from '../i18n';
import { Earth } from '@icon-park/vue-next';
import { Check, Setting, SwitchButton } from '@element-plus/icons-vue';

const props = defineProps({
  activeTab: {
    type: String,
    default: 'workspace'
  },
  /** 为 true 时不显示 tab，仅显示面包屑 slot（用于设置页） */
  breadcrumbOnly: {
    type: Boolean,
    default: false
  }
});

const router = useRouter();
const { t } = useI18n();
const user = computed(() => getUser() || { username: 'Admin' });
const username = computed(() => user.value.username || user.value.name || 'Admin');
const userInitials = computed(() => String(username.value).slice(0, 2).toUpperCase());
const currentLocale = computed(() => getLocale());
const localeLabel = computed(() => (currentLocale.value === 'zh-CN' ? '中文' : 'English'));
const isAdmin = computed(() => checkIsAdmin());

function logout() {
  clearAuth();
  router.push('/login');
}

function goSettings() {
  router.push('/settings/tags');
}

function handleUserCommand(command) {
  if (command === 'logout') logout();
  else if (command === 'settings') goSettings();
}

function handleLanguageChange(locale) {
  setLocale(locale);
}
</script>

<style scoped>
.kb-header {
  height: 56px;
  border-bottom: 1px solid var(--gray-300);
  background: var(--black-white-white);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 40px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: inherit;
}

.brand:hover {
  opacity: 0.85;
}

.brand:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.brand-mark {
  color: #e11d48;
  font-size: 12px;
}

.brand-title {
  color: #032b71;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.425px;
}

.menu {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
}

/* 面包屑在 header 左侧（与 brand 同一行） */
.header-left :deep(.breadcrumb) {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 0 24px;
  font-size: 14px;
  color: var(--text-secondary);
}

.header-left :deep(.breadcrumb-link) {
  color: var(--el-color-primary);
  text-decoration: none;
}

.header-left :deep(.breadcrumb-link:hover) {
  text-decoration: underline;
}

.header-left :deep(.breadcrumb-sep) {
  color: var(--gray-400);
}

.header-left :deep(.breadcrumb-current) {
  color: var(--text-primary);
}

.menu-item {
  height: 56px;
  padding: 0 16px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #6a7282;
  font-size: 14px;
  cursor: pointer;
}

.menu-item.active {
  color: #032b71;
  border-bottom-color: #032b71;
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lang-btn {
  color: var(--text-secondary);
}

.lang-btn .lang-icon {
  margin-right: 2px;
}

.lang-text {
  font-weight: 500;
}

.lang-item-content {
  display: flex;
  align-items: center;
  gap: var(--radius-md);
  width: 100%;
}

.lang-emoji {
  font-size: 16px;
}

.lang-check {
  margin-left: auto;
  color: var(--indigo-500);
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--gray-300);
}

.user-btn {
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 6px;
}

.dropdown-item-normal {
  color: var(--gray-900);
}

.dropdown-item-normal :deep(.el-icon),
.dropdown-item-danger :deep(.el-icon) {
  margin-right: 8px;
}

.dropdown-item-danger {
  color: var(--el-color-danger);
}

.avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--black-white-white);
  background: #032b71;
  font-size: 10px;
  font-weight: 600;
}

.username {
  color: #364153;
  font-size: 14px;
}
</style>
