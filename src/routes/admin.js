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

const upload = require('../controllers/admin/uploadController');
const sw = require('../controllers/admin/switchController');
const cadre = require('../controllers/admin/cadreController');
const staff = require('../controllers/admin/staffController');
const showcase = require('../controllers/admin/showcaseController');
const student = require('../controllers/admin/studentController');
const { uploadExcel } = require('../middlewares/uploadExcel');

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
 *   - name: 管理端-学生账号
 *     description: 名册导入分发 / 列表 / 导出 / 重置密码（仅超管）
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

/* ── 点歌名额（v4）─────────────────────────────────────────────────
 * 注意顺序：必须放在 `/submit/:id` 之前，否则会被 :id 吞掉
 * ───────────────────────────────────────────────────────────────── */
/**
 * @swagger
 * /api/admin/submit/quota:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 点歌名额快照（用量 / 上限 / 已自动驳回数 / 待处理数）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: |
 *           `daily` / `weekly` 各含 `{limit, used, remaining, exhausted, periodKey}`，
 *           `limit=0` 表示不限制；`pendingWhileExhausted` 是「名额已满但仍挂着待审」的条数。
 */
router.get('/submit/quota', adminAuth, requireAdmin, submit.quota);

/**
 * @swagger
 * /api/admin/submit/quota:
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 设置每日 / 每周点歌名额上限
 *     description: |
 *       写的是系统设置（KV）里的 `song_quota_daily` / `song_quota_weekly`，
 *       传 0 表示不限制。调小上限后若立即「已满」，会顺手触发一次自动驳回。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               daily: { type: integer, example: 20 }
 *               weekly: { type: integer, example: 120 }
 *     responses:
 *       200: { description: ok }
 *       400: { description: 每周上限不能小于每日上限 }
 */
router.put('/submit/quota', adminAuth, requireAdmin, submit.setQuota);

/**
 * @swagger
 * /api/admin/submit/quota/sweep:
 *   post:
 *     tags: [管理端-投稿审核]
 *     summary: 手动触发一次自动驳回（幂等）
 *     description: 把「名额已满周期内仍待审」的点歌全部置为系统驳回；重复调用不会重复命中。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok，data 里带各周期实际驳回了多少条 }
 */
router.post('/submit/quota/sweep', adminAuth, requireAdmin, submit.sweepQuota);

/* ── v2 排期容量 / 全局候补队列 / 点歌时间窗口 ──────────────────────
 * ⚠️ 全是字面量段，必须注册在 `/submit/:id` 之前，否则会被 :id 吃掉
 * ───────────────────────────────────────────────────────────────── */
/** 容量 + 候补队列 + 窗口 一体化快照 */
router.get('/submit/capacity', adminAuth, requireAdmin, submit.capacity);
/** 手动兜底：递补队首 → 满额清队 → 窗口截止定稿（幂等） */
router.post('/submit/queue/sweep', adminAuth, requireAdmin, submit.sweepQueue);
/** 点歌时间窗口：读（管理员可看，用于常驻展示） */
router.get('/submit/window', adminAuth, requireAdmin, submit.window);
/** 点歌时间窗口：写（仅超管 —— 普通管理员只读） */
router.put('/submit/window', adminAuth, requireSuperAdmin, submit.saveWindow);

/**
 * @swagger
 * /api/admin/submit/notice:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 读取点歌注意事项（含版本号与已确认人数）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 保存点歌注意事项
 *     description: |
 *       内容有变化时版本号 +1 → 所有用户需要重新确认；内容没变则版本不动（不打扰用户）。
 *       传空字符串 = 停用注意事项（用户端不再弹窗，也不再拦提交）。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string, maxLength: 5000 }
 *     responses:
 *       200: { description: ok }
 *       400: { description: 内容超过 5000 字 }
 */
router.get('/submit/notice', adminAuth, requireAdmin, submit.notice);
router.put('/submit/notice', adminAuth, requireAdmin, submit.saveNotice);

