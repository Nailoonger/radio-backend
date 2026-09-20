'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const { sequelize } = require('./models');
const logger = require('./utils/logger');
const { success } = require('./utils/response');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const requestId = require('./middlewares/requestId');
const { seedAll } = require('./utils/seed');
const switchService = require('./services/switchService');
const songQueueService = require('./services/songQueueService');
const swaggerSpec = require('./docs/swagger');

const userRouter = require('./routes/user');
const adminRouter = require('./routes/admin');

const app = express();

// 安全头（小程序跨域不需要CSP，放宽）
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  credentials: true,
}));

// uploads 静态目录（头像等本地文件）
const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// 请求 ID（要在 morgan 之前，否则 morgan 拿不到 ID）
app.use(requestId);

// 日志
if (config.env !== 'test') {
  app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
}

// JSON body 解析
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 健康检查
app.get('/health', (req, res) => success(res, {
  status: 'ok',
  uptime: process.uptime(),
  env: config.env,
  db: process.env.DB_DIALECT || 'sqlite',
}));

// API 文档
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 业务路由
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);

// 根路径
app.get('/', (req, res) => success(res, {
  name: '菁悠广播站 API',
  docs: '/api-docs',
  health: '/health',
}));

// 404 & 错误处理
app.use(notFound);
app.use(errorHandler);

// 启动服务
async function start() {
  try {
    await sequelize.authenticate();
    logger.info('[db] 数据库连接成功');
    await sequelize.sync({ alter: false }); // 生产用 alter=false，避免误改表
    logger.info('[db] 模型同步完成');

    // 自动初始化种子数据（幂等）
    await seedAll();

    // 预热模块开关缓存
    await switchService.ensureLoaded();
    logger.info('[switch] 模块开关已预热');

    app.listen(config.port, () => {
      logger.info(`=============================================`);
      logger.info(`🚀 菁悠广播站后端已启动`);
      logger.info(`📍 地址: http://localhost:${config.port}`);
      logger.info(`📚 API文档: http://localhost:${config.port}/api-docs`);
      logger.info(`💾 数据库: ${process.env.DB_DIALECT || 'sqlite'}`);
      logger.info(`🔐 默认超管账号: ${config.initAdmin.username}`);
      logger.info(`=============================================`);
    });

    // 点歌定稿调度器（项目里没有 cron，用进程内轻量定时器）：
    //   每分钟检查一次 —— 过了窗口截止（默认播出周前的周日 18:00）就把
    //   「候补未补位(3)」与「补位未审(4)」全部自动驳回，并清理跨周残留待审。
    //   幂等靠 KV song_finalize_gate，重启/重复执行都不会误伤。
    songQueueService.startScheduler();
  } catch (e) {
    logger.error('启动失败:', e);
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGINT', async () => {
  logger.info('正在关闭...');
  await sequelize.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('正在关闭...');
  await sequelize.close();
  process.exit(0);
});

start();

module.exports = app;