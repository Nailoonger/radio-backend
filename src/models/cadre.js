'use strict';

/**
 * 社干（社团管理层）数据模型
 * - 站长、副站长、纪检长、站长助理等领导岗位
 * - 不属于任何部门，独立展示
 */

module.exports = (sequelize, DataTypes) => {
  const Cadre = sequelize.define(
    'cadre',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(32), allowNull: false, comment: '姓名' },
      role: { type: DataTypes.STRING(32), allowNull: false, comment: '职务（站长/副站长/纪检长/站长助理）' },
      grade: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '', comment: '年级班级' },
      avatar: { type: DataTypes.STRING(512), allowNull: false, comment: '头像 URL（/uploads/avatars/...）' },
      motto: { type: DataTypes.STRING(200), allowNull: true, comment: '座右铭 / 个人简介' },
      sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '排序权重，大者靠前' },
      isShow: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'is_show',
        comment: '1=展示 0=隐藏',
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
      tableName: 'cadre',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [{ fields: ['is_show', 'sort'] }],
    }
  );
  return Cadre;
};
