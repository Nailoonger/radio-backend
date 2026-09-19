'use strict';

/**
 * notice_ack —— 用户对「注意事项」的确认记录
 *
 * 为什么要独立成表（而不是在 user 表加一列）：
 *   注意事项后面大概率不止一个（点歌 / 文稿 / 留言各有一份），
 *   用 notice_key 区分、UNIQUE(openid, notice_key) 保证每人每份只有一行，
 *   以后加新的注意事项不用再改表结构。
 *
 * version 存的是「用户确认时那份内容的版本号」——
 * 管理员改了内容 → version +1 → 所有人需要重新确认（needAck 重新变 true）。
 */
module.exports = (sequelize, DataTypes) => {
  const NoticeAck = sequelize.define(
    'noticeAck',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      openid: { type: DataTypes.STRING(64), allowNull: false, comment: '确认人' },
      noticeKey: {
        type: DataTypes.STRING(32),
        allowNull: false,
        field: 'notice_key',
        comment: '注意事项标识，如 song_submit',
      },
      version: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '确认时的内容版本号',
      },
      createTime: { type: DataTypes.DATE, field: 'create_time', defaultValue: DataTypes.NOW },
      updateTime: { type: DataTypes.DATE, field: 'update_time', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'notice_ack',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        // 一人一份只有一行：并发确认时靠它兜住
        { name: 'uk_openid_notice', unique: true, fields: ['openid', 'notice_key'] },
      ],
    }
  );
  return NoticeAck;
};
