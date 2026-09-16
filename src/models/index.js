'use strict';

const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

// 各模型文件导出工厂函数 (sequelize, DataTypes) => Model
const User = require('./user')(sequelize, DataTypes);
const Admin = require('./admin')(sequelize, DataTypes);
const Submit = require('./submit')(sequelize, DataTypes);
const Program = require('./program')(sequelize, DataTypes);
const Notice = require('./notice')(sequelize, DataTypes);
const Message = require('./message')(sequelize, DataTypes);
const SystemSetting = require('./systemSetting')(sequelize, DataTypes);
const Member = require('./member')(sequelize, DataTypes);
const SystemSwitch = require('./systemSwitch')(sequelize, DataTypes);

// 关联关系
// 留言 -> 节目（多对一）
Message.belongsTo(Program, { foreignKey: 'programId', as: 'program' });
Program.hasMany(Message, { foreignKey: 'programId', as: 'messages' });

module.exports = {
  sequelize,
  User,
  Admin,
  Submit,
  Program,
  Notice,
  Message,
  SystemSetting,
  Member,
  SystemSwitch,
};