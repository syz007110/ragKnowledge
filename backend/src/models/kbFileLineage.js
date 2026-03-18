const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbFileLineage', {
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
  sourceFileId: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'source_file_id'
  },
  derivedFileId: {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: false,
    field: 'derived_file_id'
  },
  relationType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'relation_type'
  },
  createdBy: {
    type: DataTypes.BIGINT.UNSIGNED,
    field: 'created_by'
  }
}, {
  tableName: 'kb_file_lineage',
  underscored: true,
  timestamps: false
});
