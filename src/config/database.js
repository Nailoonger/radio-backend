'use strict';

const path = require('path');
const fs = require('fs');
const { Sequelize } = require('sequelize');
const config = require('./index');

// 确保证言 data 目录存在（SQLite 用）
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let sequelize;
const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

if (dialect === 'mysql') {
  // mysql2 v3 + Sequelize 6 的 latin1 bug 终极方案：
  // 在 beforeConnect hook 里给每个连接注入 SET NAMES utf8mb4
  // 必须用 callback API（mysql2 默认 callback 不是 Promise）
  const mysql2 = require('mysql2');

  sequelize = new Sequelize({
    dialect: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'radio_station',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    timezone: '+08:00',
    logging: config.env === 'development' ? console.log : false,
    dialectOptions: {
      charset: 'utf8mb4',
    },
    define: {
      underscored: false,
      freezeTableName: true,
      charset: 'utf8mb4',
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    // 关键：连接池 acquire 时先 SET NAMES（callback API，不返回 promise）
    hooks: {
      beforeConnect: (config) => {
        config.charset = 'UTF8MB4_GENERAL_CI';
      },
    },
  });
} else {
  // 默认 SQLite，开箱即用，无需任何依赖
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: process.env.DB_STORAGE || path.join(dataDir, 'radio.db'),
    logging: config.env === 'development' ? console.log : false,
    define: {
      underscored: false,
      freezeTableName: true,
    },
  });
}

module.exports = sequelize;