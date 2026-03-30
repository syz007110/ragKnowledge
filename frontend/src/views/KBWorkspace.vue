<template>
  <div class="page-shell">
    <KBTopNav />

    <main class="page-content">
      <div class="heading-row">
        <div class="heading-text">
          <h1 class="title">
            <span class="title-icon" aria-hidden="true">
              <el-icon :size="22"><TrendCharts /></el-icon>
            </span>
            {{ t('workspace.title') }}
          </h1>
          <p class="desc">{{ t('workspace.desc') }}</p>
        </div>
        <div class="heading-actions">
          <el-button class="recycle-btn" @click="router.push('/recycle-bin')">
            <el-icon><Delete /></el-icon>
            {{ t('workspace.openRecycle') }}
          </el-button>
          <el-button class="create-btn" type="primary" @click="openCreateDialog">
            <el-icon><Plus /></el-icon>
            {{ t('workspace.create') }}
          </el-button>
        </div>
      </div>

      <div class="search-wrap">
        <el-input
          v-model="keyword"
          :placeholder="t('workspace.searchPlaceholder')"
          class="kb-search-input"
          clearable
        >
          <template #prefix>
            <el-icon class="search-prefix-icon"><Search /></el-icon>
          </template>
        </el-input>
      </div>

      <section class="card-grid">
        <article
          v-for="item in filteredItems"
          :key="item.id"
          class="kb-card group"
          @click="goDetail(item.id)"
        >
          <div class="card-head">
            <div class="card-icon-wrap">
              <el-icon :size="20" class="card-icon-inner"><Document /></el-icon>
            </div>
            <div class="card-body">
              <h3 class="card-title">{{ item.name }}</h3>
              <p class="card-desc">{{ item.description }}</p>
            </div>
          </div>
          <div class="tag-row">
            <span
              v-for="tag in item.tags"
              :key="`${item.id}-${tag.name}`"
              class="card-tag"
            >
              {{ tag.name }}
            </span>
          </div>
          <div class="card-footer">
            <span class="doc-count">{{ t('workspace.docsCount', { count: item.docCount || 0 }) }}</span>
            <span class="updated-at">{{ t('workspace.updatedAt', { date: item.updatedAt }) }}</span>
          </div>
          <div class="card-actions" @click.stop>
            <el-button text size="small" class="card-action-btn" @click.stop="openEditDialog(item)">{{ t('workspace.rename') }}</el-button>
            <el-button text size="small" type="danger" class="card-action-btn" @click.stop="removeCollection(item)">{{ t('workspace.delete') }}</el-button>
          </div>
        </article>
      </section>

      <el-dialog
        v-model="collectionDialog.visible"
        :title="collectionDialog.mode === 'create' ? t('workspace.create') : t('workspace.rename')"
        width="520px"
      >
        <el-form label-position="top">
          <el-form-item :label="t('workspace.form.name')">
            <el-input v-model="collectionDialog.form.name" />
          </el-form-item>
          <el-form-item :label="t('workspace.form.description')">
            <el-input v-model="collectionDialog.form.description" type="textarea" :rows="2" />
          </el-form-item>
          <el-form-item :label="t('workspace.form.tags')">
            <el-select
              v-model="collectionDialog.form.tags"
              multiple
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              :multiple-limit="5"
              style="width: 100%"
            >
              <el-option
                v-for="item in standardTagOptions"
                :key="item.id"
                :label="item.tagName"
                :value="item.tagName"
              />
            </el-select>
            <div class="tag-tip">{{ t('workspace.form.tagsTip') }}</div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="collectionDialog.visible = false">{{ t('workspace.form.cancel') }}</el-button>
          <el-button type="primary" @click="submitCollectionDialog">{{ t('workspace.form.save') }}</el-button>
        </template>
      </el-dialog>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Document, Plus, Search, TrendCharts } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import KBTopNav from '../components/KBTopNav.vue';
import api from '../api';

const router = useRouter();
const { t } = useI18n();
const keyword = ref('');
const knowledgeItems = ref([]);
const standardTagOptions = ref([]);
const collectionDialog = ref({
  visible: false,
  mode: 'create',
  id: null,
  form: {
    name: '',
    description: '',
    tags: []
  }
});

function normalizeTagInput(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function formatDate(dateText) {
  if (!dateText) return '-';
  return String(dateText).slice(0, 10);
}

async function loadCollections() {
  const response = await api.kb.getCollections({
    keyword: keyword.value.trim()
  });
  knowledgeItems.value = (response.data?.items || []).map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description || '',
    docCount: item.docCount || 0,
    updatedAt: formatDate(item.updatedAt),
    tags: item.tags || []
  }));
}

async function loadStandardTags() {
  const response = await api.kb.getStandardTags();
  standardTagOptions.value = response.data?.items || [];
}

const filteredItems = computed(() => {
  const key = keyword.value.trim();
  if (!key) return knowledgeItems.value;
  return knowledgeItems.value.filter((item) => item.name.includes(key));
});

function goDetail(id) {
  router.push(`/knowledge/${id}`);
}

