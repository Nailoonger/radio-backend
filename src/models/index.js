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
// ⚠️ 一律 constraints: false —— **不建物理外键**。
//    原因：submit.id 在 MySQL 里是 BIGINT UNSIGNED，而这两张日志表的
//    requestId 是 INTEGER（signed）。Sequelize 默认会给 hasMany/belongsTo
//    建物理外键，MySQL 要求「引用列与被引用列类型完全一致」，于是
//    sync() 抛 ERROR 3780 中断 → 表建不全 → 容器起不来（nginx 502）。
//    SQLite 不校验外键列类型，所以本地测试测不出来。
//    引用完整性由应用层保证（与项目其他表一致，也便于批量导入/迁移）。
Submit.hasMany(AssignmentLog, { foreignKey: 'requestId', as: 'assignments', constraints: false });
AssignmentLog.belongsTo(Submit, { foreignKey: 'requestId', as: 'request', constraints: false });
Submit.hasMany(RequestStatusLog, { foreignKey: 'requestId', as: 'statusLogs', constraints: false });
RequestStatusLog.belongsTo(Submit, { foreignKey: 'requestId', as: 'request', constraints: false });

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