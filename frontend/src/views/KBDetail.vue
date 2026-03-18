<template>
  <div class="page-shell">
    <KBTopNav breadcrumb-only>
      <template #breadcrumb>
        <nav class="breadcrumb">
          <router-link to="/workspace" class="breadcrumb-link">{{ t('nav.home') }}</router-link>
          <span class="breadcrumb-sep">-</span>
          <span class="breadcrumb-current">{{ detail.title }}</span>
        </nav>
      </template>
    </KBTopNav>

    <main class="page-content">
      <section class="detail-head">
        <router-link to="/workspace" class="back-btn" aria-label="Back">
          <el-icon :size="20"><ArrowLeft /></el-icon>
        </router-link>
        <div class="head-main">
          <div class="title-row">
            <h1 class="title">{{ detail.title }}</h1>
            <span class="id-tag">ID: {{ detail.id }}</span>
          </div>
          <p class="desc">{{ detail.description }}</p>
        </div>
      </section>

      <section class="table-card">
        <header class="table-header">
          <div class="left">
            <el-icon class="table-title-icon" :size="18"><Document /></el-icon>
            <span class="table-title">{{ t('detail.docs') }}</span>
            <span class="counter">{{ total }}</span>
          </div>
          <div class="actions">
            <el-button v-if="isAdmin" class="btn-secondary" @click="$router.push('/settings/tags')">
              <el-icon><Setting /></el-icon>
              {{ t('detail.settings') }}
            </el-button>
            <el-button type="primary" class="btn-primary" @click="openFilePicker">
              <el-icon><Upload /></el-icon>
              {{ t('detail.upload') }}
            </el-button>
            <input ref="fileInputRef" class="hidden-file-input" type="file" accept=".docx,.md,.txt" multiple @change="handleFileChange" />
          </div>
        </header>

        <el-table :data="docs" style="width: 100%" class="doc-table">
          <el-table-column :label="t('detail.fileName')" min-width="200">
            <template #default="{ row }">
              <div class="doc-name-cell">
                <div class="doc-name-icon">
                  <el-icon :size="18"><Document /></el-icon>
                </div>
                <span class="doc-name-text" :title="row.name">{{ row.name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="uploadedAt" :label="t('detail.uploadedAt')" width="160" min-width="140" />
          <el-table-column :label="t('detail.status')" width="128" min-width="100">
            <template #default="{ row }">
              <span class="status-tag" :class="row.status">
                {{ row.statusDisplayText }}
              </span>
            </template>
          </el-table-column>
          <el-table-column :label="t('detail.indexStatus')" width="128" min-width="100">
            <template #default="{ row }">
              <div class="index-status">
                <div class="index-item" :class="row.status">
                  <span class="index-dot" />
                  <span class="index-label">ES_IDX</span>
                </div>
                <div class="index-item" :class="row.status">
                  <span class="index-dot" />
                  <span class="index-label">VEC_IDX</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('detail.actions')" width="260" min-width="260" align="right" fixed="right">
            <template #default="{ row }">
              <div class="action-buttons">
                <el-button text size="small" @click="rebuildFile(row)">{{ t('detail.rebuild') }}</el-button>
                <el-button text size="small" @click="renameFileRow(row)">{{ t('detail.rename') }}</el-button>
                <el-button text size="small" @click="downloadFile(row)">{{ t('detail.download') }}</el-button>
                <el-button text size="small" type="danger" @click="removeFile(row)">{{ t('detail.delete') }}</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div class="pager-wrap">
          <span class="pager-total">{{ t('detail.paginationTotal', { total }) }}</span>
          <el-pagination
            background
            layout="prev, pager, next, sizes"
            :total="total"
            :current-page="page"
            :page-size="pageSize"
            :page-sizes="[10, 20, 50]"
            @current-change="handlePageChange"
            @size-change="handlePageSizeChange"
          />
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Document, Setting, Upload } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import KBTopNav from '../components/KBTopNav.vue';
import { isAdmin as checkIsAdmin } from '../utils/auth';
import api from '../api';

const route = useRoute();
const isAdmin = computed(() => checkIsAdmin());
const { t } = useI18n();
const docs = ref([]);
const fileInputRef = ref(null);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const collectionMeta = ref({ name: null, description: null });

const detail = computed(() => ({
  id: Number(route.params.id || 0),
  title: collectionMeta.value.name || t('detail.collectionTitleFallback', { id: Number(route.params.id || 0) }),
  description: collectionMeta.value.description || t('detail.descriptionDefault')
}));

async function loadCollectionMeta() {
  if (!detail.value.id) return;
  try {
    const res = await api.kb.getCollection(detail.value.id);
    const data = res.data?.data ?? res.data ?? {};
    collectionMeta.value = {
      name: data.name ?? null,
      description: data.description ?? null
    };
  } catch (_) {
    collectionMeta.value = { name: null, description: null };
  }
}

function mapStatus(status) {
  if (status === 'ready') return { type: 'success', textKey: 'detail.statusReady' };
  if (String(status || '').includes('failed') || status === 'file_error') return { type: 'failed', textKey: 'detail.statusFailed' };
  return { type: 'processing', textKey: null };
}

async function loadFiles() {
  const response = await api.kb.getCollectionFiles(detail.value.id, {
    page: page.value,
    pageSize: pageSize.value,
    sortBy: 'createdAt',
    sortOrder: 'DESC'
  });
  docs.value = (response.data?.items || []).map((item) => {
    const statusInfo = mapStatus(item.status);
    return {
      id: item.id,
      name: item.fileName,
      size: `${(Number(item.fileSize || 0) / 1024).toFixed(1)} KB`,
      uploadedAt: String(item.createdAt || '').slice(0, 19).replace('T', ' '),
      status: statusInfo.type,
      statusText: statusInfo.textKey ? t(statusInfo.textKey) : (item.status || '-'),
      statusDisplayText: statusInfo.textKey ? t(statusInfo.textKey) : (item.status || '-')
    };
  });
  total.value = Number(response.data?.total || 0);
  page.value = Number(response.data?.page || page.value);
  pageSize.value = Number(response.data?.pageSize || pageSize.value);
}

function openFilePicker() {
  fileInputRef.value?.click();
}

async function handleFileChange(event) {
  try {
    const files = Array.from(event?.target?.files || []);
    if (!files.length) return;
    const formData = new FormData();
    files.forEach((file) => {
      formData.append('files', file);
    });
    formData.append('uploadMode', 'normal');
    await api.kb.uploadCollectionFiles(detail.value.id, formData);
    ElMessage.success(t('detail.rebuildQueued'));
    await loadFiles();
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  } finally {
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  }
}

function readFileNameFromHeaders(headers = {}) {
  const raw = headers['content-disposition'] || '';
  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (_) {
      return utf8Match[1];
    }
  }
  const plainMatch = raw.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] || '';
}

