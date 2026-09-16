# 菁悠广播站 · 使用文档

> 高中校园广播站微信小程序 + 管理后台 + 后端 API 全栈项目
> 基于 Node + Express + Sequelize，默认 **Docker Desktop 一键启动**

---

## 一、项目结构

```
radio-backend/
├── src/                          # 后端 Node + Express
│   ├── app.js                    # 入口（也挂 Swagger + uploads + requestId）
│   ├── config/                   # 配置 + Sequelize 初始化
│   ├── models/                   # 9 张表的数据模型
│   ├── controllers/              # 业务逻辑（user/ + admin/）
│   ├── routes/                   # 路由 + Swagger 注解
│   ├── middlewares/              # JWT / 权限 / 限流 / 错误处理 / requestId / 上传
│   ├── services/                 # 微信 API / 内容安全 / accessToken / 模块开关
│   ├── utils/                    # JWT / 响应 / 日志 / seed / wait-for-mysql
│   └── docs/swagger.js           # OpenAPI 3 规范
├── tests/                        # Jest + supertest 接口测试
├── sql/schema.sql                # MySQL 8 建表脚本（首启动自动执行）
├── miniprogram/                  # 微信小程序（原生 WXML/WXSS/JS）
├── admin-web/                    # 管理后台（Vue 3 + Vite + Element Plus）
├── deploy/                       # Docker 部署文件
│   ├── nginx.conf                # 统一入口反代
│   ├── wait-for-mysql.sh         # 等 MySQL TCP 通后再启 Node
│   ├── gen-selfsigned.{sh,ps1}   # 生成 10 年自签证书
│   ├── start.{sh,ps1}            # 一键启动全栈
│   ├── stop.{sh,ps1}             # 停止
│   ├── clean.{sh,ps1}            # ⚠️ 清空所有数据
│   └── logs.{sh,ps1}             # 实时日志
├── data/                         # 运行时数据（不入 git）
│   ├── mysql/                    # MySQL 数据卷
│   └── uploads/                  # 头像等上传文件
├── docker-compose.yml            # 4 个容器编排
├── Dockerfile                    # 后端镜像
└── .env / .env.example           # 环境变量
```

---

## 二、核心功能

### 学生端（小程序）

- 微信一键登录（仅获取昵称/头像）
- 点歌 / 文稿投稿（人工审核后展示）
- 我的投稿列表 + 撤销
- 节目预告、本周节目单、正在直播
- 公告列表 / 详情
- 节目留言
- 风采展示（按职务分组浏览）
- **模块开关联动**：被关闭的模块入口变灰、提交给提示

### 管理端（网页后台）

- 账号密码登录（bcrypt + JWT）
- 投稿审核（单条 / 批量通过 / 驳回带理由 / 删除）
- 节目排期（CRUD + 直播切换）
- 公告管理（CRUD + 置顶 / 上下架）
- 留言审核
- 数据统计（概览 + 7 天趋势图 + Top10 热门点歌）
- **风采展示**：成员 CRUD + 头像上传
- **模块开关**：4 个模块独立启停
- **系统设置**：KV 配置（广播站介绍、开播时间、联系方式）
- **账号管理**（仅超管）
- 改密 / 退出登录

### 超管 vs 社员

| 功能 | 超管（role=0） | 社员（role=1） |
|---|---|---|
| 投稿 / 节目 / 公告 / 留言审核 | ✅ | ✅ |
| 数据统计 | ✅ | ✅ |
| 改自己密码 | ✅ | ✅ |
| 风采展示 / 头像上传 | ✅ | ❌ |
| 模块开关 / 系统设置 | ✅ | ❌ |
| 管理员账号增删改 | ✅ | ❌ |

---

## 三、数据库表

| 表 | 说明 |
|---|---|
| `user` | 学生用户（openid 唯一） |
| `admin` | 管理员（角色：0=超管 1=社员） |
| `submit` | 投稿与点歌（核心表） |
| `program` | 节目 |
| `notice` | 公告 |
| `message` | 留言 |
| `system_setting` | KV 设置 |
| `member` | 风采展示成员 |
| `system_switch` | 模块开关 |

---

## 四、本地开发（不用 Docker）

### 1. 环境准备

- Node.js ≥ 18
- npm

### 2. 安装 + 启动

```bash
cd radio-backend
npm install

# 复制环境变量
cp .env.example .env

# 默认 SQLite（无需任何外部依赖），第一次启动会自动建表 + 创建超管
npm run dev
```

启动成功会看到：

```
🚀 菁悠广播站后端已启动
📍 地址: http://localhost:3000
📚 API文档: http://localhost:3000/api-docs
🔐 默认超管账号: teacher  密码: admin123456
```

