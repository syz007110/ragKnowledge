const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbChunkIndexState', {
  id: {
    type: DataTypes.BIGINT.UNSIGNED,
    primaryKey: true,
    autoIncrement: true
  },
  chunkId: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'chunk_id'
  },
  esDocId: {
    type: DataTypes.STRING(128),
    field: 'es_doc_id'
  },
  esStatus: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'pending',
    field: 'es_status'
  },
  esUpdatedAt: {
    type: DataTypes.DATE,
    field: 'es_updated_at'
  },
  vectorDocId: {
    type: DataTypes.STRING(128),
    field: 'vector_doc_id'
  },
  vectorStatus: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'pending',
    field: 'vector_status'
  },
  vectorUpdatedAt: {
    type: DataTypes.DATE,
    field: 'vector_updated_at'
  },
  lastErrorKey: {
    type: DataTypes.STRING(128),
    field: 'last_error_key'
  },
  lastError: {
    type: DataTypes.STRING(1000),
    field: 'last_error'
  }
}, {
  tableName: 'kb_chunk_index_state',
  underscored: true,
  timestamps: true
});
