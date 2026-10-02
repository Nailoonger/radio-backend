# 云开发迁移工作区（cloud/）

## 招新模块（2026-10-02）

新增公开报名、随机查询码、动态表单、面试及统一录取流程。入口为小程序「我的 → 加入我们」，Web 管理端「招新管理」需云通道。原学生账号与点歌接口继续沿用原行为。

2026-10-03 增量：固定学号改为 QQ 号，保留历史报名和查询码；超管可立即截止并保存报名；管理端居中审核处理台；截止后可随机生成、保存及导出全量面试顺序。复用既有招新集合，无需重复初始化，详见 `docs/specs/13-recruitment-review/`。

上线前须初始化 6 个新集合及私有权限、配置云函数 `RECRUITMENT_CODE_KEY`，详见 [招新运维与验收](../docs/recruitment.md)。初始化复用 `scripts/release` 的锁定 Manager SDK，未安装时先 `npm ci --prefix scripts/release`；默认只查看清单，携管理凭据并使用 `--run --env` 才写云环境。本地招新套件已纳入全量回归（源码及打包产物）。限流记录由现有定时器每小时有界清理。

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
| 0 | 后端接口/模型/服务全量盘点 | ✅ 完成（原 Express 后端 126 条路由 / 17 表 / 19 服务） |
| 1 | `cloud/` 骨架 + 核心库移植 + 小程序双通道 | ✅ 完成 |
| 2 | 数据层（`lib/db.js`）+ 本地测试 harness（内存假库跑真网关） | ✅ 完成 |
| 3 | 配置类集合（system_setting / system_switch）+ 首批接口（switch、station） | ✅ 完成 |
| 4 | 用户端接口移植（登录/改密/投稿/点歌/留言/节目/公告/风采） | ✅ 完成（32/32 接口 + 2 条 system 路由，云端实测 31 条全绿） |
| 5 | 点歌状态机（songStatusService + songSchedulingService）重写 | ✅ 完成（12/12 算法函数，本地 783 项全绿；**整链路云端验收已在阶段 7 由 `test-admin-submit.js` 完成**） |
| 6 | 定时触发器（原 60s sweep → 云函数定时器） | ✅ 完成（+廉价闸门把空转从 32% 额度压到 ~2%；**函数超时已配 30s**） |
| 7 | 管理端接口移植（含学生名册 Excel） | ✅ 完成（**93/93 路由**，仍就绪未 0；本地 670 项管理端断言全绿） |
| 8 | 数据迁移脚本 + 双向校验 | ✅ 完成（导出只读原库 / `_id` 规则 / `unique_keys` 补登记 / `sequence` 预置 / 双向校验 + 4 类反向用例，75 项断言全绿；**真机导入与校验待跑**） |
| 9 | admin-web 接云开发（HTTP 访问服务 + 可切换请求层） | ✅ 完成（`httpBridge` 适配 + 32 项断言；**控制台配触发路径 + 部署待陛下跑**） |

### 本地验证（每次改完必跑，秒级）

**一键跑完全部（源码 + 打包产物各一轮）：**

```bash
node cloud/scripts/regression.js            # 15 套件 × 两轮，合计 3115 项
node cloud/scripts/regression.js --source   # 只跑源码目录
node cloud/scripts/regression.js --selftest # 只自检「结论行解析器」（不依赖子进程）
```

⚠️ `regression.js` 靠**创建子进程**跑套件（只有子进程能给每个套件干净的模块实例 ——
`HARNESS_API_DIR` 是 harness 加载时读一次的，同进程里换不了源码/产物）。
若所在沙箱禁止创建子进程，它会直接说明并列出需要手工执行的命令（不会打出一片 `??`）。

**逐条跑（出问题时定位用）：**

