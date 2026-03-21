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
            <span class="ws-status" :class="`ws-${wsConnectionStatus}`">{{ wsStatusText }}</span>
            <el-button v-if="isAdmin" class="btn-secondary" @click="$router.push('/settings/tags')">
              <el-icon><Setting /></el-icon>
              {{ t('detail.settings') }}
            </el-button>
            <el-button class="btn-secondary" @click="openAskDialog">
              {{ t('detail.askTest') }}
            </el-button>
            <el-button type="primary" class="btn-primary" @click="openFilePicker">
              <el-icon><Upload /></el-icon>
              {{ t('detail.upload') }}
            </el-button>
            <input ref="fileInputRef" class="hidden-file-input" type="file" accept=".docx,.xlsx,.md,.txt,.pdf" multiple @change="handleFileChange" />
          </div>
        </header>

        <div v-if="uploadItems.length" class="upload-progress-wrap">
          <div v-for="item in uploadItems" :key="item.id" class="upload-progress-item">
            <div class="upload-meta">
              <span class="upload-name">{{ item.fileName }}</span>
              <span class="upload-state">{{ item.stateText }}</span>
            </div>
            <el-progress :percentage="item.progress" :status="item.progressStatus" :stroke-width="8" />
          </div>
        </div>

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
                <div class="index-item" :class="row.esIndexStatus">
                  <span class="index-dot" />
                  <span class="index-label">ES_IDX</span>
                </div>
                <div class="index-item" :class="row.vectorIndexStatus">
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

      <el-dialog v-model="askDialog.visible" :title="t('detail.askDialogTitle')" width="900px">
        <el-form label-position="top">
          <el-form-item :label="t('detail.askQuestion')">
            <el-input v-model="askDialog.query" type="textarea" :rows="3" :placeholder="t('detail.askPlaceholder')" />
          </el-form-item>
          <div class="ask-config-row">
            <el-form-item :label="t('detail.askEsTopK')">
              <el-input-number v-model="askDialog.esTopK" :min="1" :max="100" />
            </el-form-item>
            <el-form-item :label="t('detail.askVecTopK')">
              <el-input-number v-model="askDialog.vecTopK" :min="1" :max="100" />
            </el-form-item>
            <el-form-item :label="t('detail.askFuseTopK')">
              <el-input-number v-model="askDialog.fuseTopK" :min="1" :max="100" />
            </el-form-item>
          </div>
        </el-form>

        <div v-if="askDialog.result" class="ask-result">
          <div class="timing-row">
            ES {{ askDialog.result.timingMs?.es || 0 }}ms |
            Vec {{ askDialog.result.timingMs?.vector || 0 }}ms |
            Fuse {{ askDialog.result.timingMs?.fuseRerank || 0 }}ms |
            Total {{ askDialog.result.timingMs?.total || 0 }}ms
          </div>
          <el-tabs>
            <el-tab-pane :label="t('detail.askTabReranked')">
              <div v-for="(item, index) in askDialog.result.reranked || []" :key="`${item.key}-${index}`" class="hit-card">
                <div class="hit-meta">
                  <strong>#{{ index + 1 }}</strong>
                  <span>{{ item.fileName || '-' }}</span>
                  <span>rerank={{ Number(item.rerankScore || 0).toFixed(4) }}</span>
                  <span>rrf={{ Number(item.rrfScore || 0).toFixed(4) }}</span>
                </div>
                <div class="hit-heading">{{ Array.isArray(item.headingPath) ? item.headingPath.join(' / ') : '-' }}</div>
                <div class="hit-source">chunk={{ item.sourceRef?.chunkId || item.chunkId || '-' }} | file={{ item.sourceRef?.fileId || item.fileId || '-' }}</div>
                <div v-if="(item.assets || []).length" class="hit-assets">
                  <span v-for="asset in item.assets" :key="`asset-${asset.id}`" class="asset-chip">
                    {{ asset.assetType }}: {{ asset.sourceRef || asset.id }}
                  </span>
                </div>
                <div class="hit-content">{{ item.content }}</div>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="t('detail.askTabEs')">
              <div v-for="(item, index) in askDialog.result.retrieval?.esHits || []" :key="`${item.chunkId || index}-es-${index}`" class="hit-card">
                <div class="hit-meta">
                  <strong>#{{ index + 1 }}</strong>
                  <span>{{ item.fileName || '-' }}</span>
                  <span>score={{ Number(item.score || 0).toFixed(4) }}</span>
                </div>
                <div class="hit-heading">{{ Array.isArray(item.headingPath) ? item.headingPath.join(' / ') : '-' }}</div>
                <div class="hit-source">chunk={{ item.sourceRef?.chunkId || item.chunkId || '-' }} | file={{ item.sourceRef?.fileId || item.fileId || '-' }}</div>
                <div v-if="(item.assets || []).length" class="hit-assets">
                  <span v-for="asset in item.assets" :key="`asset-es-${asset.id}`" class="asset-chip">
                    {{ asset.assetType }}: {{ asset.sourceRef || asset.id }}
                  </span>
                </div>
                <div class="hit-content">{{ item.content }}</div>
              </div>
            </el-tab-pane>
            <el-tab-pane :label="t('detail.askTabVec')">
              <div v-for="(item, index) in askDialog.result.retrieval?.vecHits || []" :key="`${item.chunkId || index}-vec-${index}`" class="hit-card">
                <div class="hit-meta">
                  <strong>#{{ index + 1 }}</strong>
                  <span>{{ item.fileName || '-' }}</span>
                  <span>score={{ Number(item.score || 0).toFixed(4) }}</span>
                </div>
                <div class="hit-heading">{{ Array.isArray(item.headingPath) ? item.headingPath.join(' / ') : '-' }}</div>
                <div class="hit-source">chunk={{ item.sourceRef?.chunkId || item.chunkId || '-' }} | file={{ item.sourceRef?.fileId || item.fileId || '-' }}</div>
                <div v-if="(item.assets || []).length" class="hit-assets">
                  <span v-for="asset in item.assets" :key="`asset-vec-${asset.id}`" class="asset-chip">
                    {{ asset.assetType }}: {{ asset.sourceRef || asset.id }}
                  </span>
                </div>
                <div class="hit-content">{{ item.content }}</div>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>
        <template #footer>
          <el-button @click="askDialog.visible = false">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" :loading="askDialog.loading" @click="submitAskDebug">{{ t('detail.askSubmit') }}</el-button>
        </template>
      </el-dialog>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, Document, Setting, Upload } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import KBTopNav from '../components/KBTopNav.vue';
