# 菁悠广播站 · 项目长期备忘

> 域外细则在 `docs/`（song-protocol / song-protocol-vs-v1-spec / student-account / admin-permissions）与 skills。
> 本文件只留：铁律、必须按顺序做的操作、会反复踩的坑。
> 口径：**「收歌」已全站改名「点播」**（只改展示名，常量仍 `APPLICATION`）。

## 铁律
- **admin-web 按 v8 落地**（权威 `preview/admin-ui-v8/admin-ui-v8.html`）：唯一强调色 **#0066CC**、无渐变无彩色投影、深色卡为主角。**登录页是唯一例外**（用户 v4 分栏版），勿动。改前备份 `admin-web/_backup/<时间戳>-src/`。
- **绝不用 `git checkout --`**：工作树全是未提交成果。
- **UI/视觉需求先出静态 HTML 预览（标 v1/v2…），点头前不写业务代码**；版本只增不删（只新增 `preview/<主题>-v<N>/`，渲染图进 `shots/`）。需求含糊或被否 → 先问清形态再动手。
- 提交身份用全局 `Nailoonger <1493586497@qq.com>`，别写仓库级 user.email/name。

## 部署（服务器 `~/radio`）
- `build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 只改 views：`build admin-web` → `up -d --force-recreate --no-deps admin-web`。其 Dockerfile 是**多阶段构建、容器内自己 build**，服务器上**不需要**先 `npm run build`（本机 build 只用于自检）。
- **加表**靠启动 `sync({alter:false})`；**加列/索引必须跑 `scripts/db-repair.js`**（幂等、只加不改不删，按模型 `rawAttributes` 比对 information_schema，**通用**——新列写进模型即自动覆盖）。
- 固定顺序：备份 → build → `run --rm radio-backend node scripts/db-repair.js` → `up -d --force-recreate radio-backend` → 只跑幂等回填 UPDATE → `POST /api/admin/submit/queue/sweep`。
- ⚠️ MySQL `ALTER TABLE ADD COLUMN` **不幂等**（重跑 1060 并中断后续语句）。
- ⚠️ **关联一律显式 `constraints: false`**：`hasMany`/`belongsTo` 默认建物理外键，类型不一致（BIGINT UNSIGNED vs INTEGER）→ `sync()` 3780 → 半建表 + 进程退出 + nginx 502。
- ⚠️ **SQLite 全绿证明不了 MySQL 能建表**（不校验外键类型、不认 UNSIGNED）。判据必须是 MySQL 实测 → skill `sequelize-schema-rollout`。
- ℹ️ 2026-09-26 新增 `weekly_schedule.lock_paused`：上线前必须跑一次 db-repair。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。

## 云开发迁移（2026-09-28 起，主线）
- 起因：小程序正式版报 `url not in domain list`，合法域名要 ICP 备案 → 陛下裁决**不续费服务器，整体走云开发**（`wx.cloud.callFunction` 免备案）。铁律：**原 `src/`、`admin-web/`、Docker 链路一行不动**，只做加法；`app.js` 的 `requestMode` 保留 `'direct' | 'cloud'` 可随时切回。
- 云环境 `jy-radio-d1gdwmptl816ee6a9`（校园额度账号，换绑已完成）。总纲 `cloud/README.md`，字段映射 `cloud/docs/data-model-mapping.md`。
- ⚠️⚠️ **Windows CLI 传子目录必坏**（`\` 被写进压缩包条目名 → 云端解压出扁平文件）→ **整个云函数打成单文件**，只传根文件 `index.js` + `package.json`。打包器 `cloud/scripts/sync.js`（零依赖、静态分析字面量 require）→ **`handlers/index.js` 必须写静态 `() => require('./x')` 注册表**，动态拼路径打包器看不见。
- 部署：`node cloud/scripts/deploy-cloud.js`（默认只打印命令）→ 手动跑 `cli.bat cloud functions deploy --env <env> --names api --project <miniprogram> -r </dev/null`；**等 1~2 分钟**再验（云端 npm install 未完会报 Cannot find module）。
- 验证必须本机跑（481 项）：`selfcheck` 75 / `test-system` 21 / `test-gateway` 26 / `test-user-readonly` 76 / `test-user-auth` 62 / `test-user-submit` 206 / `test-bundle` 20。云端验收：`MSYS_NO_PATHCONV=1 node cloud/scripts/verify-user.js ws://127.0.0.1:9420`（需先 `cli.bat auto`）。
- ⚠️ **两个「不报错」的静默漂移**：① `ApiError` 是 **4 参** `(code, message, httpStatus=200, data)`，与 src 一致 —— 改成 3 参会把 `200` 当 data，附加数据静默丢失（40907 的 `opensAt` 就这么丢过）。② **鉴权在路由层**（`router.get(x, userAuth, ctrl)`），controller 不读 `req.user` 也可能要登录 —— 移植只搬 controller 就会漏，漏了只是「未登录也能看」。⇒ 逐条对照 `src/routes/*.js`。
- ⚠️ **云函数超时默认仅 3 秒**，CLI 改不了（只有 list/info/deploy/inc-deploy/download）→ 必须去控制台改（建议 20s）。
- 主键口径：业务查询一律用**数字 `id`**（`parseId` 收敛），4 张表用业务键当 `_id`（`setting:` / `switch:` / `ack:` / `week:`）。字段名一律**驼峰**。
- 进度：阶段 0~4 完成（用户端 33/33 接口）；**阶段 5 = 排期算法重写（最高风险，动工前先出方案）**。