```bash
node cloud/scripts/selfcheck.js            # 静态自检：路由优先级 / 时间工具逐位一致 / 错误码逐值一致 / 产物与源码一致（82 项）
node cloud/scripts/test-system.js          # /health + 建集合 + 开关（21 项）
node cloud/scripts/test-gateway.js         # 网关 + lib/db 原语（27 项）
node cloud/scripts/test-user-readonly.js   # 用户端只读（76 项）
node cloud/scripts/test-user-auth.js       # 登录 / 改密 / me（62 项）
node cloud/scripts/test-user-submit.js     # 投稿 / 点歌 11 个接口（206 项）
node cloud/scripts/test-scheduling-cost.js # 调剂选址成本表（63 项）
node cloud/scripts/test-scheduling.js      # 排期算法 12 个函数 + 定时闸门（273 项）
node cloud/scripts/test-admin-core.js      # 管理端非点歌 63 条 + 93 路由权限矩阵（166 项）
node cloud/scripts/test-admin-submit.js    # 点歌 30 条 + 排期算法整链路（231 项）
node cloud/scripts/test-admin-student.js   # 学生账号 19 条 + roster/sheet 服务（263 项）
node cloud/scripts/test-admin-routes.js    # 路由 ↔ handler 就绪性守门（19 项，**仅源码目录**）
node cloud/scripts/test-migration.js       # ★ 阶段 8 数据迁移：_id 规则 / 唯一键补登记 / 双向校验 + 反向用例（75 项）
node cloud/scripts/test-http-bridge.js     # ★ 阶段 9 HTTP 访问服务适配 + 既有通道不受影响（32 项）
node cloud/scripts/test-bundle.js          # 打包产物冒烟（24 项）
```

| 轮次 | 断言数 |
|---|---|
| 源码目录（15 套件） | **1620 项** |
| 打包产物（13 套件，`test-bundle`/`selfcheck`/`test-admin-routes` 不参与） | **1495 项** |
| 合计 | **3115 项 / 失败 0** |

⚠️ **产物行为必须与源码一致**：`HARNESS_API_DIR=miniprogram/cloudfunctions/api` 再跑一遍
（打包器是自研的，必须能自证 —— 它漏收一条 `require` 就是线上 `Cannot find module`）。
PowerShell 等价写法：

```powershell
$env:HARNESS_API_DIR="$PWD/miniprogram/cloudfunctions/api"; node cloud/scripts/test-admin-student.js
```

`cloud/scripts/harness.js` 把 `wx-server-sdk` 替换成内存假数据库（Map 存集合），
并**刻意模拟**了六个真实行为，否则测不出问题：
`add()` 撞 `_id` 抛错（等价 UNIQUE 冲突）、`doc().get()/update()` 不存在抛错、
`where().update()` 返回 `stats.updated`（等价 affectedRows）、
**多键排序按「值」比较 Date**（不同实例同一时刻必须判等，否则排序退化成插入顺序）、
**`where()` 支持顶层 `_.and([...])` / `_.or([...])`**（子项是 where 子句，可嵌套）、
**`clone()` 保留 Date 实例**（用 `JSON.stringify` 会把 Date 变成 ISO 串 →
`_.gte(某Date)` 在假库里永远不匹配，时间类条件静默失效）。
→ 新增 handler 时在 `test-gateway.js` / `test-admin-routes.js` 里加断言，不要只靠「部署后手点」。

### 阶段 5 的两个重要结论

1. **原排期算法的事务是「空的」**。`grep -rn transaction src/controllers/ src/services/songSchedulingService.js`
   证实所有调用点传的都是 `undefined` —— 真实并发模型一直是
   「单条条件 UPDATE + `affectedRows` 判定」，也就是 `applyChange` 的乐观锁。
   → 云化**不需要跨文档事务**（唯一真事务在 `admin/submitController.js:1067` 的 `purgeSongs`，与排期无关）。