function openCreateDialog() {
  collectionDialog.value = {
    visible: true,
    mode: 'create',
    id: null,
    form: {
      name: '',
      description: '',
      tags: []
    }
  };
}

function openEditDialog(item) {
  collectionDialog.value = {
    visible: true,
    mode: 'edit',
    id: item.id,
    form: {
      name: item.name,
      description: item.description || '',
      tags: (item.tags || []).map((tag) => tag.name)
    }
  };
}

async function submitCollectionDialog() {
  const name = String(collectionDialog.value.form.name || '').trim();
  if (!name) {
    ElMessage.error(t('kb.collectionNameRequired'));
    return;
  }
  const payload = {
    name,
    description: collectionDialog.value.form.description || '',
    tags: (collectionDialog.value.form.tags || [])
      .map((item) => normalizeTagInput(item))
      .filter(Boolean)
  };
  try {
    if (collectionDialog.value.mode === 'create') {
      await api.kb.createCollection({
        ...payload,
        code: `kb_${Date.now()}`
      });
    } else {
      await api.kb.updateCollection(collectionDialog.value.id, payload);
    }
    collectionDialog.value.visible = false;
    await loadCollections();
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function removeCollection(item) {
  try {
    await ElMessageBox.confirm(
      `${t('workspace.delete')}：${item.name}?`,
      t('workspace.delete'),
      { type: 'warning' }
    );
    await api.kb.deleteCollection(item.id);
    await loadCollections();
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

onMounted(() => {
  Promise.all([loadCollections(), loadStandardTags()]).catch((error) => {
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  });
});
</script>

<style scoped>
.page-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--kb-page-bg);
}

.page-content {
  width: 100%;
  max-width: 1400px;
  margin-left: auto;
  margin-right: auto;
  padding: 24px;
}

@media (min-width: 768px) {
  .page-content {
    padding: 32px;
  }
}

.heading-row {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.heading-text {
  flex: 1;
}

.title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.025em;
  color: var(--gray-900);
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  display: inline-flex;
  color: var(--kb-primary);
}

.desc {
  margin: 6px 0 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--gray-500);
}

.create-btn {
  --el-button-bg-color: var(--kb-primary);
  --el-button-border-color: var(--kb-primary);
  --el-button-hover-bg-color: var(--kb-primary);
  --el-button-hover-border-color: var(--kb-primary);
  background: var(--kb-primary);
  border-color: var(--kb-primary);
  border-radius: var(--radius-sm);
  height: 36px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.create-btn .el-icon {
  margin-right: 6px;
}

.heading-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.recycle-btn {
  border-radius: var(--radius-sm);
  border: 1px solid var(--gray-300);
  background: var(--black-white-white);
  color: var(--gray-700);
  height: 36px;
}

.recycle-btn:hover {
  background: var(--gray-50);
  border-color: var(--gray-300);
  color: var(--gray-900);
}

.search-wrap {
  width: 100%;
  max-width: none;
  margin-bottom: 28px;
}

.search-wrap :deep(.el-input__wrapper) {
  border-radius: var(--radius-sm);
  border: 1px solid var(--gray-300);
  box-shadow: none;
  padding-left: 36px;
}

.search-prefix-icon {
  color: var(--gray-400);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}

.kb-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--black-white-white);
  border: 1px solid var(--gray-300);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

.kb-card:hover {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
  border-color: rgba(var(--kb-primary-rgb), 0.4);
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.card-icon-wrap {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 2px;
  background: rgba(var(--kb-primary-rgb), 0.05);
  border: 1px solid rgba(var(--kb-primary-rgb), 0.1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.group:hover .card-icon-wrap {
  background: var(--kb-primary);
  border-color: var(--kb-primary);
}

.group:hover .card-icon-inner {
  color: var(--black-white-white) !important;
}

.card-icon-inner {
  color: var(--kb-primary);
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--gray-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-desc {
  margin: 0;
  color: var(--gray-500);
  font-size: 12px;
  line-height: 1.625;
  min-height: 36px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tag-row {
  min-height: 22px;
  margin-bottom: 12px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.card-tag {
  display: inline-flex;
  align-items: center;
  padding: 2.8px 6.8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16.5px;
  color: #4a5565;
  background: #f3f4f6;
  border: 0.8px solid #e5e7eb;
  border-radius: 6px;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.group:hover .card-tag {
  background: var(--gray-100);
  border-color: var(--gray-200);
}

.card-footer {
  border-top: 0.8px solid #f3f4f6;
  padding-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
}

.doc-count {
  background: #f9fafb;
  border: 0.8px solid #e5e7eb;
  border-radius: 6px;
  padding: 2.8px 6.8px;
  font-weight: 500;
  color: #4a5565;
}

.updated-at {
  color: #99a1af;
  font-weight: 400;
}

.card-actions {
  margin-top: 8px;
  display: flex;
  gap: 4px;
  align-items: center;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.group:hover .card-actions {
  opacity: 1;
}

.card-action-btn {
  padding: 4px !important;
  border-radius: 2px !important;
}

.card-action-btn:hover {
  background: var(--gray-100) !important;
}

.tag-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--gray-500);
}
</style>
