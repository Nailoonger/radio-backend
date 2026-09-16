# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**菁悠广播站** — 高中校园广播站微信小程序 + 管理后台 Web + Node 后端全栈项目。站名"菁悠广播站"，口号"菁菁校园情，悠悠广播声"。

技术栈：
- 后端：Node 20 + Express + Sequelize（MySQL 8 / SQLite 双支持）
- 管理后台：Vue 3 + Vite + Element Plus + Pinia + ECharts
- 小程序：原生 WXML/WXSS/JS（无第三方框架）
- 部署：Docker Compose（4 容器：mysql / backend / admin-web / nginx）

## 常用命令

```bash
# 启动 / 停止 / 清空全栈
powershell -File deploy/start.ps1
powershell -File deploy/stop.ps1
powershell -File deploy/clean.ps1      # ⚠️ 删除所有数据

# 查看日志
powershell -File deploy/logs.ps1
docker logs radio-backend --tail=100 -f

# 跑测试
npx jest                            # 全量（56 个用例）
npx jest tests/switch.test.js       # 单文件
npx jest --watch                    # watch 模式

# 改代码后重新构建
docker compose build radio-backend   # 后端
cd admin-web && npm run build && cd ..   # ⚠️ admin-web 本地先 build
docker compose build admin-web      # 然后 build 镜像

# 热加载 nginx（不用重启）
docker exec radio-nginx nginx -s reload

# MySQL CLI
docker exec -it radio-mysql mysql -uroot -proot123 radio_station
```

## 架构

### 后端 `src/`

```
src/
├── app.js                  # 入口：加载中间件 + 路由 + 启动 Swagger + 预热 switch
├── config/                 # 配置 + Sequelize 初始化（MySQL/SQLite 双 dialect）
├── models/                 # 9 张表
│   ├── user.js             # 学生（openid 唯一）
│   ├── admin.js            # 管理员（role: 0=超管 1=社员）
│   ├── submit.js           # 投稿/点歌（type: 1=点歌 2=文稿）
│   ├── program.js          # 节目（⚠️ broadcast_date 是 weekly 接口过滤字段，NULL 会导致不显示）
│   ├── notice.js           # 公告
│   ├── message.js          # 留言
│   ├── systemSetting.js    # KV 设置（广播站介绍/开播时间/联系方式）
│   ├── member.js           # 风采展示成员
│   └── systemSwitch.js     # 模块开关（submit_song/submit_article/message/member）
├── controllers/
│   ├── user/               # 小程序端接口（公开 + 需登录）
│   └── admin/              # 后台管理接口（需 JWT + 角色）
├── services/
│   ├── wechatService.js    # code2session + msgSecCheck（内容安全）
│   ├── accessTokenService.js # 微信全局 access_token 缓存
│   └── switchService.js    # 模块开关 30s 内存缓存 + assertEnabled 拦截
├── routes/                  # 带 @swagger 注解（OpenAPI 3.0）
├── middlewares/
│   ├── auth.js             # userAuth / adminAuth（JWT）
│   ├── permission.js       # requireAdmin / requireSuperAdmin
│   ├── rateLimit.js        # 登录/投稿/留言限流
│   ├── requestId.js        # X-Request-Id 中间件
│   ├── errorHandler.js     # 全局错误处理（catch ApiError）
│   └── upload.js           # multer 头像上传（2MB + jpg/png/webp）
└── docs/swagger.js         # Swagger UI
```

**关键业务规则：**
- 投稿 1 分钟内同 openid 重复内容只允许一次
- 模块开关写入接口（POST /api/user/submit, message）会拦截；读取接口（list/detail）不受影响
- 错误码 `40302 MODULE_DISABLED` = 模块已关闭
- JWT 默认 7 天过期
- 微信 access_token 自动缓存到内存

### 管理后台 `admin-web/`

```
admin-web/src/
├── App.vue
├── main.js
├── views/                  # 10 个页面
│   ├── Login.vue           # 双卡片布局（表单 + 校园插画 SVG + 楷体站名 PNG）
│   ├── Dashboard.vue       # 数据看板（4 分组 × 2 卡）
│   ├── SubmitList.vue      # 投稿审核（单条 + 批量）
│   ├── Program.vue         # 栏目管理（替代旧的"节目排期"）
│   ├── Notice.vue / Message.vue
│   ├── Member.vue          # 风采展示（CRUD + 头像上传）
│   ├── Switch.vue          # 模块开关
│   ├── Account.vue         # 管理员账号（仅超管）
│   └── Setting.vue         # 系统 KV 设置（仅超管）
├── components/
│   ├── StatusTag.vue       # 状态标签（统一封装）
│   ├── EmptyState.vue      # 空状态
│   └── icons/              # 30+ 自建 SVG 图标
├── layouts/MainLayout.vue  # 侧栏 + 顶部 header
├── stores/auth.js          # Pinia：token + admin + login/logout
└── styles/theme.css        # 全局主题（青蓝渐变 + 玻璃拟态）
```

