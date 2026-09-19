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
├── models/                 # 11 张表
│   ├── user.js             # 学生（openid 唯一）
│   ├── admin.js            # 管理员（role: 0=超管 1=社员）
│   ├── submit.js           # 投稿/点歌（type: 1=点歌 2=文稿）
│   ├── program.js          # 节目（⚠️ broadcast_date 是 weekly 接口过滤字段，NULL 会导致不显示）
│   ├── notice.js           # 公告
│   ├── message.js          # 留言
│   ├── systemSetting.js    # KV 设置（广播站介绍/开播时间/联系方式）
│   ├── cadre.js            # 社干（站长/副站长/纪检长/站长助理，无部门字段）
│   ├── staff.js            # 部门人员（播音部/主持部/编辑部，含 department + programs）
│   ├── member.js           # ⚠️ 已废弃（被 cadre + staff 取代，接口仍挂载未删）
│   └── systemSwitch.js     # 模块开关（submit_song/submit_article/message/member）
├── controllers/
│   ├── user/               # 小程序端接口（公开 + 需登录）
│   │   ├── showcaseController.js   # GET /showcase 风采聚合（cadre + staff 按部门分组）
│   │   ├── cadreController.js      # GET /cadre/:id 社干详情
│   │   └── staffController.js      # GET /staff/:id 部员详情
│   └── admin/              # 后台管理接口（需 JWT + 角色）
│       ├── cadreController.js      # 社干 CRUD（admin/cadre/*）
│       └── staffController.js      # 部员 CRUD（admin/staff/*）
├── services/
│   ├── wechatService.js    # code2session + msgSecCheck（内容安全）
│   ├── accessTokenService.js # 微信全局 access_token 缓存
│   ├── switchService.js    # 模块开关 30s 内存缓存 + assertEnabled 拦截
│   ├── bjTime.js           # ⚠️ 北京时间工具（日/周切点统一走它，新代码禁止裸 dayjs() 算日周）
│   ├── songQuotaService.js # 点歌名额：一条带条件 UPDATE 占位 + 唯一键 + 事务内占位（设计见 docs/song-quota.md）
│   ├── songNoticeService.js# 注意事项（点歌/文稿两份，KV 存正文+版本号，内容变了才 +1）
│   ├── broadcastSlotService.js # 播出时段：KV song_slot_times 发布 → 下周一~五可选列表 + 服务端校验
│   ├── submitRuleService.js# 提交规则：每人每周 2 次 + 同曲去重（归一化比较）
│   ├── studentAccountService.js # 学生账号：初始密码 hash 整批复用 + 状态 30s 缓存 + pv 使旧 token 作废
│   ├── studentRosterService.js  # 学生名册：导入/列表/年级汇总/整届清理（docs/student-account.md）
│   └── studentImportService.js  # 名册 xlsx 解析 + 工作簿生成
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
- 投稿 1 分钟内同 openid 重复内容只允许一次；留言同规则且 500 字上限
- 模块开关写入接口（POST /api/user/submit, message）会拦截；读取接口（list/detail）不受影响
- 错误码 `40302 MODULE_DISABLED` = 模块已关闭
- JWT 默认 7 天过期
- 微信 access_token 自动缓存到内存
- 风采展示：`GET /api/user/showcase` 一次返回 `{cadre, staff(按部门分组), cadreTotal, staffTotal}`；
  详情分两个接口 `/api/user/cadre/:id` 与 `/api/user/staff/:id`（仅 is_show=1，隐藏成员返回 40401）

**点歌 / 学生账号体系（2026-09-18 v8 落地，改相关代码前先读 docs/song-submit.md 与 docs/student-account.md）：**
- 点歌提交前置硬闸门（服务端，不信前端）：注意事项未确认 → `40303`；播出时段不在系统下发的
  下周一~五可选列表 → `40001`；每人每周 2 次 / 同曲一周去重 → `40903`；名额满 → `40902`（自动驳回落库不占个人次数）
- 播出时段由管理后台 `PUT /admin/submit/slots` 发布（KV `song_slot_times`），用户端 `GET /user/submit/timeslots`
  拿到的 value 是规范串 `2026-09-21 午间 12:20`，直接存 `want_broadcast_time`
