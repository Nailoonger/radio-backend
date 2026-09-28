# 云开发迁移工作区（cloud/）

> **铁律：原有 `src/`（Express 后端）、`admin-web/`、服务器上的 Docker 一律不动。**
> 本目录只做加法。任何时刻都能通过小程序端一个开关切回直连，服务器继续照着老路径跑。
> 目标：全部走微信云开发（云函数 + 文档型云数据库），不再需要备案域名、不再依赖服务器续费。

## 一、目标架构

```
小程序 wx.cloud.callFunction({ name: 'api', data: { method, path, body, token } })
        │
        ▼
[云函数 api]  ← 本目录 cloudfunctions/api
   ├─ router 分发（路径 + 方法，与现 Express 路由一一对应）
   ├─ auth 校验（沿用原 JWT，payload 语义完全不变）
   ├─ services 业务逻辑（从 src/services 移植）
   └─ 文档型云数据库（原 17 张 MySQL 表的集合化）
        │
        ▼
   管理后台 admin-web（后续阶段：接云开发 Web SDK）
```

**不需要**：ICP 备案、合法域名、SSL 证书、服务器续费。
**需要**：一个云开发环境（校园版个人版，前 6 个月免费）。

## 二、迁移总原则

| 原则 | 说明 |
|---|---|
| 加法而非替换 | `src/` 保持可运行，服务器端的部署链路（Docker/nginx）全程不动 |
| 双通道可切 | 小程序 `utils/request.js` 支持 `direct` / `cloud` 两种模式，改一行切换 |
| 同一套业务语义 | 状态数字、错误码、JWT payload 字段全部沿用，前端逻辑零改动 |
| 纯逻辑原样搬 | 不依赖 Sequelize 的文件（时间/成本表/状态常量/Excel）直接复制 |
| 数据只读导出 | 迁移时对线上 MySQL 只做 `SELECT`，绝不改删原库 |

## 三、施工阶段与进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 后端接口/模型/服务全量盘点 | ✅ 完成（126 条路由 / 17 表 / 19 服务） |
| 1 | `cloud/` 骨架 + 核心库移植 + 小程序双通道 | ✅ 完成 |
| 2 | 数据层（`lib/db.js`）+ 本地测试 harness（内存假库跑真网关） | ✅ 完成 |
| 3 | 配置类集合（system_setting / system_switch）+ 首批接口（switch、station） | ✅ 完成 |
| 4 | 用户端接口移植（登录/改密/投稿/点歌/留言/节目/公告/风采） | ✅ 完成（33/33 接口，云端实测 31 条全绿） |
| 5 | 点歌状态机（songStatusService + songSchedulingService）重写 | ⏳ 最高风险（**动工前先出方案**） |
| 6 | 定时触发器（原 60s sweep → 云函数定时器） | ⏳ |
| 7 | 管理端接口移植（含学生名册 Excel） | ⏳ |
| 8 | 数据迁移脚本 + 双向校验 | ⏳ |
| 9 | admin-web 接云开发 | ⏳ 最后一步 |

### 本地验证（每次改完必跑，秒级）

```bash
node cloud/scripts/selfcheck.js        # 静态自检：路由优先级 / 时间工具逐位一致 / 错误码逐值一致（75 项）
node cloud/scripts/test-system.js      # /health + 建集合 + 开关（21 项）
node cloud/scripts/test-gateway.js     # 网关 + lib/db 原语（26 项）
node cloud/scripts/test-user-readonly.js  # 用户端只读（76 项）
node cloud/scripts/test-user-auth.js      # 登录 / 改密 / me（62 项）
node cloud/scripts/test-user-submit.js    # 投稿 / 点歌 11 个接口（206 项）
node cloud/scripts/test-bundle.js         # 打包产物冒烟（20 项）
```

合计 **481 项**，全绿才算过。

⚠️ **产物行为必须与源码一致**：`HARNESS_API_DIR=miniprogram/cloudfunctions/api` 再跑一遍
`test-user-submit.js`（打包器是自研的，必须能自证）。