### 3. 跑测试

```bash
npx jest                       # 一次性跑 56 个用例
npx jest tests/switch.test.js  # 跑单个文件
npx jest --watch               # watch 模式
```

### 4. 启动管理后台

```bash
cd admin-web
npm install
npm run dev    # 浏览器自动打开 http://localhost:5173
```

### 5. 启动小程序

1. 下载 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. **导入项目** → 目录选 `radio-backend/miniprogram`
3. AppID 选 **测试号**
4. 详情 → 本地设置 → **勾选"不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书"**
5. 编辑器里点 **编译**

---

## 五、Docker Desktop 一键启动（推荐）

> 一键拉起 mysql + 后端 + 管理后台 + nginx 反代，所有数据持久化。

### 1. 前置

- 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- 确保 Docker Desktop 正在运行（任务栏图标）
- 中国大陆用户：Docker Desktop → Settings → Resources → Network → **配 HTTP/HTTPS 代理**（否则拉不到镜像）

### 2. 一键启动

**Windows（推荐）：**
```powershell
cd C:\Users\Administrator\radio-backend
powershell -ExecutionPolicy Bypass -File deploy\start.ps1
```

**macOS / Linux / Git Bash：**
```bash
cd /path/to/radio-backend
bash deploy/start.sh
```

首次启动会：
1. 生成自签证书（10 年，10 秒）
2. 构建 3 个镜像（2-3 分钟）
3. 启动 MySQL（自动建表 + seed）
4. 启动后端 + 管理后台 + nginx
5. 输出访问地址

### 3. 访问

> ⚠️ 浏览器对 `localhost` 域名会自动跳 HTTPS + 拦自签证书。
> **用 IP 访问**避免这个问题：

| 地址 | 说明 |
|---|---|
| **http://127.0.0.1/** | 管理后台（推荐用这个） |
| **http://127.0.0.1/api-docs/** | Swagger API 文档 |
| **http://127.0.0.1/health** | 后端健康检查 |
| 默认账号 | `teacher` / `admin123456` |

