const {
  listCollections,
  createCollection,
  getCollectionById,
  updateCollection,
  deleteCollection,
  listRecycleBinItems,
  restoreRecycleItems,
  submitRecyclePurgeJobs,
  listCollectionFilesPaged,
  deleteFile,
  renameFile,
  rebuildFile,
  getFileDownloadInfo,
  getFilePreviewData,
  getFileAssetBuffer,
  submitIngestTask,
  preparePresignedKbUpload,
  getJobStatus,
  retrievalDebug,
  retrievalSearch,
  normalizeFileExt,
  validateCollectionTags,
  listStandardTags,
  listTagAliases,
  approveTagAlias,
  rejectTagAlias
} = require('../services/kbService');
const { DEFAULT_RETRIEVAL_TOP_K, DEFAULT_RETRIEVAL_SEARCH_TOP_K } = require('../config/retrievalConstants');
const { toRetrievalSearchResponse } = require('../services/retrievalService');
const {
  validateForGenerate,
  generateFromReranked
} = require('../services/retrievalTestChatService');

const RETRIEVAL_TEST_GENERATE_TOP_K = 5;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kbStorage = require('../config/kbStorage');
const {
  buildStorageConfig,
  isS3Uri,
  buildS3Uri,
  buildUploadObjectKey,
  uploadLocalFile,
  getObjectBufferByUri,
  deleteObjectByUri,
  headObjectMeta
} = require('../services/objectStorageService');
const { hasKbPermission } = require('../middlewares/auth');
const {
  getOnlyofficeEditorBundle,
  isOnlyofficeEnabled
} = require('../services/kbOnlyofficeService');

function safeUnlink(fp) {
  try {
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) { }
}

function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(fp);
    s.on('error', reject);
    s.on('data', (buf) => h.update(buf));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function normalizeExtByFilename(name = '') {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt') return 'txt';
  if (ext === '.pdf') return 'pdf';
  return '';
}

function normalizeUploadFileName(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (/[^\u0000-\u00ff]/.test(raw)) {
    return raw;
  }
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8').trim();
    if (!decoded || decoded.includes('\uFFFD')) return raw;
    if (/[^\u0000-\u00ff]/.test(decoded)) return decoded;
    return raw;
  } catch (_) {
    return raw;
  }
}

function validateDirectIngestRequest({
  storageUri = '',
  rawText = ''
} = {}) {
  if (String(storageUri || '').trim()) {
    return {
      valid: false,
      reasonKey: 'kb.storageUriNotAllowed'
    };
  }
  if (!String(rawText || '').trim()) {
    return {
      valid: false,
      reasonKey: 'kb.rawTextRequired'
    };
  }
  return { valid: true };
}

async function cleanupStoredUpload({
  localPath = '',
  storageUri = '',
  unlinkFn = async (target) => safeUnlink(target),
  deleteObjectFn = deleteObjectByUri
} = {}) {
  if (localPath) {
    await unlinkFn(localPath);
    return;
  }
  if (isS3Uri(storageUri)) {
    await deleteObjectFn(storageUri);
  }
}

function removePendingStoredUpload(items = [], target = null) {
  const index = items.indexOf(target);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

async function getCollections(req, res, next) {
  try {
    const keyword = req.query.keyword || '';
    const collections = await listCollections({ keyword });
    return res.json({
      items: collections
    });
  } catch (error) {
    return next(error);
  }
}

async function createCollectionItem(req, res, next) {
  try {
    const { name = '', code = '', description = '', tags = [] } = req.body || {};
    if (!name.trim()) {
      return res.status(400).json({ messageKey: 'kb.collectionNameRequired', message: req.t('kb.collectionNameRequired') });
    }
    const tagValidation = validateCollectionTags(tags);
    if (!tagValidation.valid) {
      return res.status(400).json({
        messageKey: tagValidation.reasonKey,
        message: req.t(tagValidation.reasonKey)
      });
    }
    const finalCode = code.trim() || `kb_${Date.now()}`;

    const created = await createCollection({
      name,
      code: finalCode,
      description,
      tags,
      user: req.user
    });

    return res.status(201).json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      item: created
    });
  } catch (error) {
    return next(error);
  }
}

