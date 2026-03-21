function createEsLexicalProvider({
  axiosInstance,
  buildEsConfig,
  ensureConfig
}) {
  if (!axiosInstance) {
    throw new Error('es_provider_missing_axios');
  }
  return {
    async search({ collectionId, query, topK = 5 }) {
      const config = buildEsConfig();
      if (!config.enabled) {
        return { skipped: true, hits: [] };
      }
      ensureConfig(config, ['baseUrl', 'indexName'], 'es');
      const auth = config.username ? { username: config.username, password: config.password } : undefined;
      const url = `${config.baseUrl}/${encodeURIComponent(config.indexName)}/_search`;
      const body = {
        size: Math.max(1, Math.min(100, Number(topK) || 5)),
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  type: 'most_fields',
                  fields: ['content^3', 'row_kv_text^4', 'heading_path_text^2', 'file_name^1.5', 'sheet_name^1.2', 'tags']
                }
              }
            ],
            filter: [
              { term: { collection_id: Number(collectionId) } }
            ]
          }
        },
        _source: [
          'id',
          'collection_id',
          'file_id',
          'file_name',
          'heading_path_text',
          'heading_path',
          'chunk_type',
          'row_kv_text',
          'sheet_name',
          'table_id',
          'row_index',
          'chunk_no',
          'content',
          'tags'
        ]
      };
      const response = await axiosInstance.post(url, body, {
        auth,
        timeout: Number(process.env.ES_TIMEOUT_MS || 20000)
      });
      const hits = (response.data?.hits?.hits || []).map((item, index) => ({
        source: 'es',
        rank: index + 1,
        score: Number(item._score || 0),
        chunkId: String(item._source?.id || item._id || ''),
        chunkNo: Number(item._source?.chunk_no || 0),
        fileId: String(item._source?.file_id || ''),
        fileName: String(item._source?.file_name || ''),
        headingPath: Array.isArray(item._source?.heading_path)
          ? item._source.heading_path
          : (String(item._source?.heading_path_text || '').trim() ? String(item._source.heading_path_text).split(' / ') : []),
        chunkType: String(item._source?.chunk_type || 'paragraph'),
        rowKvText: String(item._source?.row_kv_text || ''),
        sheetName: String(item._source?.sheet_name || ''),
        tableId: String(item._source?.table_id || ''),
        rowIndex: Number(item._source?.row_index || 0),
        content: String(item._source?.content || ''),
        tags: Array.isArray(item._source?.tags) ? item._source.tags : []
      }));
      return { skipped: false, hits };
    }
  };
}

module.exports = {
  createEsLexicalProvider
};
