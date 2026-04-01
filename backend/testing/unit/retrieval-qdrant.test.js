const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHybridRetrievalService,
  fuseAndRerankHits
} = require('../../src/services/retrievalService');
const {
  buildQdrantPoint,
  buildQdrantSearchFilter
} = require('../../src/services/qdrantService');
const {
  countIndexedStates
} = require('../../src/services/indexStateService');

test('createHybridRetrievalService combines lexical and vector providers with assets', async () => {
  const lexicalProvider = {
    search: async () => ({
      skipped: false,
      hits: [
        {
          source: 'es',
          rank: 1,
          score: 10,
          chunkId: 'chunk-1',
          chunkNo: 1,
          fileId: 'file-1',
          fileName: 'alpha.md',
          headingPath: ['A'],
          content: 'alpha beta gamma'
        }
      ]
    })
  };
  const vectorProvider = {
    search: async () => ({
      skipped: false,
      hits: [
        {
          source: 'vector',
          rank: 1,
          score: 0.98,
          chunkId: 'chunk-1',
          chunkNo: 1,
          fileId: 'file-1',
          fileName: 'alpha.md',
          headingPath: ['A'],
          content: 'alpha beta gamma'
        },
        {
          source: 'vector',
          rank: 2,
          score: 0.61,
          chunkId: 'chunk-2',
          chunkNo: 2,
          fileId: 'file-2',
          fileName: 'beta.md',
          headingPath: ['B'],
          content: 'delta epsilon'
        }
      ]
    })
  };
  const assetResolver = async (chunkIds) => new Map([
    [String(chunkIds[0]), [{ assetKey: 'asset-1' }]]
  ]);

  const service = createHybridRetrievalService({
    lexicalProvider,
    vectorProvider,
    assetResolver
  });

  const result = await service.retrievalDebug({
    collectionId: 9,
    query: 'alpha beta',
    esTopK: 5,
    vecTopK: 5,
    fuseTopK: 5
  });

  assert.equal(result.retrieval.esHits.length, 1);
  assert.equal(result.retrieval.vecHits.length, 2);
  assert.equal(result.reranked[0].chunkId, 'chunk-1');
  assert.deepEqual(result.reranked[0].assets, [{ assetKey: 'asset-1' }]);
  assert.equal(result.retrieval.meta.esSkipped, false);
  assert.equal(result.retrieval.meta.vectorSkipped, false);
});

test('fuseAndRerankHits keeps best merged hit first', () => {
  const merged = fuseAndRerankHits({
    query: 'medical alpha',
    esHits: [
      {
        source: 'es',
        rank: 1,
        score: 8,
        chunkId: 'chunk-1',
        fileId: 'file-1',
        fileName: 'medical-alpha.md',
        headingPath: ['alpha'],
        content: 'medical alpha guidance'
      }
    ],
    vecHits: [
      {
        source: 'vector',
        rank: 1,
        score: 0.99,
        chunkId: 'chunk-1',
        fileId: 'file-1',
        fileName: 'medical-alpha.md',
        headingPath: ['alpha'],
        content: 'medical alpha guidance'
      },
      {
        source: 'vector',
        rank: 2,
        score: 0.70,
        chunkId: 'chunk-2',
        fileId: 'file-2',
        fileName: 'other.md',
        headingPath: ['misc'],
        content: 'other content'
      }
    ],
    topK: 2
  });

  assert.equal(merged.fused.length, 2);
  assert.equal(merged.reranked[0].chunkId, 'chunk-1');
});

test('buildQdrantPoint maps chunk metadata into qdrant payload', () => {
  const point = buildQdrantPoint({
    chunk: {
      id: 101,
      chunkNo: 3,
      chunkText: 'content',
      metaJson: {
        headingPath: ['PDF', 'Page 2'],
        chunkType: 'paragraph',
        rowKvText: '',
        sheetName: '',
        tableId: '',
        rowIndex: 0,
        pageNo: 2,
        sourceType: 'pdf',
        blockType: 'text',
        isOcr: true,
        sectionPath: ['PDF', 'Body']
      }
    },
    file: {
      id: 7,
      collectionId: 5,
      fileName: 'paper.pdf',
      fileExt: 'pdf'
    },
    tags: ['med', 'guide'],
    vector: [0.1, 0.2, 0.3]
  });

  assert.equal(point.id, 101);
  assert.deepEqual(point.vector, [0.1, 0.2, 0.3]);
  assert.equal(point.payload.collection_id, '5');
  assert.equal(point.payload.file_id, '7');
  assert.equal(point.payload.file_name, 'paper.pdf');
  assert.equal(point.payload.page_no, 2);
  assert.equal(point.payload.source_type, 'pdf');
  assert.deepEqual(point.payload.tags, ['med', 'guide']);
});

test('buildQdrantSearchFilter supports collection and optional metadata filters', () => {
  const filter = buildQdrantSearchFilter({
    collectionId: 9,
    fileId: 12,
    tags: ['med'],
    pageNo: 4,
    sourceType: 'pdf',
    blockType: 'table_row'
  });

  assert.deepEqual(filter, {
    must: [
      { key: 'collection_id', match: { value: '9' } },
      { key: 'file_id', match: { value: '12' } },
      { key: 'tags', match: { any: ['med'] } },
      { key: 'page_no', match: { value: 4 } },
      { key: 'source_type', match: { value: 'pdf' } },
      { key: 'block_type', match: { value: 'table_row' } }
    ]
  });
});

test('countIndexedStates can ignore vector status when vector sync disabled', () => {
  const states = [
    { esStatus: 'done', vectorStatus: 'failed' },
    { esStatus: 'done', vectorStatus: 'pending' },
    { esStatus: 'failed', vectorStatus: 'done' }
  ];

  assert.equal(countIndexedStates(states, { requireVectorSync: true }), 0);
  assert.equal(countIndexedStates(states, { requireVectorSync: false }), 2);
});
