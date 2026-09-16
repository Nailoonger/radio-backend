'use strict';

/**
 * Jest 全局 setup
 *  - 强制测试环境变量（必须在 require app 之前）
 *  - 关闭 morgan 日志
 */

process.env.NODE_ENV = 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
// 默认 JWT secret 避免测试时依赖 .env
process.env.JWT_SECRET = 'test-secret-key-for-jest-only';
// mock 微信登录
process.env.MOCK_WECHAT = '1';
// 关闭外部内容安全接口
process.env.WECHAT_SECURITY_CHECK = '0';

const logger = require('../src/utils/logger');
// 静默 logger 输出，避免污染测试结果
logger.info = () => {};
logger.warn = () => {};
logger.debug = () => {};
// error 保留，便于排查
