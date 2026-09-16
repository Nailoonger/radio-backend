# 风采展示模块 Plan

## 架构概览

在现有 Express 后端 + 小程序 + 管理后台三层架构上新增：

- **后端**：新增一张 `member` 表 + 两个 controller（admin CRUD / user list-detail）+ 一个 upload 中间件
- **小程序**：新增一个 tabBar 页面 `pages/members/members` + 详情页 `pages/memberDetail/memberDetail`
- **管理后台**：新增一个侧栏菜单「风采展示」+ 一个视图 `Member.vue`

## 核心数据结构

### Member（数据模型）

```
Member {
  id          INTEGER PK AUTOINCREMENT
  name        STRING(32)   NOT NULL     // 姓名
  role        STRING(32)   NOT NULL     // 职务：社长 / 主播 / 编辑 / 技术员 ...
  grade       STRING(32)   NOT NULL     // 年级班级，如 "高三(2)班"
  programs    STRING(200)  NOT NULL     // 负责栏目（逗号分隔文本）
  avatar      STRING(512)  NOT NULL     // 头像 URL（/uploads/avatars/...）
  motto       STRING(200)  NULL         // 座右铭 / 个人简介
  sort        INTEGER      DEFAULT 0    // 排序权重，大者靠前
  isShow      INTEGER      DEFAULT 1    // 1=展示 0=隐藏
  createTime  DATE         NOW
  updateTime  DATE         NOW
}
```

### 上传响应

```
{
  url: "/uploads/avatars/2026-09/1726001234567-abc123.jpg",
  filename: "1726001234567-abc123.jpg",
  size: 123456,
  mimetype: "image/jpeg"
}
```

## 模块设计

### 后端：src/models/member.js
- Sequelize 模型工厂函数
- 字段同上面定义
- 索引：`[{ fields: ['isShow', 'sort'] }]`（列表常用排序）
- 不需要关联关系

### 后端：src/controllers/admin/memberController.js
- `list(req, res)` — 分页 + 模糊搜索 + 职务筛选
- `detail(req, res)` — 详情
- `create(req, res)` — 新增
- `update(req, res)` — 编辑
- `remove(req, res)` — 删除
- `toggle(req, res)` — 切换 isShow

### 后端：src/controllers/user/memberController.js
- `list(req, res)` — 仅 isShow=1，按职务分组结构返回（前端 tab 用）
- `detail(req, res)` — 单个成员详情，仅 isShow=1

### 后端：src/middlewares/upload.js
- multer 单文件中间件
- 存储到 `./uploads/avatars/yyyy-mm/`
- 文件名：`Date.now() + '-' + randomStr + ext`
- MIME 过滤：image/jpeg|png|webp
- 大小限制：2MB

### 后端：src/routes/admin.js
- 新增 `POST /upload/avatar` — 头像上传
- 新增 `/member/list`、`/member/create`、`/member/:id`、`/member/:id/toggle` 等

### 后端：src/routes/user.js
- 新增 `/member/list`（带 query ?role=）
- 新增 `/member/:id`

### 后端：src/app.js
- 挂载 `app.use('/uploads', express.static(path.join(__dirname, '../uploads')))`

### 小程序：pages/members/members
- 顶部 tab 横向滚动（全部 / 社长 / 主播 / 编辑 / 技术员）
- 列表卡片：圆形头像 + 姓名 + 职务 + 年级
- 点击进详情页

### 小程序：pages/memberDetail/memberDetail
- 顶部大头像
- 姓名 + 职务 + 年级
- 栏目列表（按逗号切分）
- 座右铭（如果有）

### 小程序：app.json
- pages 数组新增 `pages/members/members`、`pages/memberDetail/memberDetail`
- tabBar.list 改成 4 项：首页 / 投稿 / 风采 / 我的

### 管理后台：admin-web/src/views/Member.vue
- 表格 + 顶部表单（搜索）
- 新增/编辑弹窗（含头像上传组件）
- 切换展示开关

### 管理后台：admin-web/src/router/index.js
- 新增 `/member` 路由 + `meta.superAdmin = true`

### 管理后台：admin-web/src/layouts/MainLayout.vue
- 侧栏新增「风采展示」菜单项

## 模块交互

```
管理后台 Member.vue
  ↓ POST /api/admin/upload/avatar (multipart)
  ↓ 拿到 url 填到表单
  ↓ POST /api/admin/member/create (json)
  ↓ 数据库写入

小程序 pages/members/members
  ↓ GET /api/user/member/list
  ↓ 按 role 分组渲染 tab + 卡片

小程序 pages/memberDetail/memberDetail
  ↓ GET /api/user/member/:id
  ↓ 渲染详情
```

