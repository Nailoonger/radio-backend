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
        comment: '0=超级管理员(老师) 1=普通管理员(社员) 2=站员(伙伴端)',
      },
      /**
       * 指向 user 表（2026-10-31 新增，账号密码统一）
       *
       * ⚠️ 云端 admin 集合早就有这个字段（`adminMgr.js` 在写它），
       *    但 MySQL 这边一直没加列 —— 直连模式下写不进去，是既有的结构分叉，这次补齐。
       * ⚠️ 密码唯一事实源改成 user.password 之后，管理员登录要靠它找到那条 user 记录。
       *    没有它就只能退化成「按 username 猜」，老师工号和学号撞了就认错人。
       * ⚠️ 允许为空（存量数据要回填），但**新建账号必须写**。
       */
      userId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'user_id',
        comment: '关联 user.id（密码与身份的唯一来源）',
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