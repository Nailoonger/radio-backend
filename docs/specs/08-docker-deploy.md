# Docker 全栈部署 Spec

## 背景

菁悠广播站已有 Node 后端 + Vue 管理后台 + 微信小程序三块代码。本地开发用 `node src/app.js` + `npm run dev`，切换环境需要重启 + 配置。

需要一个**一键部署**方案，用 Docker Desktop 本地一键拉起整套栈：
- MySQL 8 容器（替代 SQLite）
- Node 后端容器（连 MySQL）
- Vue 管理后台容器（Nginx 静态托管）
- Nginx 反代容器（统一 80/443 入口，含自签 HTTPS）
- 微信小程序源码**只打包不部署**（小程序发布走微信开发者工具）

## 目标

- `docker compose up -d` 一键启动全套
- 数据持久化：MySQL、uploads/、.env 都在本地卷
- 本机浏览器访问 `https://localhost/` → 管理后台
- 本机浏览器访问 `https://localhost/api/*` → 后端
- 本机浏览器访问 `https://localhost/api-docs/` → Swagger
- 手机 / 微信扫码能通过局域网 IP 访问（暂用自签证书，浏览器会告警）
- 一键停止：`docker compose down`（保留数据）；一键清空：`docker compose down -v`

## 功能需求

### F1：MySQL 容器
- F1.1 使用官方 `mysql:8.0` 镜像
- F1.2 数据卷 `./data/mysql` 持久化
- F1.3 初始化脚本 `sql/schema.sql` 自动建表（first-boot 时挂载到 `/docker-entrypoint-initdb.d/`）
- F1.4 root 密码从 `.env` 读取，默认 `root123`
- F1.5 健康检查：`mysqladmin ping`

### F2：后端容器
- F2.1 基于项目已有 `Dockerfile`（多阶段构建：deps → runtime）
- F2.2 镜像名 `radio-backend`
- F2.3 启动命令 `node src/app.js`
- F2.4 环境变量：`DB_DIALECT=mysql`、`DB_HOST=mysql`、`DB_USER=root`、`DB_PASSWORD=root123`、`DB_NAME=radio_station`、`NODE_ENV=production`
- F2.5 端口 3000 仅暴露到 docker 网络，不直暴露主机
- F2.6 启动时自动 seed（admin / settings / switches / 示例节目）
- F2.7 等待 MySQL healthy 才启动

### F3：管理后台容器
- F3.1 基于官方 `nginx:1.27-alpine`
- F3.2 构建：`admin-web` 跑 `npm run build`，产物 `dist/` 拷到 nginx 镜像
- F3.3 Nginx 配置 SPA fallback（所有非静态资源 → `index.html`）
- F3.4 内部端口 80，不直暴露主机
- F3.5 通过 `/api/*` 反代到 `radio-backend:3000`

### F4：Nginx 反代容器（统一入口）
- F4.1 基于 `nginx:1.27-alpine`
- F4.2 端口 80 + 443 暴露主机
- F4.3 HTTP 自动跳转 HTTPS
- F4.4 HTTPS 用**自签证书**（首次启动生成；也可挂载用户提供的证书覆盖）
- F4.5 反代规则：
  - `/` → `admin-web:80`（管理后台 SPA）
  - `/api/*` → `radio-backend:3000`（后端 API）
  - `/uploads/*` → `radio-backend:3000`（头像静态文件）
  - `/api-docs/*` → `radio-backend:3000`（Swagger UI）
- F4.6 自签证书生成脚本 `deploy/gen-selfsigned.sh`（Windows 用 `gen-selfsigned.ps1`）

### F5：docker-compose
- F5.1 文件 `docker-compose.yml` 放在项目根
- F5.2 4 个服务：`mysql`、`radio-backend`、`admin-web`、`nginx`
- F5.3 默认网络 `radionet`，所有服务互联
- F5.4 `.env` 读取敏感配置（密码等）
- F5.5 `volumes:` 持久化 mysql + uploads
- F5.6 健康检查链：mysql healthy → backend healthy → nginx 可启动

### F6：辅助脚本
- F6.1 `deploy/start.sh` / `deploy/start.ps1`：检查 Docker Desktop 状态 → 生成自签证书 → `docker compose up -d --build`
- F6.2 `deploy/stop.sh` / `deploy/stop.ps1`：`docker compose down`
- F6.3 `deploy/clean.sh` / `deploy/clean.ps1`：`docker compose down -v`（删数据）
- F6.4 `deploy/logs.sh` / `deploy/logs.ps1`：`docker compose logs -f`
- F6.5 `deploy/gen-selfsigned.sh` / `deploy/gen-selfsigned.ps1`：调用 openssl 生成 10 年证书到 `deploy/certs/`

### F7：微信小程序
- F7.1 `miniprogram/` 目录**保持源码**，不在容器里跑
- F7.2 容器部署后，把 `app.js` 里 `baseURL` 改为 `https://<局域网IP>/api`（用户在开发者工具手动改）
- F7.3 提供 `miniprogram/README.md` 更新说明

## 非功能需求

- N1：整套启动到可用 ≤ 90 秒（首次含镜像构建）
- N2：mysql 数据卷 `./data/mysql` 至少 5GB
- N3：uploads 持久化到 `./data/uploads`
- N4：.env 不进 git
- N5：所有端口冲突时给清晰提示
- N6：Docker Desktop 内存 ≤ 4GB
- N7：自签证书有效期 10 年

## 不做的事

- 不部署到云服务器（生产环境）—— 仅 Docker Desktop 本地
- 不做 HTTPS 自动续签（自签证书）
- 不做 CI/CD（GitHub Actions / GitLab CI）
- 不打 tag 推到 Docker Hub
- 不做多副本 / 集群
- 不做监控告警（Prometheus / Grafana）
- 不做日志聚合
- 不做自动备份数据库（用户自己 cp data/mysql）
- 不做小程序 CI 上传（miniprogram-ci）

## 验收标准

- AC1：项目根 `docker compose config` 校验通过，无语法错
- AC2：`deploy/start.ps1`（或 .sh）一键启动，输出"✅ 全栈已启动"
- AC3：浏览器访问 `https://localhost/` 自动跳转 / 显示管理后台登录页
- AC4：浏览器访问 `https://localhost/api/health` 返回 `{"code":0,...}`
- AC5：浏览器访问 `https://localhost/api-docs/` 看到 Swagger UI，46+ 接口
- AC6：管理后台能登录 teacher/admin123456（数据库 seed 自动创建）
- AC7：管理后台能创建成员、上传头像、图片存到 `./data/uploads`
- AC8：`docker compose down` 停止后，`./data/mysql` 和 `./data/uploads` 数据仍在
- AC9：重启 `docker compose up -d` 后，之前创建的管理员 / 成员 / 公告仍在
- AC10：`deploy/clean.ps1` 能清空所有数据
- AC11：手机扫码预览时，nginx 自签证书导致微信"该域名证书无效"提示，但可继续访问（生产替换为正式证书即可）
- AC12：每个辅助脚本都有对应的 .sh 和 .ps1 两份