/**
 * @swagger
 * /api/admin/submit/timeslots:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 预览用户能选到的播出时段（与用户端同源）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/submit/timeslots', adminAuth, requireAdmin, submit.timeslots);

/**
 * @swagger
 * /api/admin/submit/slots:
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 发布 / 修改点歌可选播出时段
 *     description: |
 *       用户可选的时段由这里维护（用户 2026-09-18 要求）。
 *       传 `{times:[{time:"07:20",label:"早间"},…]}`；最多 6 个，格式 HH:mm，会按时间排序。
 *       保存后**立即生效**（清掉 30 秒读缓存）。可选**日期范围固定为下一周的周一到周五**，不在这里改。
 *       校验失败（格式不对 / 一个都没传）返回 40001。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.put('/submit/slots', adminAuth, requireAdmin, submit.saveSlots);

/**
 * @swagger
 * /api/admin/submit/schedule:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 下周排期矩阵（审核即排期）
 *     description: |
 *       5 天（下周一~周五）× N 时段，每格返回 approved（已通过）/ pending（待审）/
 *       capacity（每场容量，0=不限）/ full（是否排满）。totalPending 为下周总待审数。
 *       ⚠️ 字面量段 /submit/schedule 必须注册在 /submit/:id 之前。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/submit/schedule', adminAuth, requireAdmin, submit.schedule);

/**
 * @swagger
 * /api/admin/submit/rules:
 *   get:
 *     tags: [管理端-投稿审核]
 *     summary: 读取点歌提交规则
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: |
 *           `{weeklyUserLimit, dupBlock, defaultUserLimit}`
 *           —— 每人每周点歌上限（0=不限）、同一首歌一周内是否禁止重复（1/0）。
 *   put:
 *     tags: [管理端-投稿审核]
 *     summary: 修改点歌提交规则
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               weeklyUserLimit: { type: integer, example: 2, description: 0=不限 }
 *               dupBlock: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: ok }
 */
router.get('/submit/rules', adminAuth, requireAdmin, submit.rules);
router.put('/submit/rules', adminAuth, requireAdmin, submit.saveRules);

/**
 * @swagger
 * /api/admin/submit/songs:
 *   delete:
 *     tags: [管理端-投稿审核]
 *     summary: 一键清空全部点歌数据（仅超级管理员）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirm]
 *             properties:
 *               confirm: { type: string, enum: [DELETE] }
 *     responses:
 *       200: { description: 返回 deletedSongs 条数 }
 *       403: { description: 仅超级管理员可操作 }
 *     ⚠️ 字面量段 /submit/songs 必须注册在 /submit/:id 之前，否则被 :id 吃掉
 */
router.delete('/submit/songs', adminAuth, requireSuperAdmin, submit.purgeSongs);

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
 * /api/admin/submit/{id}/revoke:
 *   put:
 *     summary: 撤销审核结果（已通过 / 已驳回 → 回到待审）
 *     description: |
 *       v8 审核处理台的「撤销」。已通过的点歌会归还名额（与删除同规则），
 *       避免名额被一条撤销掉的记录长期占用。
 *     tags: [管理端-投稿]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 已撤销 }
 */
router.put('/submit/:id/revoke', adminAuth, requireAdmin, submit.revoke);

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

