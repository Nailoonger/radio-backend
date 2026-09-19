'use strict';

/**
 * user —— 小程序用户
 *
 * 两种身份共存于本表：
 *   1. 学生账号（2026-09 起）：openid 为空，靠 username + password 登录
 *   2. 老微信用户：openid 有值，password 为空（开关 account_login_required 关闭时可用）
 *
 * ⚠️ 账号体系刻意复用 user 表而非新建身份表：
 *    submit / message / notice_ack / song_quota 全部按 `openid` 字段关联归属，
 *    登录时把 JWT 的 openid 字段填成「账号本身」，这些存量逻辑一行都不用改。
 *
 * ⚠️ defaultScope 排除 password：任何查询默认拿不到哈希。
 *    需要比对密码时显式用 `User.scope('withPassword')`。
 */
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
        allowNull: true, // 学生账号没有微信 openid；MySQL 的 UNIQUE 允许多行 NULL
        unique: true,
        comment: '微信OpenID（账号体系下为空）',
      },
      username: {
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '登录账号 = 入学年级 + 班级 + 序号，如 20240101',
      },
      password: {
        type: DataTypes.STRING(72),
        allowNull: true,
        comment: 'bcrypt 哈希；老微信用户为空',
      },
      grade: {
        type: DataTypes.STRING(8),
        allowNull: true,
        comment: '入学年级，如 2024',
      },
      classNo: {
        type: DataTypes.STRING(4),
        allowNull: true,
        field: 'class_no',
        comment: '班级，如 01',
      },
      seatNo: {
        type: DataTypes.STRING(4),
        allowNull: true,
        field: 'seat_no',
        comment: '序号，如 01',
      },
      remark: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '备注（可存姓名）',
      },
      status: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: '1=启用 0=禁用',
      },
      pwdChangedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'pwd_changed_at',
        comment: '为空 = 仍是初始密码 usr123456',
      },
      lastLoginAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_login_at',
        comment: '最近登录时间',
      },
      loginCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'login_count',
        comment: '累计登录次数',
      },
      importBatchId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'import_batch_id',
        comment: '来源导入批次',
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
      defaultScope: {
        attributes: { exclude: ['password'] },
      },
      scopes: {
        // 仅登录 / 改密这类必须比对哈希的场景使用
        withPassword: { attributes: { include: ['password'] } },
      },
      indexes: [
        { name: 'uk_username', unique: true, fields: ['username'] },
        { name: 'uk_grade_class_seat', unique: true, fields: ['grade', 'class_no', 'seat_no'] },
        { name: 'idx_grade_class', fields: ['grade', 'class_no'] },
      ],
    }
  );
  return User;
};
