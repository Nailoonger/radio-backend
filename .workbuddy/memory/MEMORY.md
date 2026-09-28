# 菁悠广播站 · 项目长期备忘

> 细则在 `docs/`（song-protocol / student-account / admin-permissions）、`cloud/README.md` + `cloud/docs/*`、skills。本文件只留铁律、固定操作顺序、反复踩的坑。
> 口径：**「收歌」已全站改名「点播」**（只改展示名，常量仍 `APPLICATION`）。

## 铁律
- **只做加法**：原 Express `src/` + `admin-web/` + Docker 链路一行不删，保留 `requestMode: 'direct'|'cloud'` 开关。陛下原话「不要删除原来的，以防我想换回来」。
- **绝不用 `git checkout --`**（工作树全是未提交成果）。
- UI/视觉需求**先出静态 HTML 预览（标 v1/v2…），点头前不写业务代码**；版本只增不删（新增 `preview/<主题>-v<N>/`，图进 `shots/`）。需求含糊或被否 → 先问清形态。
- 提交身份用全局 `Nailoonger <1493586497@qq.com>`，不写仓库级 user.email/name。

## 云开发迁移（`cloud/`，主线 · 阶段 0–9 **全部做完**，只剩真机导入与部署）
- **起因**：小程序正式版 `url not in domain list`（合法域名需 ICP 备案）→ 陛下裁决**不续费服务器、整体走云开发**。免费额度：调用 20 万次/月、资源使用量 10 万 GBs/月、容量 2GB。
- 环境 `jy-radio-d1gdwmptl816ee6a9`。总纲 `cloud/README.md`；字段映射 `cloud/docs/data-model-mapping.md`；方案 `stage5-scheduling-plan.md` / `stage6-timer-plan.md` / `stage7-admin-plan.md`；skill `express-to-cloudfunction-migration`（**23 条静默漂移**）。
- **进度**：0–9 **全部完成**（真机导入/部署待陛下跑）。回归 **3115 项 / 0 失败**（源码 15 套件 1620 + 产物 13 套件 1495）。产物 50 模块 / 395.2 KB。
- **阶段 9（admin-web 接云）= HTTP 访问服务通道**：⚠️ 「要不要备案」的答案是**都不需要**（用官方默认域名即可；只有绑自有域名才要）。A（HTTP 访问服务）默认域名有**有效期需续期**；B（Web SDK）无此问题但多一个 npm 依赖 + 要开匿名登录 ⇒ **选 A**。
  - 云函数侧 `api/httpBridge.js`：把「集成请求」还原成 `{method,path,body,token,query}`，适配必须放在 index.js **解构 event 之前**（放错完全不生效）；判据只认 `httpMethod || requestContext`（收窄，否则误伤小程序请求）。两种形态：信封模式（admin-web 用，不依赖「路径透传」）+ RESTful 兜底。
  - admin-web `src/utils/http.js` 改成**门面**：`VITE_REQUEST_MODE=direct` 导出原 axios 实例（行为逐字不变），`=cloud` 导出同形状门面 → 全站 114 处调用零改动。xlsx 走 `{filename,base64,mime}` → `atob` 还原 Blob。
  - `cloud/scripts/test-http-bridge.js` 32 项；关键反向保护：E 段钉死「小程序 callFunction 与定时触发照旧」。
- **阶段 8（`cloud/migration/`，手册 `cloud/migration/README.md`）**：只 SELECT 原库 → JSON Lines → 控制台导入 → 控制台导出 → `verify.js` 双向校验。⚠️ 官方三约束：JSON **Lines**、时间必须 `{"$date": "<ISO>"}`（写成裸 ISO 串 → 导入后是字符串，时间条件**静默失效**）、Upsert 可重复。三个陷阱：① **`unique_keys` 必须补登记**（文档库无 UNIQUE，不补＝能建重名管理员**且不报错**），**NULL 不登记**（MySQL UNIQUE 允许多行 NULL）② **`sequence` 预置 = `max(id)` 不是 +1**（nextId 是「先 inc 再返回」）③ `weekStartDate` 是 DATEONLY，**保持字符串**（转 Date 会把 `_id` 拼成 `week:Mon Oct 05 2026…`）。
- **陛下已裁决的两处源实现瑕疵（2026-09-29）**：
  - `stats.overview.approved` 与 `topSongs()` 的口径 `status:1` → **均改 `status ∈ {1,5,6}`** ✅（陛下分两次拍板；⚠️ 别再"顺手"改回 `{status:1}`）。
  - `previewSchedule(dryRun)` 的 `promoted/rescheduled/stillWaiting` 恒 0 → 已修（`reschedule` 新增 dryRun 专用 `extraWaiting`/`seatedOverride`，**按 id 去重**）；顺带修 `autoRejectedIfLocked` 虚高（原复用当前闸门下的 `left`，而 `lockWeek` 显式 `crossSlot:true` → 预览说驳回 1、真锁定 0，**主结论都错**）。→ 漂移 #23。
  - 教训：**「把恒 X 改成真实值」的修复必须补反向用例**（造「值该不为 X」的场景）；自检 `git diff --stat` 里测试脚本必须同时在列。