// ============= 社干（仅超管） =============
/**
 * @swagger
 * /api/admin/cadre/list:
 *   get:
 *     tags: [管理端-风采展示]
 *     summary: 社干列表
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
router.get('/cadre/list', adminAuth, requireSuperAdmin, cadre.list);
router.get('/cadre/:id', adminAuth, requireSuperAdmin, cadre.detail);
router.post('/cadre/create', adminAuth, requireSuperAdmin, cadre.create);
router.put('/cadre/:id', adminAuth, requireSuperAdmin, cadre.update);
router.delete('/cadre/:id', adminAuth, requireSuperAdmin, cadre.remove);
router.put('/cadre/:id/toggle', adminAuth, requireSuperAdmin, cadre.toggle);

// ============= 部门人员（仅超管） =============
/**
 * @swagger
 * /api/admin/staff/list:
 *   get:
 *     tags: [管理端-风采展示]
 *     summary: 部门人员列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *       - in: query
 *         name: department
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
router.get('/staff/list', adminAuth, requireSuperAdmin, staff.list);
router.get('/staff/:id', adminAuth, requireSuperAdmin, staff.detail);
router.post('/staff/create', adminAuth, requireSuperAdmin, staff.create);
router.put('/staff/:id', adminAuth, requireSuperAdmin, staff.update);
router.delete('/staff/:id', adminAuth, requireSuperAdmin, staff.remove);
router.put('/staff/:id/toggle', adminAuth, requireSuperAdmin, staff.toggle);

// ============= 风采展示 · 合并入口（社干 + 部员，仅超管） =============
/**
 * @swagger
 * /api/admin/showcase/list:
 *   get:
 *     tags: [管理端-风采展示]
 *     summary: 社干与部员的合并列表（归一化字段，供后台一个页面使用）
 *     description: |
 *       把 cadre 与 staff 两张表映射成同一形状：`{id,type,name,avatar,subtitle,isShow}`，
 *       其中 `subtitle` 社干取职务、部员取部门。
 *       **只是读接口的合并，不是合表** —— 原有 /admin/cadre/* 与 /admin/staff/* 保持不变，
 *       小程序 `/api/user/showcase` 也不受影响。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [all, cadre, staff], default: all }
 *       - in: query
 *         name: keyword
 *         schema: { type: string }
 *         description: 按姓名 / 职务 / 部门 / 年级 / 负责栏目模糊匹配
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 50, maximum: 200 }
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
 *                         list:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: integer }
 *                               type: { type: string, enum: [cadre, staff] }
 *                               name: { type: string }
 *                               avatar: { type: string }
 *                               subtitle: { type: string }
 *                               role: { type: string }
 *                               department: { type: string }
 *                               programs: { type: string }
 *                               isShow: { type: integer, enum: [0, 1] }
 *                         total: { type: integer }
 *                         counts: { type: object, properties: { cadre: { type: integer }, staff: { type: integer }, all: { type: integer } } }
 *                         onShow: { type: object }
 *       400: { description: type 参数不合法 }
 */
router.get('/showcase/list', adminAuth, requireSuperAdmin, showcase.list);

/**
 * @swagger
 * /api/admin/showcase/{type}/{id}/toggle:
 *   put:
 *     tags: [管理端-风采展示]
 *     summary: 切换显示 / 隐藏（社干与部员共用）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema: { type: string, enum: [cadre, staff] }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: ok }
 *       400: { description: type 参数不合法 }
 *       404: { description: 成员不存在 }
 */
router.put('/showcase/:type/:id/toggle', adminAuth, requireSuperAdmin, showcase.toggle);

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

// ============= 学生账号（导入分发 / 列表 / 导出 / 重置，仅超管） =============
/**
 * ⚠️ 路由顺序（踩过的坑，别动）：
 *    凡路径里含字面量段（import / template / list / stats / export / batches / grades / grade / reset-password）
 *    的接口，都必须注册在 `/student/:id` **之前**，否则会被 `:id` 吃掉。
 *    （`/student/grade/:grade` 是两段，本身不会撞 `/student/:id`，但为省心一律排前面）
 */
/**
 * @swagger
 * /api/admin/student/import/preview:
 *   post:
 *     tags: [管理端-学生账号]
 *     summary: 上传名册并预览（只解析，不写库）
 *     description: |
 *       表格只需含「年级 / 班级 / 序号」，第 4 列姓名可选。
 *       自动识别表头（认不到就按前 3 列顺序）、自动归一化（2024级/24 → 2024，1班 → 01，第5 → 05）。
 *       返回每行结论：`new` 新建 / `update` 覆盖（未激活）/ `active` 已激活受保护 / `invalid` 异常。
 *       同时回传 `rawRows`，确认导入时原样回传即可。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: 解析完成（未写库） }
 *       400: { description: 文件类型 / 大小 / 列识别失败 }
 */
router.post('/student/import/preview', adminAuth, requireSuperAdmin, uploadExcel, student.importPreview);

/**
 * @swagger
 * /api/admin/student/import/commit:
 *   post:
 *     tags: [管理端-学生账号]
 *     summary: 确认导入（服务端会重新解析 + 重新校验）
 *     description: |
 *       接收 `rows`（预览时回传的原始二维数组）+ `filename`。
 *       服务端不信任前端结论，会重新解析并重新查库，落库整批同一事务。
 *       `force=true` 时「已激活」的账号也允许覆盖（但不会覆盖其密码）。
 *       `strict=true` 时只要有异常行就拒绝整批。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows]
 *             properties:
 *               rows: { type: array, items: { type: array, items: { type: string } } }
 *               filename: { type: string }
 *               force: { type: boolean, default: false }
 *               strict: { type: boolean, default: false }
 *     responses:
 *       200: { description: 返回 batchId 与新建 / 更新 / 跳过 / 异常 计数 }
 *       400: { description: 行数超限 / 严格模式下有异常行 }
 */
