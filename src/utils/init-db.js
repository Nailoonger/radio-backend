'use strict';

/**
 * CLI: 同步模型到数据库（创建/更新表结构）
 * 运行: npm run db:init
 */
const { sequelize } = require('../models');
const logger = require('./logger');

(async () => {
  try {
    await sequelize.authenticate();
    logger.info('[db] 数据库连接成功');
    await sequelize.sync({ alter: true });
    logger.info('[db] 表结构同步完成（alter模式）');
    await sequelize.close();
    process.exit(0);
  } catch (e) {
    logger.error('[db] 同步失败:', e);
    process.exit(1);
  }
})();