`cloud/scripts/harness.js` 把 `wx-server-sdk` 替换成内存假数据库（Map 存集合），
并**刻意模拟**了三个真实行为，否则测不出问题：
`add()` 撞 `_id` 抛错（等价 UNIQUE 冲突）、`doc().get()/update()` 不存在抛错、
`where().update()` 返回 `stats.updated`（等价 affectedRows）。
→ 新增 handler 时在 `test-gateway.js` 里加断言，不要只靠「部署后手点」。

### 已跑通的接口（用户端 33/33）

| 分组 | 接口 |
|---|---|
| 系统 | `GET /health`、`POST /system/init-collections` |
| 开关 | `GET /user/switch/list`、`GET /user/switch/:key` |
| 登录 | `POST /user/login`、`POST /user/login/account`、`PUT /user/change-password`、`GET /user/me` |
| 公告 | `GET /user/notice/list`、`GET /user/notice/:id` |
| 节目 | `GET /user/program/current`、`weekly`、`schedule`、`/:id` |
| 风采 | `GET /user/showcase`、`GET /user/cadre/:id`、`GET /user/staff/:id` |
| 站务 | `GET /user/station/intro`、`schedule`、`contact` |
| 留言 | `POST /user/message`、`GET /user/message/my` |
| 我的 | `GET /user/profile` |
| **投稿/点歌** | `POST /user/submit`、`GET /user/submit/my`、`quota`、`window`、`week`、`notice`、`timeslots`、`/:id`、`POST /user/submit/notice/ack`、`DELETE /user/submit/:id`、`POST /user/submit/:id/leave-queue` |

### ⚠️ 两个「不报错」的静默漂移（移植时务必对照）

1. **`ApiError` 是 4 参**：`(code, message, httpStatus = 200, data = null)`，与 `src/utils/response.js` 一致。
   从 src 逐字移植过来的 service 会写 `new ApiError(code, msg, 200, { opensAt })` ——
   若云版改成 3 参，`200` 会被当成 `data`，**附加数据静默丢失**（message 却仍然正确）。
2. **路由层中间件要单独对照 `src/routes/*.js`**：Express 的鉴权挂在路由上，
   controller 里**不读** `req.user` 也可能需要登录。
   只搬 controller 会漏鉴权，漏了不报错、只会「未登录也能看」。
   （例：`/user/submit/window`、`/user/submit/timeslots` 都挂了 `userAuth`；
   而 `/user/submit/week` **没有** —— 全组唯一免登录。）

## 四、关键设计决策（已在阶段 1 落定）

1. **继续用 JWT，不改鉴权模型**
   云函数原生能拿 `OPENID`，但本项目「账号体系复用 openid 字段填学号」是业务基石。
   沿用原 JWT（`openid` 填学号、`pv` 作废旧 token），**17 个依赖 `req.user.openid` 的逻辑零改动**。
   → 小程序端不用改登录流程、不用改本地 token 存储。

2. **用 `_id` 模拟唯一约束**（阶段 2 落地）
   文档数据库没有 UNIQUE 索引。原 `song_quota`、`notice_ack`、`user` 的
   `uk_username` / `uk_grade_class_seat` 等唯一性，改用「固定 `_id` 写入」实现：
   `_id = 业务键拼接`，重复插入天然报错，等价于 UNIQUE 冲突。
   → 点歌状态机的并发兜底（原靠带条件 UPDATE 影响 0 行判断）改判「插入/更新是否成功」。

3. **日志表冗余快照，不做关联查询**
   原 `assignment_log` / `request_status_log` 外键刻意 `constraints:false`。
   文档库里彻底改为：日志自身冗余存关键字段，查询不 JOIN。

4. **定时任务语义保持「每分钟一次」**
   原 `songQueueService.startScheduler()`（60s tick，幂等 + `ticking` 防重入）
   → 云函数定时触发器每分钟触发同一个 sweep 入口。
   冷启动可能造成同一分钟重复执行，因此**幂等性必须比原来更严格**（阶段 6 细化）。

5. **上传改云存储**
   原 `/uploads` 本地静态目录 → 云存储。注意：小程序 `<image>` 组件不做域名校验，
   现有 `http://IP/uploads/...` 在正式版仍可显示，**头像类图片可最后再迁**。

## 五、文件地图

