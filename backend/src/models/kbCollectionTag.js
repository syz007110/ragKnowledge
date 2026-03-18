const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbCollectionTag', {
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
  tagId: {
    type: DataTypes.BIGINT,
    field: 'tag_id'
  },
  aliasId: {
    type: DataTypes.BIGINT,
    field: 'alias_id'
  },
  createdBy: {
    type: DataTypes.BIGINT,
    field: 'created_by'
  }
}, {
  tableName: 'kb_collection_tag',
  underscored: true,
  timestamps: false
});
