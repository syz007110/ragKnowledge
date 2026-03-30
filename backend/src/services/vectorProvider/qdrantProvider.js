const {
  buildQdrantConfig,
  buildQdrantPoint,
  buildQdrantSearchFilter,
  ensureQdrantCollection,
  upsertQdrantPoints,
  searchQdrantPoints,
  deleteQdrantPointsByFilter,
  setQdrantPayloadByFilter
} = require('../qdrantService');
const {
  buildEmbeddingConfig,
  createEmbeddingService
} = require('../embeddingService');
const { DEFAULT_RETRIEVAL_TOP_K } = require('../../config/retrievalConstants');

function normalizeQdrantHit(item, index) {
  const payload = item?.payload || {};
  return {
    source: 'vector',
    rank: index + 1,
    score: Number(item?.score || 0),
    chunkId: String(item?.id || payload.chunk_id || ''),
    chunkNo: Number(payload.chunk_no || 0),
    fileId: String(payload.file_id || ''),
    fileName: String(payload.file_name || ''),
    chunkType: String(payload.chunk_type || 'paragraph'),
    rowKvText: String(payload.row_kv_text || ''),
    sheetName: String(payload.sheet_name || ''),
    tableId: String(payload.table_id || ''),
    rowIndex: Number(payload.row_index || 0),
    headingPath: Array.isArray(payload.heading_path) ? payload.heading_path : [],
    content: String(payload.content || '')
  };
}

function createQdrantVectorProvider({ embeddingService = createEmbeddingService() } = {}) {
  return {
    async ensureCollection() {
      return ensureQdrantCollection();
    },
    async upsertChunks({ file, chunks, tags = [], vectors = [] }) {
      if (!Array.isArray(chunks) || !chunks.length) return { skipped: true, count: 0 };
      const points = chunks.map((chunk, index) => buildQdrantPoint({
        chunk,
        file,
        tags,
        vector: vectors[index] || []
      }));
      await ensureQdrantCollection();
      return upsertQdrantPoints(points);
    },
    async search({ collectionId, query, topK = DEFAULT_RETRIEVAL_TOP_K, fileId = null, tags = [], pageNo = null, sourceType = '', blockType = '' }) {
      const qdrantConfig = buildQdrantConfig();
      const embeddingConfig = buildEmbeddingConfig();
      if (!qdrantConfig.enabled || !embeddingConfig.enabled) {
        return { skipped: true, hits: [] };
      }
      const vector = await embeddingService.embedQuery(query);
      if (!Array.isArray(vector) || !vector.length) {
        return { skipped: true, hits: [] };
      }
      const filter = buildQdrantSearchFilter({
        collectionId,
        fileId,
        tags,
        pageNo,
        sourceType,
        blockType
      });
      const result = await searchQdrantPoints({
        vector,
        filter,
        limit: topK,
        withPayload: true
      });
      return {
        skipped: result.skipped,
        hits: (result.result || []).map(normalizeQdrantHit)
      };
    },
    async deleteFileChunks({ fileId }) {
      return deleteQdrantPointsByFilter({
        must: [
          { key: 'file_id', match: { value: String(fileId || '') } }
        ]
      });
    },
    async deleteCollectionChunks({ collectionId }) {
      return deleteQdrantPointsByFilter({
        must: [
          { key: 'collection_id', match: { value: String(collectionId || '') } }
        ]
      });
    },
    async updateFileMetadata({ fileId, fileName }) {
      return setQdrantPayloadByFilter({
        payload: {
          file_name: String(fileName || '')
        },
        filter: {
          must: [
            { key: 'file_id', match: { value: String(fileId || '') } }
          ]
        }
      });
    }
  };
}

module.exports = {
  createQdrantVectorProvider,
  normalizeQdrantHit
};
