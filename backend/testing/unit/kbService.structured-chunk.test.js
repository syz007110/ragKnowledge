const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitStructuredBlocksToChunks,
  buildVectorChunkContent,
  runWithBackoffRetry
} = require('../../src/services/kbService');

test('splitStructuredBlocksToChunks keeps table rows as standalone chunks', () => {
  const chunks = splitStructuredBlocksToChunks([
    { type: 'heading', level: 1, text: '财务明细' },
    { type: 'table_row', rowKvText: '姓名: 张三; 金额: 100', tableId: 'table-1', rowIndex: 1 },
    { type: 'table_row', rowKvText: '姓名: 李四; 金额: 200', tableId: 'table-1', rowIndex: 2 }
  ], 800);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].chunkType, 'table_row');
  assert.equal(chunks[2].chunkType, 'table_row');
  assert.equal(chunks[1].rowKvText, '姓名: 张三; 金额: 100');
  assert.equal(chunks[2].rowKvText, '姓名: 李四; 金额: 200');
});

test('buildVectorChunkContent includes heading and row context', () => {
  const content = buildVectorChunkContent({
    chunkText: '金额 100',
    metaJson: {
      headingPath: ['财务明细', '3月'],
      rowKvText: '姓名: 张三; 金额: 100',
      sheetName: 'Sheet1',
      tableId: 'table-1'
    }
  });

  assert.match(content, /章节: 财务明细 \/ 3月/);
  assert.match(content, /工作表: Sheet1/);
  assert.match(content, /行数据: 姓名: 张三; 金额: 100/);
  assert.match(content, /金额 100/);
});

test('runWithBackoffRetry retries and then throws after max attempts', async () => {
  let attempts = 0;
  const startedAt = Date.now();

  await assert.rejects(
    () => runWithBackoffRetry(
      async () => {
        attempts += 1;
        throw new Error('temporary_failure');
      },
      {
        retries: 2,
        baseDelayMs: 10,
        maxDelayMs: 20
      }
    ),
    /temporary_failure/
  );

  const elapsed = Date.now() - startedAt;
  assert.equal(attempts, 3);
  assert.ok(elapsed >= 20);
});
