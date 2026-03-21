const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateDirectIngestRequest,
  cleanupStoredUpload
} = require('../src/controllers/kbController');
const {
  rollbackFailedIngestCreation
} = require('../src/services/kbService');

test('validateDirectIngestRequest rejects client-provided storageUri', () => {
  const result = validateDirectIngestRequest({
    collectionId: 1,
    fileName: 'manual.txt',
    rawText: 'hello world',
    storageUri: 'file:///etc/passwd'
  });

  assert.deepEqual(result, {
    valid: false,
    reasonKey: 'kb.storageUriNotAllowed'
  });
});

test('validateDirectIngestRequest requires rawText for direct ingest', () => {
  const result = validateDirectIngestRequest({
    collectionId: 1,
    fileName: 'manual.txt',
    rawText: '   ',
    storageUri: ''
  });

  assert.deepEqual(result, {
    valid: false,
    reasonKey: 'kb.rawTextRequired'
  });
});

test('cleanupStoredUpload removes local files without touching object storage', async () => {
  const calls = [];
  await cleanupStoredUpload({
    localPath: 'D:/tmp/file.txt',
    storageUri: 'file://D:/tmp/file.txt',
    unlinkFn: async (target) => calls.push(['unlink', target]),
    deleteObjectFn: async (target) => calls.push(['deleteObject', target])
  });

  assert.deepEqual(calls, [['unlink', 'D:/tmp/file.txt']]);
});

test('cleanupStoredUpload removes uploaded objects for s3 URIs', async () => {
  const calls = [];
  await cleanupStoredUpload({
    localPath: '',
    storageUri: 's3://logtoolkb/kb/1/file.txt',
    unlinkFn: async (target) => calls.push(['unlink', target]),
    deleteObjectFn: async (target) => calls.push(['deleteObject', target])
  });

  assert.deepEqual(calls, [['deleteObject', 's3://logtoolkb/kb/1/file.txt']]);
});

test('rollbackFailedIngestCreation destroys lineage job and file', async () => {
  const calls = [];
  const makeRecord = (name) => ({
    destroy: async () => calls.push(name)
  });

  await rollbackFailedIngestCreation({
    lineageRecord: makeRecord('lineage'),
    jobRecord: makeRecord('job'),
    file: makeRecord('file')
  });

  assert.deepEqual(calls, ['lineage', 'job', 'file']);
});
