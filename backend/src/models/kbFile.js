const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbFile', {
  id: {
    type: DataTypes.BIGINT.UNSIGNED,
    primaryKey: true,
    autoIncrement: true
  },
  collectionId: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'collection_id'
  },
  fileName: {
    type: DataTypes.STRING(255),
    allowNull: false,
    field: 'file_name'
  },
  fileExt: {
    type: DataTypes.STRING(16),
    allowNull: false,
    field: 'file_ext'
  },
  mimeType: {
    type: DataTypes.STRING(128),
    field: 'mime_type'
  },
  fileSize: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
    field: 'file_size'
  },
  storageUri: {
    type: DataTypes.STRING(500),
    allowNull: false,
    field: 'storage_uri'
  },
  contentSha256: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'content_sha256'
  },
  ragflowDocumentId: {
    type: DataTypes.STRING(128),
    field: 'ragflow_document_id'
  },
  uploadMode: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'normal',
    field: 'upload_mode'
  },
  versionNo: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 1,
    field: 'version_no'
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'uploaded'
  },
  errorMessageKey: {
    type: DataTypes.STRING(128),
    field: 'error_message_key'
  },
  errorMessage: {
    type: DataTypes.STRING(1000),
    field: 'error_message'
  },
  isDeleted: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0,
    field: 'is_deleted'
  },
  createdBy: {
    type: DataTypes.BIGINT.UNSIGNED,
    field: 'created_by'
  },
  updatedBy: {
    type: DataTypes.BIGINT.UNSIGNED,
    field: 'updated_by'
  },
  deletedAt: {
    type: DataTypes.DATE,
    field: 'deleted_at'
  }
}, {
  tableName: 'kb_file',
  underscored: true,
  timestamps: true
});
