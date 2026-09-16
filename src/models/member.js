'use strict';

module.exports = (sequelize, DataTypes) => {
  const Member = sequelize.define(
    'member',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(32), allowNull: false, comment: '姓名' },
      role: { type: DataTypes.STRING(32), allowNull: false, comment: '职务（社长/主播/编辑/技术员...）' },
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
      tableName: 'member',
      timestamps: true,
      createdAt: 'create_time',
      updatedAt: 'update_time',
      indexes: [{ fields: ['is_show', 'sort'] }],
    }
  );
  return Member;
};
