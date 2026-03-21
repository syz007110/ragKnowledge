const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbChunkAsset', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  chunkId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'chunk_id'
  },
  assetId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'asset_id'
  },
  relationType: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'inline',
    field: 'relation_type'
  },
  sortNo: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'sort_no'
  }
}, {
  tableName: 'kb_chunk_asset',
  underscored: true,
  timestamps: true,
  updatedAt: false
});
