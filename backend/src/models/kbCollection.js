const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbCollection', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(128),
    allowNull: false
  },
  code: {
    type: DataTypes.STRING(64),
    allowNull: false
  },
  description: {
    type: DataTypes.STRING(500)
  },
  ragflowDatasetId: {
    type: DataTypes.STRING(128),
    field: 'ragflow_dataset_id'
  },
  status: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 1
  },
  isDeleted: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0,
    field: 'is_deleted'
  },
  createdBy: {
    type: DataTypes.BIGINT,
    field: 'created_by'
  },
  updatedBy: {
    type: DataTypes.BIGINT,
    field: 'updated_by'
  },
  deletedAt: {
    type: DataTypes.DATE,
    field: 'deleted_at'
  }
}, {
  tableName: 'kb_collection',
  underscored: true,
  timestamps: true
});
