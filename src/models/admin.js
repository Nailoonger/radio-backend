'use strict';

module.exports = (sequelize, DataTypes) => {
  const Admin = sequelize.define(
    'admin',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      username: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        comment: '登录账号',
      },
      password: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'bcrypt加密',
      },
      nickname: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      role: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '0=超级管理员(老师) 1=普通管理员(社员)',
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '0=禁用 1=启用',
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        field: 'last_login_at',
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
      tableName: 'admin',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
    }
  );
  return Admin;
};