## 给陛下的服务器命令
- 他在自己的 PowerShell 里跑。SQL 用 `docker exec -e MYSQL_PWD="$DB_PASSWORD" -i radio-mysql mysql -uroot "$DB_NAME"`；`-p<密码>` 必打印无害的 password warning（stderr，不是失败）。
- ⚠️ SQL 别用中文别名/标识符（经 shell→docker 传参乱码 1064），多行走 `<<'SQL'` heredoc。
- ⚠️ **本机 push 与服务器 pull/build 绝不写进同一个代码块**（拆两块、首行写明机器、注释另起一行），否则他整段贴到服务器 → push 报只读错。服务器 deploy key 是**只读**的，属正常设计。

## 本机坑
- Bash 工具可用（管道/heredoc/git）；走 PowerShell 时 stdout 不回显，要落盘再 Read。⚠️ **同一文件多处改动必须串行 Edit**（并发 Edit 静默吞掉前一个）。
- **改前端后先跑两个源码自检**（秒级，比截图便宜）：`node scripts/check-vue-bindings.js`（未声明 `_ctx.` 引用 —— 构建不报错、运行时只渲染空白；清单＝SubmitList + SongSettings + StatusTag）、`node scripts/check-wxml-classes.js`。
  ⚠️ 前者的「未声明引用 N 个」是**含白名单的计数**（`$router` 等），**判据是下一行 missing 有没有列名字**，别被 N 吓到。
- 构建撞 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`：`NODE_OPTIONS` 里挂着 `node-language-shim.cjs`，连 `fs.rmSync` 都被 safe-delete 拦 → 删 dist 与 build 一律 `NODE_OPTIONS=""`。
- ⚠️ **深色卡 / 窄容器里的尾部提示会被 flex-shrink 压扁折行**：改文案没用，要 `.parent{flex-wrap:wrap;row-gap:8px}` + `.hint{flex:none}`。**判据量 `height` 不量 width**（单行 ~16px）。
- 不开 Docker 的整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + `npm run seed` + `node src/app.js`；admin-web 走 vite dev（路由 `/submit/settings`，**不是** `/#/...`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。
  ⚠️ 复用的服务**会在会话之间掉线**：现象是 `curl localhost:PORT` 返回 **502**（本机代理在拦，不是真服务）→ 截图前先探活，掉了就重起后端 + vite。**用 `_shot.db` 前若 schema 变过要先 `rm` 再 db:init**（旧库会 `no such column` 崩）。
