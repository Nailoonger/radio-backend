/**
 * Jest 配置
 *  - 使用 supertest 启停整个 Express app（不发端口，内部直连）
 *  - 用内存 SQLite 保证测试隔离 + 速度
 *  - 通过环境变量强制 NODE_ENV=test，关闭日志/morgan/限流
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // 测试环境变量
  globals: {
    TEST_DB_STORAGE: ':memory:',
  },
  // 覆盖率报告
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/utils/init-db.js',
    '!src/utils/seed.js',
  ],
};
