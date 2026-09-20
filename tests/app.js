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
  await openSongWindowForTest();
}

/**
 * 点歌规则 v2 的测试前置：把「点歌时间窗口」关掉（enabled=0 = 一直开放）。
 *
 * 为什么必须做：v2 里学生只能在窗口内点歌（默认周六 18:00 → 周日 18:00），
 * 否则提交点歌一律 40907。用例不该依赖「跑测试时的钟点」，
 * 也不该为了过用例去 mock 系统时间，所以统一把窗口限制关掉。
 * 窗口判闸本身由 scripts/verify-song-queue.js 的 A 段专门覆盖。
 *
 * 顺带把「每人每周上限」调到不限：一批用例会连续提交十几条点歌，
 * 默认 2 次会中途撞上限而连锁失败；上限规则另有 verify-song-submit.js 覆盖。
 *
 * ⚠️ 必须在 resetDB() 之后调用 —— resetDB 会清空 KV 表。
 */
async function openSongWindowForTest() {
  const kv = require('../src/services/kvService');
  const songWindow = require('../src/services/songWindowService');
  const submitRule = require('../src/services/submitRuleService');
  await kv.set(
    songWindow.KV_WINDOW,
    JSON.stringify({ ...songWindow.DEFAULT_WINDOW, enabled: 0 }),
    '测试：不限点歌时间'
  );
  await submitRule.setRules({ weeklyUserLimit: 0, dupBlock: 1 });
  songWindow.clearCache();
  submitRule.clearCache();
}

/** 取一批可用的播出时段值（下一周周一到周五），给点歌用例当 wantBroadcastTime */
async function nextWeekSlotValues() {
  const broadcastSlot = require('../src/services/broadcastSlotService');
  const slots = await broadcastSlot.getSlots();
  return slots.list.map((s) => s.value);
}

module.exports = { buildApp, initTestEnv, openSongWindowForTest, nextWeekSlotValues };