**注意：** admin-web 镜像构建**需要本地先 `npm run build`**！容器内 npm build 会因 native 模块（rollup/win32）失败。Dockerfile 已改为只 COPY dist/。

### 小程序 `miniprogram/`

```
miniprogram/
├── app.js                  # globalData: baseURL / token / switches
├── app.json                # 4 个 tabBar + 9 个页面路由
├── pages/                  # 9 个页面
│   ├── index/              # 首页（节目 + 公告 + 投稿入口）
│   ├── submit/             # 投稿/点歌表单
│   ├── members/            # 风采展示（按职务分 tab）
│   ├── mySubmit/           # 我的投稿
│   ├── about/              # 广播站介绍
│   ├── login/ noticeDetail/ programDetail/ memberDetail/
├── utils/
│   ├── request.js          # 统一 wx.request 封装（懒获取 app 实例）
│   └── format.js
└── assets/                 # tabBar 图标（4 个 PNG）+ 站徽
```

**关键约束：**
- 模拟器只能走 `127.0.0.1:80`（不能走 `3000`，因为 Docker backend 端口不暴露到主机）
- 真机扫码用电脑 LAN IP（如 `http://192.168.1.100:80/api`）
- HSTS 会让 Chrome 自动给 localhost 加 `https://`，**必须用 IP 或无痕窗口**

### 数据库 `sql/schema.sql`

**关键约束：**
- 9 张表，CHARACTER SET utf8mb4
- `program.broadcast_date` 必填，否则 `weekly/schedule` 接口按日期范围过滤返回空
- `schema.sql` 首启动自动执行（first-boot 触发）
- 集成时务必保证 `sql/schema.sql` 与 Sequelize 模型同步（包括 `member` / `system_switch`）

## Docker 部署

```
docker-compose.yml        # 4 服务编排
├── radio-mysql           # mysql:8.0（持久化 data/mysql）
├── radio-backend         # 我们的 Node 后端（监听 3000 内部）
├── radio-admin-web       # nginx + Vue dist
└── radio-nginx           # 80 + 443 反代入口

deploy/
├── nginx.conf            # 统一入口：80 跳 443 + 自签证书 + 反代 4 路径
├── nginx-admin.conf      # admin-web 容器内的 nginx
├── wait-for-mysql.sh     # 等 MySQL TCP 通后再启动 Node
├── gen-selfsigned.{sh,ps1}  # 生成 10 年自签证书
└── start/stop/clean/logs.{sh,ps1}
```

**URL 路由：**
- `/` → admin-web（Vue SPA）
- `/api/*` → radio-backend:3000
- `/uploads/*` → radio-backend:3000（头像）
- `/api-docs/*` → radio-backend:3000

**Edge HSTS 问题：** 用 `http://127.0.0.1/` 不要用 `http://localhost/`，否则浏览器强制 HTTPS 走自签证书失败。

## 关键决策（不要违反）

| 决策 | 原因 |
|---|---|
| admin-web Dockerfile 只 COPY dist/ | 容器内 npm build 因 rollup native 模块失败 |
| 启动后立即 `seedAll()` 自动建默认超管 | teacher/admin123456（已 bcrypt）|
| `module_disabled` 错误码 40302 | 区别于普通 40301 禁止 |
| 模块开关缓存 30 秒 + set 时立即预热 | 减少 DB 查询 |
| 头像用本地 /uploads（不上云）| 学习场景简化 |
| PostgreSQL→MySQL 用 ORM 切换 .env 即可 | 已支持 dual dialect |

## 提交规范

Conventional Commits：
```
feat(backend): 添加超管自保护逻辑
fix(miniprogram): 修复首页公告 404
style(admin-web): 优化 Dashboard 顶部 8 卡
docs: 补充 Docker 部署章节
chore(deps): 升级 echarts 到 6.1
```

中文 subject，动词开头，≤ 30 字。

## 测试

- 后端：`tests/*.test.js` — Jest + supertest + 内存 SQLite
- 测试覆盖：登录 / 投稿 / 审核 / RBAC / 风采 / 模块开关
- 提交前必跑 `npx jest`，56 个用例全绿

## 常见陷阱

1. **小程序模拟器看不到数据** → baseURL 用 `http://127.0.0.1:80/api`（不是 3000！）
2. **Docker build 卡住** → 检查 `.vite` 缓存、`node_modules/.vite` 是否被锁
3. **MySQL 启动后第一次慢** → `wait-for-mysql.sh` 已在用，但首次数据卷初始化要 30s+
4. **schema.sql 改了不生效** → MySQL 数据卷已存在；删 `data/mysql/` 重建或只补字段
5. **admin-web 看不到新代码** → 必须本地 build 后再 `docker compose build admin-web`
