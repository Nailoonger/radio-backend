# 菁悠广播站 · 项目长期备忘

## 铁律（用户明确交代）
- **admin-web 按 v8 落地**（唯一权威 `preview/admin-ui-v8/admin-ui-v8.html`）。三硬规则：唯一强调色 **#0066CC** / 无渐变无彩色投影 / 深色卡为主角。**登录页唯一例外**（用户的 v4 分栏版：330 品牌区 + 400 玻璃卡 + 对角渐变底），勿动。改前备份 `admin-web/_backup/<时间戳>-src/`。
- **绝不用 `git checkout --`**：工作树全是未提交成果，checkout 会全退回旧版。
- **UI/视觉需求先出静态 HTML 预览（标 v1/v2…），点头前不写业务代码。** 版本只增不删：只新增 `preview/<主题>-v<N>/`，渲染图 `shots/`。
- 需求被否 / 含糊先问清形态再动手，宁可多问一句（v1 目录树被否过）。
- 用户表态（2026-09-21）：**别在本机构建/部署，直接 commit + push，再给服务器更新步骤**。本机 Docker 不是部署目标。
- git 提交身份（2026-09-21 修正）：仓库级曾写死 `dev@jingyou.local`（GitHub 不计入贡献图），已 unset 回落到全局 `Nailoonger <1493586497@qq.com>`——新提交别再写仓库级 user.email/name。

## 部署
- 源码改动必须 `docker compose build <svc>` + `up -d --force-recreate <svc>`；restart 不换镜像。admin-web 改 views：`npm run build` → `build admin-web` → `up -d --force-recreate --no-deps admin-web`。
- radio-nginx 会莫名自退（Exited 0）→ 80 全拒，排障先看它。admin-web 健康检查探 `http://127.0.0.1/`（localhost 解析 ::1）。
- 本机 Docker Desktop Linux 引擎常没启动：`docker ps` 报 `npipe …cannot find the file` 就是它没开。
- 改模型字段后老库炸 `ER_KEY_COLUMN_DOES_NOT_EXITS` → 先跑 `scripts/db-repair.js`（幂等）再 restart。服务器路径 `~/radio`。

## 本机环境坑
- **Bash 工具已坏**（exit 127），shell 一律走 **PowerShell**；stdout 用 `| Out-File -Encoding utf8` 落盘再 Read（别用 `*>`）。node 中文乱码 → 脚本自己 `fs.writeFileSync(...,'utf8')`。
- **同一文件多处改动必须串行 Edit**（并发 Edit 基于旧内容，后写的静默吞掉前一个）。
- 静态预览搬小程序样式：**rpx 必须折算 px（1rpx=0.52px）**，否则声明被丢、容器塌 0；折完别再套 scale。固定高手机框里 `vh` 换固定 px。静态页验证直接 `file://`。
- agent-browser：stdio 必须用文件 fd 不能管道（会挂死）；`set viewport` 在 `open` 之前；会话跑久会崩（3680 字节空白截图 + 「全 0 但没报错」假绿）——一次会话 ≤3 张、截图带体积断言、首张热身丢弃；CLI click 不支持属性选择器（eval 里 `.click()`）。
- safe-delete 钩子的 trash 本机是坏的：清临时文件走 Node `fs.unlinkSync`。
- git push 前先开代理（FlClash 127.0.0.1:7890），否则 schannel 断连。
- **预览自检三件套**：模拟点击页签后逐屏截图 + 未定义类名扫描 + 溢出量测（表格 ≥2 个操作按钮量 `td.scrollWidth`）。配方在 skill `web-ui-screenshot-verify`。
- 本机自定义控件 `box-sizing` 是 content-box：带 padding 又限宽的元素补 `border-box`。
- 不开 Docker 的整链路验证：后端 `DB_STORAGE=./data/_shot.db` + `npm run db:init` + seed 造数 + `node src/app.js`；admin-web vite dev（URL 是 `/student` 非 `/#/student`）；`localStorage.setItem('admin_token',token)` + `admin_info`(role:0) 进超管页。
- jest 基线：56 条里 15 条失败全是已删 member 模块的（member.test 14 + switch.test 1），别当新回归。

## 后端约定
- backend 容器 UTC，MySQL 北京时间；按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- 限制器/计数器：计数放库；占位用一条带条件 UPDATE；周期行靠 UNIQUE 兜并发；失败只对「表不存在」降级为不限。
- multer 中文文件名 latin1→utf8 修正已在 `uploadExcel.js`，新上传点都要带。
- 路由顺序：字面量段（`/submit/quota`）在参数路由（`/submit/:id`）之前。
- ⚠️ **toast.push({icon: X}) 的图标必须确认已 import**：v3 三处重置密码 toast 引用 `IconKey` 却漏导入，成功路径炸成「IconKey is not defined」红 toast（密码其实重置成功了），被用户当成「重置不了」。排查口诀：接口 curl 全通 → 坏在前端交互；hook XHR + 看 toast 文案。
- 验证脚本（SQLite 内存库，跑完读同目录 `*-output.txt`；改相关代码先跑）：`verify-song-queue.js`(89)、`verify-song-submit.js`(107)、`verify-student-account.js`(174，含 G3 改名/G4 批量停用)。
- **新开关不进 seed.js**（switch.test 断言恰好 4 条）：走 `switchService.KNOWN_SWITCHES` + 管理端列表补默认行；缺行视为 on。

