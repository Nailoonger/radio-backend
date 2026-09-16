'use strict';

const router = require('express').Router();
const { userAuth } = require('../middlewares/auth');
const { submitLimiter, messageLimiter } = require('../middlewares/rateLimit');

const auth = require('../controllers/user/authController');
const submit = require('../controllers/user/submitController');
const message = require('../controllers/user/messageController');
const program = require('../controllers/user/programController');
const notice = require('../controllers/user/noticeController');
const profile = require('../controllers/user/profileController');
const member = require('../controllers/user/memberController');
const sw = require('../controllers/user/switchController');

/**
 * @swagger
 * tags:
 *   - name: 用户端-登录
 *     description: 微信小程序登录相关
 *   - name: 用户端-投稿
 *     description: 点歌 / 文稿投稿
 *   - name: 用户端-留言
 *     description: 节目 / 广播站留言
 *   - name: 用户端-节目
 *     description: 节目预告、直播、详情
 *   - name: 用户端-公告
 *     description: 公告列表 / 详情
 *   - name: 用户端-个人中心
 *     description: 个人数据聚合 + 广播站介绍
 */

// ============= 鉴权 =============
/**
 * @swagger
 * /api/user/login:
 *   post:
 *     tags: [用户端-登录]
 *     summary: 微信登录
 *     description: |
 *       客户端 wx.login() 拿 code，服务端用 code 换 openid，自动 upsert 用户，签发 JWT。
 *       开发环境设置 MOCK_WECHAT=1 时使用 `mock_<code>` 作为 openid，便于无 AppID 联调。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/LoginResponse'
 */
router.post('/login', auth.login);

/**
 * @swagger
 * /api/user/me:
 *   get:
 *     tags: [用户端-登录]
 *     summary: 获取当前登录用户信息
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/User'
 *       401: { description: 未登录 }
 */
router.get('/me', userAuth, auth.me);

// ============= 投稿/点歌 =============
/**
 * @swagger
 * /api/user/submit:
 *   post:
 *     tags: [用户端-投稿]
 *     summary: 提交投稿（点歌 / 文稿）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - $ref: '#/components/schemas/SubmitSongRequest'
 *               - $ref: '#/components/schemas/SubmitArticleRequest'
 *           examples:
 *             点歌:
 *               value: { type: 1, songName: 起风了, singer: 买辣椒也用券, wishContent: 毕业快乐 }
 *             文稿:
 *               value: { type: 2, articleTitle: 我的高三, articleContent: ...... }
 *     responses:
 *       200:
 *         description: 提交成功
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         id: { type: integer }
 *       400: { description: 参数错误 / 敏感内容 }
 *       409: { description: 重复提交 / 限流 }
 */
router.post('/submit', userAuth, submitLimiter, submit.create);

/**
 * @swagger
 * /api/user/submit/my:
 *   get:
 *     tags: [用户端-投稿]
 *     summary: 我的投稿列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: integer, enum: [0,1,2] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       allOf:
 *                         - $ref: '#/components/schemas/PageResult'
 *                         - type: object
 *                           properties:
 *                             list:
 *                               type: array
 *                               items: { $ref: '#/components/schemas/Submit' }
 */
router.get('/submit/my', userAuth, submit.myList);

/**
 * @swagger
 * /api/user/submit/{id}:
 *   get:
 *     tags: [用户端-投稿]
 *     summary: 投稿详情（仅自己的）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Submit'
 *       404: { description: 不存在 }
 */
router.get('/submit/:id', userAuth, submit.detail);

/**
 * @swagger
 * /api/user/submit/{id}:
 *   delete:
 *     tags: [用户端-投稿]
 *     summary: 撤销待审核的投稿
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       403: { description: 已审核，不可撤销 }
 */
router.delete('/submit/:id', userAuth, submit.cancel);

// ============= 留言 =============
/**
 * @swagger
 * /api/user/message:
 *   post:
 *     tags: [用户端-留言]
 *     summary: 提交留言
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MessageRequest'
 *     responses:
 *       200: { description: ok }
 *       400: { description: 内容为空 / 过长 / 含敏感词 }
 *       409: { description: 1 分钟内已留言 / 限流 }
 */
router.post('/message', userAuth, messageLimiter, message.create);

