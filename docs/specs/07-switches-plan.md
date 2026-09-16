# 模块开关 Plan

## 架构概览

新增一个轻量"开关服务"——`src/services/switchService.js`，封装：
- 内存缓存（30s TTL）
- 4 个固定 key 的查 / 改 / 列表
- 后端路由（admin + user 各一组）
- 业务模块在写入路径上调用 `assertEnabled(key)` 拦截

整体不引入额外依赖。

## 核心数据结构

### SystemSwitch（数据模型）

```
SystemSwitch {
  id          INTEGER PK
  key         STRING(64)   UNIQUE  NOT NULL   // submit_song / submit_article / message / member
  value       STRING(8)   NOT NULL DEFAULT 'on'  // 'on' | 'off'
  desc        STRING(255) NULL        // 中文说明
  updatedBy   INTEGER     NULL        // admin id
  updatedAt   DATE        NOW
  createTime  DATE        NOW
}
```

### 默认 4 条记录（首次启动 seed）

| key | value | desc |
|---|---|---|
| `submit_song` | on | 点歌投稿 |
| `submit_article` | on | 文稿投稿 |
| `message` | on | 节目留言 |
| `member` | on | 风采展示 |

## 模块设计

### src/services/switchService.js
- `cache = Map<key, {value, expiresAt}>`
- `TTL = 30 * 1000`
- `isEnabled(key)` —— 先查缓存，未命中或过期则查 DB；返回 boolean（任何值 != 'off' 视为 on）
- `getAll()` —— 返回 { key, value, desc }[]（缓存整个列表）
- `set(key, value, adminId)` —— 更新 DB，删缓存
- `getPublicAll()` —— 给用户端，只返回 { key, value }[]（不暴露 desc/updatedBy）
- `getPublic(key)` —— 单个 key 的 { key, value }

### src/models/systemSwitch.js
- Sequelize 工厂函数
- 索引：`[{ fields: ['key'], unique: true }]`

### src/controllers/admin/switchController.js
- `list(req, res)` —— GET /api/admin/switch/list
- `update(req, res, next)` —— PUT /api/admin/switch/:key，body.value 必填

### src/controllers/user/switchController.js
- `list(req, res)` —— GET /api/user/switch/list（公开）
- `get(req, res, next)` —— GET /api/user/switch/:key（公开）

### src/utils/response.js
- 新增错误码 `MODULE_DISABLED = 40302`

### 业务拦截（最少改动）
- `src/controllers/user/submitController.js` —— 在 `create` 函数体顶部加 `assertEnabled(type === 1 ? 'submit_song' : 'submit_article')`
- `src/controllers/user/messageController.js` —— 在 `create` 函数体顶部加 `assertEnabled('message')`
- 写一个 `assertEnabled(key)` 辅助函数：
  ```js
  function assertEnabled(key) {
    if (!switchService.isEnabled(key)) {
      throw new ApiError(Codes.MODULE_DISABLED, '该模块暂时关闭，请稍后再试');
    }
  }
  ```
  放在 switchService.js 末尾导出
- 风采展示（member）暂只控读不影响，所以本次不做拦截

### src/routes/admin.js
- `GET /switch/list`
- `PUT /switch/:key`

### src/routes/user.js
- `GET /switch/list`
- `GET /switch/:key`

### src/utils/seed.js
- `seedSwitches()`：在 `seedAll()` 里调用；首次启动时插入 4 条默认记录（已存在则跳过）

### src/docs/swagger.js
- 新增 Switch schema + 「模块开关」tag
- admin/user 路由加 @swagger 注解

## 模块交互

```
[小程序 onLaunch]
    → GET /api/user/switch/list
    → app.globalData.switches = { submit_song: 'on', submit_article: 'on', ... }
    → 投稿页根据 switches[type] 渲染 tab 灰/亮

[管理后台 切换开关]
    → PUT /api/admin/switch/:key  body: { value: 'off' }
    → switchService.set()  → 删缓存  → 立即生效（最多 30s 同步给所有节点）

[学生 提交点歌]
    → POST /api/user/submit {type:1}
    → assertEnabled('submit_song')
    → 关闭 → throw ApiError(MODULE_DISABLED, ...)
    → 小程序收到 code 40302 → toast「该模块暂时关闭」
```

## 文件组织

