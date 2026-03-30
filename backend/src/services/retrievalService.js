const crypto = require('crypto');
const { DEFAULT_RETRIEVAL_TOP_K } = require('../config/retrievalConstants');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function tokenizeText(value = '') {
  const raw = String(value || '').toLowerCase();
  const terms = raw.match(/[\p{L}\p{N}_-]+/gu) || [];
  return terms.filter(Boolean);
}

function fuseAndRerankHits({ query, esHits = [], vecHits = [], topK = DEFAULT_RETRIEVAL_TOP_K, rrfK = 60 }) {
  const map = new Map();
  const push = (hit, lane) => {
    const keyBase = hit.chunkId || `${hit.fileId}:${sha256(hit.content).slice(0, 12)}`;
    const key = String(keyBase);
    if (!map.has(key)) {
      map.set(key, {
        key,
        chunkId: hit.chunkId,
        chunkNo: hit.chunkNo || 0,
        fileId: hit.fileId,
        fileName: hit.fileName,
        headingPath: hit.headingPath || [],
        chunkType: hit.chunkType || 'paragraph',
        rowKvText: hit.rowKvText || '',
        sheetName: hit.sheetName || '',
        tableId: hit.tableId || '',
        rowIndex: Number(hit.rowIndex || 0),
        content: hit.content || '',
        esRank: null,
        vecRank: null,
        esScore: 0,
        vecScore: 0
      });
    }
    const item = map.get(key);
    if (lane === 'es') {
      item.esRank = hit.rank;
      item.esScore = hit.score;
    } else {
      item.vecRank = hit.rank;
      item.vecScore = hit.score;
    }
  };

  esHits.forEach((hit) => push(hit, 'es'));
  vecHits.forEach((hit) => push(hit, 'vector'));

  const queryTokens = tokenizeText(query);
  const merged = Array.from(map.values()).map((item) => {
    const rrfScore =
      (item.esRank ? 1 / (rrfK + item.esRank) : 0) +
      (item.vecRank ? 1 / (rrfK + item.vecRank) : 0);
    const haystack = `${item.fileName || ''} ${Array.isArray(item.headingPath) ? item.headingPath.join(' ') : ''} ${item.content || ''}`.toLowerCase();
    const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length;
    const overlapScore = queryTokens.length ? overlapCount / queryTokens.length : 0;
    const titleHitScore = queryTokens.some((token) => String(item.fileName || '').toLowerCase().includes(token))
      ? 1
      : 0;
    const rerankScore = 0.7 * rrfScore + 0.2 * overlapScore + 0.1 * titleHitScore;
    return {
      ...item,
      rrfScore,
      overlapScore,
      titleHitScore,
      rerankScore
    };
  });

  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  const fused = merged.slice(0, Math.max(1, Math.min(100, Number(topK) || DEFAULT_RETRIEVAL_TOP_K)));
  const reranked = [...fused].sort((a, b) => b.rerankScore - a.rerankScore);
  return {
    fused,
    reranked
  };
}

function createHybridRetrievalService({
  lexicalProvider,
  vectorProvider,
  assetResolver = async () => new Map()
}) {
  if (!lexicalProvider || typeof lexicalProvider.search !== 'function') {
    throw new Error('lexical_provider_missing');
  }
  if (!vectorProvider || typeof vectorProvider.search !== 'function') {
    throw new Error('vector_provider_missing');
  }

  return {
    async retrievalDebug({ collectionId, query, esTopK = DEFAULT_RETRIEVAL_TOP_K, vecTopK = DEFAULT_RETRIEVAL_TOP_K, fuseTopK = DEFAULT_RETRIEVAL_TOP_K }) {
      const startedAt = Date.now();
      const safeQuery = String(query || '').trim();
      if (!safeQuery) {
        return {
          query: '',
          retrieval: { esHits: [], vecHits: [], meta: { esSkipped: false, vectorSkipped: false } },
          fused: [],
          reranked: [],
          timingMs: { es: 0, vector: 0, fuseRerank: 0, total: 0 }
        };
      }

      const esStart = Date.now();
      const esResult = await lexicalProvider.search({ collectionId, query: safeQuery, topK: esTopK });
      const esCost = Date.now() - esStart;

      const vectorStart = Date.now();
      const vecResult = await vectorProvider.search({ collectionId, query: safeQuery, topK: vecTopK });
      const vectorCost = Date.now() - vectorStart;

      const fuseStart = Date.now();
      const merged = fuseAndRerankHits({
        query: safeQuery,
        esHits: esResult.hits,
        vecHits: vecResult.hits,
        topK: fuseTopK
      });
      const fuseCost = Date.now() - fuseStart;

      const allChunkIds = [
        ...(esResult.hits || []).map((item) => item.chunkId),
        ...(vecResult.hits || []).map((item) => item.chunkId),
        ...(merged.fused || []).map((item) => item.chunkId),
        ...(merged.reranked || []).map((item) => item.chunkId)
      ];
      const chunkAssetMap = await assetResolver(allChunkIds);
      const withAssets = (list = []) => list.map((item) => ({
        ...item,
        sourceRef: {
          fileId: item.fileId,
          fileName: item.fileName,
          chunkId: item.chunkId,
          chunkNo: item.chunkNo || 0,
          headingPath: item.headingPath || [],
          chunkType: item.chunkType || 'paragraph',
          sheetName: item.sheetName || '',
          tableId: item.tableId || '',
          rowIndex: Number(item.rowIndex || 0)
        },
        assets: chunkAssetMap.get(String(item.chunkId || '')) || []
      }));

      return {
        query: safeQuery,
        retrieval: {
          esHits: withAssets(esResult.hits),
          vecHits: withAssets(vecResult.hits),
          meta: {
            esSkipped: Boolean(esResult.skipped),
            vectorSkipped: Boolean(vecResult.skipped)
          }
        },
        fused: withAssets(merged.fused),
        reranked: withAssets(merged.reranked),
        timingMs: {
          es: esCost,
          vector: vectorCost,
          fuseRerank: fuseCost,
          total: Date.now() - startedAt
        }
      };
    }
  };
}

module.exports = {
  fuseAndRerankHits,
  createHybridRetrievalService
};