async function getCollectionItem(req, res, next) {
  try {
    const item = await getCollectionById(Number(req.params.id));
    if (!item) {
      return res.status(404).json({ messageKey: 'kb.collectionNotFound', message: req.t('kb.collectionNotFound') });
    }
    return res.json({ item });
  } catch (error) {
    return next(error);
  }
}

async function updateCollectionItem(req, res, next) {
  try {
    const { name = '', description = '', tags } = req.body || {};
    if (!name.trim()) {
      return res.status(400).json({ messageKey: 'kb.collectionNameRequired', message: req.t('kb.collectionNameRequired') });
    }
    if (Array.isArray(tags)) {
      const tagValidation = validateCollectionTags(tags);
      if (!tagValidation.valid) {
        return res.status(400).json({
          messageKey: tagValidation.reasonKey,
          message: req.t(tagValidation.reasonKey)
        });
      }
    }
    const item = await updateCollection({
      id: Number(req.params.id),
      name,
      description,
      tags,
      user: req.user
    });
    if (!item) {
      return res.status(404).json({ messageKey: 'kb.collectionNotFound', message: req.t('kb.collectionNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      item
    });
  } catch (error) {
    return next(error);
  }
}

async function listStandardTagItems(req, res, next) {
  try {
    const items = await listStandardTags({
      keyword: req.query.keyword || ''
    });
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
}

async function listTagAliasItems(req, res, next) {
  try {
    const items = await listTagAliases({
      keyword: req.query.keyword || '',
      status: req.query.status || ''
    });
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
}

async function approveTagAliasItem(req, res, next) {
  try {
    const alias = await approveTagAlias({
      aliasId: Number(req.params.id),
      targetTagName: req.body?.tagName || '',
      user: req.user
    });
    if (!alias) {
      return res.status(404).json({ messageKey: 'kb.tagAliasNotFound', message: req.t('kb.tagAliasNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success')
    });
  } catch (error) {
    return next(error);
  }
}

async function rejectTagAliasItem(req, res, next) {
  try {
    const alias = await rejectTagAlias({
      aliasId: Number(req.params.id),
      user: req.user
    });
    if (!alias) {
      return res.status(404).json({ messageKey: 'kb.tagAliasNotFound', message: req.t('kb.tagAliasNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success')
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteCollectionItem(req, res, next) {
  try {
    const item = await deleteCollection({
      id: Number(req.params.id),
      user: req.user
    });
    if (!item) {
      return res.status(404).json({ messageKey: 'kb.collectionNotFound', message: req.t('kb.collectionNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success')
    });
  } catch (error) {
    return next(error);
  }
}

async function getRecycleBinItems(req, res, next) {
  try {
    const result = await listRecycleBinItems({
      keyword: req.query.keyword || ''
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function restoreRecycleBinItems(req, res, next) {
  try {
    const result = await restoreRecycleItems({
      collectionIds: req.body?.collectionIds || [],
      fileIds: req.body?.fileIds || [],
      user: req.user,
      locale: req.locale
    });
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      result
    });
  } catch (error) {
    if (error.message === 'kb.recycle.collectionNotRestored') {
      return res.status(400).json({
        messageKey: 'kb.recycle.collectionNotRestored',
        message: req.t('kb.recycle.collectionNotRestored')
      });
    }
    return next(error);
  }
}

async function purgeRecycleBinItems(req, res, next) {
  try {
    const jobs = await submitRecyclePurgeJobs({
      collectionIds: req.body?.collectionIds || [],
      fileIds: req.body?.fileIds || [],
      user: req.user,
      locale: req.locale
    });
    return res.status(202).json({
      messageKey: 'kb.recycle.purgeQueued',
      message: req.t('kb.recycle.purgeQueued'),
      jobs: jobs.map((item) => ({
        id: item.id,
        bizType: item.bizType,
        bizId: item.bizId,
        status: item.status
      }))
    });
  } catch (error) {
    return next(error);
  }
}

async function getCollectionFiles(req, res, next) {
  try {
    const collectionId = Number(req.params.id);
    const {
      status = '',
      fileType = '',
      keyword = '',
      page = 1,
      pageSize = 20,
      sortBy = 'createdAt',
      sortOrder = 'DESC'
    } = req.query;
    const result = await listCollectionFilesPaged({
      collectionId,
      status,
      fileType,
      keyword,
      page,
      pageSize,
      sortBy,
      sortOrder
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function initPresignedUploadItem(req, res, next) {
  try {
    const collectionId = Number(req.params.id);
    const {
      fileName = '',
      contentSha256 = '',
      fileSize = 0,
      mimeType = '',
      uploadMode = 'normal'
    } = req.body || {};

    const normalizedFileName = normalizeUploadFileName(fileName);
    if (!normalizedFileName) {
      return res.status(400).json({ messageKey: 'kb.fileNameRequired', message: req.t('kb.fileNameRequired') });
    }

    const result = await preparePresignedKbUpload({
      collectionId,
      fileName: normalizedFileName,
      contentSha256,
      fileSize,
      mimeType,
      uploadMode
    });

    if (result.rejected) {
      return res.status(400).json({
        messageKey: result.reasonKey,
        message: req.t(result.reasonKey)
      });
    }

    if (result.dedupReused) {
      return res.status(200).json({
        messageKey: 'kb.dedupReused',
        message: req.t('kb.dedupReused'),
        dedupReused: true,
        file: result.file
      });
    }

    if (result.recycleRestoreMatch) {
      return res.status(200).json({
        messageKey: 'kb.recycleRestoreMatch',
        message: req.t('kb.recycleRestoreMatch'),
        recycleRestoreMatch: true,
        deletedFile: result.deletedFile,
        collectionDeleted: result.collectionDeleted,
        collection: result.collection
      });
    }

    return res.status(200).json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      objectKey: result.objectKey,
      storageUri: result.storageUri,
      uploadUrl: result.uploadUrl,
      method: result.method,
      headers: result.headers,
      expiresIn: result.expiresIn
    });
  } catch (error) {
    return next(error);
  }
}

async function completePresignedUploadItem(req, res, next) {
  try {
    const collectionId = Number(req.params.id);
    const {
      objectKey = '',
      contentSha256 = '',
      fileName = '',
      fileSize = 0,
      mimeType = '',
      uploadMode = 'normal',
      metadata = {}
    } = req.body || {};

    const key = String(objectKey || '').trim();
    const expectedPrefix = `kb/${collectionId}/`;
    if (!key.startsWith(expectedPrefix) || key.includes('..')) {
      return res.status(400).json({
        messageKey: 'kb.presignObjectKeyInvalid',
        message: req.t('kb.presignObjectKeyInvalid')
      });
    }

    const trimmedName = normalizeUploadFileName(fileName);
    if (!trimmedName) {
      return res.status(400).json({ messageKey: 'kb.fileNameRequired', message: req.t('kb.fileNameRequired') });
    }

    const hash = String(contentSha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      return res.status(400).json({
        messageKey: 'kb.contentSha256Invalid',
        message: req.t('kb.contentSha256Invalid')
      });
    }

    const size = Number(fileSize);
    if (!Number.isFinite(size) || size < 1) {
      return res.status(400).json({ messageKey: 'kb.uploadLimitExceeded', message: req.t('kb.uploadLimitExceeded') });
    }
    if (size > kbStorage.MAX_FILE_SIZE) {
      return res.status(400).json({ messageKey: 'kb.uploadLimitExceeded', message: req.t('kb.uploadLimitExceeded') });
    }

    const cfg = buildStorageConfig();
    if (!cfg.enabled) {
      return res.status(400).json({
        messageKey: 'kb.presignRequiresObjectStorage',
        message: req.t('kb.presignRequiresObjectStorage')
      });
    }

    let headMeta;
    try {
      headMeta = await headObjectMeta(key);
    } catch (error) {
      if (error?.message === 'kb.presignObjectMissing' || error?.code === 'kb.presignObjectMissing') {
        return res.status(400).json({
          messageKey: 'kb.presignObjectMissing',
          message: req.t('kb.presignObjectMissing')
        });
      }
      throw error;
    }

    if (headMeta.contentLength !== size) {
      return res.status(400).json({
        messageKey: 'kb.presignSizeMismatch',
        message: req.t('kb.presignSizeMismatch')
      });
    }

    const ext = normalizeFileExt(trimmedName, '');
    if (!['md', 'txt', 'docx', 'xlsx', 'pdf'].includes(ext)) {
      return res.status(400).json({ messageKey: 'kb.fileExtUnsupported', message: req.t('kb.fileExtUnsupported') });
    }

    const storageUri = buildS3Uri(cfg.bucket, key);

    const result = await submitIngestTask({
      collectionId,
      fileName: trimmedName,
      fileExt: ext,
      mimeType,
      fileSize: size,
      uploadMode,
      storageUri,
      contentSha256: hash,
      rawText: '',
      metadata,
      user: req.user,
      locale: req.locale
    });

    if (result.rejected) {
      return res.status(400).json({
        messageKey: result.reasonKey,
        message: req.t(result.reasonKey)
      });
    }

    if (result.dedupReused) {
      await deleteObjectByUri(storageUri);
      return res.status(200).json({
        messageKey: 'kb.dedupReused',
        message: req.t('kb.dedupReused'),
        dedupReused: true,
        file: result.file
      });
    }

    if (result.recycleRestoreMatch) {
      await deleteObjectByUri(storageUri);
      return res.status(200).json({
        messageKey: 'kb.recycleRestoreMatch',
        message: req.t('kb.recycleRestoreMatch'),
        recycleRestoreMatch: true,
        deletedFile: result.deletedFile,
        collectionDeleted: result.collectionDeleted,
        collection: result.collection
      });
    }

    return res.status(202).json({
      messageKey: 'kb.ingestAccepted',
      message: req.t('kb.ingestAccepted'),
      file: result.file,
      job: result.jobRecord,
      queueJobId: result.queueJobId
    });
  } catch (error) {
    return next(error);
  }
}

async function createIngestTask(req, res, next) {
  try {
    const {
      collectionId,
      fileName = '',
      fileExt = '',
      mimeType = '',
      fileSize = 0,
      uploadMode = 'normal',
      storageUri = '',
      rawText = '',
      metadata = {}
    } = req.body || {};

    if (!collectionId) {
      return res.status(400).json({ messageKey: 'kb.collectionIdRequired', message: req.t('kb.collectionIdRequired') });
    }
    if (!fileName.trim()) {
      return res.status(400).json({ messageKey: 'kb.fileNameRequired', message: req.t('kb.fileNameRequired') });
    }
    const validation = validateDirectIngestRequest({
      storageUri,
      rawText
    });
    if (!validation.valid) {
      return res.status(400).json({
        messageKey: validation.reasonKey,
        message: req.t(validation.reasonKey)
      });
    }

    const ext = normalizeFileExt(fileName, fileExt);
    if (!['md', 'txt', 'docx', 'xlsx', 'pdf'].includes(ext)) {
      return res.status(400).json({ messageKey: 'kb.fileExtUnsupported', message: req.t('kb.fileExtUnsupported') });
    }

    const result = await submitIngestTask({
      collectionId: Number(collectionId),
      fileName,
      fileExt: ext,
      mimeType,
      fileSize,
      uploadMode,
      storageUri,
      rawText,
      metadata,
      user: req.user,
      locale: req.locale
    });

    if (result.rejected) {
      return res.status(400).json({
        messageKey: result.reasonKey,
        message: req.t(result.reasonKey)
      });
    }

    if (result.dedupReused) {
      return res.status(200).json({
        messageKey: 'kb.dedupReused',
        message: req.t('kb.dedupReused'),
        dedupReused: true,
        file: result.file
      });
    }

    if (result.recycleRestoreMatch) {
      return res.status(200).json({
        messageKey: 'kb.recycleRestoreMatch',
        message: req.t('kb.recycleRestoreMatch'),
        recycleRestoreMatch: true,
        deletedFile: result.deletedFile,
        collectionDeleted: result.collectionDeleted,
        collection: result.collection
      });
    }

    return res.status(202).json({
      messageKey: 'kb.ingestAccepted',
      message: req.t('kb.ingestAccepted'),
      file: result.file,
      job: result.jobRecord,
      queueJobId: result.queueJobId
    });
  } catch (error) {
    return next(error);
  }
}

async function retrievalDebugItem(req, res, next) {
  try {
    const body = req.body || {};
    const {
      collectionId,
      query = '',
      keywords = [],
      esTopK = DEFAULT_RETRIEVAL_TOP_K,
      vecTopK = DEFAULT_RETRIEVAL_TOP_K,
      fuseTopK = DEFAULT_RETRIEVAL_TOP_K
    } = body;
    const generate = Boolean(body.generate);

    if (!collectionId) {
      return res.status(400).json({ messageKey: 'kb.collectionIdRequired', message: req.t('kb.collectionIdRequired') });
    }
    if (!String(query || '').trim()) {
      return res.status(400).json({ messageKey: 'kb.queryRequired', message: req.t('kb.queryRequired') });
    }

    let es = Number(esTopK) || DEFAULT_RETRIEVAL_TOP_K;
    let vec = Number(vecTopK) || DEFAULT_RETRIEVAL_TOP_K;
    let fuse = Number(fuseTopK) || DEFAULT_RETRIEVAL_TOP_K;
    let chatConfig = null;

    if (generate) {
      const cfg = validateForGenerate();
      if (!cfg.ok) {
        return res.status(400).json({
          messageKey: cfg.messageKey,
          message: req.t(cfg.messageKey)
        });
      }
      chatConfig = cfg.config;
      es = RETRIEVAL_TEST_GENERATE_TOP_K;
      vec = RETRIEVAL_TEST_GENERATE_TOP_K;
      fuse = RETRIEVAL_TEST_GENERATE_TOP_K;
    }

    const result = await retrievalDebug({
      collectionId: Number(collectionId),
      query: String(query || ''),
      keywords: normalizeKeywordsInput(keywords),
      esTopK: es,
      vecTopK: vec,
      fuseTopK: fuse
    });

    if (generate && chatConfig) {
      const gen = await generateFromReranked({
        query: String(query || ''),
        reranked: result.reranked,
        config: chatConfig
      });
      if (!gen.ok) {
        result.generation = {
          error: true,
          messageKey: gen.messageKey,
          message: req.t(gen.messageKey),
          ...(gen.upstreamStatus != null ? { upstreamStatus: gen.upstreamStatus } : {}),
          ...(gen.detail ? { detail: gen.detail } : {})
        };
      } else {
        result.generation = {
          answer: gen.answer,
          model: gen.model,
          timingMs: gen.timingMs,
          ...(gen.usage ? { usage: gen.usage } : {})
        };
      }
    }

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

function clampRetrievalSearchTopK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRIEVAL_SEARCH_TOP_K;
  return Math.min(5, Math.max(1, Math.floor(parsed)));
}

function normalizeKeywordsInput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

async function retrievalSearchItem(req, res, next) {
  try {
    const body = req.body || {};
    const {
      collectionId,
      query = '',
      keywords = [],
      esTopK = DEFAULT_RETRIEVAL_SEARCH_TOP_K,
      vecTopK = DEFAULT_RETRIEVAL_SEARCH_TOP_K,
      fuseTopK = DEFAULT_RETRIEVAL_SEARCH_TOP_K
    } = body;
    const generate = Boolean(body.generate);

    if (!collectionId) {
      return res.status(400).json({ messageKey: 'kb.collectionIdRequired', message: req.t('kb.collectionIdRequired') });
    }
    if (!String(query || '').trim()) {
      return res.status(400).json({ messageKey: 'kb.queryRequired', message: req.t('kb.queryRequired') });
    }

    if (generate) {
      const cfg = validateForGenerate();
      if (!cfg.ok) {
        return res.status(400).json({
          messageKey: cfg.messageKey,
          message: req.t(cfg.messageKey)
        });
      }
      const chatConfig = cfg.config;
      const k = RETRIEVAL_TEST_GENERATE_TOP_K;
      const debugResult = await retrievalDebug({
        collectionId: Number(collectionId),
        query: String(query || ''),
        keywords: normalizeKeywordsInput(keywords),
        esTopK: k,
        vecTopK: k,
        fuseTopK: k
      });
      const result = toRetrievalSearchResponse(debugResult, { limit: k });
      const gen = await generateFromReranked({
        query: String(query || ''),
        reranked: debugResult.reranked,
        config: chatConfig
      });
      if (!gen.ok) {
        result.generation = {
          error: true,
          messageKey: gen.messageKey,
          message: req.t(gen.messageKey),
          ...(gen.upstreamStatus != null ? { upstreamStatus: gen.upstreamStatus } : {}),
          ...(gen.detail ? { detail: gen.detail } : {})
        };
      } else {
        result.generation = {
          answer: gen.answer,
          model: gen.model,
          timingMs: gen.timingMs,
          ...(gen.usage ? { usage: gen.usage } : {})
        };
      }
      return res.json(result);
    }

    const safeTopK = clampRetrievalSearchTopK(fuseTopK);
    const result = await retrievalSearch({
      collectionId: Number(collectionId),
      query: String(query || ''),
      keywords: normalizeKeywordsInput(keywords),
      esTopK: clampRetrievalSearchTopK(esTopK),
      vecTopK: clampRetrievalSearchTopK(vecTopK),
      fuseTopK: safeTopK
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function uploadCollectionFiles(req, res, next) {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const collectionId = Number(req.params.id);
  if (!Number.isFinite(collectionId) || collectionId <= 0) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.status(400).json({ messageKey: 'kb.collectionIdRequired', message: req.t('kb.collectionIdRequired') });
  }
  if (!uploadedFiles.length) {
    return res.status(400).json({ messageKey: 'kb.fileNameRequired', message: req.t('kb.fileNameRequired') });
  }
  if (uploadedFiles.length > kbStorage.BATCH_MAX_FILES) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.status(400).json({ messageKey: 'kb.uploadLimitExceeded', message: req.t('kb.uploadLimitExceeded') });
  }
  const batchTotalBytes = uploadedFiles.reduce((sum, current) => sum + Number(current?.size || 0), 0);
  if (batchTotalBytes > kbStorage.BATCH_MAX_TOTAL_SIZE) {
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return res.status(400).json({ messageKey: 'kb.uploadLimitExceeded', message: req.t('kb.uploadLimitExceeded') });
  }
  const pendingStoredUploads = [];

  try {
    kbStorage.ensureLocalDir();
    const objectStorageConfig = buildStorageConfig();
    const uploadMode = String(req.body?.uploadMode || 'normal');
    const accepted = [];
    const reused = [];
    const failed = [];
    const recycleRestoreMatches = [];

    for (const file of uploadedFiles) {
      const originalName = normalizeUploadFileName(file.originalname) || path.basename(file.path);
      const ext = normalizeExtByFilename(originalName);
      if (!ext) {
        safeUnlink(file.path);
        failed.push({ fileName: originalName, reason: req.t('kb.fileExtUnsupported') });
        continue;
      }

      const stageStartAt = Date.now();
      const contentSha256 = await sha256File(file.path);
      console.log('[KB上传] hash_done', {
        fileName: originalName,
        size: Number(file.size || 0),
        elapsedMs: Date.now() - stageStartAt
      });
      let storageUri = '';
      let localPath = '';
      let storedUpload = null;
      const storageStartAt = Date.now();
      if (objectStorageConfig.enabled) {
        const objectKey = buildUploadObjectKey({
          collectionId,
          fileName: originalName
        });
        storageUri = await uploadLocalFile({
          localPath: file.path,
          objectKey,
          contentType: file.mimetype || ''
        });
        safeUnlink(file.path);
        console.log('[KB上传] minio_done', {
          fileName: originalName,
          storageUri,
          elapsedMs: Date.now() - storageStartAt
        });
      } else {
        const safeBase = path.basename(originalName, path.extname(originalName)).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || 'kb';
        const finalName = `${safeBase}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(originalName).toLowerCase()}`;
        const finalPath = path.resolve(kbStorage.LOCAL_DIR, finalName);
        await fs.promises.rename(file.path, finalPath);
        storageUri = `file://${finalPath}`;
        localPath = finalPath;
        console.log('[KB上传] local_store_done', {
          fileName: originalName,
          storageUri,
          elapsedMs: Date.now() - storageStartAt
        });
      }
      storedUpload = { storageUri, localPath };
      pendingStoredUploads.push(storedUpload);

      const enqueueStartAt = Date.now();
      const result = await submitIngestTask({
        collectionId,
        fileName: originalName,
        fileExt: ext,
        mimeType: file.mimetype || '',
        fileSize: file.size || 0,
        uploadMode,
        storageUri,
        contentSha256,
        metadata: {
          source: 'upload',
          localPath
        },
        user: req.user,
        locale: req.locale
      });
      console.log('[KB上传] enqueued', {
        fileName: originalName,
        elapsedMs: Date.now() - enqueueStartAt,
        totalElapsedMs: Date.now() - stageStartAt,
        dedupReused: Boolean(result?.dedupReused),
        rejected: Boolean(result?.rejected),
        taskId: Number(result?.jobRecord?.id || 0),
        queueJobId: String(result?.queueJobId || '')
      });

      if (result.rejected) {
        await cleanupStoredUpload(storedUpload);
        removePendingStoredUpload(pendingStoredUploads, storedUpload);
        failed.push({ fileName: originalName, reason: req.t(result.reasonKey) });
        continue;
      }
      if (result.dedupReused) {
        await cleanupStoredUpload(storedUpload);
        removePendingStoredUpload(pendingStoredUploads, storedUpload);
        reused.push({ fileName: originalName, file: result.file });
        continue;
      }
      if (result.recycleRestoreMatch) {
        await cleanupStoredUpload(storedUpload);
        removePendingStoredUpload(pendingStoredUploads, storedUpload);
        recycleRestoreMatches.push({
          fileName: originalName,
          deletedFile: result.deletedFile,
          collectionDeleted: result.collectionDeleted,
          collection: result.collection
        });
        continue;
      }
      removePendingStoredUpload(pendingStoredUploads, storedUpload);
      accepted.push({
        fileName: originalName,
        file: result.file,
        job: result.jobRecord,
        queueJobId: result.queueJobId
      });
    }

    return res.status(202).json({
      messageKey: 'kb.ingestAccepted',
      message: req.t('kb.ingestAccepted'),
      accepted,
      reused,
      failed,
      ...(recycleRestoreMatches.length ? { recycleRestoreMatches } : {})
    });
  } catch (error) {
    await Promise.allSettled(pendingStoredUploads.map((item) => cleanupStoredUpload(item)));
    uploadedFiles.forEach((f) => safeUnlink(f.path));
    return next(error);
  }
}

async function getTaskStatus(req, res, next) {
  try {
    const { id } = req.params;
    const jobStatus = await getJobStatus(Number(id));
    if (!jobStatus) {
      return res.status(404).json({ messageKey: 'kb.jobNotFound', message: req.t('kb.jobNotFound') });
    }

    return res.json({
      taskId: jobStatus.dbJob.id,
      dbStatus: jobStatus.dbJob.status,
      queueState: jobStatus.queueState,
      queueProgress: jobStatus.queueProgress,
      failedReason: jobStatus.queueFailedReason || jobStatus.dbJob.lastError || null,
      payload: jobStatus.dbJob.payloadJson || {}
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteFileItem(req, res, next) {
  try {
    const file = await deleteFile({
      id: Number(req.params.id),
      user: req.user
    });
    if (!file) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success')
    });
  } catch (error) {
    if (error.message === 'kb.fileBusyProcessing') {
      return res.status(409).json({
        messageKey: 'kb.fileBusyProcessing',
        message: req.t('kb.fileBusyProcessing')
      });
    }
    return next(error);
  }
}

async function rebuildFileItem(req, res, next) {
  try {
    const result = await rebuildFile({
      id: Number(req.params.id),
      user: req.user,
      locale: req.locale
    });
    if (!result) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    return res.status(202).json({
      messageKey: 'kb.ingestAccepted',
      message: req.t('kb.ingestAccepted'),
      file: result.file,
      job: result.jobRecord,
      queueJobId: result.queueJobId
    });
  } catch (error) {
    if (error.message === 'kb.fileBusyProcessing') {
      return res.status(409).json({
        messageKey: 'kb.fileBusyProcessing',
        message: req.t('kb.fileBusyProcessing')
      });
    }
    return next(error);
  }
}

async function renameFileItem(req, res, next) {
  try {
    const nextName = String(req.body?.fileName || '').trim();
    if (!nextName) {
      return res.status(400).json({ messageKey: 'kb.fileNameRequired', message: req.t('kb.fileNameRequired') });
    }
    const file = await renameFile({
      id: Number(req.params.id),
      fileName: nextName,
      user: req.user
    });
    if (!file) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      file
    });
  } catch (error) {
    if (error.message === 'kb.fileBusyProcessing') {
      return res.status(409).json({
        messageKey: 'kb.fileBusyProcessing',
        message: req.t('kb.fileBusyProcessing')
      });
    }
    if (error.message === 'kb.fileNameDuplicated') {
      return res.status(400).json({ messageKey: 'kb.fileNameDuplicated', message: req.t('kb.fileNameDuplicated') });
    }
    if (error.message === 'kb.fileExtUnsupported') {
      return res.status(400).json({ messageKey: 'kb.fileExtUnsupported', message: req.t('kb.fileExtUnsupported') });
    }
    return next(error);
  }
}

function buildAsciiFileName(name = '') {
  return String(name || 'download')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180) || 'download';
}

async function previewFileItem(req, res, next) {
  try {
    const result = await getFilePreviewData({ id: Number(req.params.id) });
    if (result.error === 'not_found') {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      data: result
    });
  } catch (error) {
    return next(error);
  }
}

async function getOnlyofficeEditorConfigItem(req, res, next) {
  try {
    const mode = String(req.query.mode || 'view').toLowerCase() === 'edit' ? 'edit' : 'view';
    if (mode === 'edit' && !hasKbPermission(req.user, 'kb:upload')) {
      return res.status(403).json({ messageKey: 'auth.forbidden', message: req.t('auth.forbidden') });
    }
    if (!isOnlyofficeEnabled()) {
      return res.status(503).json({
        messageKey: 'kb.onlyofficeDisabled',
        message: req.t('kb.onlyofficeDisabled')
      });
    }
    const data = await getOnlyofficeEditorBundle({
      fileId: Number(req.params.id),
      user: req.user,
      mode
    });
    return res.json({
      messageKey: 'common.success',
      message: req.t('common.success'),
      data
    });
  } catch (error) {
    if (error.message === 'kb.fileNotFound') {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    if (error.message === 'kb.onlyofficeUnsupportedType') {
      return res.status(400).json({
        messageKey: 'kb.onlyofficeUnsupportedType',
        message: req.t('kb.onlyofficeUnsupportedType')
      });
    }
    if (error.message === 'kb.onlyofficeJwtSecretMissing') {
      return res.status(503).json({
        messageKey: 'kb.onlyofficeDisabled',
        message: req.t('kb.onlyofficeDisabled')
      });
    }
    return next(error);
  }
}

async function downloadFileAssetItem(req, res, next) {
  try {
    const result = await getFileAssetBuffer({
      fileId: Number(req.params.id),
      assetId: Number(req.params.assetId)
    });
    if (!result) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (result.buffer?.length) {
      res.setHeader('Content-Length', String(result.buffer.length));
    }
    return res.send(result.buffer);
  } catch (error) {
    return next(error);
  }
}

async function downloadFileItem(req, res, next) {
  try {
    const result = await getFileDownloadInfo({
      id: Number(req.params.id)
    });
    if (!result) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    const { file, localPath } = result;
    const encodedFileName = encodeURIComponent(String(file.fileName || 'download'));
    const asciiFileName = buildAsciiFileName(file.fileName || 'download');
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    if (Number(file.fileSize || 0) > 0) {
      res.setHeader('Content-Length', String(file.fileSize));
    }
    const inline = String(req.query?.inline || req.query?.preview || '') === '1';
    res.setHeader(
      'Content-Disposition',
      inline
        ? `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`
        : `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`
    );
    if (localPath) {
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
      }
      return res.sendFile(localPath);
    }
    if (isS3Uri(file.storageUri)) {
      const buffer = await getObjectBufferByUri(file.storageUri);
      return res.send(buffer);
    }
    return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
  } catch (error) {
    if (error.message === 'kb.fileNotFound') {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    return next(error);
  }
}

module.exports = {
  getCollections,
  createCollectionItem,
  getCollectionItem,
  updateCollectionItem,
  deleteCollectionItem,
  getRecycleBinItems,
  restoreRecycleBinItems,
  purgeRecycleBinItems,
  getCollectionFiles,
  uploadCollectionFiles,
  initPresignedUploadItem,
  completePresignedUploadItem,
  createIngestTask,
  retrievalDebugItem,
  retrievalSearchItem,
  getTaskStatus,
  renameFileItem,
  deleteFileItem,
  rebuildFileItem,
  downloadFileItem,
  downloadFileAssetItem,
  previewFileItem,
  getOnlyofficeEditorConfigItem,
  listStandardTagItems,
  listTagAliasItems,
  approveTagAliasItem,
  rejectTagAliasItem,
  validateDirectIngestRequest,
  cleanupStoredUpload
};
