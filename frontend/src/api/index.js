import http from './http';

export default {
  auth: {
    login(payload) {
      return http.post('/api/auth/login', payload);
    },
    me() {
      return http.get('/api/auth/me');
    }
  },
  kb: {
    getStatus() {
      return http.get('/health');
    },
    getCollections(params = {}) {
      return http.get('/api/kb/collections', { params });
    },
    getCollection(collectionId) {
      return http.get(`/api/kb/collections/${collectionId}`);
    },
    createCollection(payload) {
      return http.post('/api/kb/collections', payload);
    },
    updateCollection(collectionId, payload) {
      return http.put(`/api/kb/collections/${collectionId}`, payload);
    },
    deleteCollection(collectionId) {
      return http.delete(`/api/kb/collections/${collectionId}`);
    },
    getRecycleBin(params = {}) {
      return http.get('/api/kb/recycle-bin', { params });
    },
    restoreRecycleBin(payload) {
      return http.post('/api/kb/recycle-bin/restore', payload);
    },
    purgeRecycleBin(payload) {
      return http.post('/api/kb/recycle-bin/purge', payload);
    },
    getCollectionFiles(collectionId, params = {}) {
      return http.get(`/api/kb/collections/${collectionId}/files`, { params });
    },
    uploadCollectionFiles(collectionId, formData) {
      return http.post(`/api/kb/collections/${collectionId}/files/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
    },
    createIngestTask(payload) {
      return http.post('/api/kb/ingest-tasks', payload);
    },
    getTaskStatus(taskId) {
      return http.get(`/api/kb/ingest-tasks/${taskId}`);
    },
    downloadFile(fileId) {
      return http.get(`/api/kb/files/${fileId}/download`, {
        responseType: 'blob'
      });
    },
    renameFile(fileId, payload) {
      return http.put(`/api/kb/files/${fileId}`, payload);
    },
    deleteFile(fileId) {
      return http.delete(`/api/kb/files/${fileId}`);
    },
    rebuildFile(fileId) {
      return http.post(`/api/kb/files/${fileId}/rebuild`);
    },
    getStandardTags(params = {}) {
      return http.get('/api/kb/tag-config/standards', { params });
    },
    getTagAliases(params = {}) {
      return http.get('/api/kb/tag-config/aliases', { params });
    },
    approveTagAlias(aliasId, payload = {}) {
      return http.post(`/api/kb/tag-config/aliases/${aliasId}/approve`, payload);
    },
    rejectTagAlias(aliasId) {
      return http.post(`/api/kb/tag-config/aliases/${aliasId}/reject`);
    }
  }
};
