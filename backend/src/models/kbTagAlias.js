const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbTagAlias', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  aliasName: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'alias_name'
  },
  normName: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'norm_name'
  },
  status: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'pending'
  },
  tagId: {
    type: DataTypes.BIGINT,
    field: 'tag_id'
  },
  createdBy: {
    type: DataTypes.BIGINT,
    field: 'created_by'
  },
  reviewedBy: {
    type: DataTypes.BIGINT,
    field: 'reviewed_by'
  },
  reviewedAt: {
    type: DataTypes.DATE,
    field: 'reviewed_at'
  }
}, {
  tableName: 'kb_tag_alias',
  underscored: true,
  timestamps: true
});