如一定要用 `localhost`，参考 [排错章节](#十二排错指南) 清 Edge HSTS。

### 4. 管理命令

```powershell
# Windows
powershell -File deploy\stop.ps1       # 停止（保留数据）
powershell -File deploy\clean.ps1      # ⚠️ 停止 + 删除所有数据
powershell -File deploy\logs.ps1       # 实时日志
powershell -File deploy\gen-selfsigned.ps1   # 重新生成证书
```

```bash
# Linux / macOS
bash deploy/stop.sh
bash deploy/clean.sh
bash deploy/logs.sh
bash deploy/gen-selfsigned.sh
```

### 5. 数据持久化

| 路径 | 内容 |
|---|---|
| `./data/mysql/` | MySQL 数据库（删了 = 数据全丢） |
| `./data/uploads/` | 上传的头像图片 |
| `./deploy/certs/` | 自签证书 |
| `./.env` | 环境变量（含密码） |

`clean.ps1` 会删除前 3 个，**`.env` 不会被删**。

---

## 六、API 接口速览

> 完整文档看 http://127.0.0.1/api-docs/

### 用户端（小程序）

```
POST   /api/user/login                微信登录
GET    /api/user/me                   当前用户
POST   /api/user/submit               提交投稿
GET    /api/user/submit/my            我的投稿
DELETE /api/user/submit/:id           撤销投稿
POST   /api/user/message              提交留言
GET    /api/user/message/my           我的留言
GET    /api/user/program/current      正在直播
GET    /api/user/program/weekly       本周节目单
GET    /api/user/program/schedule     节目预告
GET    /api/user/program/:id          节目详情
GET    /api/user/notice/list          公告列表
GET    /api/user/notice/:id           公告详情
GET    /api/user/profile              个人中心聚合
GET    /api/user/station/intro        广播站介绍
GET    /api/user/station/schedule     开播时间
GET    /api/user/station/contact      联系方式
GET    /api/user/member/list          风采展示列表
GET    /api/user/member/:id           风采详情
GET    /api/user/switch/list          模块开关（公开）
GET    /api/user/switch/:key          单个开关
```

### 管理端（后台）

```
POST   /api/admin/login               管理员登录
GET    /api/admin/profile             当前管理员
PUT    /api/admin/change-password     改密
POST   /api/admin/logout              退出（仅清前端）
GET    /api/admin/submit/list         投稿列表
PUT    /api/admin/submit/:id/approve  通过
PUT    /api/admin/submit/:id/reject   驳回
POST   /api/admin/submit/batch        批量审核
DELETE /api/admin/submit/:id          删除投稿
GET    /api/admin/program/list        节目列表
POST   /api/admin/program/create      新增节目
PUT    /api/admin/program/:id         更新节目
DELETE /api/admin/program/:id         删除节目
PUT    /api/admin/program/:id/live    切换直播
GET    /api/admin/notice/list         公告列表
POST   /api/admin/notice/create       发布公告
PUT    /api/admin/notice/:id          更新公告
DELETE /api/admin/notice/:id          删除公告
PUT    /api/admin/notice/:id/toggle   上下架
GET    /api/admin/message/list        留言列表
PUT    /api/admin/message/:id/approve 通过留言
PUT    /api/admin/message/:id/reject  驳回留言
DELETE /api/admin/message/:id         删除留言
GET    /api/admin/stats/overview      数据概览
GET    /api/admin/stats/submit-trend  投稿趋势
GET    /api/admin/stats/top-songs     热门点歌
GET    /api/admin/setting/list        系统设置列表（超管）
PUT    /api/admin/setting/:key        修改设置（超管）
GET    /api/admin/admin/list          管理员列表（超管）
POST   /api/admin/admin/create        新增管理员（超管）
PUT    /api/admin/admin/:id           修改管理员（超管）
DELETE /api/admin/admin/:id           删除管理员（超管）
GET    /api/admin/member/list         风采成员列表（超管）
POST   /api/admin/member/create       新增成员（超管）
PUT    /api/admin/member/:id          修改成员（超管）
DELETE /api/admin/member/:id          删除成员（超管）
PUT    /api/admin/member/:id/toggle   成员上下架（超管）
POST   /api/admin/upload/avatar       上传头像（超管）
GET    /api/admin/switch/list         模块开关列表（超管）
PUT    /api/admin/switch/:key         修改开关（超管）
GET    /health                        健康检查（公开）
```

---

## 七、安全要点

1. **学生隐私**：仅获取微信昵称/头像，不强制收集手机号
2. **人工审核**：所有投稿/留言必须后台审核后才展示
3. **密码加密**：管理员密码 bcrypt 10 轮哈希存储
4. **JWT**：所有管理接口需 `Authorization: Bearer <token>`
5. **限流**：投稿/留言/登录均接入 `express-rate-limit`
6. **内容安全**：可启用微信官方 `msgSecCheck` 接口
7. **防重复提交**：相同用户 1 分钟内同类内容只允许一次
8. **请求 ID**：每个请求有 `X-Request-Id`，便于排查
9. **模块开关**：写入路径强制校验，防止后台误操作后接口被滥用

---

## 八、小程序对接

### 配置 baseURL

打开 `miniprogram/app.js`：

```js
baseURL: 'http://127.0.0.1:3000/api'  // 本地 Docker
// 或
baseURL: 'https://your-domain.com/api'  // 生产
```

### 微信开发者工具

1. **详情 → 本地设置** → 勾"不校验合法域名"
2. 编译运行

### 真机预览（手机扫码）

1. 电脑和手机**同一 WiFi**
2. 后端监听 `0.0.0.0:3000`（默认是）
3. baseURL 用电脑局域网 IP（如 `http://192.168.1.100:3000/api`）
4. 手机扫码预览

### 提审上线

1. 在 [微信公众平台](https://mp.weixin.qq.com) 注册小程序
2. 后端部署到**已备案**的 HTTPS 域名
3. 微信公众平台 → 开发 → 服务器域名 → 配置 `https://your-domain.com` 为 request 合法域名
4. 修改 `miniprogram/app.js` 的 baseURL
5. 用微信开发者工具上传代码 + 提交审核

---

## 九、模块开关使用

### 管理后台

侧栏「**模块开关**」→ 4 张卡片：

| Key | 中文 | 默认 |
|---|---|---|
| `submit_song` | 点歌投稿 | on |
| `submit_article` | 文稿投稿 | on |
| `message` | 节目留言 | on |
| `member` | 风采展示 | on |

点开关立即生效（30 秒缓存窗口同步给全端）。

### 小程序体验

- **关闭后**：入口还在但变灰 + 文案"（已关闭）"
- **提交时**：弹 toast「该模块暂时关闭，请稍后再试」
- **读取不受影响**（仍可查看历史内容）

---

## 十、常见操作

### 改默认管理员密码

管理后台 → 右上角头像 → 修改密码
**或** SQL：直接改 `admin.password`（bcrypt 加密后）

### 添加新社员

管理后台 → 账号管理 → + 新增管理员 → 填账号密码角色
（仅超管可见，仅超管可操作）

### 添加新栏目（节目）

管理后台 → 栏目管理 → + 新增节目 → 填节目名 / 主持人 / 播出时间 / 是否展示

### 设置广播站介绍

管理后台 → 系统设置 → 找到 `station_intro` → 编辑 value
（或 SQL 直接 update）

---

## 十一、数据库迁移 / 备份

### 备份

```bash
# Docker 方式
docker exec radio-mysql mysqldump -uroot -proot123 radio_station > backup_$(date +%Y%m%d).sql

# 本地 SQLite 方式
cp data/radio.db backup_radio_$(date +%Y%m%d).db
```

### 还原

```bash
cat backup_20260915.sql | docker exec -i radio-mysql mysql -uroot -proot123 radio_station
```

### 换 MySQL（生产）

修改 `.env`：
```env
DB_DIALECT=mysql
DB_HOST=your-mysql-host
DB_PORT=3306
DB_NAME=radio_station
DB_USER=your_user
DB_PASSWORD=your_password
```
导入 `sql/schema.sql` 即可。

---

## 十二、排错指南

### 端口冲突

| 端口 | 用途 | 冲突时 |
|---|---|---|
| 80 | nginx HTTP | 改 `docker-compose.yml` 里的 `"80:80"` 为 `"8080:80"`，前端访问 `http://127.0.0.1:8080/` |
| 443 | nginx HTTPS | 同上 |
| 3306 | MySQL | 改 `"3306:3306"` 为 `"3307:3306"`，同步 `.env` 里的 `DB_PORT=3307` |
| 3000 | 后端 | 仅暴露到容器网络，无需改 |

### Edge 浏览器打不开管理后台

详见 [#排错 Edge HSTS](#)。最快方案：**用 IP 不用域名**：

```
http://127.0.0.1/    ← 推荐
```

### Docker 拉不到镜像

中国大陆用户：Docker Desktop → Settings → Resources → Network → 配 HTTP/HTTPS 代理。

### 容器起不来

```bash
docker compose logs -f           # 看实时日志
docker compose logs radio-backend --tail=100  # 看具体容器
```

### 改了代码不生效

```bash
docker compose up -d --build <service-name>   # 单服务重建
docker compose up -d --build                  # 全部重建
```

### 数据库连不上

```bash
docker exec -it radio-mysql mysql -uroot -proot123
# MySQL> SHOW DATABASES;
# MySQL> USE radio_station;
# MySQL> SHOW TABLES;
```

### 管理员密码忘了

```bash
docker exec -it radio-mysql mysql -uroot -proot123 radio_station -e "
UPDATE admin SET password='\$2a\$10\$Kx9GZSF3FFxgJ9uKViIne.jndmwowJaWkNecq.Uwv5CeriBkUfqfy' WHERE username='teacher';
"
```
（上面 hash 对应 `admin123456`）

---

## 十三、生产部署建议

1. **HTTPS**：申请正式证书（Let's Encrypt 免费），把 `deploy/certs/` 换成正式证书
2. **域名**：备案 + DNS 解析
3. **MySQL**：用云数据库（RDS / 腾讯云 MySQL）替代容器
4. **存储**：头像存对象存储（OSS / COS）+ CDN
5. **监控**：Prometheus + Grafana 采集容器 metrics
6. **日志**：ELK / Loki 集中收集
7. **备份**：每日 cron 备份 MySQL 到对象存储
8. **CI/CD**：GitHub Actions 自动构建镜像 + 推送 + 部署

---

## 十四、依赖

### 后端
- express、sequelize、sqlite3 / mysql2、jsonwebtoken、bcryptjs、multer、express-rate-limit、helmet、morgan、swagger-jsdoc、swagger-ui-express、dotenv、dayjs、axios、multer

### 管理后台
- vue 3、vue-router 4、pinia、element-plus、axios、dayjs、echarts、vite

### 小程序
- 原生 WXML/WXSS/JS（无第三方框架）

### DevOps
- Docker、Docker Compose、MySQL 8.0、nginx 1.27

---

## 十五、贡献 / 开发约定

- 后端文件改动 → 必须新增/更新对应的 `tests/*.test.js`
- 路由改动 → 必须补 `@swagger` 注解
- 数据模型改动 → 必须同步 `sql/schema.sql`
- 提交前跑一遍 `npx jest` 确认 56 个用例全绿

---

**项目版本**：v1.0.0
**站名**：菁悠广播站
**站口号**：菁菁校园情，悠悠广播声
**默认账号**：`teacher` / `admin123456`（首次登录后请立即改密）
