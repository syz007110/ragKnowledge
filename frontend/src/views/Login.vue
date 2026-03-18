<template>
  <div class="login-container">
    <!-- 左侧背景区（与 logtool 布局一致） -->
    <div class="login-left" :style="{ backgroundImage: 'url(/login-bg.jpg)' }"></div>

    <!-- 右侧表单区 -->
    <div class="login-right">
      <!-- 语言切换（与 logtool SmartSearchPage 一致） -->
      <div class="lang-switch">
        <el-dropdown trigger="click" @command="changeLanguage">
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
      </div>

      <div class="form-content">
        <h1 class="welcome-title">{{ t('login.title') }}</h1>
        <p class="welcome-subtitle">{{ t('login.subtitle') }}</p>
        <el-form class="auth-form" @submit.prevent>
          <el-form-item>
            <el-input
              v-model="username"
              :placeholder="t('common.userName')"
              size="large"
            />
          </el-form-item>
          <el-form-item>
            <el-input
              v-model="password"
              show-password
              :placeholder="t('common.password')"
              size="large"
              @keyup.enter="handleLogin"
            />
          </el-form-item>
          <el-form-item>
            <el-button
              type="primary"
              :loading="loading"
              class="submit-button"
              size="large"
              @click="handleLogin"
            >
              {{ t('common.login') }}
            </el-button>
          </el-form-item>
        </el-form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { Earth } from '@icon-park/vue-next';
import { Check } from '@element-plus/icons-vue';
import api from '../api';
import { setToken, setUser } from '../utils/auth';
import { getLocale, setLocale } from '../i18n';

const router = useRouter();
const { t } = useI18n();
const loading = ref(false);
const username = ref('');
const password = ref('');
const currentLocale = computed(() => getLocale());
const localeLabel = computed(() => (currentLocale.value === 'zh-CN' ? '中文' : 'English'));

function parseLoginPayload(data) {
  const token = data?.token || data?.data?.token || data?.accessToken || '';
  const user = data?.user || data?.data?.user || data?.data || {};
  return { token, user };
}

async function handleLogin() {
  if (!username.value.trim() || !password.value.trim()) {
    ElMessage.warning(t('common.requiredCredential'));
    return;
  }

  loading.value = true;
  try {
    const response = await api.auth.login({
      username: username.value.trim(),
      password: password.value
    });
    const { token, user } = parseLoginPayload(response.data || {});
    if (!token) {
      throw new Error('登录响应缺少 token');
    }
    setToken(token);
    setUser({
      ...user,
      username: user.username || username.value.trim()
    });
    ElMessage.success(t('common.loginSuccess'));
    router.push('/workspace');
  } catch (error) {
    const message = error?.response?.data?.message || error.message || t('common.loginFailed');
    ElMessage.error(message);
  } finally {
    loading.value = false;
  }
}

function changeLanguage(locale) {
  setLocale(locale);
}
</script>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  width: 100%;
}

/* 左侧背景区 - 60%，与 logtool 一致 */
.login-left {
  width: 60%;
  height: 100vh;
  background-size: auto 100%;
  background-position: center;
  background-repeat: no-repeat;
  position: relative;
  overflow: hidden;
  background-color: var(--blue-50);
}

/* 右侧操作区 - 40% */
.login-right {
  width: 40%;
  background: var(--bg-secondary);
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 3rem;
}

.lang-switch {
  position: absolute;
  top: 2rem;
  right: 2rem;
  z-index: 10;
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

/* 下拉项：与 logtool SmartSearchPage 一致 */
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

.form-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: 400px;
  width: 100%;
  margin: 0 auto;
}

.welcome-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
}

.welcome-subtitle {
  font-size: 1rem;
  color: var(--text-secondary);
  margin: 0 0 2rem 0;
}

.auth-form {
  margin-top: 1.5rem;
}

.submit-button {
  width: 100%;
  height: 48px;
  font-size: 1rem;
  font-weight: 500;
}

/* 响应式 - 与 logtool 断点一致 */
@media (max-width: 768px) {
  .login-container {
    flex-direction: column;
  }

  .login-left {
    width: 100%;
    min-height: 30vh;
    height: 30vh;
    background-size: cover;
  }

  .login-right {
    width: 100%;
    padding: 2rem;
  }
}
</style>