2. **排期算法在用户端「零入口」**。用户端 `cancel` 的可撤销判定是
   `review===PENDING || (APPROVED && schedule===WAITING)`，而 `cancelRequest` 里
   触发 `afterRelease` 的条件是 `isSeated()`（`APPROVED && APPROVED`）—— 两者**互斥**。
   → 阶段 5 **无法用用户端接口做云端验收**，真实入口全在管理端（阶段 7）。
   ✅ **已于阶段 7 补齐**：`test-admin-submit.js` 让 `initialAllocate` / `reschedule`
   （含跨时段与 `crossSlot` 闸门）/ `lockWeek`（含满周自动驳回）/ `unlockWeek`
   （含 `lockPaused` 与 `restore`）/ `manualAssign` / `setPlayed` / `sweep`
   **第一次被真实调用**并逐条断言。

### 阶段 7 的关键结论

1. **云端没有中间件层 → 鉴权必须散落到 93 个 handler 的第一行**（`asAdmin` / `asSuper`）。
   漏写不会报错，只会「没登录也能调」或「普管也能调」。为此建了**93 条路由 × 三种身份**
   的权限矩阵，当场抓到 `cadre` / `staff` / `showcase` 三个模块权限写错（普管可写）。
   ⚠️ 权限规范**必须双向显式声明**（`SUPER_ONLY` + `PLAIN_ONLY` 两个 Set，
   并断言 `|SUPER_ONLY| + |PLAIN_ONLY| === 去重后的 handlerKey 数`）。
   只写「超管专属」、用「不在集合里就算普管」隐式推另一半，会让「本该超管却漏写的 key」
   静默降级成普管 —— **而矩阵全绿**。
   ⚠️ 93 条路由 → **91 个 handlerKey**（`admin.submit.capacity` 与 `sweepQueue`
   各有一 key 两路由）；超管 55 key / 56 路由，普管 36 key / 37 路由。
2. **就绪性要单独测**：权限矩阵判「普管可调路由」时只要求「不是 40101 / 40301」，
   于是**加载失败（50001）会静默通过**。→ 新增 `test-admin-routes.js` 单独钉死
   「每个 handler 文件都登记了 / 每条路由都解析到真实函数 / 诊断文案能分辨未登记与未导出」。
3. **二进制文件的传输契约改了**（云函数只走 JSON，没有 multipart、没有二进制响应体）：
   - 上传：`{ filename, fileBase64 }`
   - 下载：`{ filename, mime, base64 }`（前端 atob → Blob → 触发下载）
   ⚠️ 云函数单次请求/响应体约 **1MB**，xlsx 转 base64 再 +33% → 超大名册需改走云存储。
   这是**有意偏离**，前端（阶段 9）必须相应改造。
4. 未搬 `loginLimiter` / `submitLimiter` / `messageLimiter`（Express 内存限流，
   云函数多实例下天然失效；改用「时间窗口 + 唯一键」业务级防刷，已由断言覆盖）。
5. 未搬 `uploadController`（未被任何路由引用）。
6. **两处「源实现瑕疵」已被陛下裁决修正**（2026-09-29，详见 `docs/stage7-admin-plan.md` §五）：
   - `stats.overview` 的 `approved` 与 `topSongs()` 的 `status:1` → **均改 `status ∈ {1,5,6}`**
     （旧口径在派生镜像下只表示「已排期」，把「已通过·待排期」和「已播放」一起漏掉；
     两处是同一个「已通过」语义，陛下分两次拍板后统一）。
     ⚠️ 别再"顺手"改回 `{ status: 1 }`。
   - `previewSchedule(dryRun)` 的 `promoted/rescheduled/stillWaiting` 恒 0 → 已修（见静默漂移 #10）；
     顺带修正了 `autoRejectedIfLocked` 的**虚高**（它原先复用当前闸门下的 `left`，
     而锁定时刻闸门是强制放开的 → 预览说会驳回 1 条、真锁定时 0 条）。
     所以「**预览排期的主结论在修正前也是错的**」—— 这条比数字归零更值得记。
7. **有意的缺陷修正**（已标注，因为改的是「显示」而不是「语义」）：
   `formatTime` / `stamp` 从容器本地时间（= UTC，导出时间早 8 小时）改成北京时间。