import { isAdmin as checkIsAdmin } from '../utils/auth';
import api from '../api';
import websocketClient from '../services/websocketClient';

const route = useRoute();
const isAdmin = computed(() => checkIsAdmin());
const { t } = useI18n();
const docs = ref([]);
const fileInputRef = ref(null);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const collectionMeta = ref({ name: null, description: null });
const askDialog = ref({
  visible: false,
  loading: false,
  query: '',
  esTopK: 5,
  vecTopK: 5,
  fuseTopK: 5,
  result: null
});
const uploadItems = ref([]);
const wsConnectionStatus = ref('disconnected');
const activeTaskIds = new Set();
let loadDebounceTimer = null;
const UPLOAD_MAX_FILES = Number.parseInt(import.meta.env.VITE_KB_UPLOAD_MAX_FILES || '32', 10);
const UPLOAD_SINGLE_FILE_MAX_BYTES = Number.parseInt(import.meta.env.VITE_KB_UPLOAD_SINGLE_MAX_BYTES || `${50 * 1024 * 1024}`, 10);
const UPLOAD_BATCH_TOTAL_MAX_BYTES = Number.parseInt(import.meta.env.VITE_KB_UPLOAD_BATCH_MAX_BYTES || `${1024 * 1024 * 1024}`, 10);
const UPLOAD_REQUEST_TIMEOUT_MS = Number.parseInt(import.meta.env.VITE_KB_UPLOAD_REQUEST_TIMEOUT_MS || `${15 * 60 * 1000}`, 10);
const uploadConcurrencyRaw = Number.parseInt(import.meta.env.VITE_KB_UPLOAD_CONCURRENCY || '3', 10);
const UPLOAD_CONCURRENCY = Math.min(5, Math.max(3, Number.isFinite(uploadConcurrencyRaw) ? uploadConcurrencyRaw : 3));

