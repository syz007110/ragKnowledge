const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { Op } = require('sequelize');
const { runIngestPipeline, normalizeFileExt, INGEST_JOB_ABORT_FILE_DELETED } = require('../services/kbService');
const { KbFile, KbJob } = require('../models');
const { publishKbTaskStatus } = require('../services/wsEventPublisher');
const { isS3Uri, getObjectBufferByUri } = require('../services/objectStorageService');
const {
  isDocumentServiceEnabled,
  parseByDocumentService,
  cleanByDocumentService,
  chunkFromCleanedDocument,
  chunkFromDirectRawText,
  buildPreviewPlainText
} = require('../services/kbDocumentService');
const {
  uploadEmbeddedPayloadsAndRefillParseDocument,
  persistNormalizedParseJsonArtifact
} = require('../services/kbParseDocumentAssets');

async function extractRawText(payload) {
  if (payload.rawText && String(payload.rawText).trim()) {
    return {
      rawText: String(payload.rawText),
      parseDocument: null,
      embeddedImagePayloads: {},
      docx: null,
      xlsx: null,
      pdf: null
    };
  }
  const file = await KbFile.findByPk(payload.fileId);
  if (!file) {
    return {
      rawText: '',
      parseDocument: null,
      embeddedImagePayloads: {},
      docx: null,
      xlsx: null,
      pdf: null
    };
  }
  if (Number(file.isDeleted) === 1) {
    throw new Error(INGEST_JOB_ABORT_FILE_DELETED);
  }

  const ext = normalizeFileExt(file.fileName, file.fileExt);
  const storageUri = String(file.storageUri || '');
  const localPath = storageUri.startsWith('file://')
    ? storageUri.replace('file://', '')
    : storageUri;
  let absPath = '';
  let tempPath = '';
  try {
    if (isS3Uri(storageUri)) {
      const objectBody = await getObjectBufferByUri(storageUri);
      const extPart = path.extname(file.fileName || '') || '';
      tempPath = path.resolve(os.tmpdir(), `kb-object-${file.id}-${Date.now()}-${Math.round(Math.random() * 1e6)}${extPart}`);
      await fs.writeFile(tempPath, objectBody);
      absPath = tempPath;
    } else {
      if (!localPath || localPath.startsWith('kb://')) {
        return {
          rawText: '',
          parseDocument: null,
          embeddedImagePayloads: {},
          docx: null,
          xlsx: null,
          pdf: null
        };
      }
      absPath = path.isAbsolute(localPath)
        ? localPath
        : path.resolve(process.cwd(), localPath);
    }

    if (!isDocumentServiceEnabled()) {
      throw new Error('kb.parser.documentServiceUnavailable');
    }

    const parsed = await parseByDocumentService({
      absPath,
      fileExt: ext
    });
    if (!parsed || !parsed.parseDocument) {
      throw new Error('kb.parser.documentServiceUnavailable');
    }
    let rawText = '';
    try {
      rawText = await buildPreviewPlainText(parsed.parseDocument, ext);
    } catch {
      rawText = '';
    }
    return {
      rawText,
      parseDocument: parsed.parseDocument,
      embeddedImagePayloads: parsed.embeddedImagePayloads || {},
      docx: null,
      xlsx: null,
      pdf: null
    };
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => null);
    }
  }
}

/**
 * Parse → (upload images + refill) → clean → chunk via document-service; or direct rawText → chunk.
 */
async function buildPythonIngestChunks({ file, parsed, fileExt }) {
  if (parsed.parseDocument) {
    let pd = parsed.parseDocument;
    const embedded = parsed.embeddedImagePayloads || {};
    if (file && Object.keys(embedded).length) {
      pd = await uploadEmbeddedPayloadsAndRefillParseDocument({
        file,
        parseDocument: pd,
        embeddedImagePayloads: embedded
      });
    }
    await persistNormalizedParseJsonArtifact({ file, parseDocument: pd });
    const cleaned = await cleanByDocumentService(pd);
    const chunks = await chunkFromCleanedDocument(cleaned, { fileExt, maxChunkSize: 800 });
    return { pythonChunks: chunks, enrichedParseDocument: pd };
  }
  if (String(parsed.rawText || '').trim()) {
    const chunks = await chunkFromDirectRawText(parsed.rawText, fileExt, 800);
    return { pythonChunks: chunks, enrichedParseDocument: null };
  }
  return { pythonChunks: [], enrichedParseDocument: null };
}