## 点歌体系（v2 已落地，docs/song-queue-v2.md）
- 容量＝按播出格子：每格 `song_slot_capacity`(默认1) + 全局候补队列 `song_queue_limit`（0=自动）。提交即占位（0/1/4 占位，3=候补），容量按 `scheduled_slot`。状态机 0待审/1已排期/2已驳回/3候补中/4已补位待审。播出周前周日 18:00 定稿清 3、4（0 保留）；递补不要求先审。调度器 `songQueueService.startScheduler()` 60s tick + KV 幂等。
- 易错点：释放后 `afterRelease()` 必须 await；「播出周已结束」= `wsMs+5天`（周六00:00）；窗口文案「每周六」不是「每周周六」。
- 时间窗口：默认周六 18:00 → 周日 18:00，KV `song_submit_window`；改窗口仅超管；窗口外 40907；窗口结束＝审核截止；锚 `nextWeekRange(now).start`。
- **铁规矩**：点歌起止时间常驻展示，文案服务端下发（`GET /user/submit/window`），前端不硬编码。
- 错误码 40903/40904/40906/40907（40905 留空）。时段 KV `song_slot_times`（`GET/PUT /admin/submit/slots`）；slot 值格式 `2026-09-21 午间 12:20`；每人每周 2 次；同曲一周一次（归一化）；候补算占用、`auto_rejected=1` 不算。
- 管理端「已通过」统一叫「**已排期**」。排期矩阵 `GET /admin/submit/schedule`。清空 `DELETE /admin/submit/songs` 仅超管（confirm:"DELETE"，只删 type=1）。

## 学生账号（docs/student-account.md）
- 账号=年级(4)+班级(2)+序号(2)；初始密码 `user`+学号（`initPasswordFor` 唯一出口）；复用 user 表。
- ⚠️ **姓名**：对外 `name`；库里 `remark`+`nickname` 两列必须同写。读取点不唯一（管理端列表读 remark；投稿/留言审核、小程序我的、`/user/me` 读 `nickname||remark`）。`updateStudent` 三 key 都接受。
- ⚠️ **admin-web `utils/http.js` 对业务错误只 reject 不弹 message**，调用方必须自己 `ElMessage.error(e.message)`。
- 开关 `account_login_required`（缺行视为 on）→ 微信登录 40302；测试环境放行。改密/重置/停用后旧 token 失效（JWT pv + 30s 缓存）。
- **头像=姓名首字圆形，用户不可换**，`user.avatar` 恒空串。
- ⚠️ `classOptions` 取 `gradeInfo.value?.classes` 是「子目录混淆」根源：班级选项只能取当前选中年级的详情。

## 学生账号管理端（已落地）
- v1（目录树）已废：**不要树形/层级下钻**，要单页+筛选条件。v2 形态＝条件条（年级→班级→启用→激活→批次→关键字，班级级联于年级）+ 胶囊 + 批量范围＝筛选结果 + 整届操作只在选中年级时出现。业务代码＝`views/StudentAccounts.vue` + `components/student/*Sheet` + `utils/spring.js` 等。
- 后端 `POST /admin/student/status/batch`（上限 500）；`/student/delete/batch` 在 `/student/:id` 之前。
- v3 交互已落地（Apple 式，2026-09-21）：hero 带 **summary 摘要**（listStudents 聚合：已激活/停用/有投稿，失败降级 null）；ToastHost 可撤销轻反馈；批量删除/毕业清理保留确认（真删不可逆）。
- ⚠️ 时序坑：`reload()` 必须 `await fetchStudents()` 之后再 `syncHeader()` —— 顶栏「命中 N 个」用 listTotal，不等数据回来就刷会显示旧 total。
- ⚠️ 造数坑：sequelize bulkCreate 传下划线属性名（`class_no`/`pwd_changed_at`）被**静默丢弃**（模型是驼峰+field 映射）——造数属性名必须跟模型驼峰走。
- 页头动作组（2026-09-21，用户指定）：「更多操作/名册导入」在**页头右上角**、不在条件条里；机制＝MainLayout `.header-actions`(#ph-actions，空时不占位) + 页面 `<Teleport v-if="phReady" to="#ph-actions">`。⚠️ **直接整页加载时布局子树在 detached DOM 上，Teleport 目标查不到会静默丢内容——必须 onMounted+nextTick 后再挂**（SPA 站内跳转测不出这 bug）；条件条行尾只留「重置」。
- **顶栏 v8 定稿（2026-09-21）：没有全局搜索、没有刷新按钮**（筛选条自带搜索栏，用户嫌顶栏搜索冗余直接下线）；右侧只有页面动作组；`triggerRefresh`/`setRefreshHandler` 机制保留但无入口。学生账号副标题＝`共 N 个账号 · X 届 · 已激活 M`。

## UI 规范
- 骨架尺寸＝真实组件（头像40/标题15/正文12/标签22/按钮36）。v8 `.tag`(23px)/`.ano`(19px) 见 admin-ui-v8.html 201/397 行；`ano-new`=红=「需后端新增」。
- 行内动作分层：只切视图 → 强调色文字链接（`.link-btn`+`→`）；改数据 → 实体描边按钮；中间加 `.vsep`。
- **预览列宽≠业务列宽**：搬进业务表前按真实 `td` 宽重量（预览页 `getBoundingClientRect` 量胶囊 vs `td.clientWidth−padding`）。
- 点歌窗口状态条（小程序）两行：上规则下状态。预览 `preview/song-queue-v1/`。song-queue-admin-v1 已落地（commit 9d35735，`.tag-queue`/`.tag-acc`/`.pos-chip`，theme.css `--acc-bg`）。

## 已废弃（别再捡回来）
- 登录页背景 v1（AI 底图+插画）全删且被否，别再走「AI 生成底图」这条路；Login.vue 至今是用户 v4 分栏版。