- 一键清空点歌数据 `DELETE /admin/submit/songs`（仅超管，body `confirm:"DELETE"`）：删 type=1 + 清 song_quota，
  文稿 / notice_ack 不动；普通管理员越权一律 `40301`（权限边界权威表：`docs/admin-permissions.md`）
- 学生账号：`POST /user/login/account`（学号+密码）为主通道；微信登录通道受开关 `account_login_required`（默认 on）拦截。
  JWT openid 字段填学号本身 → 存量按 openid 归属的逻辑零改动；改密/重置/停用后旧 token 靠 `pv` + 30s 状态缓存作废
- **学生初始密码 = `user` + 学号**（如 user20240101，2026-09-18 晚用户改版）：
  每人不同 → 导入/重置逐行哈希（初始哈希用 cost 8 保性能，改密后 cost 10，bcrypt 哈希自带 cost 登录自动适配）；
  `studentAccountService.initPasswordFor(username)` 是唯一出口；导入 commit 前端超时放宽到 180s
- 学生账号管理接口全部仅超管（`/admin/student/*`），整届清理 `DELETE /admin/student/grade/:grade`
  支持 safe / disable / purge（purge 需 confirm 原样等于年级）

### 管理后台 `admin-web/`

```
admin-web/src/
├── App.vue
├── main.js
├── views/                  # 14 个页面
│   ├── Login.vue           # 登录页（顶部栏 + 收音机简笔插画 + 玻璃拟态登录卡片 + 页脚）
│   ├── Dashboard.vue       # 数据看板（4 分组 × 2 卡）
│   ├── SubmitList.vue      # 投稿审核（单条 + 批量）
│   ├── SongSettings.vue    # 点歌设置（名额 / 提交规则 / 播出时段发布 / 两份注意事项 / 危险区清空，超管才渲染清空）
│   ├── Program.vue         # 栏目管理（替代旧的"节目排期"）
│   ├── Notice.vue / Message.vue
│   ├── StudentAccounts.vue # 学生账号（按年级总览+毕业清理 / 账号列表 / 批量导入预览确认 / 导入批次撤销；仅超管）
│   ├── Member.vue          # 风采展示（CRUD + 头像上传）
│   ├── Switch.vue          # 模块开关
│   ├── Account.vue         # 管理员账号（仅超管）
│   └── Setting.vue         # 系统 KV 设置（仅超管）
├── components/
│   ├── StatusTag.vue       # 状态标签（统一封装）
│   ├── EmptyState.vue      # 空状态
│   └── icons/              # 30+ 自建 SVG 图标
├── layouts/MainLayout.vue  # 侧栏（NAV_GROUPS 数组，superAdmin 项按角色过滤）+ 顶部 header
├── stores/auth.js          # Pinia：token + admin + isSuperAdmin(role===0) + login/logout
├── router/index.js         # meta.superAdmin 路由守卫 + 菜单过滤双层权限
├── utils/http.js           # axios：{code:0} 解包；blob 直通；401 跳登录；403/40301 专文案
└── styles/theme.css        # 全局主题（青蓝渐变 + 玻璃拟态；⚠️ 与小程序设计语言相反，v8 预览是新方向的参照）
```

**注意：** admin-web 镜像构建**需要本地先 `npm run build`**！容器内 npm build 会因 native 模块（rollup/win32）失败。Dockerfile 已改为只 COPY dist/。

### 小程序 `miniprogram/`

**2026-09 已完成 v2 改版**（设计系统 v2 + 自定义胶囊 tabBar + 启动动画 + 11 页面）。
设计稿源文件：Ardot `726404665321310`（5 屏方案 + 启动动画规格）、`726428897655895`（徽标应用效果板）。

