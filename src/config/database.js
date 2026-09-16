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
  sequelize = new Sequelize({
    dialect: 'mysql',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'radio_station',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    timezone: '+08:00',
    logging: config.env === 'development' ? console.log : false,
    define: {
      underscored: false, // 表字段采用下划线还是驼峰
      freezeTableName: true,
      charset: 'utf8mb4',
    },
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
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