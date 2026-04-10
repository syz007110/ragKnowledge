<template>
  <div class="page-shell">
    <KBTopNav breadcrumb-only>
      <template #breadcrumb>
        <nav class="breadcrumb">
          <router-link to="/workspace" class="breadcrumb-link">{{ t('detail.breadcrumbWorkbench') }}</router-link>
          <span class="breadcrumb-sep">/</span>
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
            <div class="title-meta">
              <span class="id-tag">ID: {{ detail.id }}</span>
              <span class="meta-sep" aria-hidden="true">|</span>
              <span class="doc-count-badge">{{ t('detail.docCountBadge', { count: total }) }}</span>
            </div>
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

        <div class="table-scroll-wrap">
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
          <el-table-column :label="t('detail.uploadedAt')" width="160" min-width="140">
            <template #default="{ row }">
              <span class="cell-mono">{{ row.uploadedAt }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('detail.status')" width="128" min-width="100">
            <template #default="{ row }">
              <span class="status-tag" :class="row.status">
                <el-icon v-if="row.status === 'success'" class="status-tag__icon"><CircleCheck /></el-icon>
                <el-icon v-else-if="row.status === 'failed'" class="status-tag__icon"><CircleClose /></el-icon>
                <el-icon v-else-if="row.status === 'processing'" class="status-tag__icon is-spin"><Loading /></el-icon>
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
          <el-table-column :label="t('detail.actions')" width="220" min-width="200" align="left">
            <template #default="{ row }">
              <div class="action-buttons">
                <el-tooltip :content="t('detail.preview')" placement="top">
                  <el-button
                    text
                    class="action-icon-btn"
                    :disabled="row.status !== 'success'"
                    :aria-label="t('detail.preview')"
                    @click.stop="openPreview(row)"
                  >
                    <el-icon :size="16"><View /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('detail.rebuild')" placement="top">
                  <el-button
                    text
                    class="action-icon-btn"
                    :aria-label="t('detail.rebuild')"
                    @click.stop="rebuildFile(row)"
                  >
                    <el-icon :size="16"><RefreshRight /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('detail.rename')" placement="top">
                  <el-button text class="action-icon-btn" :aria-label="t('detail.rename')" @click.stop="renameFileRow(row)">
                    <el-icon :size="16"><EditPen /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('detail.download')" placement="top">
                  <el-button text class="action-icon-btn" :aria-label="t('detail.download')" @click.stop="downloadFile(row)">
                    <el-icon :size="16"><Download /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="t('detail.delete')" placement="top">
                  <el-button text type="danger" class="action-icon-btn" :aria-label="t('detail.delete')" @click.stop="removeFile(row)">
                    <el-icon :size="16"><Delete /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
            </template>
          </el-table-column>
        </el-table>
        </div>
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
          <el-form-item :label="t('detail.askGenerate')">
            <div class="ask-generate-row">
              <el-switch v-model="askDialog.generate" />
              <span class="ask-generate-hint">{{ t('detail.askGenerateHint') }}</span>
            </div>
          </el-form-item>
          <div class="ask-config-row">
            <el-form-item :label="t('detail.askEsTopK')">
              <el-input-number v-model="askDialog.esTopK" :min="1" :max="100" :disabled="askDialog.generate" />
            </el-form-item>
            <el-form-item :label="t('detail.askVecTopK')">
              <el-input-number v-model="askDialog.vecTopK" :min="1" :max="100" :disabled="askDialog.generate" />
            </el-form-item>
            <el-form-item :label="t('detail.askFuseTopK')">
              <el-input-number v-model="askDialog.fuseTopK" :min="1" :max="100" :disabled="askDialog.generate" />
            </el-form-item>
          </div>
        </el-form>

        <div v-if="askDialog.result" class="ask-result">
          <div class="timing-row">
            ES {{ askDialog.result.timingMs?.es || 0 }}ms |
            Vec {{ askDialog.result.timingMs?.vector || 0 }}ms |
            Fuse {{ askDialog.result.timingMs?.fuseRerank || 0 }}ms |
            Total {{ askDialog.result.timingMs?.total || 0 }}ms
            <template v-if="askDialog.result.generation && !askDialog.result.generation.error">
              | {{ t('detail.askGenerationChatMs', { ms: askDialog.result.generation.timingMs || 0 }) }}
              <template v-if="askDialog.result.generation.usage">
                |
                {{
                  t('detail.askGenerationTokensTiming', {
                    prompt: askDialog.result.generation.usage.promptTokens,
                    completion: askDialog.result.generation.usage.completionTokens,
                    total: askDialog.result.generation.usage.totalTokens
                  })
                }}
              </template>
            </template>
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
            <el-tab-pane v-if="askDialog.result.generation" :label="t('detail.askTabGenerate')">
              <template v-if="askDialog.result.generation.error">
                <el-alert type="warning" show-icon :closable="false" :title="t('detail.askGenerationErrorTitle')" />
                <p class="gen-error-text">{{ askDialog.result.generation.message }}</p>
                <p v-if="askDialog.result.generation.upstreamStatus != null" class="gen-error-meta">
                  HTTP {{ askDialog.result.generation.upstreamStatus }}
                </p>
              </template>
              <template v-else>
                <div class="gen-meta">
                  {{ t('detail.askGenerationModel') }}: {{ askDialog.result.generation.model || '-' }}
                </div>
                <div v-if="askDialog.result.generation.usage" class="gen-meta gen-usage">
                  {{
                    t('detail.askGenerationTokens', {
                      prompt: askDialog.result.generation.usage.promptTokens,
                      completion: askDialog.result.generation.usage.completionTokens,
                      total: askDialog.result.generation.usage.totalTokens
                    })
                  }}
                </div>
                <div class="gen-answer">{{ askDialog.result.generation.answer }}</div>
              </template>
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

      <el-drawer
        v-model="preview.visible"
        direction="rtl"
        class="kb-preview-drawer"
        modal-class="kb-drawer-overlay"
        destroy-on-close
        :close-on-click-modal="true"
        :show-close="false"
        @closed="onPreviewDrawerClosed"
      >
        <template #header="{ close, titleId, titleClass }">
          <div class="preview-drawer-header" :id="titleId" :class="titleClass">
            <div class="preview-drawer-header__icon">
              <el-icon :size="22"><Document /></el-icon>
            </div>
            <div class="preview-drawer-header__text">
              <div class="preview-drawer-header__title">{{ previewFileLabel || t('detail.previewTitle') }}</div>
              <div class="preview-drawer-header__sub">{{ t('detail.previewSubtitle') }}</div>
            </div>
            <button type="button" class="preview-drawer-header__close" :aria-label="t('common.cancel')" @click="close">
              <el-icon :size="18"><Close /></el-icon>
            </button>
          </div>
        </template>
        <div v-if="preview.loading" class="preview-loading">
          <el-icon class="is-loading" :size="28"><Loading /></el-icon>
          <span>{{ t('detail.previewLoading') }}</span>
        </div>
        <div v-else-if="preview.errorMessage" class="preview-error">
          {{ preview.errorMessage }}
        </div>
        <div v-else-if="preview.data?.previewable" class="preview-body">
          <div class="preview-toolbar">
            <label class="preview-overlay-label">
              <span>{{ t('detail.previewChunkOverlay') }}</span>
              <el-switch
                v-model="preview.chunkOverlay"
                :disabled="['pdf', 'docx', 'xlsx'].includes(preview.data.previewMode)"
              />
            </label>
            <span v-if="preview.data.sourceTruncated && preview.data.previewMode === 'text'" class="preview-trunc-hint">{{ t('detail.previewTruncated') }}</span>
            <span v-if="preview.data.previewMode === 'pdf'" class="preview-pdf-hint">{{ preview.useOnlyoffice ? t('detail.previewOnlyofficePdfHint') : t('detail.previewPdfOverlayHint') }}</span>
            <span v-else-if="['docx', 'xlsx'].includes(preview.data.previewMode)" class="preview-pdf-hint">{{ preview.useOnlyoffice ? t('detail.previewOnlyofficeOfficeHint') : t('detail.previewOfficeOverlayHint') }}</span>
          </div>
          <div class="preview-panels">
            <div class="preview-panel preview-panel--left">
              <div class="preview-panel-title preview-panel-title--toolbar">
                <span>{{ t('detail.previewLeftTitle') }}</span>
                <span v-if="['pdf', 'docx', 'xlsx'].includes(preview.data.previewMode)" class="preview-panel-title__mode">
                  {{ t('detail.previewSourceFile') }}
                </span>
              </div>
              <div class="preview-panel-body">
                <div
                  v-if="
                    preview.data.previewMode === 'pdf' &&
                    (preview.pdfObjectUrl || (preview.useOnlyoffice && preview.ooMountId))
                  "
                  class="preview-page-stack"
                >
                  <div class="preview-page-canvas">
                    <div
                      v-if="preview.useOnlyoffice && preview.ooMountId"
                      :key="preview.ooMountId"
                      :id="preview.ooMountId"
                      class="preview-onlyoffice preview-onlyoffice--canvas"
                    />
                    <iframe
                      v-else-if="preview.pdfObjectUrl"
                      class="preview-iframe preview-iframe--canvas"
                      title="pdf-preview"
                      :src="preview.pdfObjectUrl"
                    />
                  </div>
                </div>
                <div
                  v-else-if="preview.useOnlyoffice && preview.ooMountId"
                  :key="preview.ooMountId"
                  :id="preview.ooMountId"
                  class="preview-onlyoffice"
                />
                <div
                  v-else-if="preview.data.previewMode === 'docx'"
                  ref="docxPreviewRef"
                  class="preview-office preview-office--docx"
                />
                <div
                  v-else-if="preview.data.previewMode === 'xlsx'"
                  ref="xlsxPreviewRef"
                  class="preview-office preview-office--xlsx"
                />
                <div
                  v-else-if="preview.data.previewMode === 'text'"
                  class="preview-text-scroll"
                >
                  <template v-if="preview.chunkOverlay">
                    <span
                      v-for="(seg, idx) in previewTextSegments"
                      :key="`seg-${idx}`"
                      class="preview-seg"
                      :class="{
                        'preview-seg--hl': seg.chunkId != null,
                        'preview-seg--sel': seg.selected
                      }"
                      @click="seg.chunkId != null && selectPreviewChunk(seg.chunkId)"
                    >{{ seg.text }}</span>
                  </template>
                  <pre v-else class="preview-pre">{{ preview.data.sourceText }}</pre>
                </div>
              </div>
            </div>
            <div class="preview-panel preview-panel--right">
              <div class="preview-panel-title preview-panel-title--split">
                <span>{{ t('detail.previewRightTitle') }}</span>
                <span class="preview-chunk-total">{{ t('detail.previewChunkTotal', { count: (preview.data.chunks || []).length }) }}</span>
              </div>
              <el-scrollbar class="preview-chunk-list">
                <div
                  v-for="ch in preview.data.chunks"
                  :key="ch.id"
                  :ref="(el) => setChunkCardRef(ch.id, el)"
                  class="preview-chunk-card"
                  :class="{ 'preview-chunk-card--active': Number(preview.selectedChunkId) === Number(ch.id) }"
                  @click="selectPreviewChunk(ch.id)"
                >
                  <div class="preview-chunk-meta">
                    <div class="preview-chunk-meta__main">
                      <span class="preview-chunk-no">c{{ ch.chunkNo }}</span>
                      <span v-if="(ch.headingPath || []).length" class="preview-chunk-path">{{ (ch.headingPath || []).join(' / ') }}</span>
                    </div>
                    <span class="preview-chunk-chars">{{ t('detail.previewChunkChars', { n: (ch.chunkText || '').length }) }}</span>
                  </div>
                  <div class="preview-chunk-text">{{ ch.chunkText }}</div>
                  <div
                    v-if="sortedChunkPreviewAssets(ch).length"
                    class="preview-chunk-assets"
                  >
                    <template v-for="a in sortedChunkPreviewAssets(ch)" :key="a.id">
                      <PreviewChunkAssetImg
                        v-if="isChunkPreviewAssetImage(a)"
                        :file-id="Number(preview.data.file.id)"
                        :asset-id="Number(a.id)"
                      />
                    </template>
                  </div>
                </div>
              </el-scrollbar>
            </div>
          </div>
        </div>
      </el-drawer>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ArrowLeft,
  CircleCheck,
  CircleClose,
  Close,
  Delete,
  Document,
  Download,
  EditPen,
  Loading,
  RefreshRight,
  Setting,
  Upload,
  View
} from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import axios from 'axios';
import KBTopNav from '../components/KBTopNav.vue';
import PreviewChunkAssetImg from '../components/PreviewChunkAssetImg.vue';
import { isAdmin as checkIsAdmin } from '../utils/auth';
import api from '../api';
import websocketClient from '../services/websocketClient';
import { renderDocxPreview, renderXlsxPreview } from '../utils/kbOfficePreview';
import { sha256HexFromBlob } from '../utils/fileSha256';