const detail = computed(() => ({
  id: Number(route.params.id || 0),
  title: collectionMeta.value.name || t('detail.collectionTitleFallback', { id: Number(route.params.id || 0) }),
  description: collectionMeta.value.description || t('detail.descriptionDefault')
}));
const wsStatusText = computed(() => {
  if (wsConnectionStatus.value === 'connected') return 'WS已连接';
  if (wsConnectionStatus.value === 'connecting') return 'WS连接中';
  return 'WS未连接';
});

function scheduleLoadFiles() {
  if (loadDebounceTimer) clearTimeout(loadDebounceTimer);
  loadDebounceTimer = setTimeout(() => {
    loadFiles().catch(() => null);
  }, 600);
}

function updateUploadItem(id, patch = {}) {
  uploadItems.value = uploadItems.value.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

function upsertUploadItemByTask(taskId, patch = {}) {
  if (!taskId) return;
  const idx = uploadItems.value.findIndex((item) => Number(item.taskId) === Number(taskId));
  if (idx < 0) return;
  const next = [...uploadItems.value];
  next[idx] = { ...next[idx], ...patch };
  uploadItems.value = next;
}

function mapTaskEventToProgressState(task) {
  const status = String(task?.status || '').toLowerCase();
  const progress = Math.max(0, Math.min(100, Number(task?.progress || 0)));
  if (status === 'done') {
    return { progress: 100, progressStatus: 'success', stateText: '处理完成' };
  }
  if (status === 'failed') {
    return { progress, progressStatus: 'exception', stateText: '处理失败' };
  }
  if (status === 'queued') {
    return { progress: Math.max(progress, 5), progressStatus: '', stateText: '等待处理' };
  }
  return { progress: Math.max(progress, 10), progressStatus: '', stateText: '处理中' };
}

function handleKbTaskStatus(message) {
  const taskId = Number(message?.taskId || 0);
  const collectionId = Number(message?.collectionId || 0);
  const isCurrentCollection = collectionId && collectionId === Number(detail.value.id || 0);
  const shouldHandle = isCurrentCollection || activeTaskIds.has(taskId);
  if (!shouldHandle) return;
  const mapped = mapTaskEventToProgressState(message);
  upsertUploadItemByTask(taskId, mapped);
  if (['done', 'failed'].includes(String(message?.status || '').toLowerCase())) {
    activeTaskIds.delete(taskId);
  }
  scheduleLoadFiles();
}

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

function mapDisplayStatus(displayStatus) {
  if (displayStatus === 'ready') return { type: 'success', textKey: 'detail.statusReady' };
  if (displayStatus === 'failed') return { type: 'failed', textKey: 'detail.statusFailed' };
  if (displayStatus === 'waiting') return { type: 'waiting', textKey: 'detail.statusWaiting' };
  return { type: 'processing', textKey: 'detail.statusProcessing' };
}

function mapIndexStatus(status) {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'failed';
  return 'processing';
}

async function loadFiles() {
  const response = await api.kb.getCollectionFiles(detail.value.id, {
    page: page.value,
    pageSize: pageSize.value,
    sortBy: 'createdAt',
    sortOrder: 'DESC'
  });
  docs.value = (response.data?.items || []).map((item) => {
    const statusInfo = mapDisplayStatus(item.displayStatus);
    return {
      id: item.id,
      name: item.fileName,
      size: `${(Number(item.fileSize || 0) / 1024).toFixed(1)} KB`,
      uploadedAt: String(item.createdAt || '').slice(0, 19).replace('T', ' '),
      status: statusInfo.type,
      statusText: statusInfo.textKey ? t(statusInfo.textKey) : (item.status || '-'),
      statusDisplayText: statusInfo.textKey ? t(statusInfo.textKey) : (item.status || '-'),
      esIndexStatus: mapIndexStatus(item.indexSummary?.esStatus),
      vectorIndexStatus: mapIndexStatus(item.indexSummary?.vectorStatus)
    };
  });
  total.value = Number(response.data?.total || 0);
  page.value = Number(response.data?.page || page.value);
  pageSize.value = Number(response.data?.pageSize || pageSize.value);
}

function openFilePicker() {
  fileInputRef.value?.click();
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      await worker(current);
    }
  });
  await Promise.all(workers);
}

