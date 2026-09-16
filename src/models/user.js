'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'user',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      openid: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        comment: '微信OpenID',
      },
      unionid: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      nickname: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      avatar: {
        type: DataTypes.STRING(512),
        allowNull: true,
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
      tableName: 'user',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
    }
  );
  return User;
};