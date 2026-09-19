'use strict';

/**
 * 部门人员数据模型
 * - 各部门基层成员：播音部 / 主持部 / 编辑部
 * - 包含：岗位（role）、负责栏目（programs）
 */

module.exports = (sequelize, DataTypes) => {
  const Staff = sequelize.define(
    'staff',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(32), allowNull: false, comment: '姓名' },
      role: { type: DataTypes.STRING(32), allowNull: false, comment: '具体岗位（主播/主持/编辑/记者/技术员...）' },
      department: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: '',
        comment: '所属部门：播音部 / 主持部 / 编辑部',
      },
      grade: { type: DataTypes.STRING(32), allowNull: false, defaultValue: '', comment: '年级班级' },
      programs: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '', comment: '负责栏目（逗号分隔）' },
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
      tableName: 'staff',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [
        { fields: ['is_show', 'sort'] },
        { fields: ['department', 'sort'] },
      ],
    }
  );
  return Staff;
};