router.post('/student/import/commit', adminAuth, requireSuperAdmin, student.importCommit);

/**
 * @swagger
 * /api/admin/student/template:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 下载导入模板 xlsx
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: xlsx 文件流 }
 */
router.get('/student/template', adminAuth, requireSuperAdmin, student.template);

/**
 * @swagger
 * /api/admin/student/list:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 学生账号列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: keyword, schema: { type: string }, description: 账号 / 姓名模糊 }
 *       - { in: query, name: grade, schema: { type: string } }
 *       - { in: query, name: classNo, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: integer, enum: [0, 1] } }
 *       - { in: query, name: activated, schema: { type: integer, enum: [0, 1] }, description: 1=已改密 0=仍是初始密码 }
 *       - { in: query, name: batchId, schema: { type: integer } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: ok }
 */
router.get('/student/list', adminAuth, requireSuperAdmin, student.list);

/**
 * @swagger
 * /api/admin/student/stats:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 按年级 / 班级汇总激活进度（总数 / 已激活 / 未激活）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/student/stats', adminAuth, requireSuperAdmin, student.stats);

/**
 * @swagger
 * /api/admin/student/export:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 导出学生账号 xlsx（含初始密码）
 *     description: |
 *       「初始密码」列只在学生**仍是初始密码**时有值；已改密的行留空（哈希不可逆，导不出来）。
 *       支持按年级 / 班级 / 批次 / `activated=0`（仅未激活）筛选。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: xlsx 文件流 }
 *       404: { description: 没有符合条件的账号 }
 */
router.get('/student/export', adminAuth, requireSuperAdmin, student.exportXlsx);

/**
 * @swagger
 * /api/admin/student/grades:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 按年级汇总（账号按年级分类查询的入口）
 *     description: 返回每个年级的 账号总数 / 已激活 / 未激活 / 停用 / 班级数。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/student/grades', adminAuth, requireSuperAdmin, student.grades);

/**
 * @swagger
 * /api/admin/student/grade/{grade}:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 某年级明细 + 毕业清理试算（只读）
 *     description: |
 *       返回该年级账号总数、班级分布、以及清理试算：
 *       `canDelete` = 可直接删除的个数，`withSubmit` = 有投稿记录、只会被停用的个数。
 *       点「毕业清理」前用它渲染确认框。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 *       404: { description: 该年级没有账号 }
 */
router.get('/student/grade/:grade', adminAuth, requireSuperAdmin, student.gradeDetail);

/**
 * @swagger
 * /api/admin/student/grade/{grade}:
 *   delete:
 *     tags: [管理端-学生账号]
 *     summary: 整届清理 —— 一键删除该年级所有账号
 *     description: |
 *       body.mode:
 *       · `safe`（默认）：没有投稿记录的硬删；有投稿记录的改停用（投稿审核记录仍指向该账号）。
 *       · `disable`：一个都不删，整届停用。
 *       · `purge`：全删（危险），必须把年级原样填进 body.confirm 才放行。
 *       执行后该届所有账号的登录态立即失效（缓存作废，不等 30 秒）。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 返回 deleted / disabled / total }
 *       400: { description: purge 未确认 }
 *       404: { description: 该年级没有账号 }
 */
router.delete('/student/grade/:grade', adminAuth, requireSuperAdmin, student.removeGrade);

/**
 * /api/admin/student/cleanup/last:
 *   get:
 *     summary: 最近一次整届清理的回执（v8「清理完成」屏）
 *     description: |
 *       返回：执行时间 / 执行人 / 模式 / 删除数 / 停用数 / 涉及班级 / 耗时 / 未受影响数 /
 *       被停用的账号清单（用于「查看停用的 N 个」与导出清理回执）。
 *     tags: [管理端-学生账号]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: grade
 *         schema: { type: string }
 *         description: 不传则取全局最近一次
 *     responses:
 *       200: { description: ok，没有回执时 data 为 null }
 */
