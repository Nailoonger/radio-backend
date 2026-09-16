'use strict';

module.exports = (sequelize, DataTypes) => {
  const SystemSwitch = sequelize.define(
    'system_switch',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      key: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        comment: 'submit_song / submit_article / message / member',
      },
      value: {
        type: DataTypes.STRING(8),
        allowNull: false,
        defaultValue: 'on',
        comment: "'on' | 'off'",
      },
      desc: { type: DataTypes.STRING(255), allowNull: true },
      updatedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'updated_by',
        comment: 'admin.id，最后修改人',
      },
      updatedAt: {
        type: DataTypes.DATE,
        field: 'update_time',
        defaultValue: DataTypes.NOW,
      },
      createTime: {
        type: DataTypes.DATE,
        field: 'create_time',
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'system_switch',
      timestamps: false,
    }
  );
  return SystemSwitch;
};