/**
 * @swagger
 * /api/user/message/my:
 *   get:
 *     tags: [用户端-留言]
 *     summary: 我的留言
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/message/my', userAuth, message.myList);

// ============= 节目 =============
/**
 * @swagger
 * /api/user/program/current:
 *   get:
 *     tags: [用户端-节目]
 *     summary: 正在直播节目
 *     responses:
 *       200:
 *         description: ok（没有则为 null）
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Program'
 */
router.get('/program/current', program.current);

/**
 * @swagger
 * /api/user/program/weekly:
 *   get:
 *     tags: [用户端-节目]
 *     summary: 本周节目单
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         weekRange:
 *                           type: object
 *                           properties:
 *                             from: { type: string, format: date }
 *                             to: { type: string, format: date }
 *                         list:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/Program' }
 */
router.get('/program/weekly', program.weekly);

/**
 * @swagger
 * /api/user/program/schedule:
 *   get:
 *     tags: [用户端-节目]
 *     summary: 节目预告列表（默认未来 7 天）
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: ok }
 */
router.get('/program/schedule', program.schedule);

/**
 * @swagger
 * /api/user/program/{id}:
 *   get:
 *     tags: [用户端-节目]
 *     summary: 节目详情 + 已通过的留言
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: ok
 *       404: { description: 不存在 }
 */
router.get('/program/:id', program.detail);

// ============= 公告 =============
/**
 * @swagger
 * /api/user/notice/list:
 *   get:
 *     tags: [用户端-公告]
 *     summary: 公告列表（仅展示中）
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       allOf:
 *                         - $ref: '#/components/schemas/PageResult'
 *                         - type: object
 *                           properties:
 *                             list:
 *                               type: array
 *                               items: { $ref: '#/components/schemas/Notice' }
 */
router.get('/notice/list', notice.list);

/**
 * @swagger
 * /api/user/notice/{id}:
 *   get:
 *     tags: [用户端-公告]
 *     summary: 公告详情
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: ok
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Notice'
 *       404: { description: 不存在 }
 */
router.get('/notice/:id', notice.detail);

// ============= 个人中心 + 广播站介绍 =============
/**
 * @swagger
 * /api/user/profile:
 *   get:
 *     tags: [用户端-个人中心]
 *     summary: 个人中心聚合数据
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 包含投稿统计、待审核、最近记录
 */
router.get('/profile', userAuth, profile.profile);

/**
 * @swagger
 * /api/user/station/intro:
 *   get:
 *     tags: [用户端-个人中心]
 *     summary: 广播站介绍
 *     responses:
 *       200: { description: ok }
 *       404: { description: 未配置 }
 */
router.get('/station/intro', profile.stationIntro);

/**
 * @swagger
 * /api/user/station/schedule:
 *   get:
 *     tags: [用户端-个人中心]
 *     summary: 开播时间
 *     responses:
 *       200: { description: ok }
 *       404: { description: 未配置 }
 */
router.get('/station/schedule', profile.stationSchedule);

/**
 * @swagger
 * /api/user/station/contact:
 *   get:
 *     tags: [用户端-个人中心]
 *     summary: 联系方式
 *     responses:
 *       200: { description: ok }
 *       404: { description: 未配置 }
 */
router.get('/station/contact', profile.stationContact);

// ============= 风采展示 =============
/**
 * @swagger
 * /api/user/member/list:
 *   get:
 *     tags: [用户端-风采展示]
 *     summary: 成员列表（按职务分组）
 *     parameters:
 *       - in: query
 *         name: role
 *         schema: { type: string }
 *         description: 可选，按职务精确筛选
 *     responses:
 *       200: { description: ok }
 */
router.get('/member/list', member.list);

/**
 * @swagger
 * /api/user/member/{id}:
 *   get:
 *     tags: [用户端-风采展示]
 *     summary: 成员详情
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 不存在或已下架 }
 */
router.get('/member/:id', member.detail);

// ============= 模块开关 =============
/**
 * @swagger
 * /api/user/switch/list:
 *   get:
 *     tags: [用户端-模块开关]
 *     summary: 公开获取所有模块开关状态
 *     responses:
 *       200: { description: ok }
 */
router.get('/switch/list', sw.list);

/**
 * @swagger
 * /api/user/switch/{key}:
 *   get:
 *     tags: [用户端-模块开关]
 *     summary: 公开获取单个模块开关状态
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: ok }
 */
router.get('/switch/:key', sw.get);

module.exports = router;