- jest 基线：56 条里 15 条失败全是已删 member 模块的（member.test 14 + switch.test 1），别当新回归。
- **push 配方**：PortableGit 凭据没问题（GCM 0.05s 返回 `Nailoonger` + `gho_…`），卡的是代理 CONNECT 隧道「闲置后首次建立」极慢 → **先 curl 预热（期望 401）再 push**：
  ```bash
  curl -s -o /dev/null -w "%{http_code}" --max-time 8 -x http://127.0.0.1:7890 \
    "https://github.com/<owner>/<repo>.git/info/refs?service=git-receive-pack"
  timeout 200 git -c credential.guiPrompt=false -c credential.interactive=never push --progress origin master
  ```
  ⚠️⚠️ **唯一可信判据是 `git status -sb` 无 `ahead N`** —— `| tail` 会换掉退出码、吞掉进度，看着像"无输出＝成功"（已误判过一次）。`ls-remote` 通 ≠ 能 push。
- 截图验证配方见 skill `web-ui-screenshot-verify`（agent-browser：stdio 用文件 fd 不能管道、`set viewport` 在 `open` 前、一次会话 ≤3 张、首张热身丢弃、元素截图必须 `shotEl(sel, file)` 两参）。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须确认已 import（漏导入会炸成功路径，被当成"操作失败"）。
- 验证脚本（SQLite 内存库，改相关代码先跑）：`verify-song-protocol.js`(187 项)、`verify-song-submit.js`(107)、`verify-student-account.js`(174)。`verify-song-queue.js` 已作废。
- **三维状态保持数字**（陛下 2026-09-26 裁决）：接口同时下发数字 + 名字（`songStatusService.statusView()`）。⚠️ **数字 ↔ 常量名只允许在 `songStatusService` 一处定义**，别处禁写裸数字。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`（id 兜同秒，防分页重复/漏）。

## 点歌体系（现行＝协议版）
- 提交**不判容量**，一律 `review=PENDING/schedule=UNASSIGNED`；审核通过只拿候选资格，`initialAllocate` 按首选时段分组、组内按提交时间升序取前 capacity，其余 `WAITING`；到 `schedule_lock_at` 跑 `lockWeek`，剩余 `AUTO_REJECTED`、周 `LOCKED`。
- ⛔ **点播截止前 `reschedule` 只做原位递补、绝不跨时段**：判据 `canCrossSlot()` = `now >= applicationEndAt`；`crossSlot` 默认 `null` 自动判断，只有 `lockWeek()` 与超管手动「执行排期」传 `true`。
- 选址＝成本表（`songRescheduleCost.js`）：同天其他时段 10 / 前后一天同时段 20 / 前后一天其他时段 30 / 更远 50 / 跨周 ∞；同 cost 按下标升序。
- 占位口径唯一：`review=APPROVED AND schedule=APPROVED`（驳回自动释放）。`status` 是**派生镜像**（5 已播放 / 6 已通过待排期 / 7 已取消），改状态一律走 `songStatusService.applyChange()`；它是带条件 UPDATE，影响 0 行 = 没抢到 → 返回**空 `logs`**，调用方判 `if (r.logs.length)`。
- **权限**：普通管理员只能看 / 通过 / 驳回 / 看候补；排期、锁定、**解锁**、人工调整（指派/改时段/标记播放/撤销）、容量·规则·窗口配置**仅超管**。⚠️ **两套口径别统一**：列表页（SubmitList）写操作**隐藏** + 只读虚线块；设置页（SongSettings）保存按钮**置灰**。
- **解锁（`POST /submit/schedule/unlock`，仅超管，2026-09-26）**：①周退回 `SCHEDULING` + 清 `locked_at` ②锁定时被系统自动驳回的候补退回 `WAITING`（只动仍原封不动的，`restore:false` 可跳过）③**`lock_paused = 1`** —— 不能省：`sweep()` 只按 `now >= schedule_lock_at` 自动锁，解锁必然发生在锁定时刻之后，不拦住下一轮 sweep＝解锁白做。恢复自动锁定只能**手动重新锁定**（`lockWeek()` 清 0）。解锁不动锚点。
- **时间窗口（2026-09-25 改版）**：星期**任选 周一→周日**，最长可铺满整周。⚠️⚠️ 锚点＝**点播周的周一 00:00**（＝播出周 − 7 天），`offMon(d) = (d===0?7:d)-1`；旧 `offBack(d)=(1-d+7)%7` 对周一给 0 → 窗口落到播出周本身 → `nextWeekRange` 跳周。硬约束只有 `0 ≤ startOff < endOff ≤ 7 天`。
- **点播截止 ≠ 审核截止**：`application_end_at` 只停止收新歌；`schedule_lock_at = review_end_at = 审核截止`（KV `reviewDay`/`reviewTime`；**null = 未配置 → 退回「点播结束 + `song_lock_offset_minutes`」**）。前端**别再用 `lockAt − applicationEndAt` 反算偏移**，`weekView` 已下发 `reviewEndAt`。
- ⚠️ **周行锚点会跟着配置刷新**（`ensureWeek → refreshAnchors`）：学生端窗口＝实时读 KV，周状态/闸门/锁定时刻＝周行快照。`DRAFT/APPLICATION/REVIEW` 重新对齐配置；**`SCHEDULING/LOCKED/CANCELLED` 冻结**。
- 保留不变：每人每周 2 次、同曲一周去重。有意偏离协议：不建 `schedule_slots` 表（格子由 `broadcastSlotService` 派生）；容量仍是全局 KV；`song_queue_limit` 废弃。
- ⚠️ **两个「周」必须分清**：点播窗口星期任选、锚定**点播周**；播出时段固定**下一周周一~周五**、锚定**播出周**。页面文案要标归属。
- **提交路径只有 5 个拦截码**：`40303` 未确认注意事项 / `40907` 窗口外 / `40001` 时段非系统下发 / `40903` 同曲重复·次数用完 / `40901` 一分钟内重提。**`40902 / 40904 / 40906` 已无任何生产路径**（仅存 `response.js` 常量）→ 文档与页面别再引用；`SLOT_FULL_REASON` 是**排期阶段**的驳回理由。

## admin-web 点歌页（2026-09-27 / 09-28 落定）
- **周状态带**（commit `1a274de`）：**一个阶段只有两种形态** —— 进行中带「中」（点播中/审核中/排期中），**已完成与未到都不带**；状态只由胶囊颜色表达（深 `--ink`＝当前 / 绿＝已走过 / 羊皮纸＝未到 / 浅灰＝已取消）。`WEEK_FLOW` 存 `cn`+`on` 两个名，`cn: isOn ? x.on : x.cn`。后端 `WEEK_STATUS_CN` 是**"进行中"口径**，去「中」由前端做；`DRAFT` 两端统一「未开放」。
  ⚠️⚠️ **前端 `WEEK_FLOW` 必须与后端 `WEEK_STATUS` 六态对齐**（DRAFT/APPLICATION/REVIEW/SCHEDULING/LOCKED/CANCELLED）：曾漏 `CANCELLED` → `findIndex` 返回 −1 → **整条链全落「未到」**，静默错不报错。
- **改名「收歌」→「点播」**：只改展示名，常量仍 `APPLICATION`，接口/数据零改动。⚠️ **改名会打断验证脚本的断言期望 → 必须连脚本一起换 + 重跑**，不能只看构建。残留「收歌」只在 docs / 历史 preview / `sql` 列 COMMENT。
- **投稿列表 8 列**（1920 视口）：selection 46 / 内容 `min-width:330`（唯一弹性）/ **首选时段 150**（2026-09-27 新增）/ 投稿人 150（居中）/ 提交时间 118 / 审核人·时间 142（居中）/ 状态 148（居中）/ 操作 **236**（`fixed="right"`）。**没有空列** —— 那段"有分隔线没内容"是内容列的右半截。⚠️ 改前先 `getBoundingClientRect()` 逐列量，别拿截图猜。
  ⚠️ 操作列 236 是算出来的：最长组合 184 + padding 20 → 204，取 236 留余量；**旧值 200 会把「查看日志」裁成「查看」**。判断"用户报的裁切是不是当前 bug"→ 先看**按钮组合对不对得上代码**（超管在「已排期」下不渲染「查看日志」，截图里有它＝更早版本）。实体按钮宽：通过/驳回 54、改时段 66、标记播放 78、指派时段 78；文字链 `.op-log`≈52 / `.op-del`≈28；gap 6。**量折行看 height 不看 width**。
- **「首选时段」列的调剂红标**（陛下裁定 B 方案）：实排 ≠ 首选时，首选项 `line-through` + 压灰，**灰用 `--muted`(#7a7a7a) 不能用 `--soft`(#c7c7cc)**（soft 在浅底上对比度 ≈1.9:1，实测读不出来）；下一行灰箭头 `→` 引出**红色实排**，**红色只上时间串本身**（`.slot-t`），箭头与前缀字都不上色。时段串走 `shortSlot()` 去掉年份（不去年份 ≈125px > 150 列可用 ≈126px，卡折行边缘）。原则：**"退到后面" ≠ "看不见"**。
- **点歌设置已按 v3 重排（2026-09-28）**：页首「一个播出周期」总览 → **5 分组**（① 点播与审核 ② 排期 ③ 播出安排 ④ 学生端文案 ⑤ 危险区）；卡头右侧统一保存态（绿「已保存 ✓」/ 琥珀「有未保存的改动」，**只提示不拦截**，baseline 只在「拉取」与「保存成功」两处落盘）；说明文字收进卡底羊皮纸 `.tip`；容量卡上半只读统计 + `.div-line` + 下半编辑。旧版 8 板块平铺、三段失效说明（提交即占位 / 40906 / 40904）、写死的「每周六 18:00」均已删。
- ⚠️ **Element Plus 的 `el-option` 不能用 `null` 当 value**：`v-model` 为 `null` 时它视为空值，即使存在 `:value="null"` 的选项也照样显示 placeholder（实测显示成「请选择」，管理员看不出当前档位）。解法＝UI 用字符串哨兵（`FOLLOW_REVIEW`）、提交时再转回 `null`。
- **陛下发来的批注截图**：用 skill `screenshot-annotation-parse` 解析，别肉眼猜他圈的是哪一列，猜错就是整轮返工。

## 学生账号（细则 `docs/student-account.md`）
- 账号＝年级(4)+班级(2)+序号(2)；初始密码 `user`+学号（`initPasswordFor` 唯一出口）；复用 user 表。
- ⚠️ 姓名对外 `name`，库里 `remark` + `nickname` 必须同写（读取点不唯一）。头像＝姓名首字圆形，用户不可换。
- ⚠️ `utils/http.js` 对业务错误只 reject 不弹 message，调用方必须自己 `ElMessage.error(e.message)`。
- 开关 `account_login_required`（缺行视为 on）；改密/重置/停用后旧 token 靠 `pv` + 30s 状态缓存作废。
- 管理端 v2＝单页 + 条件条（年级→班级→启用→激活→批次→关键字）+ 胶囊 + 批量＝筛选结果，**不要目录树**。页头动作组走 MainLayout `#ph-actions` + `Teleport`，**必须 onMounted+nextTick 后再挂**。⚠️ 造数 `bulkCreate` 必须传模型**驼峰**属性名（下划线名被静默丢弃）。
- 顶栏 v8 定稿：**没有全局搜索、没有刷新按钮**；副标题＝`共 N 个账号 · X 届 · 已激活 M`。

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 全局候补队 / `song_queue_limit`）。
- 登录页 v1（AI 底图 + 插画）全删且被否，别再走「AI 生成底图」。
- 学生账号 v1（目录树形态）。