async function finalizeIngestAbortedFileDeleted({ job, kbJobId, fileId }) {
  const kbJob = await KbJob.findByPk(kbJobId);
  if (kbJob && String(kbJob.status || '') !== 'failed') {
    await kbJob.update({
      status: 'failed',
      lastErrorKey: 'kb.job.abortedSoftDeleted',
      lastError: 'file_soft_deleted'
    });
  }
  await publishKbTaskStatus({
    taskId: kbJobId,
    queueJobId: String(job.id),
    status: 'failed',
    progress: Number(job.progress() || 0),
    fileId: Number(fileId || 0),
    collectionId: Number(job.data?.collectionId || 0),
    jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse'),
    error: 'file_soft_deleted'
  });
}

async function processKbIngestJob(job) {
  const { fileId, kbJobId } = job.data;
  console.log(`[KB处理器] processing queueJob=${job.id}, file=${fileId}, kbJob=${kbJobId}`);
  try {
    let file = await KbFile.findByPk(fileId);
    if (!file || Number(file.isDeleted) === 1) {
      await finalizeIngestAbortedFileDeleted({ job, kbJobId, fileId });
      return { aborted: true, reason: 'file_missing_or_deleted' };
    }
    const reindexOnly = Boolean(job.data?.metadata?.reindexOnly)
      || (Number(job.attemptsMade || 0) > 0 && String(file?.status || '') === 'index_failed');
    // Mark DB early so list/preview APIs match Bull retries (attemptsMade>0) and long extract/chunk phases.
    // Clear last error so retries are not shown as "processing" + stale timeout text from a prior attempt.
    await KbJob.update(
      { status: 'processing', lastError: null, lastErrorKey: null },
      { where: { id: kbJobId } }
    );
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 5,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });
    await job.progress(10);
    const parsed = reindexOnly
      ? {
        rawText: '',
        parseDocument: null,
        embeddedImagePayloads: {},
        docx: null,
        xlsx: null,
        pdf: null
      }
      : await extractRawText(job.data);
    await job.progress(45);
    file = await KbFile.findByPk(fileId);
    if (!file || Number(file.isDeleted) === 1) {
      await finalizeIngestAbortedFileDeleted({ job, kbJobId, fileId });
      return { aborted: true, reason: 'file_deleted_during_extract' };
    }
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 45,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });

    const fileExt = file ? normalizeFileExt(file.fileName, file.fileExt) : '';
    let pythonChunks = null;
    let enrichedParseDocument = null;
    if (!reindexOnly) {
      const built = await buildPythonIngestChunks({
        file,
        parsed,
        fileExt
      });
      pythonChunks = built.pythonChunks;
      enrichedParseDocument = built.enrichedParseDocument;
    }

    const result = await runIngestPipeline({
      fileId,
      kbJobId,
      reindexOnly,
      pythonChunks,
      enrichedParseDocument
    });

    await job.progress(100);
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'done',
      progress: 100,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });
    return {
      queueJobId: job.id,
      ...result,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error.message === INGEST_JOB_ABORT_FILE_DELETED) {
      await finalizeIngestAbortedFileDeleted({ job, kbJobId, fileId });
      return { aborted: true, reason: 'file_soft_deleted' };
    }
    const file = await KbFile.findByPk(fileId);
    const parserErrorKey = (
      error.message === 'kb.parser.documentServiceUnavailable'
        ? 'kb.parser.documentServiceUnavailable'
        : (
          error.message === 'kb.parser.docxUnavailable'
            ? 'kb.parser.docxUnavailable'
            : (
              error.message === 'kb.parser.xlsxUnavailable'
                ? 'kb.parser.xlsxUnavailable'
                : (error.message === 'kb.parser.pdfUnavailable' ? 'kb.parser.pdfUnavailable' : null)
            )
        )
    );
    const pipelineErrorKey = error.message.includes('kb.index.syncFailed') ? 'kb.index.syncFailed' : null;
    const fallbackErrorKey = parserErrorKey || pipelineErrorKey || 'kb.job.processingFailed';
    if (file) {
      const preserveFileFailure = ['parse_failed', 'index_failed'].includes(String(file.status || ''));
      if (!preserveFileFailure) {
        await file.update({
          status: 'processing_failed',
          errorMessageKey: fallbackErrorKey,
          errorMessage: error.message
        });
      }
    }
    // Always persist the latest failure for this attempt; do not overwrite a terminal 'done' row.
    await KbJob.update(
      {
        status: 'failed',
        lastErrorKey: fallbackErrorKey,
        lastError: error.message
      },
      { where: { id: kbJobId, status: { [Op.ne]: 'done' } } }
    );
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'failed',
      progress: Number(job.progress() || 0),
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse'),
      error: error.message
    });
    throw error;
  }
}

module.exports = {
  processKbIngestJob,
  extractRawText
};