/** 直传 MinIO/S3：不带 JWT，避免污染预签名请求 */
const uploadToStorageAxios = axios.create();

const route = useRoute();
const isAdmin = computed(() => checkIsAdmin());
const { t } = useI18n();
const docs = ref([]);
const fileInputRef = ref(null);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const collectionMeta = ref({ name: null, description: null });
const RETRIEVAL_TEST_GENERATE_TOP_K = 5;

const askDialog = ref({
  visible: false,
  loading: false,
  query: '',
  generate: false,
  topKBeforeGenerate: null,
  esTopK: 20,
  vecTopK: 20,
  fuseTopK: 20,
  result: null
});
const preview = ref({
  visible: false,
  loading: false,
  data: null,
  errorMessage: '',
  pdfObjectUrl: '',
  officeArrayBuffer: null,
  chunkOverlay: true,
  selectedChunkId: null,
  useOnlyoffice: false,
  ooBundle: null,
  ooMountId: ''
});
const docxPreviewRef = ref(null);
const xlsxPreviewRef = ref(null);
let onlyofficeDocEditor = null;
const chunkCardRefs = new Map();
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

const previewFileLabel = computed(() => {
  const f = preview.value.data?.file;
  if (!f) return '';
  return f.fileName || f.name || '';
});

const previewTextSegments = computed(() => {
  const data = preview.value.data;
  if (!data?.sourceText || data.previewMode !== 'text' || !preview.value.chunkOverlay) return [];
  return buildPreviewSegments(
    data.sourceText,
    data.chunks || [],
    preview.value.selectedChunkId
  );
});

