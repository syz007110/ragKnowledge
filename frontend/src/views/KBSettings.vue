<template>
  <div class="page-shell">
    <KBTopNav breadcrumb-only>
      <template #breadcrumb>
        <nav class="breadcrumb">
          <router-link to="/workspace" class="breadcrumb-link">{{ t('nav.home') }}</router-link>
          <span class="breadcrumb-sep">-</span>
          <span class="breadcrumb-current">{{ t('breadcrumb.settings') }}</span>
        </nav>
      </template>
    </KBTopNav>
    <main class="page-content">
      <div class="page-head">
        <h1 class="title">{{ t('settings.title') }}</h1>
        <p class="desc">{{ t('settings.desc') }}</p>
      </div>

      <section class="panel">
        <header class="panel-header">
          <span class="panel-title">{{ t('settings.pendingTitle') }}</span>
        </header>
        <el-table :data="pendingAliases" style="width: 100%">
          <el-table-column prop="aliasName" :label="t('settings.aliasName')" min-width="160" />
          <el-table-column prop="status" :label="t('settings.status')" width="110" />
          <el-table-column prop="createdAt" :label="t('settings.createdAt')" width="180" />
          <el-table-column :label="t('settings.actions')" width="220">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="approveAlias(row)">{{ t('settings.approve') }}</el-button>
              <el-button size="small" type="danger" plain @click="rejectAlias(row)">{{ t('settings.reject') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="panel">
        <header class="panel-header">
          <span class="panel-title">{{ t('settings.standardTitle') }}</span>
        </header>
        <div class="tag-wrap">
          <el-tag v-for="item in standardTags" :key="item.id" class="tag-item" size="large">
            {{ item.tagName }}
          </el-tag>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import KBTopNav from '../components/KBTopNav.vue';
import api from '../api';

const { t } = useI18n();
const standardTags = ref([]);
const pendingAliases = ref([]);

function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 19).replace('T', ' ');
}

async function loadTagConfig() {
  const [standardRes, aliasRes] = await Promise.all([
    api.kb.getStandardTags(),
    api.kb.getTagAliases({ status: 'pending' })
  ]);
  standardTags.value = standardRes.data?.items || [];
  pendingAliases.value = (aliasRes.data?.items || []).map((item) => ({
    id: item.id,
    aliasName: item.aliasName,
    status: item.status,
    createdAt: formatDate(item.createdAt)
  }));
}

async function approveAlias(row) {
  try {
    await api.kb.approveTagAlias(row.id);
    ElMessage.success(t('common.success'));
    await loadTagConfig();
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function rejectAlias(row) {
  try {
    await ElMessageBox.confirm(
      `${t('settings.rejectConfirm')} ${row.aliasName}?`,
      t('settings.reject'),
      { type: 'warning' }
    );
    await api.kb.rejectTagAlias(row.id);
    ElMessage.success(t('common.success'));
    await loadTagConfig();
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

onMounted(() => {
  loadTagConfig().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
});
</script>

<style scoped>
.page-shell {
  min-height: 100vh;
  background: #f5f6f8;
}

.page-content {
  padding: 24px 32px 32px;
}

.page-head {
  margin-bottom: 16px;
}

.title {
  margin: 0;
  font-size: 22px;
  color: #101828;
}

.desc {
  margin: 8px 0 0;
  color: #6a7282;
  font-size: 14px;
}

.panel {
  background: #fff;
  border: 1px solid #d1d5dc;
  border-radius: 10px;
  margin-top: 16px;
}

.panel-header {
  padding: 14px 16px;
  border-bottom: 1px solid #eceff3;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #1e2939;
}

.tag-wrap {
  padding: 16px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tag-item {
  margin: 0;
}
</style>
