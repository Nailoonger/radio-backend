'use strict';

const router = require('express').Router();
const { adminAuth } = require('../middlewares/auth');
const { requireSuperAdmin, requireAdmin } = require('../middlewares/permission');
const { loginLimiter } = require('../middlewares/rateLimit');

const auth = require('../controllers/admin/authController');
const submit = require('../controllers/admin/submitController');
const program = require('../controllers/admin/programController');
const notice = require('../controllers/admin/noticeController');
const message = require('../controllers/admin/messageController');
const adminMgr = require('../controllers/admin/adminController');
const stats = require('../controllers/admin/statsController');
const setting = require('../controllers/admin/settingController');
const member = require('../controllers/admin/memberController');
const upload = require('../controllers/admin/uploadController');
const sw = require('../controllers/admin/switchController');

/**
 * @swagger
 * tags:
 *   - name: 管理端-登录
 *     description: 管理员账号密码登录
 *   - name: 管理端-账号
 *     description: 当前管理员信息与改密
 *   - name: 管理端-投稿审核
 *     description: 投稿列表 / 通过 / 驳回 / 批量
 *   - name: 管理端-节目排期
 *     description: 节目 CRUD + 直播切换
 *   - name: 管理端-公告管理
 *     description: 公告 CRUD + 上下架
 *   - name: 管理端-留言审核
 *     description: 留言列表 / 通过 / 驳回
 *   - name: 管理端-数据统计
 *     description: 概览、趋势、热门点歌
 *   - name: 管理端-系统设置
 *     description: KV 设置（仅超管）
 *   - name: 管理端-账号管理
 *     description: 增删改查管理员（仅超管）
 */

// ============= 鉴权 =============
/**
 * @swagger
 * /api/admin/login:
 *   post:
 *     tags: [管理端-登录]
 *     summary: 管理员登录
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AdminLoginRequest'
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
 *                       type: object
 *                       properties:
 *                         token: { type: string }
 *                         admin: { $ref: '#/components/schemas/Admin' }
 *       401: { description: 账号或密码错误 }
 *       403: { description: 账号已禁用 }
 *       429: { description: 登录尝试过多 }
 */
router.post('/login', loginLimiter, auth.login);

// ============= 当前管理员 =============
/**
 * @swagger
 * /api/admin/profile:
 *   get:
 *     tags: [管理端-账号]
 *     summary: 当前管理员信息
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
 *                     data: { $ref: '#/components/schemas/Admin' }
 */
router.get('/profile', adminAuth, auth.profile);

/**
 * @swagger
 * /api/admin/change-password:
 *   put:
 *     tags: [管理端-账号]
 *     summary: 修改自己的密码
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
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200: { description: ok }
 *       400: { description: 原密码错误 / 长度过短 }
 */
router.put('/change-password', adminAuth, auth.changePassword);

/**
 * @swagger
 * /api/admin/logout:
 *   post:
 *     tags: [管理端-账号]
 *     summary: 退出登录（前端清 token 即可，服务端无状态）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.post('/logout', adminAuth, auth.logout);

// ============= 投稿审核 =============
/**
 * @swagger
 * /api/admin/submit/list:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 投稿列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: integer, enum: [0,1,2] }
 *       - in: query
 *         name: type
 *         schema: { type: integer, enum: [1,2] }
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200: { description: ok（list 含 nickname/avatar 冗余字段） }
 */
router.get('/submit/list', adminAuth, requireAdmin, submit.list);

/**
 * @swagger
 * /api/admin/submit/{id}:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 投稿详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 不存在 }
 */
router.get('/submit/:id', adminAuth, requireAdmin, submit.detail);

/**
 * @swagger
 * /api/admin/submit/{id}/approve:
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 审核通过
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.put('/submit/:id/approve', adminAuth, requireAdmin, submit.approve);

/**
 * @swagger
 * /api/admin/submit/{id}/reject:
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 驳回
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: ok }
 *       400: { description: 缺少驳回理由 }
 */
router.put('/submit/:id/reject', adminAuth, requireAdmin, submit.reject);

/**
 * @swagger
 * /api/admin/submit/{id}:
 *   delete:
 *     tags: [管理端-投稿审核]
 *     summary: 删除投稿
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.delete('/submit/:id', adminAuth, requireAdmin, submit.remove);

/**
 * @swagger
 * /api/admin/submit/batch:
 *   post:
 *     tags: [管理端-投稿审核]
 *     summary: 批量审核
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BatchSubmitRequest'
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
 *                         affected: { type: integer }
 */
router.post('/submit/batch', adminAuth, requireAdmin, submit.batch);

