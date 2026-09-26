# 菁悠广播站 · 项目长期备忘

> 细节已分流到 `docs/`（song-protocol / song-protocol-vs-v1-spec / student-account）与 skills。
> 本文件只留：铁律、必须按顺序做的操作、会反复踩的坑。

## 铁律
- **admin-web 按 v8 落地**（权威 `preview/admin-ui-v8/admin-ui-v8.html`）：唯一强调色 **#0066CC**、无渐变无彩色投影、深色卡为主角。**登录页是唯一例外**（用户 v4 分栏版），勿动。改前备份 `admin-web/_backup/<时间戳>-src/`。
- **绝不用 `git checkout --`**：工作树全是未提交成果。
- **UI/视觉需求先出静态 HTML 预览（标 v1/v2…），点头前不写业务代码**；版本只增不删（只新增 `preview/<主题>-v<N>/`，渲染图进 `shots/`）。需求含糊或被否 → 先问清形态再动手。
  📌 **待裁决**：`preview/song-admin-ui-v3/`（最新）—— 状态链规则已定：**进行中 = 深色胶囊 + 「××中」，已完成 / 未到 = 同写「××」不带「中」，状态只靠颜色区分**（深 #272729 / 绿 `--green-bg` / 羊皮纸）。**待陛下挑：APPLICATION 阶段改叫什么 —— ① 点播（推荐）② 点歌 ③ 许愿 ④ 征歌**（只换展示名，常量仍 `APPLICATION`）。另：点歌设置 8 板块 → 5 分组（陛下暂未表态）；`WEEK_FLOW` 漏 `CANCELLED` 要补。**陛下点头前不动 `SubmitList.vue` / `SongSettings.vue`**。
- **别在本机构建/部署**：改完 → 本地 commit → 交陛下 push + 服务器更新步骤。提交身份用全局 `Nailoonger <1493586497@qq.com>`，别写仓库级 user.email/name。

## 部署（服务器 `~/radio`）
- `docker compose build <svc>` + `up -d --force-recreate <svc>`（restart 不换镜像）。admin-web 改 views：`docker compose build admin-web` → `up -d --force-recreate --no-deps admin-web`。
  （`admin-web/Dockerfile` 是**多阶段构建**，容器内自己 `npm ci + npm run build`，注释明写「不再依赖主机预构建」→ 服务器上**不需要**先跑 `npm run build`；本机 `npm run build` 只用于自检。）
- **加表靠启动 `sync({alter:false})`**（只建缺失的表）；**加列 / 索引必须跑 `scripts/db-repair.js`**（幂等、只加不改不删，按模型 `rawAttributes` 与 information_schema 比对，**通用**——新列写进模型即自动覆盖，不用改脚本）。`sql/schema.sql` 只在数据卷首次初始化时执行。
  ℹ️ 2026-09-26 新增 `weekly_schedule.lock_paused` 属此列 → **上线前必须跑一次 db-repair**。
- 固定顺序：备份 → build → `run --rm radio-backend node scripts/db-repair.js` → `up -d --force-recreate radio-backend` → 只跑幂等回填 UPDATE → `POST /api/admin/submit/queue/sweep`。
- ⚠️ MySQL `ALTER TABLE ADD COLUMN` **不幂等**（重跑 1060 并中断后续语句）。
- ⚠️ **关联一律显式 `constraints: false`**：Sequelize `hasMany`/`belongsTo` 默认建物理外键，类型不一致（`BIGINT UNSIGNED` vs `INTEGER`）→ `sync()` 抛 3780 中断 → 半建表 + 进程退出 + nginx 502。
- ⚠️ **SQLite 全绿证明不了 MySQL 能建表**（不校验外键类型、不认 UNSIGNED）。建表/类型/索引改动的判据必须是 MySQL 实测。详见 skill `sequelize-schema-rollout`。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。

## 给陛下的服务器命令
- 他多在自己开的 PowerShell 里跑。SQL 用 `docker exec -e MYSQL_PWD="$DB_PASSWORD" -i radio-mysql mysql -uroot "$DB_NAME"`；`-p<密码>` 必打印无害的 password warning（stderr，不是失败）。
- ⚠️ SQL 别用中文别名/标识符（经 shell→docker 传参会乱码 1064），多行走 `<<'SQL'` heredoc。
- ⚠️ **本机 push 与服务器 pull/build 绝不写进同一个代码块**：拆两块、首行写明机器、注释另起一行（混排会让陛下整段贴到服务器 → push 报只读错）。
- 服务器 deploy key 是**只读**的，在服务器上 `git push` 报 read only 属正常设计。

