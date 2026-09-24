'use strict';

/**
 * 状态变更日志（协议文档「十、request_status_logs」）
 *
 * 每次任一维度（审核 / 排期 / 播放）发生变化都追一条，后台可以完整回答
 * 「这首歌为什么现在是这个状态」：
 *
 *   PENDING_REVIEW → REJECTED       operator = reviewer_001  reason = 歌曲内容不符合规则
 *   WAITING        → APPROVED       operator = SYSTEM        reason = ORIGINAL_SLOT_CAPACITY_RELEASED
 *
 * 与 assignment_log 的分工：这张记**状态**，那张记**时段**。
 * 同一首歌被调剂时会同时产生两条（状态从 WAITING→APPROVED，时段从 A→B）。
 */
module.exports = (sequelize, DataTypes) => {
  const RequestStatusLog = sequelize.define(
    'requestStatusLog',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      requestId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'request_id',
        comment: 'FK submit.id',
      },
      operatorId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'operator_id',
        comment: '管理员 id；系统动作为 null 且 operatorName = SYSTEM',
      },
      operatorName: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'operator_name',
        comment: 'SYSTEM / ADMIN / USER（学生自己撤销）',
      },
      dimension: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'review',
        comment: 'review / schedule / play —— 哪一个维度变了',
      },
      fromStatus: {
        type: DataTypes.STRING(24),
        allowNull: true,
        field: 'from_status',
        comment: '变更前状态名（如 PENDING_REVIEW / WAITING）',
      },
      toStatus: {
        type: DataTypes.STRING(24),
        allowNull: false,
        field: 'to_status',
        comment: '变更后状态名',
      },
      reason: { type: DataTypes.STRING(255), allowNull: true },
      createTime: { type: DataTypes.DATE, field: 'created_at', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'request_status_log',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: false,
      indexes: [
        { name: 'idx_rstatus_request', fields: ['request_id'] },
        { name: 'idx_rstatus_created', fields: ['created_at'] },
      ],
    }
  );
  return RequestStatusLog;
};
