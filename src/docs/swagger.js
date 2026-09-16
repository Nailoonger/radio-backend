'use strict';

const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

// swagger-jsdoc 在 Windows 下要求 glob 用正斜杠
const ROUTES_GLOB = path.join(__dirname, '..', 'routes', '*.js').replace(/\\/g, '/');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '菁悠广播站 API',
      version: '1.0.0',
      description: '菁悠广播站微信小程序 + 管理后台 后端 API 文档',
      contact: { name: '菁悠广播站开发组' },
    },
    servers: [{ url: 'http://localhost:3000', description: '本地' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        // ============ 通用 ============
        ApiResponse: {
          type: 'object',
          properties: {
            code: { type: 'integer', example: 0, description: '0=成功，非0=业务错误' },
            message: { type: 'string', example: 'ok' },
            data: { type: 'object', nullable: true },
          },
        },
        PageQuery: {
          type: 'object',
          properties: {
            page: { type: 'integer', example: 1 },
            pageSize: { type: 'integer', example: 10 },
          },
        },
        PageResult: {
          type: 'object',
          properties: {
            list: { type: 'array', items: { type: 'object' } },
            total: { type: 'integer' },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
          },
        },

        // ============ 用户端 ============
        User: {
          type: 'object',
          properties: {
            openid: { type: 'string', example: 'mock_abc123' },
            nickname: { type: 'string', example: '同学' },
            avatar: { type: 'string', example: 'https://...' },
          },
        },
        LoginRequest: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', description: 'wx.login() 返回的 code' },
            nickname: { type: 'string' },
            avatar: { type: 'string' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        SubmitSongRequest: {
          type: 'object',
          required: ['type', 'songName', 'singer'],
          properties: {
            type: { type: 'integer', enum: [1, 2], example: 1 },
            songName: { type: 'string', example: '起风了' },
            singer: { type: 'string', example: '买辣椒也用券' },
            wishContent: { type: 'string', example: '毕业快乐' },
            wantBroadcastTime: { type: 'string', example: '2026-09-15 午间' },
          },
        },
        SubmitArticleRequest: {
          type: 'object',
          required: ['type', 'articleTitle', 'articleContent'],
          properties: {
            type: { type: 'integer', enum: [2], example: 2 },
            articleTitle: { type: 'string' },
            articleContent: { type: 'string' },
            wantBroadcastTime: { type: 'string' },
          },
        },
        Submit: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            openid: { type: 'string' },
            type: { type: 'integer', description: '1=点歌 2=文稿' },
            songName: { type: 'string', nullable: true },
            singer: { type: 'string', nullable: true },
            wishContent: { type: 'string', nullable: true },
            articleTitle: { type: 'string', nullable: true },
            articleContent: { type: 'string', nullable: true },
            wantBroadcastTime: { type: 'string', nullable: true },
            status: { type: 'integer', description: '0=待审核 1=已通过 2=已驳回' },
            rejectReason: { type: 'string', nullable: true },
            reviewerId: { type: 'integer', nullable: true },
            reviewTime: { type: 'string', format: 'date-time', nullable: true },
            createTime: { type: 'string', format: 'date-time' },
          },
        },
        MessageRequest: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', maxLength: 500 },
            programId: { type: 'integer', nullable: true },
          },
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            openid: { type: 'string' },
            programId: { type: 'integer', nullable: true },
            nickname: { type: 'string' },
            avatar: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'integer' },
            rejectReason: { type: 'string', nullable: true },
            createTime: { type: 'string', format: 'date-time' },
          },
        },
        Program: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            host: { type: 'string', nullable: true },
            broadcastTime: { type: 'string' },
            broadcastDate: { type: 'string', format: 'date', nullable: true },
            desc: { type: 'string', nullable: true },
            cover: { type: 'string', nullable: true },
            isShow: { type: 'integer' },
            isLive: { type: 'integer' },
            sort: { type: 'integer' },
          },
        },
        Notice: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            content: { type: 'string' },
            isTop: { type: 'integer' },
            isShow: { type: 'integer' },
            publisherId: { type: 'integer', nullable: true },
            publishTime: { type: 'string', format: 'date-time' },
          },
        },

        // ============ 管理端 ============
        AdminLoginRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', example: 'teacher' },
            password: { type: 'string', example: 'admin123456' },
          },
        },
        Admin: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            username: { type: 'string' },
            nickname: { type: 'string', nullable: true },
            role: { type: 'integer', description: '0=超管 1=社员' },
            status: { type: 'integer' },
            lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        BatchSubmitRequest: {
          type: 'object',
          required: ['ids', 'action'],
          properties: {
            ids: { type: 'array', items: { type: 'integer' } },
            action: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string', description: '驳回时必填' },
          },
        },
        ProgramUpsertRequest: {
          type: 'object',
          required: ['title', 'broadcastTime'],
          properties: {
            title: { type: 'string' },
            host: { type: 'string' },
            broadcastTime: { type: 'string', example: '周一 12:30-13:00' },
            broadcastDate: { type: 'string', format: 'date' },
            desc: { type: 'string' },
            cover: { type: 'string' },
            isShow: { type: 'integer' },
            sort: { type: 'integer' },
          },
        },
        NoticeUpsertRequest: {
          type: 'object',
          required: ['title', 'content'],
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            isTop: { type: 'integer' },
            isShow: { type: 'integer' },
          },
        },
        SystemSetting: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            key: { type: 'string' },
            value: { type: 'string' },
            desc: { type: 'string', nullable: true },
          },
        },
        SettingUpsertRequest: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            desc: { type: 'string' },
          },
        },
        Member: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            role: { type: 'string', description: '职务，如 社长 / 主播 / 编辑 / 技术员' },
            grade: { type: 'string', description: '年级班级，如 高三(2)班' },
            programs: { type: 'string', description: '负责栏目，逗号分隔' },
            avatar: { type: 'string', description: '头像 URL（/uploads/avatars/...）' },
            motto: { type: 'string', nullable: true, description: '座右铭 / 个人简介' },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },
        MemberUpsertRequest: {
          type: 'object',
          required: ['name', 'role', 'avatar'],
          properties: {
            name: { type: 'string', maxLength: 32 },
            role: { type: 'string', maxLength: 32 },
            grade: { type: 'string', maxLength: 32 },
            programs: { type: 'string', maxLength: 200 },
            avatar: { type: 'string', maxLength: 512 },
            motto: { type: 'string', maxLength: 200 },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },
        Switch: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            key: { type: 'string', example: 'submit_song' },
            value: { type: 'string', enum: ['on', 'off'] },
            desc: { type: 'string' },
            updatedBy: { type: 'integer', nullable: true },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        SwitchUpdateRequest: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string', enum: ['on', 'off'] } },
        },
      },
    },
    tags: [
      { name: '通用' },
      { name: '用户端-登录' },
      { name: '用户端-投稿' },
      { name: '用户端-留言' },
      { name: '用户端-节目' },
      { name: '用户端-公告' },
      { name: '用户端-个人中心' },
      { name: '用户端-风采展示' },
      { name: '用户端-模块开关' },
      { name: '管理端-登录' },
      { name: '管理端-账号' },
      { name: '管理端-投稿审核' },
      { name: '管理端-节目排期' },
      { name: '管理端-公告管理' },
      { name: '管理端-留言审核' },
      { name: '管理端-数据统计' },
      { name: '管理端-系统设置' },
      { name: '管理端-账号管理' },
      { name: '管理端-风采展示' },
      { name: '管理端-模块开关' },
    ],
  },
  apis: [ROUTES_GLOB],
};

module.exports = swaggerJsdoc(options);
