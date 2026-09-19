'use strict';

/**
 * import_batch —— 学生名册导入批次
 *
 * 为什么单独记批次：
 *   传错表格时可以「一键撤销」—— 只删本批次里**还没被激活**（从未登录、仍是初始密码）的账号，
 *   已经用过的账号不动，避免把学生的投稿记录打断（submit.openid 存的是账号）。
 */
module.exports = (sequelize, DataTypes) => {
  const ImportBatch = sequelize.define(
    'importBatch',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      filename: {
        type: DataTypes.STRING(255),
        allowNull: false,
        defaultValue: '',
        comment: '上传的原始文件名',
      },
      total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '表格总数据行数' },
      created: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '新建账号数' },
      updated: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '覆盖更新数' },
      skipped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '跳过数（已激活受保护）' },
      invalid: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '异常行数' },
      operatorId: { type: DataTypes.INTEGER, allowNull: true, field: 'operator_id', comment: '操作管理员 id' },
      operator: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '', comment: '操作管理员用户名' },
      createTime: { type: DataTypes.DATE, field: 'create_time', defaultValue: DataTypes.NOW },
      updateTime: { type: DataTypes.DATE, field: 'update_time', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'import_batch',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [{ name: 'idx_create_time', fields: ['create_time'] }],
    }
  );
  return ImportBatch;
};
