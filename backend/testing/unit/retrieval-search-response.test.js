const test = require('node:test');
const assert = require('node:assert/strict');

const { toRetrievalSearchResponse } = require('../../src/services/retrievalService');

function makeHit(index) {
  return {
    chunkId: `chunk-${index}`,
    chunkNo: index,
    fileId: `file-${index}`,
    fileName: `manual-${index}.md`,
    headingPath: ['Section', `${index}`],
    content: `content-${index}`,
    rerankScore: 1 - index * 0.01,
    sourceRef: {
      fileId: `file-${index}`,
      fileName: `manual-${index}.md`,
      chunkId: `chunk-${index}`,
      chunkNo: index,
      headingPath: ['Section', `${index}`]
    },
    assets: []
  };
}

test('toRetrievalSearchResponse returns multi hits and caps at provided limit', () => {
  const debugResult = {
    query: 'network disconnected',
    reranked: Array.from({ length: 8 }, (_, i) => makeHit(i + 1)),
    timingMs: { total: 123 }
  };

  const out = toRetrievalSearchResponse(debugResult, { limit: 5 });

  assert.equal(out.query, 'network disconnected');
  assert.equal(Array.isArray(out.hits), true);
  assert.equal(out.hits.length, 5);
  assert.equal(out.hits[0].ref, 'K1');
  assert.equal(out.hits[4].ref, 'K5');
});

test('toRetrievalSearchResponse uses safe default when limit missing', () => {
  const debugResult = {
    query: 'power issue',
    reranked: Array.from({ length: 20 }, (_, i) => makeHit(i + 1)),
    timingMs: { total: 88 }
  };

  const out = toRetrievalSearchResponse(debugResult);

  assert.equal(out.hits.length, 5);
});