```
miniprogram/
├── app.js                  # globalData: baseURL / token / switches / statusBarHeight
├── app.json                # navigationStyle: custom + tabBar.custom: true + 11 个页面路由
├── app.wxss                # 设计系统 v2：色板/字号/间距 token + 全部公共类（改样式先看这里）
├── custom-tab-bar/         # 胶囊浮动底部导航（tabBar.custom=true 必需）
├── components/
│   └── launch-mask/        # 启动动画「声波唤醒」全屏遮罩（首页接入，dismiss() 退场）
├── pages/                  # 11 个页面
│   ├── index/              # 首页（启动动画接入 + 品牌头部 + 直播卡 + 节目单/公告列表）
│   ├── submit/             # 投稿（点歌闸门：进点歌弹注意事项滑到底才能确认；播出时段只读行+底部弹层
│   │                       #   按天分组选值，只选不输；「本周还可点 N 次」提示；40303/40902/40903 分支处理）
│   ├── login/              # 登录（两步式：学号+密码 → isDefaultPwd 时强制首登激活改密；微信一键登录降级为次要入口）
│   ├── members/            # 风采（社干/部门人员两层 tab + 部门筛选 + 3 列网格）
│   ├── mySubmit/           # 我的投稿（用户卡 + 状态筛选 + 条目列表；头像恒为姓名首字）
│   ├── programs/           # 节目单（未来 7 天，按日期分组）
│   ├── notices/            # 公告列表（分页 + 触底加载）
│   ├── about/ noticeDetail/ programDetail/ memberDetail/
│   │                       # memberDetail 支持 ?type=cadre|staff 双类型
├── utils/
│   ├── request.js          # 统一 wx.request 封装（懒获取 app 实例；baseURL 已含 /api，路径不要再带 /api）
│   └── format.js           # fmtDate / submitStatusText / submitStatusClass
└── assets/                 # tab-*.png ×8（线性图标灰/白两态）、station-badge.png（彩色站徽）、
                            # station-badge-mono.png（单色版，深色场景备用，当前未引用）
```

**页面接口对照：**

| 页面 | 接口 |
|---|---|
| index | `/user/program/current`、`/user/program/weekly`、`/user/notice/list` |
| login | `POST /user/login/account`（学号）、`PUT /user/change-password`、`POST /user/login`（微信老通道） |
| submit / mySubmit | `/user/submit`、`/user/submit/my`、`/user/submit/:id`(DELETE)、`/user/submit/quota`、`/user/submit/notice`(type=song)、`/user/submit/notice/ack`、`/user/submit/timeslots` |
| members | `/user/showcase` |
| memberDetail | `/user/cadre/:id` 或 `/user/staff/:id`（?type= 参数） |
| programs | `/user/program/schedule`（默认未来 7 天） |
| notices | `/user/notice/list?page=&pageSize=` |
| programDetail | `/user/program/:id` + 留言 `POST /user/message` |

**可复跑验证脚本（SQLite 内存库，不需要 MySQL / Docker，改相关代码先跑）：**
```bash
node scripts/verify-song-submit.js      # 点歌全链路 107 项（名额/注意事项/时段/规则/清空/路由顺序）
node scripts/verify-student-account.js  # 学生账号 151 项
```

**已有库需手动跑的迁移**（schema.sql 只在数据卷首启时执行）：
```bash
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-quota.sql
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-notice-slot.sql
docker exec -i radio-mysql mysql -uroot -proot123 radio_station < sql/migrations/2026-09-18-song-rules.sql
# 学生账号相关迁移见 docs/student-account.md
```

**关键约束：**
- 模拟器只能走 `127.0.0.1:80`（不能走 `3000`，因为 Docker backend 端口不暴露到主机）
- 真机扫码用电脑 LAN IP（如 `http://192.168.1.100:80/api`）
- HSTS 会让 Chrome 自动给 localhost 加 `https://`，**必须用 IP 或无痕窗口**

### 数据库 `sql/schema.sql`

**关键约束：**
- 11 张表，CHARACTER SET utf8mb4（cadre / staff 为新增；member 已废弃但表和接口仍挂载）
- `program.broadcast_date` 必填，否则 `weekly/schedule` 接口按日期范围过滤返回空
- `schema.sql` 首启动自动执行（first-boot 触发）
- 集成时务必保证 `sql/schema.sql` 与 Sequelize 模型同步（包括 `cadre` / `staff` / `system_switch`）

## 小程序设计系统 v2（改 UI 前必读）

**三条硬规则：**
1. 全局只有一个强调色 `--accent: #0066CC`，所有"可点"的东西都用它；深色场景用 `--accent-on-dark: #2997FF`
2. 不用装饰性渐变、不用彩色投影（违反案例：青蓝渐变 tab、彩色 box-shadow，均已清除）
3. 深色卡（`--tile: #272729`）是视觉主角，其余信息退到羊皮纸（`--parchment: #F5F5F7`）

token 与公共类全部在 `app.wxss`（色板 / `.t-*` 五档文字 / `.card` / `.tile` / `.segment` / `.btn` /
`.filter` / `.info-*` 等），页面 wxss 只写页面私有样式，公共样式优先补进 app.wxss。