function buildPreviewSegments(sourceText, chunks, selectedChunkId) {
  const sorted = [...chunks].sort(
    (a, b) => (Number(a.startOffset) || 0) - (Number(b.startOffset) || 0)
  );
  let cursor = 0;
  const segments = [];
  for (const ch of sorted) {
    let s = Math.max(0, Math.min(Number(ch.startOffset) || 0, sourceText.length));
    let e = Math.max(s, Math.min(Number(ch.endOffset) || 0, sourceText.length));
    if (s < cursor) s = cursor;
    if (e <= s) continue;
    if (cursor < s) {
      segments.push({ text: sourceText.slice(cursor, s), chunkId: null, selected: false });
    }
    segments.push({
      text: sourceText.slice(s, e),
      chunkId: ch.id,
      selected: Number(ch.id) === Number(selectedChunkId)
    });
    cursor = e;
  }
  if (cursor < sourceText.length) {
    segments.push({ text: sourceText.slice(cursor), chunkId: null, selected: false });
  }
  return segments;
}

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
      const mimeType = (file.type && String(file.type).trim()) || 'application/octet-stream';
      try {
        updateUploadItem(row.id, { progress: 2, progressStatus: '', stateText: t('detail.uploadHashing') });
        const contentSha256 = await sha256HexFromBlob(file);

        updateUploadItem(row.id, { progress: 5, stateText: t('detail.uploadPresign') });
        const initRes = await api.kb.presignInit(
          detail.value.id,
          {
            fileName: file.name,
            contentSha256,
            fileSize: file.size,
            mimeType,
            uploadMode: 'normal'
          },
          { timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS }
        );
        const initData = initRes?.data || {};

        if (initData.dedupReused) {
          reusedCount += 1;
          updateUploadItem(row.id, { progress: 100, progressStatus: 'success', stateText: '已复用' });
          return;
        }

        const uploadUrl = String(initData.uploadUrl || '').trim();
        const objectKey = String(initData.objectKey || '').trim();
        if (!uploadUrl || !objectKey) {
          throw new Error(initData.message || t('detail.uploadDirectFailed'));
        }

        const putHeaders = { ...(initData.headers && typeof initData.headers === 'object' ? initData.headers : {}) };
        if (!putHeaders['Content-Type'] && !putHeaders['content-type']) {
          putHeaders['Content-Type'] = mimeType;
        }

        updateUploadItem(row.id, { progress: 8, stateText: '上传中' });
        await uploadToStorageAxios.put(uploadUrl, file, {
          headers: putHeaders,
          timeout: UPLOAD_REQUEST_TIMEOUT_MS,
          onUploadProgress: (progressEvent) => {
            const totalBytes = Number(progressEvent?.total || file.size || 0);
            const loaded = Number(progressEvent?.loaded || 0);
            if (!totalBytes) return;
            const ratio = loaded / totalBytes;
            const percent = Math.min(98, Math.round(8 + ratio * 90));
            updateUploadItem(row.id, { progress: percent, stateText: '上传中' });
          }
        });

        updateUploadItem(row.id, { progress: 99, stateText: '等待入队' });
        const completeRes = await api.kb.presignComplete(
          detail.value.id,
          {
            objectKey,
            contentSha256,
            fileName: file.name,
            fileSize: file.size,
            mimeType,
            uploadMode: 'normal',
            metadata: { source: 'upload-presign' }
          },
          { timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS }
        );
        const completeData = completeRes?.data || {};

        if (completeData.dedupReused) {
          reusedCount += 1;
          updateUploadItem(row.id, { progress: 100, progressStatus: 'success', stateText: '已复用' });
          return;
        }

        acceptedCount += 1;
        const taskId = Number(completeData.job?.id || 0);
        if (taskId) activeTaskIds.add(taskId);
        updateUploadItem(row.id, {
          progress: 100,
          progressStatus: '',
          stateText: '等待处理',
          taskId: taskId || null
        });
      } catch (error) {
        failedCount += 1;
        const apiMsg = error?.response?.data?.message;
        const message = apiMsg || error.message || t('detail.uploadDirectFailed');
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

function setChunkCardRef(id, el) {
  const key = Number(id);
  if (!el) {
    chunkCardRefs.delete(key);
    return;
  }
  chunkCardRefs.set(key, el);
}

function sortedChunkPreviewAssets(ch) {
  const list = Array.isArray(ch?.assets) ? ch.assets : [];
  return [...list].sort((a, b) => (Number(a.sortNo) || 0) - (Number(b.sortNo) || 0));
}

function isChunkPreviewAssetImage(a) {
  const m = String(a?.mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  return String(a?.assetType || '') === 'image';
}

function selectPreviewChunk(id) {
  preview.value.selectedChunkId = id;
  const el = chunkCardRefs.get(Number(id));
  if (el?.scrollIntoView) {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function destroyOnlyofficeEditor() {
  if (onlyofficeDocEditor && typeof onlyofficeDocEditor.destroyEditor === 'function') {
    try {
      onlyofficeDocEditor.destroyEditor();
    } catch (_) {
      /* drawer may have removed container */
    }
  }
  onlyofficeDocEditor = null;
}

function trimOnlyofficeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function loadOnlyofficeScript(baseUrl) {
  if (typeof window !== 'undefined' && window.DocsAPI) {
    return Promise.resolve();
  }
  const src = `${trimOnlyofficeBaseUrl(baseUrl)}/web-apps/apps/api/documents/api.js`;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('onlyoffice script load failed'));
    document.head.appendChild(s);
  });
}

async function ensureLegacyOfficeBinary(row, payload) {
  if (payload.previewMode === 'pdf' && !preview.value.pdfObjectUrl) {
    const dl = await api.kb.downloadFile(row.id, { inline: true });
    const blob = new Blob([dl.data], { type: payload.file?.mimeType || 'application/pdf' });
    preview.value.pdfObjectUrl = window.URL.createObjectURL(blob);
  } else if (
    (payload.previewMode === 'docx' || payload.previewMode === 'xlsx')
    && !preview.value.officeArrayBuffer
  ) {
    const dl = await api.kb.downloadFile(row.id);
    preview.value.officeArrayBuffer = await dl.data.arrayBuffer();
  }
}

async function renderLegacyOfficeIfNeeded() {
  const mode = preview.value.data?.previewMode;
  const ab = preview.value.officeArrayBuffer;
  if (mode === 'docx' && !docxPreviewRef.value) await nextTick();
  if (mode === 'xlsx' && !xlsxPreviewRef.value) await nextTick();
  try {
    if (mode === 'docx' && docxPreviewRef.value && ab) {
      await renderDocxPreview(docxPreviewRef.value, ab);
    } else if (mode === 'xlsx' && xlsxPreviewRef.value && ab) {
      renderXlsxPreview(xlsxPreviewRef.value, ab);
    }
  } catch (err) {
    console.error('[preview] office render failed', err);
    ElMessage.error(t('detail.previewOfficeRenderFailed'));
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function mountOnlyofficePreview() {
  const bundle = preview.value.ooBundle;
  const mountId = preview.value.ooMountId;
  if (!bundle?.documentServerUrl || !bundle?.config || !mountId) {
    return false;
  }
  destroyOnlyofficeEditor();
  try {
    await loadOnlyofficeScript(bundle.documentServerUrl);
  } catch (err) {
    console.error('[preview] onlyoffice script', err);
    return false;
  }
  await nextTick();
  const el = document.getElementById(mountId);
  if (!el || typeof window.DocsAPI === 'undefined' || !window.DocsAPI.DocEditor) {
    return false;
  }
  try {
    onlyofficeDocEditor = new window.DocsAPI.DocEditor(mountId, bundle.config);
    return true;
  } catch (err) {
    console.error('[preview] onlyoffice editor', err);
    return false;
  }
}

async function openPreview(row) {
  if (row.status !== 'success') {
    ElMessage.warning(t('detail.previewNotReady'));
    return;
  }
  preview.value.visible = true;
  preview.value.loading = true;
  preview.value.errorMessage = '';
  preview.value.data = null;
  destroyOnlyofficeEditor();
  preview.value.useOnlyoffice = false;
  preview.value.ooBundle = null;
  preview.value.ooMountId = '';
  if (preview.value.pdfObjectUrl) {
    window.URL.revokeObjectURL(preview.value.pdfObjectUrl);
  }
  preview.value.pdfObjectUrl = '';
  preview.value.officeArrayBuffer = null;
  preview.value.selectedChunkId = null;
  preview.value.chunkOverlay = true;
  chunkCardRefs.clear();
  try {
    const response = await api.kb.getFilePreview(row.id);
    const payload = response.data?.data ?? response.data ?? {};
    preview.value.data = payload;
    if (!payload.previewable) {
      preview.value.errorMessage = t('detail.previewNotReady');
      return;
    }

    const officePreviewModes = ['pdf', 'docx', 'xlsx'];
    if (officePreviewModes.includes(payload.previewMode)) {
      try {
        const ooResp = await api.kb.getOnlyofficeConfig(row.id, { mode: 'view' });
        const bundle = ooResp.data?.data;
        if (bundle?.documentServerUrl && bundle?.config) {
          preview.value.useOnlyoffice = true;
          preview.value.ooBundle = bundle;
          preview.value.ooMountId = `oo-preview-${row.id}-${Date.now()}`;
        }
      } catch {
        /* OnlyOffice 未启用或类型不支持时沿用浏览器内预览 */
      }
    }

    if (!preview.value.useOnlyoffice) {
      await ensureLegacyOfficeBinary(row, payload);
    }
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    preview.value.errorMessage = message || t('detail.previewLoadFailed');
  } finally {
    preview.value.loading = false;
  }

  if (preview.value.errorMessage) return;

  await nextTick();

  if (preview.value.useOnlyoffice) {
    const ok = await mountOnlyofficePreview();
    if (!ok) {
      preview.value.useOnlyoffice = false;
      preview.value.ooBundle = null;
      preview.value.ooMountId = '';
      destroyOnlyofficeEditor();
      try {
        await ensureLegacyOfficeBinary(row, preview.value.data);
        await nextTick();
        await renderLegacyOfficeIfNeeded();
      } catch (err) {
        console.error('[preview] onlyoffice fallback failed', err);
        ElMessage.error(t('detail.previewOfficeRenderFailed'));
      }
    }
    return;
  }

  await renderLegacyOfficeIfNeeded();
}

function onPreviewDrawerClosed() {
  destroyOnlyofficeEditor();
  preview.value.useOnlyoffice = false;
  preview.value.ooBundle = null;
  preview.value.ooMountId = '';
  if (preview.value.pdfObjectUrl) {
    window.URL.revokeObjectURL(preview.value.pdfObjectUrl);
  }
  preview.value.pdfObjectUrl = '';
  preview.value.officeArrayBuffer = null;
  if (docxPreviewRef.value) docxPreviewRef.value.innerHTML = '';
  if (xlsxPreviewRef.value) xlsxPreviewRef.value.innerHTML = '';
  preview.value.data = null;
  preview.value.errorMessage = '';
  preview.value.selectedChunkId = null;
  chunkCardRefs.clear();
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
      fuseTopK: askDialog.value.fuseTopK,
      generate: Boolean(askDialog.value.generate)
    });
    askDialog.value.result = response.data || null;
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  } finally {
    askDialog.value.loading = false;
  }
}