```
cloud/
├── README.md                      # 本文件：总纲与进度
├── docs/
│   └── data-model-mapping.md      # 17 张 MySQL 表 → 云数据库集合映射
├── cloudfunctions/
│   └── api/                       # 主网关云函数（唯一对外函数）
│       ├── index.js               # 入口：解析入参 + 分发 + 统一异常
│       ├── router.js              # 路由表 126 条（数组顺序即优先级）
│       ├── package.json
│       ├── handlers/              # 按接口分文件，一个 handlerKey 对应一个方法
│       │   ├── index.js           #   惰性解析 + 未移植兜底
│       │   ├── system.js          #   /health
│       │   └── user/
│       │       ├── switch.js      #   /user/switch/*
│       │       └── profile.js     #   /user/station/*
│       ├── services/              # 业务服务（从 src/services 移植）
│       │   ├── kv.js              #   系统设置 KV
│       │   └── switch.js          #   模块开关
│       └── lib/
│           ├── response.js         # 错误码与统一响应（原样移植）
│           ├── bjTime.js           # 北京时间工具（原样移植）
│           ├── auth.js             # JWT 校验 + pv 新鲜度 + 角色
│           └── db.js               # 数据层：唯一键模拟 / 数字主键 / 条件更新
└── scripts/
    ├── selfcheck.js               # 静态自检（68 项）
    ├── harness.js                 # 内存假数据库（stub 掉 wx-server-sdk）
    └── test-gateway.js            # 网关实测（25 项）
```

## 六、小程序端切换开关

`miniprogram/app.js` 的 `globalData`：

```js
cloudEnvId: 'jy-radio-d1gdwmptl816ee6a9',  // 云开发环境 ID（2026-09-28 创建）
requestMode: 'direct',                     // 'direct' = 走原服务器（现状）； 'cloud' = 走云函数
```

**调试期免改代码切换**（开发者工具控制台执行，之后重启小程序）：

```js
wx.setStorageSync('debug_requestMode', 'cloud')   // 切云通道
wx.setStorageSync('debug_requestMode', 'direct')  // 切回直连
wx.removeStorageSync('debug_requestMode')         // 恢复默认
```

两个模式**共用同一套调用签名**，业务代码（页面）完全无感。

## 七、云函数镜像目录（重要）

微信开发者工具的 `cloudfunctionRoot` **必须位于项目目录内**，不接受仓库根目录外的路径。
所以源文件在 `cloud/cloudfunctions/`，运行时目录是 `miniprogram/cloudfunctions/`（`project.config.json` 里 `"cloudfunctionRoot": "cloudfunctions/"`）。

```
node cloud/scripts/sync.js           # 同步（单向镜像，覆盖 + 清理多余）
node cloud/scripts/sync.js --check   # 只校验一致性（不一致退出码 1）
```

⚠️ **永远不要手改 `miniprogram/cloudfunctions/`** —— 改源文件后跑一次 `sync.js`。
`selfcheck.js` 里有镜像一致性断言，改完不同步会当场报红。

## 八、首次部署步骤（陛下操作）

1. **开发者工具** → 顶部「云开发」→ 确认环境为 `jy-radio-d1gdwmptl816ee6a9`；
2. 左侧文件树找到 `cloudfunctions/api` → **右键 → 上传并部署：云端安装依赖**
   （首次约 1~2 分钟；它会在云端装 `wx-server-sdk` / `jsonwebtoken` / `bcryptjs` / `axios` / `exceljs`）；
3. **验证通道**：控制台执行 `wx.cloud.callFunction({name:'api',data:{method:'GET',path:'/health'}})`，
   返回 `{ code: 0, data: { ok: true, scope: 'cloud-function', ... } }` 即通道打通；
4. **验证业务接口**（需先建集合，见下）：控制台切 `debug_requestMode = 'cloud'` 重启小程序，
   观察启动时 `[request:cloud] GET /user/switch/list → 0` 的日志；
5. 都通过后，把 `app.js` 的 `requestMode` 正式改成 `'cloud'` 再提审。

**云数据库集合**（云开发控制台 → 数据库 → 新建集合）：

| 阶段 | 需要建的集合 |
|---|---|
| 验证 `/health` | 无 |
| 验证开关/站点信息 | `system_switch`、`system_setting` |
| 后续阶段 | `user`、`submit`、`weekly_schedule`、`unique_keys`、`sequence` …（见 docs/data-model-mapping.md） |