### 已跑通的接口（用户端 32/32 · 系统 2 · **管理端 93/93**）

> 合计 **127 条路由**（`ADMIN_ROUTES` 93 + `USER_ROUTES` 32 + `system` 2），
> `test-admin-routes.js` 断言「每一条都解析到真实导出的函数」。

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

**管理端 93 条（阶段 7）** —— 全部仅管理端；其中**超管 56 路由 / 普管 37 路由**：

| 模块 | 条数 | 说明 |
|---|---|---|
| `admin.auth` | 4 | 登录 / me / 改密 |
| `admin.setting` | 3 | 系统设置 CRUD（普管只读） |
| `admin.switch` | 2 | 模块开关（普管只读） |
| `admin.program` | 5 | 节目（含 `set-live`，全表仅一个 live） |
| `admin.notice` | 5 | 公告 |
| `admin.message` | 4 | 留言审核（普管可审） |
| `admin.stats` | 3 | 概览 / 投稿趋势 / 热门歌曲 |
| `admin.cadre` | 6 | 社干（**超管专属**，支持增删改） |
| `admin.staff` | 6 | 部员（**超管专属**） |
| `admin.showcase` | 2 | 风采排序 / 显隐（**超管专属**） |
| `admin.adminMgr` | 4 | 管理员账号（超管专属，含「不能删自己 / 至少留一个超管」） |
| `admin.student` | 19 | 学生名册（导入 / 导出 / 统计 / 整届清理 / 批次回滚），**全部超管专属** |
| `admin.submit` | 30 | 点歌：列表 / 审核 / 排期 / 锁定解锁 / 容量 / 规则 / 窗口 / 注意事项 / 一键清空 |
| **合计** | **93** | 超管 56 路由 / 普管 37 路由（同一 handlerKey 可挂多条路由） |

### ⚠️ 十二个「不报错」的静默漂移（移植时务必对照）

1. **`ApiError` 是 4 参**：`(code, message, httpStatus = 200, data = null)`，与 `src/utils/response.js` 一致。
   从 src 逐字移植过来的 service 会写 `new ApiError(code, msg, 200, { opensAt })` ——
   若云版改成 3 参，`200` 会被当成 `data`，**附加数据静默丢失**（message 却仍然正确）。
2. **路由层中间件要单独对照 `src/routes/*.js`**：Express 的鉴权挂在路由上，
   controller 里**不读** `req.user` 也可能需要登录。
   只搬 controller 会漏鉴权，漏了不报错、只会「未登录也能看」。
   （例：`/user/submit/window`、`/user/submit/timeslots` 都挂了 `userAuth`；
   而 `/user/submit/week` **没有** —— 全组唯一免登录。）
3. **`week.update()` 之后必须同步内存对象**。源里 `week` 是 Sequelize 实例，`await week.update(patch)`
   之后实例自身就是新值；云端 `week` 是普通对象，`updateById` 只改库。
   不同步的后果是 `weekView(week)` **返回旧状态**，且不报错。
   → 统一走 `scheduling.applyWeekPatch()`。
4. **字段名一律驼峰**：`sweep()` 里写 `w.week_start_date` 会得到 `undefined`
   → `msOfWeekStartDate` 返回 `null` → 那一周被静默跳过 → **永远锁不上**，且不报错。
5. **`scheduledSlot` 是 `YYYY-MM-DD 中文时段名 时刻`，字典序只在跨天时等于时间序**。
   「日期 ≤ 今天」不能写成 `_.lte('<今天> 23:59')` —— 同一天的串前 11 位全同，
   第 11 位开始比 `早`(U+65E9) vs `2`(0x32) → **当天被判为「不小于」，静默漏掉当天**。
   → 一律写成 `_.lt('<明天日期>')`（日期定长零填充 → 时间序 == 字典序）。
   踩点见 `cloud/docs/stage6-timer-plan.md` §4，防回归断言 `test-scheduling.js` `W5-0/W5a`。
