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
const showcase = require('../controllers/user/showcaseController');
const cadre = require('../controllers/user/cadreController');
const staff = require('../controllers/user/staffController');
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
 * /api/user/login/account:
 *   post:
 *     tags: [用户端-登录]
 *     summary: 学生账号密码登录（主通道）
 *     description: |
 *       账号 = 入学年级 + 班级 + 序号，如 `20240101`；初始密码统一 `usr123456`。
 *       账号不存在 / 密码错误返回同一句文案（防学号枚举）；账号被停用返回 40301。
 *       返回体里的 `user.isDefaultPwd=true` 表示还是初始密码，前端应引导改密。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: '20240101' }
 *               password: { type: string, example: usr123456 }
 *     responses:
 *       200:
 *         description: 登录成功，返回 token + user
 *       401: { description: 账号或密码错误 }
 *       403: { description: 账号已停用 }
 */
router.post('/login/account', auth.loginByAccount);

/**
 * @swagger
 * /api/user/change-password:
 *   put:
 *     tags: [用户端-登录]
 *     summary: 修改自己的密码
 *     description: |
 *       新密码需 ≥8 位且同时含字母和数字，不能与原密码相同。
 *       改密成功后签发新 token（旧 token 因密码版本不匹配立刻失效）。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               oldPassword: { type: string }
 *               newPassword: { type: string, example: abc123456 }
 *     responses:
 *       200: { description: 返回新 token }
 *       400: { description: 原密码不正确 / 新密码不符合要求 }
 *       401: { description: 未登录 }
 */
router.put('/change-password', userAuth, auth.changePassword);

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
 * /api/user/submit/quota:
 *   get:
 *     tags: [用户端-投稿]
 *     summary: 点歌名额状态（是否已满 / 还剩几个）
 *     description: |
 *       投稿页用来提前提示「今日点歌名额已满」，避免学生白填一遍表单。
 *       没有登录也能看，但接口在需登录的分组里，保持与 /submit 一致。
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
 *                       type: object
 *                       properties:
 *                         song:
 *                           type: object
 *                           properties:
 *                             exhausted: { type: boolean }
 *                             daily: { type: object, nullable: true }
 *                             weekly: { type: object, nullable: true }
 */
router.get('/submit/quota', userAuth, submit.quota);

/**
 * 点歌时间窗口状态（v2 新增）
 * GET /api/user/submit/window
 * 常驻展示在点歌模块用：open / opensAt / closesAt / windowText
 * ⚠️ 字面量段必须排在 /submit/:id 之前
 */
router.get('/submit/window', userAuth, submit.windowStatus);

/**
 * 本周点歌排期（小程序首页展示用，2026-09-21）
 * GET /api/user/submit/week
 * 公开接口（与 /program/current 一致，首页未登录也要能看）；
 * 开关 home_song_schedule 服务端把关，off 时 visible=false 且不下发数据。
 * ⚠️ 字面量段必须排在 /submit/:id 之前
 */
router.get('/submit/week', submit.weekSchedule);

/**
 * @swagger
 * /api/user/submit/notice:
 *   get:
 *     tags: [用户端-投稿]
 *     summary: 点歌注意事项（进入点歌模块时调用）
 *     description: |
 *       返回 `{configured, needAck, content, version}`。
 *       `configured=false`（后台没配内容）时前端**不要弹**，直接放行。
 *       确认后需调 `POST /submit/notice/ack`。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/submit/notice', userAuth, submit.notice);

/**
 * @swagger
 * /api/user/submit/notice/ack:
 *   post:
 *     tags: [用户端-投稿]
 *     summary: 确认已阅读点歌注意事项
 *     description: |
 *       前端在「滑到页底 + 点我已知晓」后调用，传当前 `version`。
 *       幂等：重复确认不会报错；服务端会取 min(传入版本, 当前版本)。
 *       ⚠️「必须滑到底」只是前端交互，服务端只能校验「确认过没有」。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.post('/submit/notice/ack', userAuth, submit.ackNotice);

/**
 * @swagger
 * /api/user/submit/timeslots:
 *   get:
 *     tags: [用户端-投稿]
 *     summary: 可选的播出时段（下一周周一到周五）
 *     description: |
 *       播出时间**不允许用户手输**，只能从这个列表里选。
 *       范围 = 下一周的周一到周五（严格下一周）× 系统设置 `broadcast_schedule` 里的每日时段。
 *       返回的每一项里 `value` 就是提交时要回传的字符串，`label` 可直接展示。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/submit/timeslots', userAuth, submit.timeslots);

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

/**
 * @swagger
 * /api/user/submit/{id}/leave-queue:
 *   post:
 *     tags: [用户端-投稿]
 *     summary: 放弃候补（status=3，出队并触发递补）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 已退出候补队列 }
 *       403: { description: 不是候补中的记录 }
 */
router.post('/submit/:id/leave-queue', userAuth, submit.leaveQueue);

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
 * /api/user/showcase:
 *   get:
 *     tags: [用户端-风采展示]
 *     summary: 风采展示（社干 + 部门人员）
 *     description: |
 *       一次返回所有在岗社干 + 部门人员。
 *       - cadre: 社干列表（按 sort DESC, id ASC）
 *       - staff: 按部门分组的人员
 *     responses:
 *       200: { description: ok }
 */
router.get('/showcase', showcase.showcase);

// ============= 社干 / 部员详情 =============
/**
 * @swagger
 * /api/user/cadre/{id}:
 *   get:
 *     tags: [用户端-风采展示]
 *     summary: 社干详情（仅 is_show=1）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 成员不存在 }
 */
router.get('/cadre/:id', cadre.detail);

/**
 * @swagger
 * /api/user/staff/{id}:
 *   get:
 *     tags: [用户端-风采展示]
 *     summary: 部员详情（仅 is_show=1）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 成员不存在 }
 */
router.get('/staff/:id', staff.detail);

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