watch(
  () => askDialog.value.generate,
  (on) => {
    if (on) {
      askDialog.value.topKBeforeGenerate = {
        esTopK: askDialog.value.esTopK,
        vecTopK: askDialog.value.vecTopK,
        fuseTopK: askDialog.value.fuseTopK
      };
      askDialog.value.esTopK = RETRIEVAL_TEST_GENERATE_TOP_K;
      askDialog.value.vecTopK = RETRIEVAL_TEST_GENERATE_TOP_K;
      askDialog.value.fuseTopK = RETRIEVAL_TEST_GENERATE_TOP_K;
    } else {
      const b = askDialog.value.topKBeforeGenerate;
      if (b) {
        askDialog.value.esTopK = b.esTopK;
        askDialog.value.vecTopK = b.vecTopK;
        askDialog.value.fuseTopK = b.fuseTopK;
      }
      askDialog.value.topKBeforeGenerate = null;
    }
  }
);

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
/* 知识库文档详情：顶栏 56px + 主区填满剩余高度，表格区在 main 内滚动 */
.page-shell {
  height: 100vh;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kb-page-bg);
}

.page-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1600px;
  margin-left: auto;
  margin-right: auto;
  padding: 24px;
}

@media (min-width: 768px) {
  .page-content {
    padding: 32px;
  }
}

