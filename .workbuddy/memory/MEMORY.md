# 菁悠广播站 · 项目长期备忘

> **本文件只留：铁律 + 固定操作顺序 + 反复踩的坑。**
> 细则位置：`docs/`（song-protocol / student-account / admin-permissions）、`cloud/README.md` + `cloud/docs/*`、`.workbuddy/memory/PROJECT-NOTES.md`（点歌体系细则坑 / admin-web 视觉参数 / 学生账号 / 已废弃 —— 改对应模块前读那一节）、各 skill。
> 口径：「收歌」已全站改名「点播」（只改展示名，常量仍 `APPLICATION`）。

## 铁律
- **只做加法**：原 Express `src/` + `admin-web/` + Docker 链路一行不删，保留 `requestMode: 'direct'|'cloud'` 开关（陛下：「不要删除原来的，以防我想换回来」）。
- **绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉改动**先出静态 HTML 预览并标版本号（v1/v2…），点头前不写业务代码**；版本只增不删。被否或含糊 → 先问清形态。
- 提交身份用全局 `Nailoonger <1493586497@qq.com>`，不写仓库级 user.*。

## 云开发迁移（`cloud/` · 阶段 0–9 全做完，只剩真机导入/部署）
起因：小程序正式版 `url not in domain list`（合法域名需备案）→ 陛下裁决**不续费服务器、整体走云开发**（免费额度 20 万次调用/月、10 万 GBs/月、容量 2GB）。
- 环境 `jy-radio-d1gdwmptl816ee6a9`；appid `wxa88836729f07a976`。总纲 `cloud/README.md`；方案 `cloud/docs/stage5|6|7|8|9-*.md`；skill `express-to-cloudfunction-migration`（**25 条静默漂移**）。
- 进度：0–9 全完成。回归 **3115 项 / 0 失败**（源码 15 套件 + 产物 13 套件）。产物 50 模块 / 395.2 KB。
- **阶段 9（admin-web 接云）走 HTTP 访问服务**：「要不要备案」**都不需要**（官方默认域名已备案，只有绑自有域名才要）。选 A 不选 B（B 多 npm 依赖 + 需开匿名登录），代价是 A 的默认域名**有有效期需续期**。
  - `api/httpBridge.js` 把「集成请求」还原成 `{method,path,body,token,query}`。⚠️ 适配必须放在 index.js **解构 event 之前**（放错完全不生效且不报错）；判据只认 `httpMethod || requestContext`（收窄，否则误伤小程序请求）。信封模式（admin-web 用，不依赖路径透传）+ RESTful 兜底。
  - admin-web `src/utils/http.js`＝**门面**：`VITE_REQUEST_MODE=direct` 导出原 axios 实例（行为逐字不变），`=cloud` 导出同形状门面 → 全站 114 处调用零改动。xlsx 改走 `{filename,base64,mime}` → `atob` 还原 Blob。⚠️ 认证分支别加 `body?.code === 40101`（原后端失败统一返 HTTP 401，加了就是改行为）。
- **阶段 8 数据迁移（`cloud/migration/`，手册 `README.md`）**：只 SELECT 原库 → JSON Lines → 控制台导入 → 控制台导出 → `verify.js` 双向校验。
  - 官方三约束：JSON **Lines**、时间必须 `{"$date":"<ISO>"}`（裸 ISO 串 → 导入后是普通字符串，时间条件**静默失效**）、Upsert 可重复。
  - 三个「不报错」陷阱：① **`unique_keys` 必须补登记**（文档库无 UNIQUE，不补＝能建重名管理员**且不报错**），**NULL 一律不登记**（MySQL UNIQUE 允许多行 NULL）② **`sequence` 预置 = `max(id)` 不是 +1**（`nextId` 先 inc 再返回）③ `weekStartDate` 是 DATEONLY，**保持字符串**（转 Date 会把 `_id` 拼成 `week:Mon Oct 05 2026…`，周行再也查不到）。
  - 迁移脚本一律纯函数无 IO；**大整数 id 走 `Number()` 归一**（BIGINT 经 mysql2 返字符串）。
