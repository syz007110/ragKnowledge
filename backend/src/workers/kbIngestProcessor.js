const fs = require('fs/promises');
const path = require('path');
const { runIngestPipeline, normalizeFileExt } = require('../services/kbService');
const { KbFile, KbJob } = require('../models');

let mammoth = null;
try {
  // Optional runtime dependency for docx parsing.
  mammoth = require('mammoth');
} catch (error) {
  mammoth = null;
}

async function extractRawText(payload) {
  if (payload.rawText && String(payload.rawText).trim()) {
    return String(payload.rawText);
  }
  const file = await KbFile.findByPk(payload.fileId);
  if (!file) return '';

  const ext = normalizeFileExt(file.fileName, file.fileExt);
  const storageUri = String(file.storageUri || '');
  const localPath = storageUri.startsWith('file://')
    ? storageUri.replace('file://', '')
    : storageUri;

  if (!localPath || localPath.startsWith('kb://')) {
    return '';
  }
  const absPath = path.isAbsolute(localPath)
    ? localPath
    : path.resolve(process.cwd(), localPath);

  if (ext === 'docx') {
    if (!mammoth) {
      const kbJob = await KbJob.findByPk(payload.kbJobId);
      if (kbJob) {
        await kbJob.update({
          status: 'failed',
          lastErrorKey: 'kb.parser.docxUnavailable',
          lastError: 'mammoth_missing'
        });
      }
      throw new Error('kb.parser.docxUnavailable');
    }
    const result = await mammoth.extractRawText({ path: absPath });
    return result.value || '';
  }

  return fs.readFile(absPath, 'utf8');
}

async function processKbIngestJob(job) {
  const { fileId, kbJobId } = job.data;
  console.log(`[KB处理器] processing queueJob=${job.id}, file=${fileId}, kbJob=${kbJobId}`);
  try {
    await job.progress(10);
    const rawText = await extractRawText(job.data);
    await job.progress(45);

    const result = await runIngestPipeline({
      fileId,
      kbJobId,
      rawText
    });

    await job.progress(100);
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
    const parserErrorKey = error.message === 'kb.parser.docxUnavailable' ? 'kb.parser.docxUnavailable' : null;
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
    throw error;
  }
}

module.exports = {
  processKbIngestJob
};
