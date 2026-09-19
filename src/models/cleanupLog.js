'use strict';

/**
 * cleanup_log —— 整届清理（毕业清理）的执行回执
 *
 * 为什么要落库：
 *   v8 方案的「清理完成」屏要回答三个问题：删了几个、留了几个、怎么找回。
 *   这些信息执行完就没了，必须留档才能显示回执、导出清理回执、事后追责。
 *
 * disabled_accounts 存 JSON（用户名 / 姓名 / 班级）——
 *   被停用的账号没被删除，管理员还能用「搜索账号」查到；回执里给出这一小段清单，
 *   就不用为了看 4 个学号再去查一遍库。
 */
module.exports = (sequelize, DataTypes) => {
  const CleanupLog = sequelize.define(
    'cleanupLog',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
      grade: { type: DataTypes.STRING(8), allowNull: false, comment: '年级（4 位入学年，如 2024）' },
      gradeName: { type: DataTypes.STRING(16), field: 'grade_name', comment: '如「2024 级」' },
      mode: { type: DataTypes.STRING(10), allowNull: false, comment: 'safe / disable / purge' },
      total: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0, comment: '该届账号总数' },
      deleted: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0, comment: '真正删除数' },
      disabled: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0, comment: '改为停用数' },
      classCount: { type: DataTypes.INTEGER.UNSIGNED, field: 'class_count', defaultValue: 0, comment: '涉及班级数' },
      untouched: {
        type: DataTypes.INTEGER.UNSIGNED,
        defaultValue: 0,
        comment: '其余届未被触碰的账号数（回执里「不受影响」那一行）',
      },
      costMs: { type: DataTypes.INTEGER.UNSIGNED, field: 'cost_ms', defaultValue: 0, comment: '执行耗时（毫秒）' },
      operatorId: { type: DataTypes.INTEGER.UNSIGNED, field: 'operator_id', comment: '执行人管理员 id' },
      operatorName: {
        type: DataTypes.STRING(64),
        field: 'operator_name',
        comment: '执行人显示名（回执里要写「由 林晓 执行」）',
      },
      disabledAccounts: {
        type: DataTypes.TEXT,
        field: 'disabled_accounts',
        comment: 'JSON 数组：[{username, name, className}]',
      },
      createTime: { type: DataTypes.DATE, field: 'create_time', defaultValue: DataTypes.NOW },
      updateTime: { type: DataTypes.DATE, field: 'update_time', defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'cleanup_log',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        { name: 'idx_grade_time', fields: ['grade', 'create_time'] },
      ],
    }
  );
  return CleanupLog;
};