.detail-head {
  flex-shrink: 0;
  margin-bottom: 20px;
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
  flex-wrap: wrap;
  gap: 0 12px;
}

.title-meta {
  margin-left: 1rem;
  padding-left: 1rem;
  border-left: 1px solid var(--gray-200);
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.025em;
  color: var(--gray-900);
}

.id-tag {
  font-size: 12px;
  line-height: 1.25;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--gray-600);
  border: 1px solid var(--gray-200);
  border-radius: 2px;
  background: var(--gray-100);
  padding: 2px 8px;
}

.meta-sep {
  color: var(--gray-300);
  font-weight: 300;
  user-select: none;
  padding: 0 2px;
}

.doc-count-badge {
  font-size: 13px;
  font-weight: 500;
  color: var(--gray-600);
}

.cell-mono {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--gray-700);
}

.desc {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--gray-700);
}

.table-card {
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--gray-300);
  border-radius: 8px;
  overflow: hidden;
  background: var(--black-white-white);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.table-header {
  flex-shrink: 0;
  min-height: 66px;
  border-bottom: 1px solid var(--gray-200);
  background: var(--black-white-white);
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
  flex-shrink: 0;
  padding: 10px 24px 14px;
  border-bottom: 1px solid var(--gray-200);
  background: var(--slate-50);
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

.ask-generate-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.ask-generate-hint {
  font-size: 12px;
  color: #667085;
  line-height: 1.4;
}

.gen-meta {
  font-size: 12px;
  color: #475467;
  margin-bottom: 8px;
}

.gen-answer {
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.55;
  color: #101828;
}

.gen-error-text {
  margin: 10px 0 0;
  font-size: 13px;
  color: #475467;
  line-height: 1.5;
}

.gen-error-meta {
  margin: 6px 0 0;
  font-size: 12px;
  color: #667085;
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

.table-scroll-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.doc-table :deep(.el-table__header th) {
  font-size: 12px;
  font-weight: 600;
  color: var(--gray-500);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: left;
  background: var(--black-white-white) !important;
}

.doc-table :deep(.el-table__header-wrapper) {
  position: sticky;
  top: 0;
  z-index: 10;
}

.doc-table :deep(.el-table__cell) {
  font-size: 12px;
  color: var(--gray-700);
  text-align: left;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
}

.status-tag__icon {
  flex-shrink: 0;
}

.status-tag__icon.is-spin {
  animation: kb-spin 1s linear infinite;
}

@keyframes kb-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
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
  background: #10b981;
}

.index-item.failed .index-dot {
  background: var(--kb-danger);
}

.index-item.processing .index-dot {
  background: #9a6700;
}

.index-item.waiting .index-dot {
  background: var(--gray-300);
}

.index-label {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--gray-500);
}