// ============= 节目排期 =============
/**
 * @swagger
 * /api/admin/program/list:
 *   get:
 *     tags: [管理端-节目排期]
 *     summary: 节目列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/program/list', adminAuth, requireAdmin, program.list);

/**
 * @swagger
 * /api/admin/program/create:
 *   post:
 *     tags: [管理端-节目排期]
 *     summary: 新增节目
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProgramUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.post('/program/create', adminAuth, requireAdmin, program.create);

/**
 * @swagger
 * /api/admin/program/{id}:
 *   put:
 *     tags: [管理端-节目排期]
 *     summary: 更新节目
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ProgramUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.put('/program/:id', adminAuth, requireAdmin, program.update);

/**
 * @swagger
 * /api/admin/program/{id}:
 *   delete:
 *     tags: [管理端-节目排期]
 *     summary: 删除节目
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.delete('/program/:id', adminAuth, requireAdmin, program.remove);

/**
 * @swagger
 * /api/admin/program/{id}/live:
 *   put:
 *     tags: [管理端-节目排期]
 *     summary: 切换"正在直播"标识（保证全站唯一）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isLive]
 *             properties:
 *               isLive: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: ok }
 */
router.put('/program/:id/live', adminAuth, requireAdmin, program.setLive);

// ============= 公告 =============
/**
 * @swagger
 * /api/admin/notice/list:
 *   get:
 *     tags: [管理端-公告管理]
 *     summary: 公告列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/notice/list', adminAuth, requireAdmin, notice.list);

/**
 * @swagger
 * /api/admin/notice/create:
 *   post:
 *     tags: [管理端-公告管理]
 *     summary: 发布公告
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NoticeUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.post('/notice/create', adminAuth, requireAdmin, notice.create);

/**
 * @swagger
 * /api/admin/notice/{id}:
 *   put:
 *     tags: [管理端-公告管理]
 *     summary: 更新公告
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/NoticeUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.put('/notice/:id', adminAuth, requireAdmin, notice.update);

/**
 * @swagger
 * /api/admin/notice/{id}:
 *   delete:
 *     tags: [管理端-公告管理]
 *     summary: 删除公告
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.delete('/notice/:id', adminAuth, requireAdmin, notice.remove);

/**
 * @swagger
 * /api/admin/notice/{id}/toggle:
 *   put:
 *     tags: [管理端-公告管理]
 *     summary: 切换展示 / 隐藏
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.put('/notice/:id/toggle', adminAuth, requireAdmin, notice.toggle);

// ============= 留言审核 =============
/**
 * @swagger
 * /api/admin/message/list:
 *   get:
 *     tags: [管理端-留言审核]
 *     summary: 留言列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: integer, enum: [0,1,2] }
 *       - in: query
 *         name: programId
 *         schema: { type: integer }
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/message/list', adminAuth, requireAdmin, message.list);

/**
 * @swagger
 * /api/admin/message/{id}/approve:
 *   put:
 *     tags: [管理端-留言审核]
 *     summary: 通过留言
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.put('/message/:id/approve', adminAuth, requireAdmin, message.approve);

/**
 * @swagger
 * /api/admin/message/{id}/reject:
 *   put:
 *     tags: [管理端-留言审核]
 *     summary: 驳回留言
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: ok }
 */
router.put('/message/:id/reject', adminAuth, requireAdmin, message.reject);

/**
 * @swagger
 * /api/admin/message/{id}:
 *   delete:
 *     tags: [管理端-留言审核]
 *     summary: 删除留言
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.delete('/message/:id', adminAuth, requireAdmin, message.remove);

// ============= 数据统计 =============
/**
 * @swagger
 * /api/admin/stats/overview:
 *   get:
 *     tags: [管理端-数据统计]
 *     summary: 数据概览（投稿、留言、用户、内容）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/stats/overview', adminAuth, requireAdmin, stats.overview);

/**
 * @swagger
 * /api/admin/stats/submit-trend:
 *   get:
 *     tags: [管理端-数据统计]
 *     summary: 投稿近 N 天趋势（按天分组）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/stats/submit-trend', adminAuth, requireAdmin, stats.submitTrend);

/**
 * @swagger
 * /api/admin/stats/top-songs:
 *   get:
 *     tags: [管理端-数据统计]
 *     summary: 热门点歌 Top10
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/stats/top-songs', adminAuth, requireAdmin, stats.topSongs);

// ============= 系统设置（仅超管） =============
/**
 * @swagger
 * /api/admin/setting/list:
 *   get:
 *     tags: [管理端-系统设置]
 *     summary: 列出所有设置
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/setting/list', adminAuth, requireSuperAdmin, setting.list);

/**
 * @swagger
 * /api/admin/setting/{key}:
 *   get:
 *     tags: [管理端-系统设置]
 *     summary: 读取指定设置
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 不存在 }
 */
