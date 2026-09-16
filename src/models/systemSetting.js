'use strict';

module.exports = (sequelize, DataTypes) => {
  const SystemSetting = sequelize.define(
    'system_setting',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      value: { type: DataTypes.TEXT, allowNull: true },
      desc: { type: DataTypes.STRING(255), allowNull: true },
      updateTime: {
        type: DataTypes.DATE,
        field: 'update_time',
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'system_setting',
      timestamps: false,
    }
  );
  return SystemSetting;
};