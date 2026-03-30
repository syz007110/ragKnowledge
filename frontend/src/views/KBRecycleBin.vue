<template>
  <div class="page-shell">
    <KBTopNav />
    <main class="page-content">
      <section class="head">
        <router-link to="/workspace" class="back-btn" aria-label="Back">
          <el-icon :size="20"><ArrowLeft /></el-icon>
        </router-link>
        <el-icon class="head-trash" :size="28"><Delete /></el-icon>
        <div class="head-text">
          <h1 class="title">{{ t('recycle.pageTitle') }}</h1>
          <p class="desc">{{ t('recycle.desc') }}</p>
        </div>
      </section>

      <section v-if="selectedCollectionIds.length || selectedFileIds.length" class="selection-bar">
        <span class="selection-text">
          {{ t('recycle.selectedPrefix') }}
          <strong class="selection-num">{{ selectedCollectionIds.length }}</strong>
          {{ t('recycle.selectedMid') }}
          <strong class="selection-num">{{ selectedFileIds.length }}</strong>
          {{ t('recycle.selectedEnd') }}
        </span>
        <div class="selection-actions">
          <el-button type="danger" plain @click="batchPurge">
            <el-icon><Delete /></el-icon>
            {{ t('recycle.purge') }}
          </el-button>
          <el-button type="primary" :disabled="!canBatchRestore" @click="batchRestore">
            <el-icon><RefreshLeft /></el-icon>
            {{ t('recycle.restore') }}
          </el-button>
        </div>
      </section>

      <section class="table-panel">
        <el-table v-if="rows.length" :data="pagedRows" row-key="id" style="width: 100%">
          <el-table-column width="70">
            <template #default="{ row }">
              <el-checkbox :model-value="isCollectionSelected(row.id)" @change="toggleCollection(row, $event)" />
            </template>
          </el-table-column>
          <el-table-column :label="t('recycle.table.name')" min-width="420">
            <template #default="{ row }">
              <div class="collection-cell">
                <button class="expand-btn" type="button" @click.stop="toggleExpand(row.id)">
                  <el-icon><ArrowRight v-if="!isExpanded(row.id)" /><ArrowDown v-else /></el-icon>
                </button>
                <el-icon class="collection-icon"><Folder /></el-icon>
                <span class="collection-name">{{ row.name }}</span>
                <el-tag v-if="row.isDeleted" size="small" type="danger" effect="plain">{{ t('recycle.collectionDeleted') }}</el-tag>
                <el-tag v-else size="small" type="success" effect="plain">{{ t('recycle.collectionActive') }}</el-tag>
              </div>
              <div v-if="isExpanded(row.id)" class="file-list">
                <div v-for="file in row.files" :key="file.id" class="file-row">
                  <el-checkbox :model-value="isFileSelected(file.id)" @change="toggleFile(row, file, $event)" />
                  <el-icon class="file-icon"><Document /></el-icon>
                  <span class="file-name">{{ file.fileName }}</span>
                  <span class="file-actions">
                    <el-button text size="small" disabled @click.stop="restoreSingleFile(file)">
                      {{ t('recycle.restore') }}
                    </el-button>
                    <el-button text size="small" type="danger" @click.stop="purgeSingleFile(file)">
                      {{ t('recycle.purge') }}
                    </el-button>
                  </span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('recycle.table.deletedAt')" width="200">
            <template #default="{ row }">
              {{ formatDateTime(row.deletedAt) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('recycle.table.fileCount')" width="120">
            <template #default="{ row }">
              {{ row.files.length }}
            </template>
          </el-table-column>
          <el-table-column :label="t('recycle.table.actions')" width="220" align="right">
            <template #default="{ row }">
              <el-button text size="small" :disabled="!row.canRestore" @click.stop="restoreSingleCollection(row)">
                {{ t('recycle.restore') }}
              </el-button>
              <el-button text size="small" type="danger" @click.stop="purgeSingleCollection(row)">
                {{ t('recycle.purge') }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else :description="t('recycle.empty')" />
        <footer v-if="rows.length" class="table-footer-bar">
          <span class="footer-summary">{{ t('recycle.footerSummary', { collections: totalCollections, files: totalFiles }) }}</span>
          <el-pagination
            v-model:current-page="recyclePage"
            v-model:page-size="recyclePageSize"
            layout="sizes, prev, pager, next"
            :total="rows.length"
            :page-sizes="[10, 20, 50]"
            background
          />
        </footer>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown, ArrowLeft, ArrowRight, Delete, Document, Folder, RefreshLeft } from '@element-plus/icons-vue';
import { useI18n } from 'vue-i18n';
import KBTopNav from '../components/KBTopNav.vue';
import api from '../api';

const { t } = useI18n();
const rows = ref([]);
const expandedSet = ref(new Set());
const selectedCollectionIds = ref([]);
const selectedFileIds = ref([]);
const recyclePage = ref(1);
const recyclePageSize = ref(50);

const pagedRows = computed(() => {
  const start = (recyclePage.value - 1) * recyclePageSize.value;
  return rows.value.slice(start, start + recyclePageSize.value);
});

const totalCollections = computed(() => rows.value.length);

const totalFiles = computed(() =>
  rows.value.reduce((sum, row) => sum + (row.files?.length || 0), 0)
);

const canBatchRestore = computed(() => {
  if (!selectedCollectionIds.value.length && selectedFileIds.value.length) {
    return false;
  }
  return selectedCollectionIds.value.length + selectedFileIds.value.length > 0;
});

function formatDateTime(value) {
  if (!value) return '-';
  return String(value).slice(0, 19).replace('T', ' ');
}

async function loadRecycleBin() {
  const response = await api.kb.getRecycleBin();
  rows.value = response.data?.items || [];
  recyclePage.value = 1;
}

watch(
  () => rows.value.length,
  (len) => {
    const maxPage = Math.max(1, Math.ceil(len / recyclePageSize.value) || 1);
    if (recyclePage.value > maxPage) recyclePage.value = maxPage;
  }
);

function isExpanded(collectionId) {
  return expandedSet.value.has(collectionId);
}

function toggleExpand(collectionId) {
  const next = new Set(expandedSet.value);
  if (next.has(collectionId)) next.delete(collectionId);
  else next.add(collectionId);
  expandedSet.value = next;
}

function isCollectionSelected(collectionId) {
  return selectedCollectionIds.value.includes(collectionId);
}

function isFileSelected(fileId) {
  return selectedFileIds.value.includes(fileId);
}

function toggleCollection(row, checked) {
  const collectionId = row.id;
  const fileIds = (row.files || []).map((file) => file.id);
  if (checked) {
    if (!selectedCollectionIds.value.includes(collectionId)) {
      selectedCollectionIds.value = [...selectedCollectionIds.value, collectionId];
    }
    selectedFileIds.value = Array.from(new Set([...selectedFileIds.value, ...fileIds]));
    return;
  }
  selectedCollectionIds.value = selectedCollectionIds.value.filter((id) => id !== collectionId);
  selectedFileIds.value = selectedFileIds.value.filter((id) => !fileIds.includes(id));
}

function toggleFile(_row, file, checked) {
  if (checked) {
    if (!selectedFileIds.value.includes(file.id)) {
      selectedFileIds.value = [...selectedFileIds.value, file.id];
    }
    return;
  }
  selectedFileIds.value = selectedFileIds.value.filter((id) => id !== file.id);
}

async function restoreBySelection(collectionIds, fileIds) {
  await ElMessageBox.confirm(t('recycle.confirmRestoreText'), t('recycle.confirmRestoreTitle'), { type: 'warning' });
  await api.kb.restoreRecycleBin({ collectionIds, fileIds });
  ElMessage.success(t('common.success'));
  selectedCollectionIds.value = [];
  selectedFileIds.value = [];
  await loadRecycleBin();
}

async function purgeBySelection(collectionIds, fileIds) {
  await ElMessageBox.confirm(t('recycle.confirmPurgeText'), t('recycle.confirmPurgeTitle'), { type: 'warning' });
  await api.kb.purgeRecycleBin({ collectionIds, fileIds });
  ElMessage.success(t('kb.recycle.purgeQueued'));
  selectedCollectionIds.value = [];
  selectedFileIds.value = [];
  await loadRecycleBin();
}

async function batchRestore() {
  if (!selectedCollectionIds.value.length && selectedFileIds.value.length) {
    ElMessage.warning(t('recycle.restoreRestricted'));
    return;
  }
  if (!selectedCollectionIds.value.length && !selectedFileIds.value.length) {
    ElMessage.warning(t('recycle.selectionRequired'));
    return;
  }
  try {
    await restoreBySelection(selectedCollectionIds.value, selectedFileIds.value);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function batchPurge() {
  if (!selectedCollectionIds.value.length && !selectedFileIds.value.length) {
    ElMessage.warning(t('recycle.selectionRequired'));
    return;
  }
  try {
    await purgeBySelection(selectedCollectionIds.value, selectedFileIds.value);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function restoreSingleCollection(row) {
  if (!row.canRestore) return;
  try {
    await restoreBySelection([row.id], []);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function purgeSingleCollection(row) {
  try {
    await purgeBySelection([row.id], []);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function restoreSingleFile(file) {
  if (!file.canRestore) {
    ElMessage.warning(t('recycle.restoreRestricted'));
    return;
  }
  try {
    await restoreBySelection([], [file.id]);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

async function purgeSingleFile(file) {
  try {
    await purgeBySelection([], [file.id]);
  } catch (error) {
    if (error === 'cancel') return;
    const message = error?.response?.data?.message || error.message;
    if (message) ElMessage.error(message);
  }
}

onMounted(() => {
  loadRecycleBin().catch((error) => {
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

.head {
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
  border: 1px solid var(--gray-300);
  border-radius: 6px;
  background: var(--black-white-white);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--gray-900);
  text-decoration: none;
  transition: background 0.2s, border-color 0.2s;
  margin-top: 2px;
}

.back-btn:hover {
  background: var(--gray-50);
  border-color: var(--gray-300);
}

.head-trash {
  flex-shrink: 0;
  color: var(--gray-400);
  margin-top: 4px;
}

.head-text {
  flex: 1;
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--gray-900);
}

.desc {
  margin: 6px 0 0;
  color: var(--gray-500);
  font-size: 14px;
}

.selection-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid rgba(var(--kb-primary-rgb), 0.2);
  background: rgba(var(--kb-primary-rgb), 0.05);
  border-radius: 2px;
  padding: 10px 16px;
  margin-bottom: 16px;
}

.selection-text {
  color: var(--gray-700);
  font-weight: 500;
  font-size: 14px;
}

.selection-num {
  color: var(--kb-primary);
  font-weight: 700;
}

.selection-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.table-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--gray-300);
  border-radius: 2px;
  overflow: hidden;
  background: var(--black-white-white);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.table-panel :deep(.el-table__header th) {
  font-size: 12px;
  font-weight: 600;
  color: var(--gray-500);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--black-white-white) !important;
}

.table-panel :deep(.el-table) {
  --el-table-border-color: var(--gray-200);
}

.table-footer-bar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--gray-200);
  background: var(--gray-50);
}

.footer-summary {
  font-size: 13px;
  color: var(--gray-600);
}

.table-footer-bar :deep(.el-pagination) {
  justify-content: flex-end;
}

.collection-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expand-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #6a7282;
}

.collection-icon {
  color: #475467;
}

.collection-name {
  color: #344054;
  font-weight: 500;
}

.file-list {
  margin-top: 8px;
  margin-left: 32px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.file-icon {
  color: #667085;
}

.file-name {
  color: #475467;
}

.file-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
}
</style>