router.get('/setting/:key', adminAuth, requireSuperAdmin, setting.get);

/**
 * @swagger
 * /api/admin/setting/{key}:
 *   put:
 *     tags: [管理端-系统设置]
 *     summary: 新增 / 更新设置
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.put('/setting/:key', adminAuth, requireSuperAdmin, setting.upsert);

// ============= 模块开关（仅超管） =============
/**
 * @swagger
 * /api/admin/switch/list:
 *   get:
 *     tags: [管理端-模块开关]
 *     summary: 列出所有模块开关
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/switch/list', adminAuth, requireSuperAdmin, sw.list);

/**
 * @swagger
 * /api/admin/switch/{key}:
 *   put:
 *     tags: [管理端-模块开关]
 *     summary: 修改某个模块开关
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value]
 *             properties:
 *               value: { type: string, enum: [on, off] }
 *     responses:
 *       200: { description: ok }
 *       400: { description: 参数错误 }
 */
router.put('/switch/:key', adminAuth, requireSuperAdmin, sw.update);

// ============= 风采展示（仅超管） =============
/**
 * @swagger
 * /api/admin/upload/avatar:
 *   post:
 *     tags: [管理端-风采展示]
 *     summary: 上传头像（单文件，字段名 file）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200: { description: 上传成功，返回 url }
 *       400: { description: 类型不符 / 文件过大 }
 */
router.post('/upload/avatar', adminAuth, requireSuperAdmin, ...upload.uploadAvatar);

/**
 * @swagger
 * /api/admin/member/list:
 *   get:
 *     tags: [管理端-风采展示]
 *     summary: 成员列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: role
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/member/list', adminAuth, requireSuperAdmin, member.list);

/**
 * @swagger
 * /api/admin/member/{id}:
 *   get:
 *     tags: [管理端-风采展示]
 *     summary: 成员详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       404: { description: 不存在 }
 */
router.get('/member/:id', adminAuth, requireSuperAdmin, member.detail);

/**
 * @swagger
 * /api/admin/member/create:
 *   post:
 *     tags: [管理端-风采展示]
 *     summary: 新增成员
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MemberUpsertRequest'
 *     responses:
 *       200: { description: ok }
 *       400: { description: 参数错误 }
 */
router.post('/member/create', adminAuth, requireSuperAdmin, member.create);

/**
 * @swagger
 * /api/admin/member/{id}:
 *   put:
 *     tags: [管理端-风采展示]
 *     summary: 更新成员
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MemberUpsertRequest'
 *     responses:
 *       200: { description: ok }
 */
router.put('/member/:id', adminAuth, requireSuperAdmin, member.update);

/**
 * @swagger
 * /api/admin/member/{id}:
 *   delete:
 *     tags: [管理端-风采展示]
 *     summary: 删除成员
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.delete('/member/:id', adminAuth, requireSuperAdmin, member.remove);

/**
 * @swagger
 * /api/admin/member/{id}/toggle:
 *   put:
 *     tags: [管理端-风采展示]
 *     summary: 切换展示 / 隐藏
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 */
router.put('/member/:id/toggle', adminAuth, requireSuperAdmin, member.toggle);

// ============= 账号管理（仅超管） =============
/**
 * @swagger
 * /api/admin/admin/list:
 *   get:
 *     tags: [管理端-账号管理]
 *     summary: 管理员列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: ok }
 */
router.get('/admin/list', adminAuth, requireSuperAdmin, adminMgr.list);

/**
 * @swagger
 * /api/admin/admin/create:
 *   post:
 *     tags: [管理端-账号管理]
 *     summary: 新增管理员
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, role]
 *             properties:
 *               username: { type: string }
 *               password: { type: string, minLength: 6 }
 *               nickname: { type: string }
 *               role: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: ok }
 *       409: { description: 用户名已存在 }
 */
router.post('/admin/create', adminAuth, requireSuperAdmin, adminMgr.create);

/**
 * @swagger
 * /api/admin/admin/{id}:
 *   put:
 *     tags: [管理端-账号管理]
 *     summary: 更新管理员（昵称/密码/角色/状态）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nickname: { type: string }
 *               password: { type: string, minLength: 6 }
 *               role: { type: integer, enum: [0, 1] }
 *               status: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: ok }
 */
router.put('/admin/:id', adminAuth, requireSuperAdmin, adminMgr.update);

/**
 * @swagger
 * /api/admin/admin/{id}:
 *   delete:
 *     tags: [管理端-账号管理]
 *     summary: 删除管理员（至少保留一个超管）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       403: { description: 不能删除自己 / 系统需保留超管 }
 */
router.delete('/admin/:id', adminAuth, requireSuperAdmin, adminMgr.remove);

module.exports = router;