- **两处源实现瑕疵（陛下已裁决 2026-09-29）**：① `overview.approved` 与 `topSongs()` 的 `status:1` → **均改 `status ∈ {1,5,6}`**（⚠️ 别再"顺手"改回）② `previewSchedule(dryRun)` 的 `promoted/rescheduled/stillWaiting` 恒 0 已修（`reschedule` 加 dryRun 专用字段，**按 id 去重**），顺带修 `autoRejectedIfLocked` 虚高 → 漂移 #23。教训：**「把恒 X 改成真实值」必须补反向用例**。
- **架构**：源 `cloud/cloudfunctions/api/`，运行目录 `miniprogram/cloudfunctions/api/`。⚠️⚠️ **Windows CLI 传子目录必坏**（`\` 进压缩包条目名 → 云端扁平化，`require('./lib/x')` 必败）→ `sync.js` 把 50 模块打成**单文件 index.js**，只传根文件 + `config.json`。⇒ `handlers/index.js` 必须是**静态注册表**。
- **部署**：`node cloud/scripts/deploy-cloud.js`（默认只打印）→ 手动 `cli.bat cloud functions deploy --env <env> --names api --project <miniprogram> -r </dev/null` → **等 1~2 分钟**再验。
- **速查**：改完跑 `node cloud/scripts/regression.js`（一键双轮）；⚠️ 本机沙箱**禁子进程**（`spawnSync` 返 `EBUSY`）→ 只能手工双跑。⚠️ 产物模式 `HARNESS_API_DIR=miniprogram/cloudfunctions/api` **项数必须与源码模式一致**。打包/删 dist 一律 `NODE_OPTIONS=""`。云端验收 `MSYS_NO_PATHCONV=1 node cloud/scripts/verify-user.js ws://127.0.0.1:9420`。
- **口径**：业务查询一律用**数字 `id`**（`parseId`）；4 张表用业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段名一律**驼峰**；⚠️ `insertOne` 之后改这行必须用**返回的 `_id`**。

## 真机收尾（陛下动手，顺序不能乱）
> 进度：① HTTP 路由 ✅ ② 部署云函数 ✅（2026-09-29 本机实测 `GET /api/health` → HTTP 200）；③④⑤⑥⑦ 待做。
> ⚠️ `dbReady: true` 只代表云库**连得上**，业务数据还没导（阶段 8 的 ③④⑤）。
> ⚠️ 实测：关路径透传时**触发路径会被剥掉**（`/api/health` 通、`/health` 网关直 404 `INVALID_PATH`）。
1. 控制台 → HTTP 访问服务 → 给 `api` 配触发路径 `/api`，记下默认域名
2. 部署云函数（产物已含 httpBridge）：`node cloud/scripts/deploy-cloud.js` 看命令 → 手动跑 → 等 1~2 分钟
3. 生产 MySQL 跑 `node cloud/migration/export.js` → `out/`（**已 gitignore**，含密码哈希）
4. 控制台逐集合导入（16 表 + `unique_keys` + `sequence`，**Upsert**）
5. 控制台逐集合导出 JSON → `cloud/migration/cloud-dump/<集合名>.json`（**文件名必须＝集合名**）
6. `node cloud/migration/verify.js` 看双向报告
7. admin-web `.env.local` 填 `VITE_REQUEST_MODE=cloud` + `VITE_CLOUD_API_URL=https://<envId>-<数字>.ap-shanghai.app.tcloudbase.com/api` → 重新 build

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 只改 views：`build admin-web` → `up -d --force-recreate --no-deps admin-web`；其 Dockerfile 容器内自 build。
- ⚠️ **`git pull` 不影响运行中的容器**（容器用构建时的镜像快照）→ 跑一次性脚本（如迁移导出）用
  `docker cp cloud/. radio-backend:/app/cloud` 塞进去（免 rebuild）；⚠️ 必须 `exec -u root`，因为 cp 进去的文件属 root、默认 `app` 用户写不了 `out/`。结尾 `/.` 是「只拷内容」（不写会套成 `/app/cloud/cloud`）。
