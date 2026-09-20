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
        comment: '学生首选播出时段，如 2026-09-21 午间 12:20（意愿数据，永不被覆盖）',
      },
      // ── v2 排期容量池 / 候补队列（docs/song-queue-v2.md）──────────────
      //    容量的「占位」口径 = status ∈ {0,1,4} AND scheduled_slot = 某格
      //    （不再有独立计数器，位子释放＝状态变化，天然不会泄漏）
      scheduledSlot: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'scheduled_slot',
        comment: '实际排期时段（候补补位后可能与首选不同；候补中为空）',
      },
      queueAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'queue_at',
        comment: '进入候补队列时刻（FIFO 排序键，同刻用 id 兜底）',
      },
      promotedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'promoted_at',
        comment: '递补为占位状态的时刻',
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '0=待审 1=已排期 2=已驳回 3=候补中 4=已补位待审',
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
        comment: '1=系统自动驳回（满额 / 逾期未审），0=人工处理',
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
        // v2：每格容量统计 / 排期矩阵
        { name: 'idx_sched_status', fields: ['scheduled_slot', 'status'] },
        // v2：候补队列取队首、算位次
        { name: 'idx_queue', fields: ['status', 'queue_at', 'id'] },
      ],
    }
  );
  return Submit;
};