## 文件组织

```
radio-backend/
├── src/
│   ├── app.js                            # +express.static('/uploads')
│   ├── models/member.js                  # NEW
│   ├── controllers/
│   │   ├── admin/memberController.js     # NEW
│   │   └── user/memberController.js      # NEW
│   ├── middlewares/upload.js             # NEW (multer)
│   ├── routes/
│   │   ├── admin.js                      # +upload + member CRUD
│   │   └── user.js                       # +member list/detail
│   └── docs/swagger.js                   # +Member schema + tag
├── tests/
│   └── member.test.js                    # NEW (10 个测试对应 AC)
├── uploads/                              # NEW（运行时创建，.gitignore）
├── miniprogram/
│   ├── app.json                          # +tabBar 4 项 + 2 个页面
│   ├── pages/
│   │   ├── members/members.{js,wxml,wxss,json}    # NEW
│   │   └── memberDetail/memberDetail.{js,wxml,wxss,json}  # NEW
│   └── assets/
│       ├── member.png                    # NEW (tabBar 图标)
│       └── member-active.png             # NEW
└── admin-web/
    └── src/
        ├── router/index.js               # +/member 路由
        ├── layouts/MainLayout.vue        # +菜单项
        └── views/Member.vue              # NEW (CRUD + 上传)
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 头像存储 | 本地 `./uploads/`，Express 静态服务 | 用户已选；零成本、零外部依赖；Docker 部署时挂卷 |
| 上传中间件 | multer 1.x | Express 生态最成熟；支持 disk storage + 自定义文件名 |
| 字段类型 | programs 存文本（逗号分隔）而非 JSON | 简单、无须关联；用户已选不关联节目 |
| 删除 | 硬删除（destroy） | 用户已选；不上 soft delete 字段 |
| 表单上传 | Element Plus `el-upload`，HTTP request 走 axios | 现有 http.js 已配好；el-upload 自动 multipart |
| 列表分页 | 默认 pageSize=20，按 sort DESC, id DESC | 与现有 program/notice 列表一致 |
| 字段长度 | 姓名/职务 32、年级 32、栏目 200、座右铭 200、头像 URL 512 | 充分且不冗余 |
| API 路径 | `/api/admin/member`、`/api/user/member` | 与现有命名一致（注意不是 members 复数） |
| tabBar 数量 | 4 项 | 微信限制 2-5 项；选 4 个给「风采」一个独立入口 |
| 职务分类（默认） | 全部 / 社长 / 主播 / 编辑 / 技术员 | 高中广播站常见职务；后续后台可任意改 role 字段 |
| 排序 | sort DESC, id DESC | 权重高的在前；同 sort 时新加的在前 |
| 表单校验 | 前端 el-form rules + 后端 throw ApiError | 双保险 |
| 上传校验时机 | 后端 multer 拦截（fileFilter + limits） | 节省带宽；前端只做 UI 反馈 |

## 被否决的方案

| 备选 | 否决理由 |
|---|---|
| 头像用七牛 / 腾讯云 COS | 用户已选本地；外部服务需配置密钥 |
| members 关联 admin 表（让管理员也是成员） | 用户已选"独立"；范围越界 |
| 头像 base64 入库 | 文件大、BLOB 备份麻烦；URL + 文件分离更通用 |
| 把栏目存 JSON 数组 | 用户已选不关联；纯文本字段够用，省关联表 |
| 软删除（deletedAt 字段） | 用户已选硬删除 |

## 技术债声明

- uploads 目录未做 CDN；大量访问时本地 IO 是瓶颈
- 没有头像压缩/裁剪；用户传大图直接保存
- 没有缩略图；列表和详情都展示原图
- 上传接口目前无频控（可能被恶意刷）；建议后续接 rate-limit

## 验收对应

| 验收 | 实现位置 |
|---|---|
| AC1 超管菜单可见 | MainLayout.vue + router/index.js |
| AC2 新增可见 | admin/memberController.create + Member.vue |
| AC3 模糊搜索 | admin/memberController.list (Op.like) |
| AC4 5MB 拒绝 | middlewares/upload.js (limits) |
| AC5 非图拒绝 | middlewares/upload.js (fileFilter) |
| AC6 tab 第 4 项 | app.json + pages/members |
| AC7 职务筛选 | user/memberController.list (group by role) |
| AC8 详情页 | pages/memberDetail |
| AC9 切换立即生效 | admin/memberController.toggle + 后端 where 过滤 |
| AC10 静态可访问 | app.js (express.static) |