router.get('/student/cleanup/last', adminAuth, requireSuperAdmin, student.cleanupLast);

/**
 * @swagger
 * /api/admin/student/batches:
 *   get:
 *     tags: [管理端-学生账号]
 *     summary: 导入批次列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.get('/student/batches', adminAuth, requireSuperAdmin, student.batches);

/**
 * @swagger
 * /api/admin/student/reset-password/batch:
 *   post:
 *     tags: [管理端-学生账号]
 *     summary: 批量重置密码为 usr123456
 *     description: 传 `ids` 数组，或传 `grade` / `classNo` 按班级重置；两者都不传会被拒绝（防手滑全量重置）。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 返回受影响条数 }
 *       400: { description: 未指定范围 }
 */
router.post('/student/reset-password/batch', adminAuth, requireSuperAdmin, student.resetPasswordBatch);

/**
 * @swagger
 * /api/admin/student/status/batch:
 *   post:
 *     tags: [管理端-学生账号]
 *     summary: 批量启用 / 停用学生账号
 *     description: |
 *       一次 UPDATE 改掉整批状态并作废登录态（逐个 PUT `/student/{id}/status` 在几百个账号时会变成几百个请求）。
 *       管理端「批量操作范围＝筛选结果」走的就是它。一次最多 500 个。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 返回 affected }
 *       400: { description: 未勾选账号 / 超过 500 个 / 缺 status }
 */
router.post('/student/status/batch', adminAuth, requireSuperAdmin, student.setStatusBatch);

/**
 * @swagger
 * /api/admin/student/batch/{id}/rollback:
 *   post:
 *     tags: [管理端-学生账号]
 *     summary: 撤销一个导入批次
 *     description: |
 *       只删本批次里「仍未激活」且「没有投稿记录」的账号；
 *       已激活（学生正在用）和有投稿记录的会保留。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 返回 removed / keptActivated / keptWithSubmit }
 */
router.post('/student/batch/:id/rollback', adminAuth, requireSuperAdmin, student.rollback);

/**
 * /api/admin/student/delete/batch:
 *   post:
 *     summary: 批量删除学生账号（仅超管）
 *     description: |
 *       按权限边界表「不可逆批量 = 超管」，本接口仅超管可调（requireSuperAdmin）。
 *       逐条复用单条删除的规则：无投稿记录 → 真删；有投稿记录 → 改为「停用」。
 *       body: { ids: number[] }，一次最多 200 个。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok，data = { total, deleted, disabled, failed[] } }
 */
router.post('/student/delete/batch', adminAuth, requireSuperAdmin, student.removeBatch);

/**
 * @swagger
 * /api/admin/student/{id}:
 *   put:
 *     tags: [管理端-学生账号]
 *     summary: 修改学生账号（备注 / 年级 / 班级 / 序号 / 状态）
 *     description: |
 *       改三元组会重算账号，并把该学生的投稿 / 留言 / 已确认记录一并迁到新账号，避免「我的投稿」变空。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 *       409: { description: 目标账号已存在 }
 */
router.put('/student/:id', adminAuth, requireSuperAdmin, student.update);

/**
 * @swagger
 * /api/admin/student/{id}/status:
 *   put:
 *     tags: [管理端-学生账号]
 *     summary: 启用 / 停用账号（停用后该学生最多 30 秒被踢下线）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.put('/student/:id/status', adminAuth, requireSuperAdmin, student.setStatus);

/**
 * @swagger
 * /api/admin/student/{id}/reset-password:
 *   put:
 *     tags: [管理端-学生账号]
 *     summary: 重置单个账号密码为 usr123456
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok }
 */
router.put('/student/:id/reset-password', adminAuth, requireSuperAdmin, student.resetPassword);

/**
 * @swagger
 * /api/admin/student/{id}:
 *   delete:
 *     tags: [管理端-学生账号]
 *     summary: 删除学生账号（有投稿记录时改为停用，不硬删）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: ok，data.deleted 区分删了还是只停用 }
 */
router.delete('/student/:id', adminAuth, requireSuperAdmin, student.remove);

module.exports = router;