- **架构**：源在 `cloud/cloudfunctions/api/`，**运行目录** `miniprogram/cloudfunctions/api/`。⚠️⚠️ **Windows CLI 传子目录必坏**（`\` 写进压缩包条目名 → 云端解压出扁平文件，`require('./lib/x')` 必败）→ `sync.js` 把 **50 模块打成单文件 index.js**，只传根文件 + `config.json`。⇒ `handlers/index.js` 必须是**静态 `() => require('./x')` 注册表**，动态拼路径打包器看不见。
- **部署**：`node cloud/scripts/deploy-cloud.js`（默认只打印）→ 手动 `cli.bat cloud functions deploy --env <env> --names api --project <miniprogram> -r </dev/null`；**等 1~2 分钟**再验。
- **会话速查**：改完跑 `node cloud/scripts/regression.js`（一键双轮）；⚠️ 本机沙箱**禁止子进程**（`spawnSync` 返 `EBUSY`）→ 只能手工双跑，脚本会列出命令。⚠️ 产物模式 `HARNESS_API_DIR=miniprogram/cloudfunctions/api` **项数必须与源码模式一致**。打包/删 dist 一律 `NODE_OPTIONS=""`（safe-delete 拦 `fs.rmSync`）。云端验收 `MSYS_NO_PATHCONV=1 node cloud/scripts/verify-user.js ws://127.0.0.1:9420`。
- **口径**：业务查询一律用**数字 `id`**（`parseId` 收敛）；4 张表用业务键当 `_id`（`setting:`/`switch:`/`ack:`/`week:`）；字段名一律**驼峰**；⚠️ `insertOne` 之后改这一行必须用**返回的 `_id`**，不能用数字 id。
- **需陛下动手**：① 控制台确认触发器页签有 `songSweepTick`（超时 3s → **30s ✅ 已配**）② HTTP 访问服务给 `api` 配触发路径 `/api` 并在 `.env.local` 填 `VITE_REQUEST_MODE=cloud` + `VITE_CLOUD_API_URL`（默认域名**有有效期**，到期控制台点「续期」）。

## 真机收尾（陛下动手，顺序不能乱）
1. 云开发控制台 → HTTP 访问服务 → 给 `api` 云函数配触发路径 `/api`，记下默认域名
2. 部署云函数（产物已含 httpBridge）：`node cloud/scripts/deploy-cloud.js` 看命令 → 手动跑，等 1~2 分钟
3. 对生产 MySQL 跑 `node cloud/migration/export.js` → `out/`（**已 gitignore**，含密码哈希）
4. 控制台逐集合导入（16 表 + `unique_keys` + `sequence`，Upsert）
5. 控制台逐集合导出 JSON → `cloud/migration/cloud-dump/<集合名>.json`
6. `node cloud/migration/verify.js` 看双向报告（文件名必须＝集合名）
7. admin-web `.env.local` 填 `VITE_REQUEST_MODE=cloud` + `VITE_CLOUD_API_URL` → 重新 build

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 只改 views：`build admin-web` → `up -d --force-recreate --no-deps admin-web`；其 Dockerfile 容器内自己 build，服务器**不需要**先 `npm run build`。
- **加表**靠启动 `sync({alter:false})`；**加列/索引必须跑 `scripts/db-repair.js`**（幂等、只加不改不删）。
- 固定顺序：备份 → build → `run --rm radio-backend node scripts/db-repair.js` → `up -d --force-recreate radio-backend` → 幂等回填 UPDATE → `POST /api/admin/submit/queue/sweep`。
- ⚠️ MySQL `ALTER TABLE ADD COLUMN` **不幂等**（重跑 1060 中断后续）。
- ⚠️ **关联一律 `constraints: false`**（默认建物理外键，类型不一致 → `sync()` 3780 → 半建表 + 502）。
- ⚠️ **SQLite 全绿证明不了 MySQL 能建表** → 判据必须 MySQL 实测（skill `sequelize-schema-rollout`）。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。
- 陛下跑 SQL：`docker exec -e MYSQL_PWD="$DB_PASSWORD" -i radio-mysql mysql -uroot "$DB_NAME"`；`-p<密码>` 的 warning 在 stderr，不是失败。⚠️ SQL 别用中文别名/标识符（乱码 1064），多行走 `<<'SQL'` heredoc。⚠️ **本机 push 与服务器 pull/build 绝不写进同一代码块**（他整段贴服务器会报只读；deploy key 只读属正常设计）。