**动效规范（统一缓动 `cubic-bezier(.22,.61,.36,1)`，时长 360~480ms）：**

| 场景 | 实现 |
|---|---|
| 启动动画 | `components/launch-mask`（方案 B 浅色：白底 + 彩色站徽 + `#0066CC` 声波；动画节奏 1.7s） |
| tabBar 切换 | `.indicator` 深色胶囊在四格间平移（360ms）。**滑动发生在目标页、从来源格滑向目标格**（切页与点按同步，不等待） |
| tabBar 显隐 | 启动动画期间胶囊 `translateY(220%)` 退到屏幕外（**容器无底色**，不是 display:none）；退场时 `pillUp` 自下而上滑入 480ms |
| 分段控件 | `.segment-indicator` 白块滑动（投稿页 2 格 / 我的页 4 格） |

**输入框样式规范（单行/多行机制完全不同，类不能混用）：**
```css
.input      { height: 88rpx;  line-height: 88rpx;  padding: 0 28rpx; }      /* 单行：定高+行高居中 */
.input-sm   { height: 76rpx;  line-height: 76rpx;  padding: 0 26rpx; }
.input-area { height: 176rpx; line-height: 1.5;    padding: 24rpx 28rpx; }  /* 多行：行高1.5+上下padding */
.input-area-lg { height: 300rpx; line-height: 1.5; padding: 24rpx 28rpx; }
```
textarea 的 wxml 必须写 `input input-area` 或 `input input-area input-area-lg`（漏了 input-area
会继承单行行高，占位文字位置就错）。

**标点规范：** 中文文案用全角标点；省略号用 `……`（两字符）不用单 `…`；
中文间隔号 `·` 两边不加空格；中文与数字之间加空格（`投稿 3 条`）。

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
| 风采拆成 cadre + staff 两表（member 废弃） | 社干无部门字段，部员有部门+负责栏目，结构不同 |
| 详情接口过滤 is_show=1，隐藏成员返回 40401 | 与旧 member/:id 行为一致；小程序 detail 页 catch 后显示空态 |
| 小程序用 tabBar.custom + 滑动指示器 | 原生 tabBar 无法实现胶囊样式与滑动动画 |
| 启动动画做成首页全屏遮罩组件（launch-mask） | 微信启动画面不可自定义；数据就绪 dismiss，兜底 4s |
| 深色场景用单色版站徽（station-badge-mono.png） | 彩色徽标深底上几乎不可见；单色版由原图亮度重映射生成 |
| 首页接口失败静默降级（catch → null/空数组） | 启动动画兜底 4s 后必然退场，不允许白屏 |
| 点歌前置约束放在服务端（时段/注意事项/次数/去重） | 前端交互只是体验，绕过前端直接调接口必须也被拦 |
| 计数器类（名额）放数据库 + 一条带条件 UPDATE | 进程内计数在 cluster/多容器下超发；先查后写必超发 |
| 失败兜底只在「表不存在」时降级不限制 | 数据库抖动宁可报错重试，也不能把限额全放开 |
| 学生账号初始密码 hash 一次整批复用 | 逐行 bcrypt 2000 人分钟级超时 |
| 头像恒为姓名首字圆形，客户端传的 avatar 直接丢弃 | 用户 2026-09-18 定死：全站不收集头像 |
| 管理端 UI 方案以 `preview/admin-ui-v8`（25 屏完整版）为唯一权威 | v1~v7 仅留档；权限边界见 docs/admin-permissions.md |

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
- 提交前必跑 `npx jest`
- ⚠️ **已知环境问题**：member.test.js / switch.test.js 依赖真实微信 appid 走 code2session，
  无有效 appid 时会报 `invalid appid` 导致 15 个用例失败（登录失败连锁）——
  这类失败与业务代码无关，换有效 appid 或 mock 后即可恢复

## 常见陷阱

