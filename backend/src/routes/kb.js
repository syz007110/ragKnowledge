const express = require('express');
const { authMiddleware, requireKbPermission } = require('../middlewares/auth');
const { kbUploadMiddleware } = require('../middlewares/kbUpload');
const {
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
} = require('../controllers/kbController');

const router = express.Router();

router.use(authMiddleware);

router.get('/collections', requireKbPermission('kb:read'), getCollections);
router.get('/collections/:id', requireKbPermission('kb:read'), getCollectionItem);
router.post('/collections', requireKbPermission('kb:upload'), createCollectionItem);
router.put('/collections/:id', requireKbPermission('kb:upload'), updateCollectionItem);
router.delete('/collections/:id', requireKbPermission('kb:delete'), deleteCollectionItem);
router.get('/recycle-bin', requireKbPermission('kb:upload'), getRecycleBinItems);
router.post('/recycle-bin/restore', requireKbPermission('kb:upload'), restoreRecycleBinItems);
router.post('/recycle-bin/purge', requireKbPermission('kb:delete'), purgeRecycleBinItems);
router.get('/collections/:id/files', requireKbPermission('kb:read'), getCollectionFiles);
router.post('/collections/:id/files/upload', requireKbPermission('kb:upload'), kbUploadMiddleware, uploadCollectionFiles);

router.post('/ingest-tasks', requireKbPermission('kb:upload'), createIngestTask);
router.get('/ingest-tasks/:id', requireKbPermission('kb:read'), getTaskStatus);
router.get('/files/:id/download', requireKbPermission('kb:read'), downloadFileItem);
router.put('/files/:id', requireKbPermission('kb:upload'), renameFileItem);
router.delete('/files/:id', requireKbPermission('kb:delete'), deleteFileItem);
router.post('/files/:id/rebuild', requireKbPermission('kb:rebuild'), rebuildFileItem);
router.get('/tag-config/standards', requireKbPermission('kb:read'), listStandardTagItems);
router.get('/tag-config/aliases', requireKbPermission('kb:read'), listTagAliasItems);
router.post('/tag-config/aliases/:id/approve', requireKbPermission('kb:upload'), approveTagAliasItem);
router.post('/tag-config/aliases/:id/reject', requireKbPermission('kb:upload'), rejectTagAliasItem);

module.exports = router;