.action-buttons {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.doc-table :deep(.el-table__body tr:hover) .action-buttons,
.doc-table :deep(.el-table__body tr:focus-within) .action-buttons {
  opacity: 1;
}

.action-icon-btn {
  padding: 6px !important;
  min-width: 28px !important;
  margin: 0 !important;
}

.action-icon-btn:hover {
  background: var(--gray-100) !important;
}

.action-icon-btn.el-button--danger:hover {
  background: rgba(var(--kb-danger-rgb), 0.08) !important;
}

.hidden-file-input {
  display: none;
}

.pager-wrap {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px 20px;
  border-top: 1px solid var(--gray-200);
}

.pager-total {
  font-size: 12px;
  color: var(--gray-500);
}

.preview-drawer-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding-right: 8px;
}

.preview-drawer-header__icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: rgba(var(--kb-primary-rgb), 0.08);
  border: 1px solid rgba(var(--kb-primary-rgb), 0.15);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--kb-primary);
}

.preview-drawer-header__text {
  flex: 1;
  min-width: 0;
}

.preview-drawer-header__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--gray-900);
  line-height: 1.35;
  word-break: break-word;
}

.preview-drawer-header__sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--gray-500);
  line-height: 1.4;
}

.preview-drawer-header__close {
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 8px;
  margin: -4px -4px 0 0;
  border-radius: var(--radius-sm);
  color: var(--slate-400);
  cursor: pointer;
  line-height: 0;
}