1. **小程序模拟器看不到数据** → baseURL 用 `http://127.0.0.1:80/api`（不是 3000！）
2. **Docker build 卡住** → 检查 `.vite` 缓存、`node_modules/.vite` 是否被锁
3. **MySQL 启动后第一次慢** → `wait-for-mysql.sh` 已在用，但首次数据卷初始化要 30s+
4. **schema.sql 改了不生效** → MySQL 数据卷已存在；删 `data/mysql/` 重建或只补字段
5. **admin-web 看不到新代码** → 必须本地 build 后再 `docker compose build admin-web`
6. **小程序接口 404 但后端是好的** → 逐条检查：request.js 会拼 baseURL（已含 /api），
   页面路径不能再以 `/api` 开头（会出现 `/api/api/...`）；
   模块开关真实路径是 `/api/user/switch/list`（不是 `/api/switch/list`）
7. **nginx 404 排查顺序**：`docker ps` 看端口 → 进 nginx 容器 wget 直连上游（`http://radio-backend:3000/...`）
   切分「反代配置问题」和「路由问题」→ 上游 200 但外层 404 才是 nginx 配置问题；
   注意 `/etc/nginx/conf.d/default.conf` 有出厂默认配置不代表它被加载了，要看 `nginx -T`

## 小程序编码规范（踩过的坑，改前必看）

1. **request 路径不要带 `/api` 前缀**（request.js 会拼 baseURL）；全库校验脚本可查
2. **所有入场动画必须 `animation-fill-mode: both`**——否则延迟期内元素以最终态先亮一下再跳回起点
3. **状态驱动的进场动画用 `animation + 类开关`，不用 transition**——
   transition 需要"规则先在、值后变"两个渲染帧，setData 一合并就失效（表现为硬切）
4. **自定义 tabBar 层级高于一切页面内容**：全屏遮罩（启动动画/引导页）盖不住它，
   必须通过 `getTabBar().setSelected()` / `setData()` 控制。
   **tabBar 滑动动画是「动画契约 v9」（定稿），改 custom-tab-bar 之前先读组件头部注释**：
   ① 动画发生在**目标页**的指示器上、从**来源格**滑向目标格（唯一一次滑动）。
   来源页不做任何预动画——它的 selected 永远等于自己的格位，不存在毒化，也就没有两次动画。
   ② 切页与点按同步（用户拍板）：switchTab 只把来源格写入 `globalData.tabFrom` 后立刻
   `wx.switchTab`，不演动画、不延迟。
   ③ 目标页 onShow 的 `setSelected(index)` 两步走：`setData({noanim:true, selected:from,
   revealed:true}, callback)` 瞬移到起点并显影 → **setData 的渲染完成回调里**
   `setData({noanim:false, selected:index})` 滑向终点。回调 = 渲染已完成、元素已真实停在
   起点，transition 必生效——这是用官方回调替代猜时间的 setTimeout（此前反复翻车的根因）。
   ④ `revealed`：实例初渲染时 selected 恒为 0，指示器等第一次 setSelected 才显示
   （`.indicator-off{opacity:0}`）；校验任何 js 改动第一步先跑 `node --check` 全量语法检查。
5. **WXML 表达式不支持函数调用和对括号表达式取下标**（`{{(a||b)[0]}}` 直接编译错误），
   需要计算的值在 js 里算好再 setData；`Object.keys/filter` 也不能在 wxml 里用
6. **微信 input 自带默认高度**：单行输入必须显式设 height + line-height 居中、上下 padding 归零，
   否则占位文字被裁掉一半；多行 textarea 用行高 1.5 + 上下 padding，两种类不能混用
7. **CSS 类的优先级陷阱**：微信默认 `button` 样式优先级高于单类名，
   铺满按钮要写 `button.btn-block { width: 100% }`（元素+类）；
   同理页面对 `button.btn` 的 width 覆盖也要用 `button.xxx`
8. **成员网格 3 列**：`width: calc((100% - 40rpx) / 3 - 1rpx)`，1rpx 余量防亚像素换行
9. **设计资产**：`station-badge.png`（彩色透明底 1410²）、`station-badge-mono.png`（单色版）；
   旧的 `station-logo.jpg`（白底 JPG）已废弃未删除；
   深色场景放彩色徽标会看不见，单色版就是为这个准备的
10. **中文排版**：全角标点、`……` 省略号、间隔号 `·` 不加空格、中文与数字间加空格；
    小字号中文加 0.5~1rpx letter-spacing 可读性明显更好；
    Windows 开发者工具没有苹方，字体栈已按 苹方→鸿蒙→MiSans→思源→雅黑 排列，
    工具里的渲染比真机丑是正常的，验收以真机为准
