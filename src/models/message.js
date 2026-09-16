'use strict';

module.exports = (sequelize, DataTypes) => {
  const Message = sequelize.define(
    'message',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      openid: { type: DataTypes.STRING(64), allowNull: false },
      programId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'program_id',
        comment: '关联节目ID，可为空（对广播站整体留言）',
      },
      nickname: { type: DataTypes.STRING(64), allowNull: true },
      avatar: { type: DataTypes.STRING(512), allowNull: true },
      content: { type: DataTypes.STRING(500), allowNull: false },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '0=待审核 1=展示 2=驳回',
      },
      rejectReason: { type: DataTypes.STRING(255), allowNull: true, field: 'reject_reason' },
      reviewerId: { type: DataTypes.INTEGER, allowNull: true, field: 'reviewer_id' },
      reviewTime: { type: DataTypes.DATE, allowNull: true, field: 'review_time' },
      createTime: {
        type: DataTypes.DATE,
        field: 'create_time',
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'message',
      timestamps: false,
      indexes: [
        { fields: ['openid'] },
        { fields: ['program_id'] },
        { fields: ['status'] },
        { fields: ['create_time'] },
      ],
    }
  );
  return Message;
};