```
radio-backend/
├── src/
│   ├── app.js                         (无需改)
│   ├── config/                        (无需改)
│   ├── models/
│   │   ├── systemSwitch.js            NEW
│   │   └── index.js                   +SystemSwitch 注册
│   ├── controllers/
│   │   ├── admin/switchController.js  NEW
│   │   ├── user/switchController.js   NEW
│   │   ├── user/submitController.js   +assertEnabled 拦截
│   │   └── user/messageController.js  +assertEnabled 拦截
│   ├── routes/
│   │   ├── admin.js                   +switch 路由 +@swagger
│   │   └── user.js                    +switch 路由 +@swagger
│   ├── services/
│   │   └── switchService.js           NEW（缓存 + assertEnabled）
│   ├── utils/
│   │   ├── response.js                +MODULE_DISABLED 错误码
│   │   └── seed.js                    +seedSwitches()
│   └── docs/swagger.js                +Switch schema +tag
├── tests/
│   └── switch.test.js                 NEW（覆盖 AC2-AC11）
├── miniprogram/
│   ├── app.js                         +onLaunch 拉开关 +globalData.switches
│   ├── pages/submit/submit.{js,wxml}  +tab 灰显 + 提交失败 toast
│   └── utils/request.js               (无需改)
└── admin-web/
    ├── src/router/index.js            +/switch 路由
    ├── src/layouts/MainLayout.vue     +「模块开关」菜单
    └── src/views/Switch.vue           NEW（开关卡片）
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 数据模型 | 新建独立表（非 KV） | 用户已选；可扩展 updatedBy，结构清晰 |
| 缓存粒度 | 整个 Map（key → value） | 表只有 4 行，全加载比单查更简单 |
| 缓存 TTL | 30 秒 | 平衡即时性与 DB 压力 |
| 缓存位置 | 服务模块内 Map（单进程） | 单 Node 进程够用；多实例需要 Redis |
| 拦截点 | service.assertEnabled() | 业务 controller 不直接调 DB，统一缓存命中 |
| 错误码 | 40302 MODULE_DISABLED | 新增而非复用 40301 FORBIDDEN（语义不同） |
| 写入拦截 vs 读取拦截 | 只拦写入 | 列表还能看历史内容；用户场景"今天关明天开"不会丢数据 |
| 用户端是否登录可读 | 否，开关公开 | 用户必须能看到模块状态以获得提示 |
| Swagger tag 名 | 「管理端-模块开关」/「用户端-模块开关」 | 与现有命名一致 |
| 小程序端缓存 | 不缓存，每次 onLaunch 拉一次 | 启动慢 50ms，换 30s 内一定最新 |
| 风采 tab 灰显 | 图标置灰 + 文案加「（暂停）」 | 不移除 tabBar 项（避免微信 tabBar 配置变更审核） |

## 被否决的方案

| 备选 | 否决理由 |
|---|---|
| 用 system_setting KV | 用户已选独立表 |
| 多节点 Redis 缓存 | 单进程不需要 |
| 拦截读接口 | 用户希望保留历史数据可看 |
| 自动 cron 启停 | 暂不做，超出范围 |
| 写入审计 log 表 | 暂不做 |

## 技术债声明

- 缓存是进程内 Map，多实例部署时各节点状态可能不一致 30 秒
- 没有写入审计 log，无法追溯"谁在什么时候改的开关"
- 开关值未做白名单校验（理论上能传任意字符串），靠代码层约定
- 风采展示（member）目前没有写入拦截（没有 admin 写入路径），后续如加"申请成为成员"等功能需补

## 验收对应

| 验收 | 实现位置 |
|---|---|
| AC1 侧栏菜单可见 | MainLayout.vue + router/index.js |
| AC2 默认 4 条 seed | seed.js seedSwitches() |
| AC3 切换立即更新 | switchController.update + HMR |
| AC4 用户端 GET 返回正确值 | switchController.list |
| AC5 点歌关闭 → 40302 | submitController + assertEnabled |
| AC6 文稿关闭 → 40302 | submitController + assertEnabled |
| AC7 留言关闭 → 40302 | messageController + assertEnabled |
| AC8 风采列表不拦截 | 不改 memberController |
| AC9 小程序 onLaunch 拉一次 | app.js |
| AC10 tab 灰显 + 提示 | submit.wxml + submit.js |
| AC11 30s 内恢复 | 缓存 30s TTL |
