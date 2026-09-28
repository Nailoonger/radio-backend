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
| 0 | 后端接口/模型/服务全量盘点 | ✅ 完成（100+ 接口 / 17 表 / 19 服务） |
| 1 | `cloud/` 骨架 + 核心库移植 + 小程序双通道 | ✅ 本次完成 |
| 2 | 数据层（`lib/db.js` 集合封装 + 唯一键模拟 + 事务替代） | ⏳ 下一批 |
| 3 | 配置类集合（system_setting / system_switch）与 KV/开关适配层 | ⏳ |
| 4 | 用户端接口移植（登录/改密/投稿/点歌/留言/节目/公告/风采） | ⏳ |
| 5 | 点歌状态机（songStatusService + songSchedulingService）重写 | ⏳ 最高风险 |
| 6 | 定时触发器（原 60s sweep → 云函数定时器） | ⏳ |
| 7 | 管理端接口移植（含学生名册 Excel） | ⏳ |
| 8 | 数据迁移脚本 + 双向校验 | ⏳ |
| 9 | admin-web 接云开发 | ⏳ 最后一步 |

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
│       ├── router.js              # 路由表（与 Express 路由一一对应）
│       ├── package.json
│       └── lib/
│           ├── response.js         # 错误码与统一响应（原样移植）
│           ├── bjTime.js           # 北京时间工具（原样移植）
│           ├── auth.js             # JWT 校验 + pv 新鲜度 + 角色
│           └── db.js               # 云数据库封装（阶段 2 填充）
└── scripts/                       # 数据迁移脚本（阶段 8）
```

## 六、小程序端切换开关（阶段 1 已落地）

`miniprogram/app.js` 的 `globalData`：

```js
cloudEnvId: '',            // 云开发环境 ID（在开发者工具里创建后填入）
requestMode: 'direct',     // 'direct' = 走原服务器（现状）； 'cloud' = 走云函数
```

改成 `'cloud'` + 填 `cloudEnvId` 即切云开发；改回 `'direct'` 立即恢复直连。
两个模式**共用同一套调用签名**，业务代码（页面）完全无感。
