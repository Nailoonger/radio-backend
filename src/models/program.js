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
        comment: '具体日期：仅特别节目档使用；常规栏目为 NULL，由 weekdays 投影出日期',
      },
      weekdays: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'weekdays',
        comment: '每周哪几天播，1=周一 … 7=周日，逗号分隔；特别档为空',
      },
      slotLabel: {
        type: DataTypes.STRING(8),
        allowNull: true,
        field: 'slot_label',
        comment: '播出时段名（午间 / 晚间），对应 KV program_slots',
      },
      slotIndex: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'slot_index',
        comment: '在该时段里排第几档，从 1 开始',
      },
      isSpecial: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'is_special',
        comment: '0=常规栏目（每周循环） 1=特别节目档（只播一次，用 broadcast_date）',
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