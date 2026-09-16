'use strict';

/**
 * 初始化种子数据：
 *  - 超级管理员账号（若不存在）
 *  - 系统设置默认值
 *  - 示例节目
 *  - 模块开关（4 个默认 on）
 * 启动时自动执行一次（幂等）
 */
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { sequelize, Admin, Program, SystemSetting, SystemSwitch } = require('../models');
const config = require('../config');
const logger = require('./logger');

async function seedAdmin() {
  const exists = await Admin.findOne({ where: { username: config.initAdmin.username } });
  if (exists) {
    logger.info(`[seed] 管理员 ${config.initAdmin.username} 已存在，跳过`);
    return exists;
  }
  const hash = await bcrypt.hash(config.initAdmin.password, 10);
  const admin = await Admin.create({
    username: config.initAdmin.username,
    password: hash,
    nickname: config.initAdmin.nickname,
    role: 0, // 超级管理员
    status: 1,
  });
  logger.info(`[seed] 已创建超级管理员: ${admin.username}`);
  return admin;
}

async function seedSettings() {
  const defaults = [
    { key: 'station_intro', value: '菁菁校园情，悠悠广播声。\n\n菁悠广播站成立于2005年，由一群热爱声音、热爱校园的同学们组成。我们用声音传递资讯，用音乐温暖日常。', desc: '广播站介绍' },
    { key: 'broadcast_schedule', value: '午间档 12:30-13:00 | 下午档 17:00-17:30', desc: '开播时间' },
    { key: 'contact', value: '广播站社长 13800138000', desc: '联系方式' },
  ];
  for (const item of defaults) {
    // upsert：不存在则创建，存在则更新 value/desc（保留 id 不变）
    const [row] = await SystemSetting.findOrCreate({
      where: { key: item.key },
      defaults: item,
    });
    if (row.value !== item.value || row.desc !== item.desc) {
      row.value = item.value;
      row.desc = item.desc;
      await row.save();
    }
  }
  logger.info('[seed] 系统设置已就绪');
}

async function seedPrograms() {
  const count = await Program.count();
  if (count > 0) return;
  const today = dayjs().format('YYYY-MM-DD');
  await Program.bulkCreate([
    { title: '午间音乐汇', host: '小李', broadcastTime: '周一至周五 12:30-13:00', broadcastDate: today, desc: '精选校园流行歌曲，伴你度过午休时光。', isShow: 1, sort: 1 },
    { title: '校园新闻速递', host: '小红', broadcastTime: '周一 17:00-17:30', broadcastDate: today, desc: '播报本周校园大事。', isShow: 1, sort: 2 },
    { title: '晚安故事', host: '小张', broadcastTime: '周五 21:30-22:00', broadcastDate: dayjs().add(4, 'day').format('YYYY-MM-DD'), desc: '为住校生送上一段温柔的睡前故事。', isShow: 1, sort: 3 },
  ]);
  logger.info('[seed] 示例节目已创建');
}

async function seedSwitches() {
  const defaults = [
    { key: 'submit_song',    value: 'on', desc: '点歌投稿' },
    { key: 'submit_article', value: 'on', desc: '文稿投稿' },
    { key: 'message',        value: 'on', desc: '节目留言' },
    { key: 'member',         value: 'on', desc: '风采展示' },
  ];
  for (const item of defaults) {
    await SystemSwitch.findOrCreate({ where: { key: item.key }, defaults: item });
  }
  logger.info('[seed] 模块开关已就绪');
}

async function seedAll() {
  try {
    await seedAdmin();
    await seedSettings();
    await seedPrograms();
    await seedSwitches();
  } catch (e) {
    logger.error('[seed] 初始化失败:', e);
  }
}

module.exports = { seedAll };

// 支持直接运行此文件
if (require.main === module) {
  (async () => {
    await sequelize.sync();
    await seedAll();
    await sequelize.close();
    process.exit(0);
  })();
}