async function rebuildFile(row) {
  await api.kb.rebuildFile(row.id);
  ElMessage.success(t('detail.rebuildQueued'));
  await loadFiles();
}

async function renameFileRow(row) {
  const { value } = await ElMessageBox.prompt(
    t('detail.renamePrompt'),
    t('detail.rename'),
    {
      inputValue: row.name,
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel')
    }
  );
  const nextName = String(value || '').trim();
  if (!nextName || nextName === row.name) return;
  await api.kb.renameFile(row.id, { fileName: nextName });
  ElMessage.success(t('common.success'));
  await loadFiles();
}

async function downloadFile(row) {
  const response = await api.kb.downloadFile(row.id);
  const fileName = readFileNameFromHeaders(response.headers || {}) || row.name || `file-${row.id}`;
  const blob = new Blob([response.data], {
    type: response.headers?.['content-type'] || 'application/octet-stream'
  });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

async function removeFile(row) {
  await ElMessageBox.confirm(
    `${t('detail.deleteConfirm')}: ${row.name}?`,
    t('detail.delete'),
    {
      type: 'warning',
      confirmButtonText: t('detail.delete'),
      cancelButtonText: t('common.cancel')
    }
  );
  await api.kb.deleteFile(row.id);
  ElMessage.success(t('common.success'));
  await loadFiles();
}

function handlePageChange(nextPage) {
  page.value = Number(nextPage || 1);
  loadFiles().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
}

function handlePageSizeChange(nextPageSize) {
  pageSize.value = Number(nextPageSize || 20);
  page.value = 1;
  loadFiles().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
}

onMounted(() => {
  loadCollectionMeta();
  loadFiles().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
});

watch(() => route.params.id, () => {
  collectionMeta.value = { name: null, description: null };
  loadCollectionMeta();
  page.value = 1;
  loadFiles().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
});
</script>

<style scoped>
/* Figma design tokens: bg #f5f6f8, primary #032b71, text #101828, #6a7282, border #d1d5dc/#e5e7eb/#f3f4f6, success #007a55/#ecfdf5/#a4f4cf, error #cd011d/#fef2f2/#ffc9c9, index green #00bc7d */
.page-shell {
  min-height: 100vh;
  background: #f5f6f8;
}

.page-content {
  padding: 32px;
}

.detail-head {
  margin-bottom: 24px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.back-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 0.8px solid #d1d5dc;
  border-radius: 6px;
  background: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #101828;
  text-decoration: none;
  transition: background 0.2s, border-color 0.2s;
}

.back-btn:hover {
  background: #f9fafb;
  border-color: #d1d5dc;
  color: #101828;
}

.head-main {
  flex: 1;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 32px;
  letter-spacing: -0.6px;
  color: #101828;
}

.id-tag {
  font-size: 12px;
  line-height: 16px;
  font-family: Consolas, monospace;
  color: #364153;
  border: 0.8px solid #d1d5dc;
  border-radius: 6px;
  background: #e5e7eb;
  padding: 2px 8px;
}

.desc {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 20px;
  color: #6a7282;
}

.table-card {
  width: 100%;
  border: 0.8px solid #d1d5dc;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1);
}

.table-header {
  min-height: 66px;
  border-bottom: 0.8px solid #e5e7eb;
  background: rgba(249, 250, 251, 0.8);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
}

.left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-title-icon {
  color: #1e2939;
}

.table-title {
  font-size: 16px;
  font-weight: 600;
  color: #1e2939;
}

.counter {
  min-width: 22px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 9999px;
  color: #032b71;
  background: rgba(3, 43, 113, 0.1);
}

.actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.actions .el-icon {
  margin-right: 6px;
}

.btn-secondary {
  background: #fff;
  border: 0.8px solid #d1d5dc;
  color: #364153;
  border-radius: 6px;
  height: 34px;
  font-size: 14px;
}

.btn-secondary:hover {
  background: #f9fafb;
  border-color: #d1d5dc;
  color: #364153;
}

.btn-primary {
  background: #032b71;
  border-color: #032b71;
  color: #fff;
  border-radius: 6px;
  height: 32px;
  font-size: 14px;
}

.btn-primary:hover {
  background: #032b71;
  border-color: #032b71;
  color: #fff;
  opacity: 0.9;
}

.doc-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.doc-name-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 6px;
  background: rgba(3, 43, 113, 0.05);
  border: 0.8px solid transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #032b71;
}

