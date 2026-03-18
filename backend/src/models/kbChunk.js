const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbChunk', {
  id: {
    type: DataTypes.BIGINT.UNSIGNED,
    primaryKey: true,
    autoIncrement: true
  },
  fileId: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'file_id'
  },
  chunkNo: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    field: 'chunk_no'
  },
  chunkText: {
    type: DataTypes.TEXT('medium'),
    allowNull: false,
    field: 'chunk_text'
  },
  tokenCount: {
    type: DataTypes.INTEGER.UNSIGNED,
    field: 'token_count'
  },
  charCount: {
    type: DataTypes.INTEGER.UNSIGNED,
    field: 'char_count'
  },
  startOffset: {
    type: DataTypes.INTEGER.UNSIGNED,
    field: 'start_offset'
  },
  endOffset: {
    type: DataTypes.INTEGER.UNSIGNED,
    field: 'end_offset'
  },
  chunkSha256: {
    type: DataTypes.STRING(64),
    allowNull: false,
    field: 'chunk_sha256'
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
  tableName: 'kb_chunk',
  underscored: true,
  timestamps: true
});
