<template>
  <div ref="root" class="preview-chunk-asset-wrap">
    <img v-if="blobUrl" :src="blobUrl" class="preview-chunk-asset-img" loading="lazy" alt="" />
    <span v-else-if="failed" class="preview-chunk-asset-fail">{{ t('detail.previewAssetLoadFailed') }}</span>
  </div>
</template>

<script setup>
import { ref, onUnmounted, onMounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '../api';

const props = defineProps({
  fileId: { type: Number, required: true },
  assetId: { type: Number, required: true }
});

const { t } = useI18n();
const root = ref(null);
const blobUrl = ref('');
const failed = ref(false);
let observer = null;

function loadBlob() {
  if (blobUrl.value || failed.value) return;
  api.kb
    .getFileAsset(props.fileId, props.assetId)
    .then((res) => {
      blobUrl.value = URL.createObjectURL(res.data);
    })
    .catch(() => {
      failed.value = true;
    });
}

onMounted(async () => {
  await nextTick();
  const el = root.value;
  if (!el) return;
  if (typeof IntersectionObserver === 'undefined') {
    loadBlob();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        observer.disconnect();
        observer = null;
        loadBlob();
      }
    },
    { root: null, rootMargin: '120px', threshold: 0.01 }
  );
  observer.observe(el);
});

onUnmounted(() => {
  if (observer) observer.disconnect();
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});
</script>

<style scoped>
.preview-chunk-asset-wrap {
  min-height: 24px;
}

.preview-chunk-asset-img {
  display: block;
  max-width: 100%;
  height: auto;
  margin-top: 8px;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
}

.preview-chunk-asset-fail {
  font-size: 12px;
  color: #9a6700;
}
</style>