- **加表**靠启动 `sync({alter:false})`；**加列/索引必须跑 `scripts/db-repair.js`**（幂等、只加不改不删）。固定顺序：备份 → build → `run --rm radio-backend node scripts/db-repair.js` → `up -d --force-recreate radio-backend` → 幂等回填 UPDATE → `POST /api/admin/submit/queue/sweep`。
- ⚠️ MySQL `ALTER TABLE ADD COLUMN` **不幂等**（重跑 1060 中断后续）。
- ⚠️ **关联一律 `constraints: false`**（默认建物理外键，类型不一致 → `sync()` 3780 → 半建表 + 502）。
- ⚠️ **SQLite 全绿证明不了 MySQL 能建表** → 判据必须 MySQL 实测（skill `sequelize-schema-rollout`）。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。
- 陛下跑 SQL：`docker exec -e MYSQL_PWD="$DB_PASSWORD" -i radio-mysql mysql -uroot "$DB_NAME"`；`-p<密码>` 的 warning 在 stderr 不是失败。⚠️ SQL 别用中文别名/标识符（乱码 1064），多行走 `<<'SQL'` heredoc。⚠️ **本机 push 与服务器 pull/build 绝不写进同一代码块**（他整段贴服务器会报只读；deploy key 只读属正常设计）。

## 本机坑
- Bash 可用（管道/heredoc/git）；PowerShell stdout 不回显 → 落盘再 Read。⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。
- **改前端先跑两个源码自检**：`node scripts/check-vue-bindings.js`（未声明 `_ctx.` 引用 —— 构建不报错、运行时只渲染空白）、`node scripts/check-wxml-classes.js`。⚠️ 前者「未声明 N 个」含白名单，**判据是下一行 missing 有没有列名字**。
- ⚠️ **深色卡/窄容器尾部提示被 flex-shrink 压扁折行**：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。**判据量 height 不量 width**。
- 不开 Docker 整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + `npm run seed` + `node src/app.js`；admin-web 走 vite dev（路由 `/submit/settings`，**不是** `/#/...`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。⚠️ 复用服务**会跨会话掉线**（`curl` 返 502 是本机代理在拦）→ 截图前探活。**`_shot.db` schema 变过要先 `rm` 再 db:init**。
- jest 基线：56 条里 15 条失败全是已删 member 模块（member.test 14 + switch.test 1），别当新回归。
- ⚠️ **push 本机推不了**（GCM 非交互取不到凭据）⇒ commit 我负责，**push 由陛下在自己 PowerShell 敲**。先 `curl` 预热探活，再 `git -c credential.guiPrompt=false -c credential.interactive=never push --progress origin master`。⚠️⚠️ **唯一可信判据是 `git status -sb` 无 `ahead N`**（`| tail` 会吞进度，已误判过一次）。
- ⚠️⚠️ **部署云函数本机做不了**：沙箱把 `reg.exe` 列入程序黑名单（安全中心 → 命令安全），
  `cli.bat` 初始化即失败（报 `wait IDE port timeout`）⇒ **必须陛下在自己终端跑**。
  CLI = `D:\dev\wx-devtools\cli.bat`；服务端口**已开**（`enableServicePort: true`）。收尾清单：`cloud/docs/final-cutover.md`。
- ⚠️ **PowerShell `Add-Type` 被安全策略拦**（禁止运行时编译 .NET）→ 图像裁剪走 Python venv：
  `~/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（已装 pillow）。
- 截图验证配方见 skill `web-ui-screenshot-verify`。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须已 import（漏导入炸成功路径，被当成"操作失败"）。
- 验证脚本（SQLite 内存库）：`verify-song-protocol.js`、`verify-song-submit.js`、`verify-student-account.js`。`verify-song-queue.js` 已作废。
- **三维状态保持数字**：接口同时下发数字 + 名字（`songStatusService.statusView()`）。⚠️ 数字↔常量名只允许在 `songStatusService` 一处定义。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`。
