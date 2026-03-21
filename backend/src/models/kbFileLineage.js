const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbFileLineage', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  collectionId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'collection_id'
  },
  sourceFileId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'source_file_id'
  },
  derivedFileId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'derived_file_id'
  },
  relationType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'relation_type'
  },
  createdBy: {
    type: DataTypes.BIGINT,
    field: 'created_by'
  }
}, {
  tableName: 'kb_file_lineage',
  underscored: true,
  timestamps: false
});
