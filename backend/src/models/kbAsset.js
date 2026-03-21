const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbAsset', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  fileId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'file_id'
  },
  assetType: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'image',
    field: 'asset_type'
  },
  storageUri: {
    type: DataTypes.STRING(500),
    allowNull: false,
    field: 'storage_uri'
  },
  mimeType: {
    type: DataTypes.STRING(128),
    field: 'mime_type'
  },
  assetSha256: {
    type: DataTypes.STRING(64),
    field: 'asset_sha256'
  },
  width: {
    type: DataTypes.INTEGER
  },
  height: {
    type: DataTypes.INTEGER
  },
  sourcePageNo: {
    type: DataTypes.INTEGER,
    field: 'source_page_no'
  },
  sourceRef: {
    type: DataTypes.STRING(128),
    field: 'source_ref'
  },
  metaJson: {
    type: DataTypes.JSON,
    field: 'meta_json'
  },
  isDeleted: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0,
    field: 'is_deleted'
  },
  deletedAt: {
    type: DataTypes.DATE,
    field: 'deleted_at'
  }
}, {
  tableName: 'kb_asset',
  underscored: true,
  timestamps: true
});