.preview-drawer-header__close:hover {
  background: rgba(226, 232, 240, 0.6);
  color: var(--slate-700);
}

.preview-panel-title--split {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.preview-chunk-total {
  font-size: 12px;
  font-weight: 400;
  color: var(--gray-500);
}

.preview-panel-title--toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.preview-panel-title__mode {
  font-size: 11px;
  font-weight: 500;
  color: var(--gray-500);
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--black-white-white);
  border: 1px solid var(--slate-200);
}

.preview-loading,
.preview-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 24px;
  color: #6a7282;
  font-size: 14px;
}

.preview-error {
  color: #cd011d;
}

.preview-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.preview-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 12px 24px;
  margin-bottom: 0;
  border-bottom: 1px solid var(--slate-200);
  background: var(--black-white-white);
}

.preview-overlay-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #364153;
  cursor: pointer;
  user-select: none;
}

.preview-trunc-hint,
.preview-pdf-hint {
  font-size: 12px;
  color: #9a6700;
}

.preview-panels {
  display: flex;
  flex: 1;
  min-height: 0;
  max-height: calc(100vh - 120px);
  gap: 0;
}

.preview-panel {
  flex: 1;
  width: 50%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  overflow: hidden;
}

.preview-panel--left {
  background: var(--slate-100);
  border-right: 1px solid var(--slate-200);
}

.preview-panel--right {
  background: var(--black-white-white);
}

.preview-panel-title {
  flex-shrink: 0;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--gray-700);
  background: var(--slate-100);
  border-bottom: 1px solid var(--slate-200);
}

.preview-panel--right .preview-panel-title {
  background: var(--black-white-white);
}

