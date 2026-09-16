'use strict';

module.exports = (sequelize, DataTypes) => {
  const Program = sequelize.define(
    'program',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      title: { type: DataTypes.STRING(128), allowNull: false },
      host: { type: DataTypes.STRING(128), allowNull: true, comment: '主持人' },
      broadcastTime: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'broadcast_time',
        comment: '开播时间描述，如 周一 12:30-13:00',
      },
      broadcastDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'broadcast_date',
        comment: '具体日期，用于日历视图',
      },
      desc: { type: DataTypes.TEXT, allowNull: true },
      cover: { type: DataTypes.STRING(512), allowNull: true },
      isShow: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'is_show',
        comment: '0=隐藏 1=展示',
      },
      isLive: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'is_live',
        comment: '0=未开播 1=正在直播',
      },
      sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
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
      tableName: 'program',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        { fields: ['broadcast_date'] },
        { fields: ['is_show'] },
      ],
    }
  );
  return Program;
};