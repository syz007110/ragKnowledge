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
  submitIngestTask,
  getJobStatus,
  normalizeFileExt,
  validateCollectionTags,
  listStandardTags,
  listTagAliases,
  approveTagAlias,
  rejectTagAlias
} = require('../services/kbService');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kbStorage = require('../config/kbStorage');

function safeUnlink(fp) {
  try {
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
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
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt') return 'txt';
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

    const ext = normalizeFileExt(fileName, fileExt);
    if (!['md', 'txt', 'docx'].includes(ext)) {
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

  try {
    kbStorage.ensureLocalDir();
    const uploadMode = String(req.body?.uploadMode || 'normal');
    const accepted = [];
    const reused = [];
    const failed = [];

    for (const file of uploadedFiles) {
      const originalName = normalizeUploadFileName(file.originalname) || path.basename(file.path);
      const ext = normalizeExtByFilename(originalName);
      if (!ext) {
        safeUnlink(file.path);
        failed.push({ fileName: originalName, reason: req.t('kb.fileExtUnsupported') });
        continue;
      }

      const contentSha256 = await sha256File(file.path);
      const safeBase = path.basename(originalName, path.extname(originalName)).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80) || 'kb';
      const finalName = `${safeBase}-${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(originalName).toLowerCase()}`;
      const finalPath = path.resolve(kbStorage.LOCAL_DIR, finalName);
      await fs.promises.rename(file.path, finalPath);

      const result = await submitIngestTask({
        collectionId,
        fileName: originalName,
        fileExt: ext,
        mimeType: file.mimetype || '',
        fileSize: file.size || 0,
        uploadMode,
        storageUri: `file://${finalPath}`,
        contentSha256,
        metadata: {
          source: 'upload',
          localPath: finalPath
        },
        user: req.user,
        locale: req.locale
      });

      if (result.rejected) {
        safeUnlink(finalPath);
        failed.push({ fileName: originalName, reason: req.t(result.reasonKey) });
        continue;
      }
      if (result.dedupReused) {
        safeUnlink(finalPath);
        reused.push({ fileName: originalName, file: result.file });
        continue;
      }
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
      failed
    });
  } catch (error) {
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
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ messageKey: 'kb.fileNotFound', message: req.t('kb.fileNotFound') });
    }
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    if (Number(file.fileSize || 0) > 0) {
      res.setHeader('Content-Length', String(file.fileSize));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`);
    return res.sendFile(localPath);
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
  createIngestTask,
  getTaskStatus,
  renameFileItem,
  deleteFileItem,
  rebuildFileItem,
  downloadFileItem,
  listStandardTagItems,
  listTagAliasItems,
  approveTagAliasItem,
  rejectTagAliasItem
};