.preview-panel-body {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 24px;
  overflow: auto;
  background: var(--slate-100);
}

.preview-panel--right .preview-panel-body {
  padding: 0;
  overflow: hidden;
  background: var(--black-white-white);
}

.preview-iframe {
  width: 100%;
  height: 100%;
  min-height: 480px;
  border: 0;
}

/* PDF 物理页比例容器（约 A4 1:1.414） */
.preview-page-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  flex: 1;
  align-items: stretch;
}

.preview-page-canvas {
  position: relative;
  width: 100%;
  max-height: min(82vh, 1100px);
  aspect-ratio: 1 / 1.414;
  margin: 0 auto;
  flex-shrink: 0;
  background: var(--black-white-white);
  border: 1px solid var(--slate-200);
  border-radius: 2px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  overflow: hidden;
}

.preview-iframe--canvas,
.preview-onlyoffice--canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
}

.preview-onlyoffice {
  width: 100%;
  height: 100%;
  min-height: 480px;
}

/* Office 预览：外层灰底画布（接近 PDF 内嵌区域的观感），勿覆盖 docx-preview 自带的白页与阴影 */
.preview-office {
  height: 100%;
  min-height: 480px;
  max-height: calc(100vh - 200px);
  overflow: auto;
  background: #e8eaed;
}

.preview-office--docx {
  padding: 0;
}

.preview-office--docx :deep(.docx-wrapper) {
  min-width: min-content;
}

.preview-office--docx :deep(section.docx) {
  min-height: 200px;
}

.preview-office--xlsx {
  padding: 12px 16px 20px;
}

.xlsx-preview-inner {
  min-width: min-content;
  max-width: 100%;
}

.xlsx-preview-sheet-panel {
  margin-bottom: 20px;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08);
  border: 1px solid #c8ccd0;
  overflow: hidden;
}

.xlsx-preview-sheet-panel:last-child {
  margin-bottom: 0;
}

.xlsx-preview-sheet-title {
  margin: 0;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #1e2939;
  background: linear-gradient(to bottom, #f8fafc, #eef2f6);
  border-bottom: 1px solid #c8ccd0;
}

.xlsx-preview-table-wrap {
  overflow: auto;
  max-height: min(60vh, 560px);
}

.xlsx-preview-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: Calibri, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  color: #101828;
  background: #fff;
}

.xlsx-preview-table td {
  border: 1px solid #d0d7de;
  padding: 4px 10px;
  min-width: 5em;
  vertical-align: top;
  white-space: nowrap;
}

.xlsx-preview-table tr:first-child td {
  font-weight: 600;
  background: #f0f3f7;
  border-bottom: 1px solid #b8c0cc;
}

.xlsx-preview-empty {
  margin: 0;
  padding: 12px;
  font-size: 13px;
  color: #6a7282;
}

.preview-text-scroll {
  height: 100%;
  min-height: 480px;
  max-height: calc(100vh - 200px);
  overflow: auto;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.55;
  color: #101828;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

.preview-pre {
  margin: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}

.preview-seg {
  cursor: default;
}

.preview-seg--hl {
  background: rgba(0, 188, 125, 0.2);
  border-radius: 2px;
  cursor: pointer;
}

.preview-seg--sel {
  outline: 2px solid var(--kb-danger);
  background: rgba(var(--kb-danger-rgb), 0.12);
  border-radius: 2px;
}

.preview-chunk-list {
  flex: 1;
  min-height: 0;
  height: 100%;
  padding: 16px;
}

.preview-chunk-list :deep(.el-scrollbar__wrap) {
  overflow-x: hidden;
}

.preview-chunk-card {
  border: 1px solid var(--slate-200);
  border-radius: 2px;
  padding: 12px;
  margin-bottom: 12px;
  background: var(--black-white-white);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
}

.preview-chunk-card:last-child {
  margin-bottom: 0;
}

.preview-chunk-card:hover {
  border-color: var(--slate-300);
  background: var(--slate-50);
}

.preview-chunk-card--active {
  border-color: var(--kb-danger);
  background: rgba(var(--kb-danger-rgb), 0.06);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.preview-chunk-card--active .preview-chunk-no {
  background: var(--kb-danger);
  color: var(--black-white-white);
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 11px;
}

.preview-chunk-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--gray-500);
}

.preview-chunk-meta__main {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.preview-chunk-chars {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--gray-500);
}

.preview-chunk-no {
  font-weight: 600;
  color: var(--kb-primary);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}

.preview-chunk-path {
  color: #475467;
}

.preview-chunk-text {
  font-size: 13px;
  line-height: 1.5;
  color: #344054;
  white-space: pre-wrap;
  word-break: break-word;
}

.preview-chunk-assets {
  margin-top: 8px;
}
</style>
