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
const Cadre = require('./cadre')(sequelize, DataTypes);
const Staff = require('./staff')(sequelize, DataTypes);
const SystemSwitch = require('./systemSwitch')(sequelize, DataTypes);
const SongQuota = require('./songQuota')(sequelize, DataTypes);
const NoticeAck = require('./noticeAck')(sequelize, DataTypes);
const ImportBatch = require('./importBatch')(sequelize, DataTypes);
const CleanupLog = require('./cleanupLog')(sequelize, DataTypes);
// 协议版点歌排期（2026-09-24，docs/song-protocol.md）
const WeeklySchedule = require('./weeklySchedule')(sequelize, DataTypes);
const AssignmentLog = require('./assignmentLog')(sequelize, DataTypes);
const RequestStatusLog = require('./requestStatusLog')(sequelize, DataTypes);

// 关联关系
// 留言 -> 节目（多对一）
Message.belongsTo(Program, { foreignKey: 'programId', as: 'program' });
Program.hasMany(Message, { foreignKey: 'programId', as: 'messages' });

// 点歌排期：一条点歌 → 多条排期变动 / 状态变更日志
Submit.hasMany(AssignmentLog, { foreignKey: 'requestId', as: 'assignments' });
AssignmentLog.belongsTo(Submit, { foreignKey: 'requestId', as: 'request' });
Submit.hasMany(RequestStatusLog, { foreignKey: 'requestId', as: 'statusLogs' });
RequestStatusLog.belongsTo(Submit, { foreignKey: 'requestId', as: 'request' });

module.exports = {
  sequelize,
  User,
  Admin,
  Submit,
  Program,
  Notice,
  Message,
  SystemSetting,
  Cadre,
  Staff,
  SystemSwitch,
  SongQuota,
  NoticeAck,
  ImportBatch,
  CleanupLog,
  WeeklySchedule,
  AssignmentLog,
  RequestStatusLog,
};