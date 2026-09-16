'use strict';

module.exports = (sequelize, DataTypes) => {
  const Notice = sequelize.define(
    'notice',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      title: { type: DataTypes.STRING(255), allowNull: false },
      content: { type: DataTypes.TEXT, allowNull: false },
      isTop: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'is_top',
        comment: '0=否 1=置顶',
      },
      isShow: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'is_show',
        comment: '0=隐藏 1=展示',
      },
      publisherId: { type: DataTypes.INTEGER, allowNull: true, field: 'publisher_id' },
      publishTime: {
        type: DataTypes.DATE,
        field: 'publish_time',
        defaultValue: DataTypes.NOW,
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
      tableName: 'notice',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [{ fields: ['is_show'] }, { fields: ['publish_time'] }],
    }
  );
  return Notice;
};