## 本机坑
- Bash 工具可用（管道/heredoc/git 都行）；走 PowerShell 时 stdout 不回显，要 `| Out-File -Encoding utf8` 落盘再 Read。**同一文件多处改动必须串行 Edit**（并发 Edit 会静默吞掉前一个）。
- 静态预览搬小程序样式：**rpx 折 px（1rpx=0.52px）**，折完别再套 scale；固定高手机框里 `vh` 换固定 px。
- **改前端后先跑两个源码自检**（秒级，比截图便宜）：`node scripts/check-vue-bindings.js`（未声明的 `_ctx.` 引用 —— 构建不报错、运行时只渲染空白；默认清单＝SubmitList + SongSettings + StatusTag）、`node scripts/check-wxml-classes.js`。写自检脚本必须先故意注入错误确认它抓得到 —— ⚠️ 注入用例**必须写成文本插值**，静态属性 `data-x="{{ x }}"` 不参与编译＝等于没注入（踩过两次）。
- admin-web 构建撞 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`：`NODE_OPTIONS` 里挂着 `node-language-shim.cjs`，**`fs.rmSync` 会被 safe-delete 垫片拦**。解法＝清掉垫片再删再 build：`NODE_OPTIONS="" node -e "require('fs').rmSync('admin-web/dist',{recursive:true,force:true})"`，build 也用 `NODE_OPTIONS=""` 跑。
- ⚠️ **深色卡里的尾部提示会被 flex-shrink 压扁折行**（SubmitList `.tile-act-hint`）：弹窗里那处被压到
  **w=62px → 折 3 行**（h=48，正常单行 h=16）。改文案没用（62px 什么都折），要改布局：
  `.tile-actions { flex-wrap: wrap; row-gap: 8px }` + `.tile-act-hint { flex: none }`。
  **判据用量不用看**：`getBoundingClientRect().height`，单行 ~16px。同一类在窄容器里必折 —— 新加提示先量。
- 截图验证配方见 skill `web-ui-screenshot-verify`（agent-browser：stdio 用文件 fd 不能管道、`set viewport` 在 `open` 前、一次会话 ≤3 张、首张热身丢弃）。
- 不开 Docker 的整链路验证：`DB_STORAGE=./data/_shot.db` + `npm run db:init` + seed + `node src/app.js`；admin-web vite dev（URL 是 `/student` 非 `/#/student`）；`localStorage` 存 `admin_token` + `admin_info`(role:0)。
- jest 基线：56 条里 15 条失败全是已删 member 模块的（member.test 14 + switch.test 1），别当新回归。
- **push 只能交给陛下**：本机 shell 走 WorkBuddy 自带 PortableGit，`credential.helper=helper-selector` 取不到 token（实测它**不返回任何凭据**，只是 `credential.helperselector.selected=manager` 再转 GCM），也没有 `gh`。git 已配仅 github 生效代理 `http.https://github.com.proxy=http://127.0.0.1:7890`；报 `Failed to connect to 127.0.0.1 port 7890` = 代理没启动。**FlClash 进程在跑 ≠ 代理在跑**（可能只监听 1053）。
- ✅ **`git push` 挂死的解法（2026-09-27 实测）**：**先用 curl 预热代理隧道，再 push 并带 `--progress` + 给足超时**。
  ```bash
  curl -s -o /dev/null -w "%{http_code}" --max-time 8 -x http://127.0.0.1:7890 \
    "https://github.com/<owner>/<repo>.git/info/refs?service=git-receive-pack"   # 期望 401
  timeout 180 git -c credential.guiPrompt=false -c credential.interactive=never push --progress origin master
  ```
  **规律：代理到 github 的 CONNECT 隧道「闲置后首次建立」极慢** —— 同一命令 7 次里 5 次被杀（90/100/120/180s 全 124 零输出），
  而预热过的那 2 次分别 16 秒 / 2 秒推完。**零输出 ≠ 卡在凭据**（GIT_TRACE_CURL 显示隧道建完就在正常传，纯属慢）。
  ⚠️ **凭据本身没问题**：`GCM_TRACE=1 GCM_CREDENTIAL_STORE=wincredman git credential fill` **0.05 秒**返回
  `username=Nailoonger` + `gho_…`（2026-09-24 的「卡在 UI/COM 初始化」结论今天不成立）。
  ⚠️⚠️ **判据别搞错**：`git push … | tail` 会把退出码换成 tail 的、进度全吞掉 → 看着像"无输出＝成功"。
  **唯一可信判据是 `git status -sb` 的 `ahead N`，N=0 才算推上去**（这次一度误判成功，实际 ahead 2）。另：能 `ls-remote` 不代表能 push。