6. **`logAssignment` 写的字段是 `assignmentType`，不是 `type`**。
   断言写成 `x.type === 'RELEASED'` 会**恒为 false 且不报错**（字段根本不存在），
   表现为「撤销了但测试说没写日志」→ 白白怀疑业务代码。照抄源 `assignment_log` 属性名。
7. **权限规范不能用「隐式推另一半」**。只声明「超管专属」、其余默认当普管，
   则「本该超管却漏写的 key」静默降级成普管而矩阵全绿。
   → 两个 Set 双向显式声明 + 断言并集恰好等于路由表、交集为空。
8. **裸 `Error + code: 40001` 的待遇**取决于**源控制器有没有 catch**：
   - `songNotice.save` / `broadcastSlot.setSlotTimes` / `scheduling.assign` → **有** catch
     → 云端必须补 `paramError(e)` 把它翻成 `40001`（漏了会退化成 `50001 服务器繁忙`）
   - `scheduling.unlockWeek` → **源控制器没有 catch** → 源后端返回 **500**
     → 云端**保持 50001 同口径**，不擅自「修好」线上既有行为
9. **`insertOne` 之后要改这一行，必须用返回的 `_id`，不能用数字业务 `id`**。
   云文档 `_id` 是自动生成的字符串（`auto_N`），数字 `id` 只是业务主键。
   写 `updateById(coll, batchId, ...)` 会抛 `document does not exist`
   ——**只在「导入成功」路径上炸**，测试不覆盖就是线上第一次导入才发现。
   （唯一例外：`system_setting` / `system_switch` / `notice_ack` / `weekly_schedule`
   这 4 张表用 `insertWithId` 把业务键当 `_id`。）
   踩点：`services/roster.js` 的 `commit()`，防回归断言 `test-admin-student.js` C 段。
10. **多阶段流程只要有一阶段跑在 `dryRun`，「链式演练」就断了**。
    正式路径是「`initialAllocate()` 写库 → `reschedule()` 读库」，第二步天然看得见第一步的
    结果；`dryRun` 下两步都不写库 → 第二步看到的是「第一步从没发生过」的世界，
    于是**同时**出现两种失真：① 按库查候选 → 一条查不到 → 计数恒 0；
    ② 各格占用还是落座前的 → 刚发给别人的座位又被算成空位 → 同一个人塞进两个位置。
    ⚠️ 只修 ① 会让数字「看起来对了」但占用图虚得更厉害，两个必须一起修。
    → 正确做法：让上一阶段把**内存结果**（候补**整行** + 落座后**占用表**）交给下一阶段
    （`reschedule` 的 `extraWaiting` / `seatedOverride`），并**按 id 去重**。
    ⚠️ 还有第三层：**汇报口径要按「最终动作时刻的参数」重算**。
    `previewSchedule` 的 `autoRejectedIfLocked` 原先复用「当前闸门」下的 `left`，
    而锁定时刻 `lockWeek()` 是**显式 `crossSlot: true`** → 闸门关着时该数字**虚高**
    （预览说会驳回 1 条，真锁定时是 0 条 —— 连主结论都错）。闸门关着时必须另跑一轮演练。
    踩点：`handlers/admin/submit.js` 的 `previewSchedule()`、`services/scheduling.js`。
    防回归：`test-admin-submit.js` H 段（含**反向用例** —— 拒绝调剂 + 首选格满时该数字必须是 1，
    否则那些 `= 0` 的断言用一个「恒返回 0」的坏实现也能全绿）。
11. **迁移/导出通道两侧必须用**同一套** wire 编解码**（阶段 8）。
    JSON 没有 Date 类型。若源快照写 `{ $date: ISO }` 而云库导出是 `Date`，
    逐字段比对会冒出**几十条假差异**，真差异被淹没；反之若写成裸 ISO 字符串，
    导入后是**字符串**，`_.gte(new Date())` 这类时间条件**全部静默失效**。
    → 统一走 `cloud/migration/wire.js`（`toWire` / `fromWire` / `sameValue`）；
      `sameValue` 额外容错「一侧还没还原 `{ $date }`」的情况，不靠调用方自觉。
    防回归：`test-migration.js` D06 / F07–F10。
