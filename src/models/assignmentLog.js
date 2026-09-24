'use strict';

/**
 * 排期变动日志（协议文档「九、assignment_logs」）
 *
 * 每一次「这首歌被放到哪个时段」的变动都追一条，包括：
 *   · 第一轮排期落座      assignment_type = INITIAL
 *   · 原位递补 / 全局调剂  assignment_type = RESCHEDULED / PROMOTED
 *   · 人工指定时段        assignment_type = MANUAL
 *
 * 为什么值得单独一张表：协议明确要求「用户申请的是周一午间、最终排到周一晚间，
 * 系统必须知道这件事」。`submit.want_broadcast_time`（首选）与
 * `submit.scheduled_slot`（实际）只保留**最终态**，中间换过几次靠这张表还原。
 *
 * ⚠️ 时段身份用**时段值字符串**（如 `2026-09-21 午间 12:20`），不是数字 id ——
 *    本项目没有单独建 `schedule_slots` 表，格子由 `broadcastSlotService` 派生
 *    （避免「配置表 + 派生态」两本账）。列名因此是 from_slot / to_slot 而非
 *    协议里的 from_slot_id / to_slot_id，语义一致。
 */
module.exports = (sequelize, DataTypes) => {
  const AssignmentLog = sequelize.define(
    'assignmentLog',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      requestId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'request_id',
        comment: 'FK submit.id',
      },
      fromSlot: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'from_slot',
        comment: '原时段值；第一轮排期时为 null',
      },
      toSlot: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'to_slot',
        comment: '新时段值；释放位子时为 null',
      },
      assignmentType: {
        type: DataTypes.STRING(24),
        allowNull: false,
        field: 'assignment_type',
        comment: 'INITIAL / RESCHEDULED / MANUAL / PROMOTED / RELEASED',
      },
      reason: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'ORIGINAL_SLOT_FULL / SLOT_RELEASED / INITIAL_ALLOCATION / MANUAL / …',
      },
      operatorId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'operator_id',
        comment: '人工操作的管理员 id；系统调度为 null',
      },
      createTime: { type: DataTypes.DATE, field: 'created_at', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'assignment_log',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: false,
      indexes: [
        { name: 'idx_assign_request', fields: ['request_id'] },
        { name: 'idx_assign_type_created', fields: ['assignment_type', 'created_at'] },
      ],
    }
  );
  return AssignmentLog;
};