.doc-name-text {
  font-size: 14px;
  font-weight: 500;
  color: #101828;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  min-width: 0;
}

.doc-table {
  width: 100% !important;
}

.doc-table :deep(.el-table) {
  table-layout: fixed;
  width: 100% !important;
}

.doc-table :deep(.el-table__body-wrapper),
.doc-table :deep(.el-table__header-wrapper) {
  width: 100% !important;
}

.doc-table :deep(.el-table__body),
.doc-table :deep(.el-table__header) table,
.doc-table :deep(.el-table__body) table {
  width: 100% !important;
}

.doc-table :deep(.el-table__cell) {
  font-size: 12px;
  color: #6a7282;
}

.doc-table :deep(.el-table__fixed-right) {
  right: 0;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

.status-tag.success {
  color: #007a55;
  background: #ecfdf5;
  border: 0.8px solid #a4f4cf;
}

.status-tag.failed {
  color: #cd011d;
  background: #fef2f2;
  border: 0.8px solid #ffc9c9;
}

.status-tag.processing {
  color: #9a6700;
  background: #fff8dc;
  border: 1px solid #f6e1a4;
}

.index-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.index-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.index-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
}

.index-item.success .index-dot {
  background: #00bc7d;
}

.index-item.failed .index-dot {
  background: #cd011d;
}

.index-item.processing .index-dot {
  background: #9a6700;
}

.index-label {
  font-family: Consolas, monospace;
  font-size: 11px;
  color: #6a7282;
}

.action-buttons {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
}

.action-buttons .el-button {
  flex-shrink: 0;
  padding-left: 8px;
  padding-right: 8px;
}

.hidden-file-input {
  display: none;
}

.pager-wrap {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px 20px;
  border-top: 0.8px solid #f3f4f6;
}

.pager-total {
  font-size: 12px;
  color: #6a7282;
}
</style>
