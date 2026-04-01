/**
 * Default depth for hybrid retrieval (ES + vector + fuse/rerank).
 * Used by API, kbService.retrievalDebug, and providers when topK is omitted.
 */
const DEFAULT_RETRIEVAL_TOP_K = 20;
const DEFAULT_RETRIEVAL_SEARCH_TOP_K = 5;

module.exports = {
  DEFAULT_RETRIEVAL_TOP_K,
  DEFAULT_RETRIEVAL_SEARCH_TOP_K
};
