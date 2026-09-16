'use strict';

/**
 * 测试辅助：构造一个干净的 Express app 实例
 *  - 不调用 app.listen（避免端口冲突）
 *  - 使用内存 SQLite，每次都 fresh 数据库
 */

const path = require('path');
const fs = require('fs');

// 切换工作目录到项目根，确保 ./data/ 相对路径生效
process.chdir(path.join(__dirname, '..'));

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');

const requestId = require('../src/middlewares/requestId');
const { notFound, errorHandler } = require('../src/middlewares/errorHandler');
const userRouter = require('../src/routes/user');
const adminRouter = require('../src/routes/admin');
const swaggerSpec = require('../src/docs/swagger');
const { success } = require('../src/utils/response');
const { seedAll } = require('../src/utils/seed');
const switchService = require('../src/services/switchService');

function buildApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(requestId);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => success(res, { status: 'ok' }));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api/user', userRouter);
  app.use('/api/admin', adminRouter);
  // 静态 uploads 目录（与生产 app.js 一致）
  const uploadDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  app.use('/uploads', express.static(uploadDir));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// 同步执行一次 seed + 缓存预热，让测试代码可以直接 buildApp() 后断言
let _inited = false;
async function initTestEnv() {
  if (_inited) return;
  _inited = true;
  // 注意：必须在 require 了 buildApp 后再 seed，因为路由里 require 了 models
  // 但 seed 不依赖 app，所以放在 buildApp 同一文件没问题
  await seedAll();
  await switchService.ensureLoaded();
}

module.exports = { buildApp, initTestEnv };