12. **`Model.findAll({ raw: true })` 会把「驼峰别名」和「裸下划线列名」两份都选出来**（阶段 8）。
    模型里既有显式属性（`createTime`，`field:'create_time'`）、又开了 `timestamps`
    时，SQL 是 `SELECT ..., create_time AS createTime, ..., create_time` ——
    于是文档里同时出现 `createTime` 与 `create_time`，违反「字段名一律驼峰」，
    且控制台导入时键名歧义极难排查。
    → `export.js` 用 `snakeDupesOf(Model)` 生成映射，transform 里**只在驼峰版本确实存在时**才删
    （宁可脏，也不能误删真字段）。防回归：`test-migration.js` A28–A30。

### 阶段 9：admin-web 怎么调云函数（两条路都不需要备案）

网页没有 wx 环境，只能走云函数的 **HTTP 访问服务**。选它的理由：零新增依赖、
适配层是我们自己的代码（能被回归网钉住）。

> ⚠️ 「要不要备案」的答案：**都不需要** —— 用腾讯云给的官方默认域名
> （`<envId>-<数字>.ap-shanghai.app.tcloudbase.com`）即可；只有绑**自有域名**才需要备案。
> 代价是默认域名有**有效期**，到期在控制台点「续期」（5 分钟生效）。
> 另一条路（`@cloudbase/js-sdk`）没有有效期问题，但要新增 npm 依赖 + 开匿名登录，
> 且通道本身在本地测不了 —— 若嫌续期麻烦可换。

云函数收到的是「集成请求」，由 `api/httpBridge.js` 还原成我们自己的 event 形状：

| 形态 | 请求 | 判据 |
|---|---|---|
| **信封**（admin-web 用） | `POST /api`，body = `{ method, path, body, token, query }` | 请求体里有 `path` |
| RESTful（兜底） | `GET /api/xxx?page=1`（需控制台开**路径透传**） | 否则 |

⚠️ 适配必须放在 `index.js` **解构 event 之前**（放错位置完全不生效，且不报错）。
⚠️ 判据只认 `httpMethod || requestContext` —— 收窄是刻意的，否则小程序请求
（同样有 `path`/`body`）会被误判成 HTTP 事件。`test-http-bridge.js` E 段钉了这条。

admin-web 侧 `src/utils/http.js` 做成**门面**：`VITE_REQUEST_MODE=direct` 时导出原 axios 实例
（行为逐字不变），`=cloud` 时导出同形状门面 → 全站 114 处 `http.get/post/...` **零改动**。
xlsx 下载在 cloud 模式下把 `{ filename, base64, mime }` 用 `atob` 还原成 Blob，
调用方 `URL.createObjectURL(blob)` 的写法一行不改。

### 阶段 8：数据迁移的三个「不报错」陷阱

1. **`unique_keys` 不补登记 = 云端能建重名管理员且不报错**。文档库没有 UNIQUE 索引，
   存量数据搬过去后这个集合**是空的**。→ 迁移必须按 8 个 scope 补登记（见方案文档 §三.3）。
2. **NULL 不能登记进 `unique_keys`**。MySQL 的 UNIQUE 允许多行 NULL
   （学生账号 `openid` 为 NULL；老微信用户 `username` 为 NULL）。
   登记 `user_openid:null` 就只剩一行能占这个键 —— 与原语义**相反**。
3. **`sequence` 必须预置，且预置值 = `max(id)`**（不是 `+1`）。
   `nextId()` 的语义是「`sequence.value` = 已发出的最后一个 id」，取号时先 `inc` 再返回。
   云数据库只保证 `_id` 唯一、**不校验业务 `id`** → 撞号静默，前端按 id 跳详情拿到错的那条。

### 阶段 6：定时器为什么不直接每分钟裸跑 `sweep()`