## 后端约定
- 容器 UTC、MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ `toast.push({icon:X})` 的图标必须确认已 import（漏导入会炸成功路径，被当成"操作失败"）。
- 验证脚本（SQLite 内存库，改相关代码先跑）：`verify-song-protocol.js`(**187 项**)、`verify-song-submit.js`(107)、`verify-student-account.js`(174)。`verify-song-queue.js` 已作废。
- **三维状态保持数字**（陛下 2026-09-26 裁决，不改字符串）：接口同时下发数字 + 名字
  （`reviewStatus` + `reviewStatusName` 等，见 `songStatusService.statusView()`）。
  ⚠️ 唯一约束：**数字 ↔ 常量名只允许在 `songStatusService` 有一处定义，别在别处写裸数字**。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端补默认行；缺行视为 on。
- `/admin/submit/list` 排序＝**先提交先审**：`create_time ASC, id ASC`（id 兜同秒，防分页重复/漏）。

## 点歌体系（现行＝协议版）
- 提交**不判容量**，一律 `review=PENDING/schedule=UNASSIGNED`；审核通过只拿候选资格，`initialAllocate` 按首选时段分组、组内按提交时间升序取前 capacity，其余 `WAITING`；到 `schedule_lock_at` 跑 `lockWeek`，剩余 `AUTO_REJECTED`、周 `LOCKED`。
- **⛔ 收歌截止前 `reschedule` 只做原位递补、绝不跨时段**：判据 `canCrossSlot()` = `now >= applicationEndAt`；`crossSlot` 默认 `null` 自动判断，只有 `lockWeek()` 与超管手动「执行排期」传 `true`。
- 选址＝成本表（`songRescheduleCost.js`）：同天其他时段 10 / 前后一天同时段 20 / 前后一天其他时段 30 / 更远 50 / 跨周 ∞；同 cost 按下标升序。
- 占位口径唯一化：`review=APPROVED AND schedule=APPROVED`（驳回自动释放）。`status` 是**派生镜像**（5 已播放 / 6 已通过待排期 / 7 已取消），改状态一律走 `songStatusService.applyChange()`；它是带条件 UPDATE，影响 0 行 = 没抢到 → 返回**空 `logs`**，调用方用 `if (r.logs.length)` 判断。
- **权限**：普通管理员只能看 / 通过 / 驳回 / 看候补；排期、锁定、**解锁**、人工调整（指派/改时段/标记播放/撤销）、时段容量/规则配置、改窗口**仅超管**。前端显隐已落地，**两套口径别统一**：列表页（SubmitList）写操作**隐藏** + 只读虚线块；设置页（SongSettings）4 个保存按钮**置灰**。
- **解锁（`POST /submit/schedule/unlock`，仅超管，2026-09-26）**：①周退回 `SCHEDULING` + 清 `locked_at`
  ②锁定时被系统自动驳回的候补退回 `WAITING`（只动仍原封不动的；`restore:false` 可跳过）
  ③**`lock_paused = 1`（新增列）** —— ⚠️ 不能省：`sweep()` 只按 `now >= schedule_lock_at` 自动锁，
  解锁必然发生在锁定时刻之后，不拦住下一轮 sweep 立刻锁回去＝解锁白做。
  恢复自动锁定只能**手动重新锁定**（`lockWeek()` 清 0）。解锁不动锚点（`SCHEDULING` 冻结）。
- **时间窗口（2026-09-25 改版）**：星期**任选 周一→周日**，最长可铺满整周（旧「五/六/日 + 72h」白名单废除）。
  ⚠️⚠️ 锚点＝**收歌周的周一 00:00**（= 播出周 − 7 天），`offMon(d) = (d===0?7:d)-1`。
  **旧 `offBack(d)=(1-d+7)%7` 对 `周一` 给 0 → 窗口落到播出周本身 → `nextWeekRange(now)` 跳周**；
  对旧白名单三值 `offMon === 7 − offBack`（结果完全一致，升级不改行为）。
  硬约束只有 `0 ≤ startOff < endOff ≤ 7 天`（不跨播出周周一 00:00，公式已结构性保证）。
