const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbTag', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  tagName: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'tag_name'
  },
  normName: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'norm_name'
  },
  status: {
    type: DataTypes.SMALLINT,
    allowNull: false,
    defaultValue: 1
  },
  isDeleted: {
    type: DataTypes.SMALLINT,
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
  tableName: 'kb_tag',
  underscored: true,
  timestamps: true
});
