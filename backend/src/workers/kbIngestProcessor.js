const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { runIngestPipeline, normalizeFileExt } = require('../services/kbService');
const { KbFile, KbJob } = require('../models');
const { publishKbTaskStatus } = require('../services/wsEventPublisher');
const { isS3Uri, getObjectBufferByUri } = require('../services/objectStorageService');
const { isDocumentServiceEnabled, parseByDocumentService } = require('../services/kbDocumentService');

async function extractRawText(payload) {
  if (payload.rawText && String(payload.rawText).trim()) {
    return {
      rawText: String(payload.rawText),
      docx: null,
      xlsx: null,
      pdf: null,
      parseDocument: null
    };
  }
  const file = await KbFile.findByPk(payload.fileId);
  if (!file) {
    return {
      rawText: '',
      docx: null,
      xlsx: null,
      pdf: null,
      parseDocument: null
    };
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
          docx: null,
          xlsx: null,
          pdf: null,
          parseDocument: null
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
    if (!parsed) {
      throw new Error('kb.parser.documentServiceUnavailable');
    }
    return parsed;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => null);
    }
  }
}

async function processKbIngestJob(job) {
  const { fileId, kbJobId } = job.data;
  console.log(`[KB处理器] processing queueJob=${job.id}, file=${fileId}, kbJob=${kbJobId}`);
  try {
    const file = await KbFile.findByPk(fileId);
    const reindexOnly = Boolean(job.data?.metadata?.reindexOnly)
      || (Number(job.attemptsMade || 0) > 0 && String(file?.status || '') === 'index_failed');
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
      ? { rawText: '', docx: null, xlsx: null, pdf: null, parseDocument: null }
      : await extractRawText(job.data);
    await job.progress(45);
    await publishKbTaskStatus({
      taskId: kbJobId,
      queueJobId: String(job.id),
      status: 'processing',
      progress: 45,
      fileId: Number(fileId || 0),
      collectionId: Number(job.data?.collectionId || 0),
      jobType: String(job.data?.metadata?.rebuild ? 'rebuild' : 'parse')
    });

    const result = await runIngestPipeline({
      fileId,
      kbJobId,
      rawText: parsed.rawText,
      parsedDocx: parsed.docx,
      parsedXlsx: parsed.xlsx,
      parsedPdf: parsed.pdf,
      reindexOnly
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
    const [file, kbJob] = await Promise.all([
      KbFile.findByPk(fileId),
      KbJob.findByPk(kbJobId)
    ]);
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
    if (kbJob) {
      const preserveJobFailure = String(kbJob.status || '') === 'failed' && kbJob.lastErrorKey;
      if (!preserveJobFailure) {
        await kbJob.update({
          status: 'failed',
          lastErrorKey: fallbackErrorKey,
          lastError: error.message
        });
      }
    }
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
