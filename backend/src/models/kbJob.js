const { DataTypes } = require('sequelize');

module.exports = (sequelize) => sequelize.define('kbJob', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  jobType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'job_type'
  },
  bizType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'biz_type'
  },
  bizId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    field: 'biz_id'
  },
  idempotencyKey: {
    type: DataTypes.STRING(128),
    allowNull: false,
    field: 'idempotency_key'
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'queued'
  },
  priority: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 5
  },
  retryCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'retry_count'
  },
  maxAttempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 3,
    field: 'max_attempts'
  },
  nextRetryAt: {
    type: DataTypes.DATE,
    field: 'next_retry_at'
  },
  queueName: {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'kb-default',
    field: 'queue_name'
  },
  payloadJson: {
    type: DataTypes.JSON,
    field: 'payload_json'
  },
  lastErrorKey: {
    type: DataTypes.STRING(128),
    field: 'last_error_key'
  },
  lastError: {
    type: DataTypes.STRING(1000),
    field: 'last_error'
  },
  createdBy: {
    type: DataTypes.BIGINT,
    field: 'created_by'
  }
}, {
  tableName: 'kb_job',
  underscored: true,
  timestamps: true
});