async function handleFileChange(event) {
  try {
    const files = Array.from(event?.target?.files || []);
    if (!files.length) return;
    if (files.length > UPLOAD_MAX_FILES) {
      ElMessage.error(t('detail.uploadMaxFiles', { max: UPLOAD_MAX_FILES }));
      return;
    }
    const hasOversizedFile = files.find((file) => Number(file?.size || 0) > UPLOAD_SINGLE_FILE_MAX_BYTES);
    if (hasOversizedFile) {
      ElMessage.error(t('detail.uploadSingleLimit', { maxMB: Math.round(UPLOAD_SINGLE_FILE_MAX_BYTES / 1024 / 1024), name: hasOversizedFile.name }));
      return;
    }
    const totalBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (totalBytes > UPLOAD_BATCH_TOTAL_MAX_BYTES) {
      ElMessage.error(t('detail.uploadBatchLimit', { maxGB: Math.round(UPLOAD_BATCH_TOTAL_MAX_BYTES / 1024 / 1024 / 1024) }));
      return;
    }
    const createdRows = files.map((file, idx) => ({
      id: `${Date.now()}_${idx}`,
      fileName: file.name,
      progress: 0,
      progressStatus: '',
      stateText: '上传中',
      taskId: null
    }));
    uploadItems.value = [...createdRows, ...uploadItems.value];

    const uploadTasks = files.map((file, idx) => ({ file, row: createdRows[idx] }));
    let acceptedCount = 0;
    let reusedCount = 0;
    let failedCount = 0;
    await runWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY, async ({ file, row }) => {
      const formData = new FormData();
      formData.append('files', file);
      formData.append('uploadMode', 'normal');
      try {
        updateUploadItem(row.id, { stateText: '上传中', progressStatus: '' });
        const response = await api.kb.uploadCollectionFiles(detail.value.id, formData, {
          timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
          onUploadProgress: (progressEvent) => {
            const total = Number(progressEvent?.total || file.size || 0);
            const loaded = Number(progressEvent?.loaded || 0);
            if (!total) return;
            const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
            updateUploadItem(row.id, { progress: percent, stateText: percent >= 100 ? '等待入队' : '上传中' });
          }
        });
        const accepted = response?.data?.accepted || [];
        const reused = response?.data?.reused || [];
        const failed = response?.data?.failed || [];
        if (accepted.length) {
          acceptedCount += 1;
          const acceptedItem = accepted.find((item) => String(item?.fileName || '') === String(file.name)) || accepted[0];
          const taskId = Number(acceptedItem?.job?.id || 0);
          if (taskId) activeTaskIds.add(taskId);
          updateUploadItem(row.id, {
            progress: 100,
            progressStatus: '',
            stateText: '等待处理',
            taskId: taskId || null
          });
        } else if (reused.length) {
          reusedCount += 1;
          updateUploadItem(row.id, { progress: 100, progressStatus: 'success', stateText: '已复用' });
        } else if (failed.length) {
          failedCount += 1;
          updateUploadItem(row.id, { progressStatus: 'exception', stateText: failed[0]?.reason || '上传失败' });
        } else {
          updateUploadItem(row.id, { progress: 100, stateText: '等待处理' });
        }
      } catch (error) {
        failedCount += 1;
        const message = error?.response?.data?.message || error.message || '上传失败';
        updateUploadItem(row.id, {
          progressStatus: 'exception',
          stateText: message
        });
      }
    });
    if (failedCount === 0) {
      ElMessage.success(t('detail.rebuildQueued'));
    } else {
      ElMessage.warning(t('detail.uploadSummary', { success: acceptedCount + reusedCount, failed: failedCount }));
    }
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

function openAskDialog() {
  askDialog.value.visible = true;
}

async function submitAskDebug() {
  const query = String(askDialog.value.query || '').trim();
  if (!query) {
    ElMessage.error(t('detail.askQueryRequired'));
    return;
  }
  askDialog.value.loading = true;
  try {
    const response = await api.kb.retrievalDebug({
      collectionId: detail.value.id,
      query,
      esTopK: askDialog.value.esTopK,
      vecTopK: askDialog.value.vecTopK,
      fuseTopK: askDialog.value.fuseTopK
    });
    askDialog.value.result = response.data || null;
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  } finally {
    askDialog.value.loading = false;
  }
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
  wsConnectionStatus.value = websocketClient.getConnectionStatus();
  websocketClient.on('connection', () => { wsConnectionStatus.value = 'connected'; });
  websocketClient.on('disconnection', () => { wsConnectionStatus.value = 'disconnected'; });
  websocketClient.on('kbTaskStatus', handleKbTaskStatus);
  websocketClient.connect();
  loadCollectionMeta();
  loadFiles().catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
});

