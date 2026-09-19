'use strict';

module.exports = (sequelize, DataTypes) => {
  const Submit = sequelize.define(
    'submit',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      openid: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '提交人openid',
      },
      type: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '1=点歌 2=文稿',
      },
      // 点歌字段
      songName: { type: DataTypes.STRING(128), allowNull: true, field: 'song_name' },
      singer: { type: DataTypes.STRING(128), allowNull: true },
      wishContent: { type: DataTypes.STRING(500), allowNull: true, field: 'wish_content' },
      // 文稿字段
      articleTitle: { type: DataTypes.STRING(255), allowNull: true, field: 'article_title' },
      articleContent: { type: DataTypes.TEXT, allowNull: true, field: 'article_content' },
      // 通用
      wantBroadcastTime: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'want_broadcast_time',
        comment: '希望播出时段，如 2026-09-15 午间',
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '0=待审核 1=已通过 2=已驳回',
      },
      rejectReason: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'reject_reason',
      },
      reviewerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'reviewer_id',
      },
      reviewTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'review_time',
      },
      autoRejected: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        field: 'auto_rejected',
        comment: '1=由系统自动驳回（点歌名额已满），0=人工处理',
      },
      createTime: {
        type: DataTypes.DATE,
        field: 'create_time',
        defaultValue: DataTypes.NOW,
      },
      updateTime: {
        type: DataTypes.DATE,
        field: 'update_time',
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'submit',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        { fields: ['openid'] },
        { fields: ['status'] },
        { fields: ['type'] },
        { fields: ['create_time'] },
        // 名额自动驳回要按「type + status + 时间区间」批量扫，单列索引不够
        { name: 'idx_type_status_create', fields: ['type', 'status', 'create_time'] },
      ],
    }
  );
  return Submit;
};