免费额度 **10 万 GBs/月**，而 `资源使用量 = 内存(GB) × 时长(s)` ——
每分钟一次 = 43,200 次/月（调用次数只占 22%，**不紧张**），
但每次跑满 3 s（256 MB）就是 **32,400 GBs ≈ 32% 额度**。

→ **成本杀手是「时长」不是「次数」**，所以解法是让**空转极快返回**（`hasPendingWork` 三次
`count()` ≈ 2% 额度），而不是降频（降频会改变行为，原实现就是 60 s 一次）。
详见 `cloud/docs/stage6-timer-plan.md`。

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
│   ├── data-model-mapping.md      # 17 张 MySQL 表 → 云数据库集合映射
│   ├── stage5-scheduling-plan.md  # 排期算法重写方案
│   ├── stage6-timer-plan.md       # 定时触发器 + 「日期串字典序」踩坑
│   ├── stage7-admin-plan.md       # ★ 管理端移植方案 + 陛下裁决记录
│   └── stage8-migration-plan.md   # ★ 数据迁移方案（_id 规则 / 唯一键补登记 / 双向校验）
├── cloudfunctions/
│   └── api/                       # 主网关云函数（唯一对外函数）
│       ├── index.js               # 入口：解析入参 + 分发 + 统一异常（含定时事件分支）
│       ├── router.js              # 路由表 127 条（数组顺序即优先级）
│       ├── httpBridge.js          # ★ 阶段 9：HTTP 访问服务的「集成请求」→ 现有 event 形状
│       ├── config.json            # ★ 定时触发器配置（阶段 6）—— 随函数一起部署
│       ├── package.json           # 依赖：wx-server-sdk / jsonwebtoken / bcryptjs / axios / exceljs
│       ├── handlers/              # 按接口分文件，一个 handlerKey 对应一个方法
│       │   ├── index.js           #   REGISTRY 静态表（24 条）+ 未移植兜底诊断
│       │   ├── system.js          #   /health · init-collections
│       │   ├── user/              #   10 个模块，32 条路由
│       │   │   ├── auth.js        #     登录 / 改密 / me / 资料
│       │   │   ├── submit.js      #     投稿 / 点歌 11 个接口
│       │   │   ├── notice.js  program.js  showcase.js  cadre.js  staff.js
│       │   │   ├── message.js     #     留言
│       │   │   ├── switch.js      #     开关（含模块开关闸门）
│       │   │   └── profile.js     #     站务信息
│       │   └── admin/             #   13 个模块，93 条路由（阶段 7）
│       │       ├── _kit.js        #     ★ 公共件：asAdmin/asSuper、likeHit/anyLike、
│       │       │                  #       sortRows/cmpValue、pick、pagedList、paramError
│       │       ├── _people.js     #     ★ 社干/部员/风采的 CRUD 工厂（guard 必传）
│       │       ├── auth.js  setting.js  switch.js  program.js  notice.js
│       │       ├── message.js  stats.js
│       │       ├── cadre.js  staff.js  showcase.js  adminMgr.js
│       │       ├── student.js     #     学生名册 19 条（全超管，含 xlsx base64 契约）
│       │       └── submit.js      #     点歌 30 条（排期算法唯一真实入口）
│       ├── services/              # 业务服务（从 src/services 移植）
│       │   ├── kv.js              #   系统设置 KV
│       │   ├── switch.js          #   模块开关（含云函数用的 isEnabledAsync）
│       │   ├── studentAccount.js  #   学生账号（初始密码 / 状态缓存 / pv 新鲜度）
│       │   ├── songWindow.js      #   点播时间窗口（逐字移植）
│       │   ├── broadcastSlot.js   #   播出时段派生（15 格/周）
│       │   ├── submitRule.js      #   提交规则 / 配额
│       │   ├── songNotice.js      #   点歌注意事项 + 已读回执
│       │   ├── songStatus.js      #   三维状态 + applyChange（乐观锁唯一入口）
│       │   ├── songQueue.js       #   候选池门面 / 状态卡
│       │   ├── songRescheduleCost.js  # 调剂选址成本表（纯函数）
│       │   ├── scheduling.js      #   ★ 排期算法 12 函数 + 定时闸门 + 周行锚点
│       │   ├── sheet.js           #   ★ xlsx / csv 读写（exceljs；MAX_ROWS=5000）
│       │   ├── roster.js          #   ★ 学生名册：解析 / 归一化 / 落库 / 整届清理
│       │   ├── accessToken.js     #   微信 access_token 缓存
│       │   └── wechat.js          #   微信接口封装
│       └── lib/
│           ├── response.js         # 错误码与统一响应（原样移植）
│           ├── bjTime.js           # 北京时间工具（原样移植）
│           ├── auth.js             # JWT 校验 + pv 新鲜度 + 角色
│           └── db.js               # 数据层：唯一键模拟 / 数字主键 / 条件更新
└── scripts/
    ├── regression.js              # ★ 一键全量回归（源码 + 产物各一轮）
    ├── selfcheck.js               # 静态自检 + 产物一致性
    ├── harness.js                 # 内存假数据库（stub 掉 wx-server-sdk）
    ├── sync.js                    # 自研零依赖打包器（产物 = 单文件 index.js）
    ├── test-gateway.js            # 网关 + db 原语
    ├── test-admin-core.js         # ★ 管理端 63 条 + 93 路由权限矩阵
    ├── test-admin-submit.js       # ★ 点歌 30 条 + 排期算法整链路
    ├── test-admin-student.js      # ★ 学生账号 19 条 + roster/sheet
    ├── test-admin-routes.js       # ★ 路由 ↔ handler 就绪性守门（仅源码目录）
    ├── test-migration.js          # ★ 阶段 8 数据迁移 + 双向校验（含 4 类反向用例）
    ├── test-http-bridge.js        # ★ 阶段 9 HTTP 访问服务适配 + 既有通道不受影响