onUnmounted(() => {
  websocketClient.off('kbTaskStatus', handleKbTaskStatus);
  if (loadDebounceTimer) clearTimeout(loadDebounceTimer);
});

watch(() => route.params.id, () => {
  collectionMeta.value = { name: null, description: null };
  loadCollectionMeta();
  page.value = 1;
  activeTaskIds.clear();
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

.ws-status {
  font-size: 12px;
  line-height: 20px;
  border-radius: 10px;
  padding: 0 8px;
  border: 1px solid #d1d5dc;
  color: #6a7282;
  background: #f9fafb;
}

.ws-status.ws-connected {
  color: #007a55;
  border-color: #a4f4cf;
  background: #ecfdf5;
}

.ws-status.ws-connecting {
  color: #9a6700;
  border-color: #f6e1a4;
  background: #fff8dc;
}

.upload-progress-wrap {
  padding: 10px 24px 14px;
  border-bottom: 0.8px solid #f3f4f6;
  background: #fafcff;
}

.upload-progress-item + .upload-progress-item {
  margin-top: 8px;
}

.upload-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 4px;
}

.upload-name {
  color: #344054;
}

.upload-state {
  color: #6a7282;
}

.ask-config-row {
  display: flex;
  gap: 16px;
}

.ask-result {
  border-top: 1px solid #e5e7eb;
  padding-top: 12px;
}

.timing-row {
  margin-bottom: 10px;
  color: #667085;
  font-size: 12px;
}

.hit-card {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  background: #fafafa;
}

.hit-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  color: #475467;
}

.hit-heading {
  margin-top: 6px;
  color: #032b71;
  font-size: 12px;
}

.hit-content {
  margin-top: 6px;
  color: #344054;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.hit-source {
  margin-top: 6px;
  color: #667085;
  font-size: 12px;
}

.hit-assets {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.asset-chip {
  font-size: 11px;
  color: #032b71;
  background: rgba(3, 43, 113, 0.08);
  border: 1px solid rgba(3, 43, 113, 0.2);
  border-radius: 12px;
  padding: 2px 8px;
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

.status-tag.waiting {
  color: #6a7282;
  background: #f3f4f6;
  border: 0.8px solid #d1d5dc;
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