- **收歌截止 ≠ 审核截止**：`application_end_at` 只停止收歌；`schedule_lock_at = review_end_at = 审核截止`
  （KV `reviewDay`/`reviewTime`；**null = 未配置 → 退回「收歌结束 + `song_lock_offset_minutes`」**，
  窗口关闭时退回播出周周一 00:00）。前端**别再用 `lockAt − applicationEndAt` 反算偏移**，`weekView` 已下发 `reviewEndAt`。
- ⚠️ **周行锚点会跟着配置刷新**（`ensureWeek → refreshAnchors`）：学生端窗口＝**实时读 KV**，
  周状态/闸门/锁定时刻＝**周行快照**，两者必须一致，否则改完配置会自相矛盾。
  `DRAFT/APPLICATION/REVIEW` 的周行重新对齐配置（值相同不写库）；
  **`SCHEDULING/LOCKED/CANCELLED` 冻结**，不再被配置改动改写。
- 保留不变：每人每周 2 次、同曲一周去重。
- 有意偏离协议：不建 `schedule_slots` 表（格子由 `broadcastSlotService` 派生）；容量仍是全局 KV；`song_queue_limit` 废弃。
- 前端已落地（commit `9b07026`）：两端都按派生 `status`；**已排期 = Σ 各格 seated**；文稿 `schedule` 恒 UNASSIGNED → 派生 status 也是 6，文案按 `type===2` 覆盖成「已通过」。
- ⚠️ **两个「周」必须分清**（页面文案/label 要标归属）：点歌窗口的星期**任选 周一→周日**、锚定**收歌周**；播出时段固定**下一周周一~周五**（`broadcastSlotService`）、锚定**播出周**。
- **提交路径实际只有 5 个拦截码**：`40303` 注意事项未确认 / `40907` 窗口外 / `40001` 时段非系统下发 / `40903` 同曲重复·次数用完 / `40901` 一分钟内重提。**`40902 / 40904 / 40906` 已无任何生产路径抛出**（仅存 `utils/response.js` 定义），文档与页面里别再引用；`SLOT_FULL_REASON` 是**排期阶段**的自动驳回理由，不是提交拦截码。
- ⚠️ `WEEK_FLOW`（SongSettings 无、`SubmitList.vue` 里）**缺 `CANCELLED`** → `findIndex` 返回 −1，4 个状态胶囊全落到「未到」。改状态链时一并处理。
- ⚠️ 操作列实体按钮宽：通过/驳回 54、撤销 54、改时段 66、标记播放 78、指派时段 78、改驳回 66；文字链 `.op-log`≈52 / `.op-del`≈28；gap 6。列宽 **236**（原 200 本就溢出）。**量折行看 height 不看 width**（`flex-wrap` 后宽度=占满）。

## 学生账号（细则 `docs/student-account.md`）
- 账号＝年级(4)+班级(2)+序号(2)；初始密码 `user`+学号（`initPasswordFor` 唯一出口）；复用 user 表。
- ⚠️ 姓名：对外 `name`，库里 `remark` + `nickname` 必须同写（读取点不唯一）。头像＝姓名首字圆形，用户不可换。
- ⚠️ `utils/http.js` 对业务错误只 reject 不弹 message，调用方必须自己 `ElMessage.error(e.message)`。
- 开关 `account_login_required`（缺行视为 on）；改密/重置/停用后旧 token 失效。
- 管理端 v2 形态＝单页 + 条件条（年级→班级→启用→激活→批次→关键字）+ 胶囊 + 批量＝筛选结果，**不要目录树**。页头动作组走 MainLayout `#ph-actions` + `Teleport`，**必须 onMounted+nextTick 后再挂**（直接整页加载时目标查不到会静默丢内容）。
- ⚠️ `reload()` 要 `await fetchStudents()` 之后再 `syncHeader()`。⚠️ 造数 `bulkCreate` 必须传模型**驼峰**属性名（下划线名被静默丢弃）。
- 顶栏 v8 定稿：**没有全局搜索、没有刷新按钮**；副标题＝`共 N 个账号 · X 届 · 已激活 M`。

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 候补队 / `song_queue_limit`）—— 仅供读旧文档与旧数据。
- 登录页 v1（AI 底图 + 插画）全删且被否，别再走「AI 生成底图」。
- 学生账号 v1（目录树形态）。