## 本机坑
- Bash 可用（管道/heredoc/git）；PowerShell stdout 不回显，要落盘再 Read。⚠️ **同一文件多处改动必须串行 Edit**（并发静默吞前一个）。
- **改前端先跑两个源码自检**（秒级）：`node scripts/check-vue-bindings.js`（未声明 `_ctx.` 引用——构建不报错、运行时只渲染空白；清单＝SubmitList + SongSettings + StatusTag）、`node scripts/check-wxml-classes.js`。⚠️ 前者「未声明 N 个」是**含白名单计数**，**判据是下一行 missing 有没有列名字**。
- ⚠️ **深色卡/窄容器尾部提示被 flex-shrink 压扁折行**：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。**判据量 height 不量 width**。
- 不开 Docker 整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + `npm run seed` + `node src/app.js`；admin-web 走 vite dev（路由 `/submit/settings`，**不是** `/#/...`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。⚠️ 复用服务**会跨会话掉线**（`curl` 返 502 是本机代理在拦）→ 截图前探活。**`_shot.db` schema 变过要先 `rm` 再 db:init**。
- jest 基线：56 条里 15 条失败全是已删 member 模块（member.test 14 + switch.test 1），别当新回归。
- ⚠️ **push 本机推不了**（GCM 非交互取不到凭据，`fatal: unable to get password from user`）⇒ commit 我负责，**push 由陛下在自己 PowerShell 敲**。预热：`curl -s -o /dev/null -w "%{http_code}" --max-time 8 -x http://127.0.0.1:7890 "https://github.com/<owner>/<repo>.git/info/refs?service=git-receive-pack"`，再 `timeout 200 git -c credential.guiPrompt=false -c credential.interactive=never push --progress origin master`。⚠️⚠️ **唯一可信判据是 `git status -sb` 无 `ahead N`**（`| tail` 会换掉退出码吞掉进度，已误判过一次）。
- 截图验证配方见 skill `web-ui-screenshot-verify`（stdio 用文件 fd 不能管道、`set viewport` 在 `open` 前、一次会话 ≤3 张、首张热身丢弃、`shotEl(sel,file)` 两参）。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须已 import（漏导入炸成功路径，被当成"操作失败"）。
- 验证脚本（SQLite 内存库）：`verify-song-protocol.js`(187)、`verify-song-submit.js`(107)、`verify-student-account.js`(174)。`verify-song-queue.js` 已作废。
- **三维状态保持数字**：接口同时下发数字 + 名字（`songStatusService.statusView()`）。⚠️ 数字↔常量名只允许在 `songStatusService` 一处定义。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`。

## 点歌体系（现行＝协议版，完整细则 `docs/song-protocol.md`）
- 提交**不判容量**；审核通过只拿候选资格，`initialAllocate` 按首选时段分组、组内按提交时间升序取前 capacity，其余 `WAITING`；到 `schedule_lock_at` 跑 `lockWeek`，剩余 `AUTO_REJECTED`。
- ⛔ **点播截止前 `reschedule` 只做原位递补、绝不跨时段**（`canCrossSlot()` = `now >= applicationEndAt`）；只有 `lockWeek()` 与超管手动「执行排期」传 `crossSlot:true`。选址＝成本表（`songRescheduleCost.js`）：同天他段 10 / 邻日同段 20 / 邻日他段 30 / 更远 50 / 跨周 ∞。
- 占位口径唯一：`review=APPROVED AND schedule=APPROVED`。`status` 是**派生镜像**（1 已排期 / 5 已播放 / 6 已通过待排期 / 7 已取消），改状态一律走 `songStatusService.applyChange()`（影响 0 行＝没抢到 → 返回**空 `logs`**，调用方判 `if (r.logs.length)`）。
- **权限**：普管只能看/通过/驳回/看候补；排期、锁定、解锁、人工调整、配置**仅超管**。⚠️ **两套口径别统一**：列表页写操作**隐藏** + 只读虚线块；设置页保存按钮**置灰**。
- **解锁（仅超管）**：①周退回 `SCHEDULING` ②被自动驳回的候补退回 `WAITING` ③**`lock_paused = 1`**（不设则下一轮 sweep 立刻重锁＝白做）。恢复只能**手动重新锁定**。
- ⚠️⚠️ 时间窗口锚点＝**点播周的周一 00:00**（＝播出周 −7 天），`offMon(d)=(d===0?7:d)-1`；旧 `offBack` 对周一给 0 → 窗口落到播出周本身。硬约束只有 `0 ≤ startOff < endOff ≤ 7 天`。
- **点播截止 ≠ 审核截止**：`schedule_lock_at = review_end_at = 审核截止`（KV `reviewDay`/`reviewTime`；null → 退回「点播结束 + 偏移」）。前端别反算偏移，`weekView` 已下发 `reviewEndAt`。
- ⚠️ **周行锚点跟着配置刷新**（`ensureWeek → refreshAnchors`）：学生端窗口＝实时读 KV；`DRAFT/APPLICATION/REVIEW` 重新对齐，**`SCHEDULING/LOCKED/CANCELLED` 冻结**。
- ⚠️ **两个「周」分清**：点播窗口锚**点播周**；播出时段固定下一周周一~周五、锚**播出周**。
- **提交路径只有 5 个拦截码**：`40303`/`40907`/`40001`/`40903`/`40901`。**`40902/40904/40906` 已无生产路径**（仅存常量）；`SLOT_FULL_REASON` 是排期阶段理由。

## admin-web 点歌页
- **周状态带**：**一个阶段只有两种形态**——进行中带「中」，已完成与未到都不带；只由胶囊颜色表达（深 `--ink`＝当前 / 绿＝走过 / 羊皮纸＝未到 / 浅灰＝已取消）。`WEEK_FLOW` 存 `cn`+`on`。⚠️⚠️ **必须与后端 `WEEK_STATUS` 六态对齐**（曾漏 `CANCELLED` → `findIndex` −1 → 整条链全落「未到」，静默错）。
- **改名「收歌」→「点播」**：只改展示名。⚠️ 会打断验证脚本断言 → 必须连脚本一起换 + 重跑。
- **投稿列表 8 列**（1920 视口）：selection 46 / 内容 `min-width:330`（唯一弹性）/ 首选时段 150 / 投稿人 150 / 提交时间 118 / 审核人·时间 142 / 状态 148 / 操作 **236**（`fixed="right"`）。⚠️ 改前 `getBoundingClientRect()` 逐列量，别拿截图猜；**量折行看 height 不看 width**。按钮宽：通过/驳回 54、改时段 66、标记播放 78、指派时段 78；`.op-log`≈52 / `.op-del`≈28；gap 6。
- **「首选时段」列调剂红标**（陛下裁定 B）：实排≠首选时，首选项 `line-through` + 压灰，**灰用 `--muted`(#7a7a7a) 不能用 `--soft`(#c7c7cc)**（对比度 ≈1.9:1 读不出）；下一行灰箭头引出**红色实排**，红色只上时间串（`.slot-t`）。时段串走 `shortSlot()` 去年份。原则：「退到后面」≠「看不见」。
- **点歌设置 v3**：页首「一个播出周期」总览 → 5 分组；卡头右侧保存态（绿「已保存 ✓」/ 琥珀「有未保存的改动」，**只提示不拦截**）；说明收进卡底羊皮纸 `.tip`；容量卡上半只读统计 + `.div-line` + 下半编辑。
- ⚠️ **Element Plus `el-option` 不能用 `null` 当 value**（`v-model` null 视为空值，显示 placeholder）→ UI 用字符串哨兵（`FOLLOW_REVIEW`），提交时转回 `null`。
- 陛下发来的批注截图 → skill `screenshot-annotation-parse`，别肉眼猜（猜错整轮返工）。

## 学生账号（细则 `docs/student-account.md`）
- 账号＝年级(4)+班级(2)+序号(2)；初始密码 `user`+学号（`initPasswordFor` 唯一出口）；复用 user 表。
- ⚠️ 姓名对外 `name`，库里 `remark` + `nickname` 必须同写（读取点不唯一）。头像＝姓名首字圆形。
- ⚠️ `utils/http.js` 对业务错误只 reject 不弹 message，调用方自己 `ElMessage.error(e.message)`。
- 开关 `account_login_required`（缺行视为 on）；改密/重置/停用后旧 token 靠 `pv` + 30s 缓存作废。
- 管理端 v2＝单页 + 条件条 + 胶囊 + 批量＝筛选结果，**不要目录树**。页头动作组走 MainLayout `#ph-actions` + `Teleport`，**必须 onMounted+nextTick 后再挂**。⚠️ `bulkCreate` 必须传模型**驼峰**属性名（下划线名被静默丢弃）。
- 顶栏 v8：**没有全局搜索、没有刷新按钮**；副标题＝`共 N 个账号 · X 届 · 已激活 M`。

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 全局候补队 / `song_queue_limit`）。
- 登录页 v1（AI 底图 + 插画）全删且被否。
- 学生账号 v1（目录树形态）。