├── migration/                     # ★ 阶段 8 数据迁移（只读原库）
│   ├── README.md                  #   操作手册（导出 → 导入 → 校验 三步）
│   ├── tables.js                  #   表级规则唯一声明处（_id 规则 / 唯一键 scope）
│   ├── wire.js                    #   落盘编解码（{ $date } ISODate 格式）+ 值相等判定
│   ├── transform.js               #   行 → 云文档（纯函数，无 IO）
│   ├── unique-keys.js             #   unique_keys 补登记（NULL 不登记）
│   ├── sequence.js                #   sequence 计数器预置（防 id 撞号）
│   ├── export.js                  #   读源库 → out/（**只 SELECT**）
│   ├── verify.js                  #   双向校验（源 ↔ 云，含唯一键/计数器结构检查）
│   ├── out/                       #   导出产物（**已 gitignore，含密码哈希**）
│   └── cloud-dump/                #   云库导出快照（**已 gitignore**）
    ├── test-scheduling.js         # 排期算法 12 函数 + 定时闸门（273 项）
    ├── test-scheduling-cost.js    # 调剂成本表（63 项）
    ├── test-user-*.js             # 用户端（只读 / 登录 / 投稿）
    ├── test-system.js             # /health + 建集合 + 开关
    ├── test-bundle.js             # 打包产物冒烟
    ├── verify-user.js             # 云端真实调用验收（需 IDE 自动化端口）
    └── deploy-cloud.js            # 部署（单文件产物）
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

0. ⚠️ **先把函数超时从默认 3 秒改成 20 秒**（云开发控制台 → 云函数 → api → 配置 → 超时时间）。
   CLI 没有改超时的能力，只能手点。**不改的后果**：`sweep()` 在数据多时会 3 秒掐断，
   表现为「定时任务偶尔什么都没做」，日志里只有一句超时。
   顺带确认 `config.json` 的触发器已随函数上传（控制台「触发器」页签能看到 `songSweepTick`）。
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
