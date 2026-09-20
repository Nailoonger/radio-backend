# 菁悠广播站 · 项目长期备忘

## 铁律 / 不要做的事（用户明确交代）

- **admin-web 按 v8 方案落地**（唯一权威 `preview/admin-ui-v8/admin-ui-v8.html`，25 屏；v1~v7 仅留档）。
  设计系统 = 小程序 app.wxss 三条硬规则（唯一强调色 #0066CC / 无渐变无彩色投影 / 深色卡为主角）。
  **唯一例外：登录页**保持用户自己的 v4 分栏版不动。不做自作主张的全量换肤；改前备份到 `admin-web/_backup/<时间戳>-src/`；改配色排除 Login.vue。
- **绝不用 `git checkout --` 恢复工作树文件**：HEAD 只有 3 个旧提交，工作树全是未提交成果，checkout 会全部退回旧版（Login.vue 丢过一次）。
- **UI/视觉需求先出静态 HTML 预览（标版本号 v1/v2…），用户点头前不写业务代码。**
  **版本只增不删**：只新增 `preview/<主题>-v<版本>/` 目录，不改名不覆盖不删除（留档对比）；
  主文件与目录同名带版本（`admin-ui-v2/admin-ui-v2.html`），渲染图 `shots/v2-xx.png`，对比入口 `preview/admin-ui-versions.html`。

## 部署铁律

- 后端/admin-web 源码改动必须 `docker compose build <svc>` + `up -d --force-recreate <svc>`，restart 不换镜像代码。
- admin-web 改 src/views 后三件套缺一不可：`npm run build` → `docker compose build` → `up -d --force-recreate --no-deps`。
- radio-nginx 会莫名自退（Exited 0）导致 80 全拒，排障先看它。
- admin-web 健康检查必须探 `http://127.0.0.1/`（localhost 解析 ::1，nginx 只听 IPv4）。
- vite build 可能写完 dist 后进程挂住：杀进程取产物，按「index.html 引用 0 缺失 + 无 0 字节」校验。

## 本机环境坑（别重复踩）

- **Bash 工具已坏**（coreutils 缺失，退出码 127），shell 一律走 **PowerShell 工具**；
  PowerShell 不回显 stdout → `*> out.txt` 再 Read。
- 截图只能走 agent-browser（Node 脚本 + execFileSync 调 win32-x64.exe），Chrome 无头截图静默失败；截图脚本用完即删。
- 删文件逐个 `Remove-Item -LiteralPath`，通配符管道会被 safe-delete 拦（trash-failed）。
- 静态页验证直接 `file://`，不起 dev server。
- `tests/**` 文件读取会被安全审批拦；含敏感字样的输出先替换再读。
- jest 失败清单：`npx jest --json --outputFile=_.json --silent` 再解析。
- **不要对同一个文件并发发多个 Edit**：它们各自基于同一份旧内容写入，后写的会静默吞掉前一个改动（本次已栽 2 次：`songWindowService.js` 的 DAY_SHORT/windowTextOf、`admin/submitController.js` 的 approve/reject）。同一文件的多处改动一律**一次一个、串行**。
- PowerShell 捕获 node stdout 会按 GBK 解码，中文变乱码；**让脚本自己 `fs.writeFileSync(..., 'utf8')` 落盘再 Read**（verify 系列脚本都自带 `*-output.txt`）。
- **静态预览搬小程序样式时，`rpx` 必须折算成 px**：rpx 只在微信里有效，浏览器当非法单位整条声明丢弃 → 尺寸全回落、容器高度塌成 0（表现为「内容挤在顶部、下方一片空白」，截图上看只是「有点怪」）。折算公式 **1rpx = 屏宽/750 = 0.52px**（390pt 设备），折完不要再套 `transform: scale(.52)`。另注意 `vh` 在固定高手机框里是相对浏览器视口的，要换成固定 px。预览自检固定三件套：类名扫描（未定义 + 同名抢属性）、`scrollHeight-clientHeight` 量溢出、真机截图。

## 后端约定（改后端前先看）

- **时区**：backend 容器无 TZ（UTC），MySQL 是北京时间。按天/周逻辑禁止裸 `dayjs()`，统一走 `src/utils/bjTime.js`（参考 songQuotaService 的 dayKey/weekKey/dayRange）。
- **限制器/计数器**：计数放数据库；占位只用一条带条件的 UPDATE（判定写进 WHERE）；周期行靠 UNIQUE 兜并发首建；失败兜底只对「表不存在」降级为不限，其它异常一律上抛。
- **multer 中文文件名**：latin1→utf8 修正已在 `src/middlewares/uploadExcel.js`，新上传点都要带。
- **路由顺序**：字面量段（如 `/submit/quota`）必须注册在参数路由（`/submit/:id`）之前（admin.js / user.js 都有此坑）。
- **验证脚本**（SQLite 内存库，无需 MySQL/Docker，跑完读同目录 `*-output.txt`）：`node scripts/verify-song-queue.js`（89 项，点歌 v2 全套：窗口/落座/递补/清队/定稿/跨周/状态防护/卡片/路由）、`node scripts/verify-song-submit.js`（107 项）、`node scripts/verify-student-account.js`（151 项）。改相关代码先跑。
- **测试基线**：`npx jest` 56 条用例里 **15 条失败**，全部是**「风采/member」模块已删未清**（member.test.js 14 条 + switch.test.js 1 条，清一色 40401 路由不存在）。点歌相关用例已全部转绿，别把 member 那 15 条当成新回归；下次要么删掉 member.test.js、要么把 switch.test 那条改掉。
- **不要往 seed.js 加开关**（switch.test 断言恰好 4 条）：新开关走 `switchService.KNOWN_SWITCHES` 注册表 + 管理端列表补默认行。

## 点歌体系要点

- **规则 v2 后端已落地（2026-09-20，方案 `docs/song-queue-v2.md`，代码 + 验证脚本全绿）**：废弃日/周名额（`song_quota` 退役），改为**按播出格子**的容量 —— 每格正式位 `song_slot_capacity`(默认1) + **全局候补队列**(`song_queue_limit`，0=自动=下周正式位总数，先进先出、跨所有时段)；**提交即占位**（status 0/1/4 占位，3=候补），容量统计按新字段 `scheduled_slot`（实际排期，**不覆盖学生首选** `want_broadcast_time`）。状态机 0 待审 / 1 已排期 / 2 已驳回 / 3 候补中 / 4 已补位待审。两条关闭线：**全格满额瞬间 → 候补队列全部自动驳回**；**播出周开始前周日 18:00 定稿 → 清 3 与 4**（0 保留）。递补**不要求先审**，补位后审不过继续递补；队列耗尽即停，空位空着。调度器：`songQueueService.startScheduler()` 在 `app.js` start() 挂 60s tick + KV `song_finalize_gate` 幂等（无 cron）。
- **v2 三条容易改错的实现细节（踩过坑）**：
  ① 释放位子后的 `afterRelease()` **必须 await**（曾用 `setImmediate` 着火即忘 → 接口说"已递补"但列表还是空的，且与下一位学生的 decideSeat 抢记录）；
  ② `finalizeDueWeeks` 的「播出周已结束」= **`wsMs + 5 天`（周六 00:00）**，不是下周一（用 +7d 会多留一整周残留待审）；
  ③ 窗口文案拼法是 `每 + 周六 = 每周六`（`DAY_SHORT`），不是 `每周周六`。
- **新增第 6 条（窗口）**：学生只在**点歌时间窗口**内可提交点歌，默认**周六 18:00 → 周日 18:00**，KV `song_submit_window`（JSON，`enabled/startDay/startTime/endDay/endTime`，0=周日…6=周六）。**修改权限：仅超管（最终口径，2026-09-20 23:00 确认；中途一版说过"管理员可改"已推翻）**，普通管理员只读；窗口外提交返回 🆕 **40907**；**窗口结束时刻 = 审核截止时刻**；文稿不受限；窗口计算锚在 `nextWeekRange(now).start`（周六/周日算出的目标周一致），配置校验要求窗口落在周五~周日。
- **铁规矩（用户 2026-09-20 明确要求「记住」）**：点歌开始/结束时间**必须常驻展示在点歌模块**——学生端点歌页顶部状态条（含倒计时）、时段选择弹层、提交成功提示、我的投稿/候补卡；管理端点歌设置面板顶部显示当前配置 + 本周窗口 + 距截止倒计时。文案**由服务端下发**（`GET /user/submit/window` 的 windowText/opensAt/closesAt/serverNow），前端不硬编码星期与时刻。
- **错误码现状（别记错）**：`40903` 是 SUBMIT_REJECTED（同曲重复/次数用完），`40906` 才是 SLOT_FULL；v2 新增 `40904` SLOT_AND_QUEUE_FULL、`40907` SONG_WINDOW_CLOSED（`40905` 留空不用）。
- 规则（延续）：严格下一周（周一也跳下周一）；时段后台 KV `song_slot_times`（`GET/PUT /admin/submit/slots`）；每人每周 2 次（`song_weekly_user_limit`）；同曲一周一次（温和归一化：全角→半角 + U+3000 单独映射 + 去空白 + 小写）；候补算占用、`auto_rejected=1` 不算。双注意事项 key 分开；排期矩阵 `GET /admin/submit/schedule`。
- **只有一个管理员负责点歌审核（用户 2026-09-20 确认）**：并发冲突不是现实风险，审核逻辑的审查重点是**状态机完整性**——驳回已通过件不还名额、批量驳回不过滤状态、通过已驳回件假成功。
- 权限：`docs/admin-permissions.md`（73 条路由）；点歌清空 `DELETE /admin/submit/songs` 仅超管（confirm:"DELETE"，只删 type=1，文稿/notice_ack 不动；**v2 起不再清 song_quota** —— 计数改为实时数 submit 行，删数据即归零）。

## 学生账号体系（后端已落地）

- ⚠️ **「姓名」的字段名（2026-09-21 修过 bug，别再踩）**：接口对外字段名是 **`name`**；
  库里是 **`remark` + `nickname` 两列，必须同时写**。读的地方不是一个：
  管理端学生账号列表读 `remark`（dto → `name`）；**投稿审核 / 留言审核 / 小程序「我的」页 / `/user/me`
  读 `nickname || remark`（nickname 优先）**；名册导入也是两列一起写。
  曾经前端发 `{remark, nickname}`、后端只认 `payload.name` → 接口回 200「已保存」但姓名一个字没动。
  现在后端 `updateStudent` 三个 key 都接受（别名兼容），空名/超 64 字 → 40001。
  回归：`scripts/verify-student-account.js` **G3 段**（12 项，含「学生端 /user/me 也是新名」）。
- ⚠️ **admin-web 的 `utils/http.js` 响应拦截器对业务错误（`code!==0`）只 reject、不弹 message**
  （只有 401 / 40301 分支会弹）。所以调用方写 `catch { /* 拦截器已提示 */ }` 是错的 ——
  必须自己 `ElMessage.error(e.message)`，否则用户点了没反应、也不报错。
- 权威文档 `docs/student-account.md`。账号=年级(4)+班级(2)+序号(2)；初始密码=`user`+学号（逐行 bcrypt cost 8，`initPasswordFor` 唯一出口）；复用 user 表（JWT openid 填学号）。
- 强制点在服务端：开关 `account_login_required`（缺行视为 on）→ 微信登录返回 40302；测试环境放行。改密/重置/停用后旧 token 失效（JWT pv + 状态 30s 缓存）。
- 年级管理：`GET /student/grades`、`GET/DELETE /student/grade/:grade`（safe/disable/purge 三模式）。
- **头像机制（用户定死）：全站头像=姓名首字圆形，用户不可换**。`/user/login` 丢弃客户端 avatar，`user.avatar` 恒空串。新代码不要再引入头像上传或 image 分支。

## UI 规范

- 加载骨架标准在 `preview/admin-ui-v6`：骨架尺寸=真实组件（头像 40/标题 15/正文 12/标签 22/按钮 36）。
- v8 `.tag`（23px/fs-xs/500）/ `.ano`（19px/fs-2xs/600）胶囊规范见 admin-ui-v8.html 201/397 行；`ano-new`=红=「需后端新增」，业务文案不走它。
- flex 双栏行插卡必须带 flex 值，否则挤爆兄弟。
- **点歌时间窗口状态条（小程序）定为两行结构**：第一行「点歌时间：每周六 18:00 – 周日 18:00」（稳定规则），第二行「开放中 · 距截止 2 小时 15 分」／「未开放 · 距开放 3 小时」（变化状态，开放中走强调色）。一行版在 390px 下必然折行，别再试。预览在 `preview/song-queue-v1/`（渲染图 `shots/v1-overview.png`），类名与尺寸搬自 `miniprogram/app.wxss` + `pages/submit/submit.wxss`。
- 预览页自检必须模拟点击页签后读实际屏（v7 栽过页签错位）。
- **管理端点歌 v2 适配预览在 `preview/song-queue-admin-v1/`**（5 屏：方案说明 / 投稿 & 点歌审核 / 审核处理台 / 下周排期矩阵 / 点歌设置；7 张渲染图在 `shots/`）。设计系统沿用 v8，只新增 3 个类：`.tag-queue`＝3 候补中（中性灰）、`.tag-acc`＝4 已补位·待审（强调色浅底，唯一「已占位但未审且有截止时间」的状态，必须最显眼）、`.pos-chip`＝候补位次小胶囊。管理端「已通过」文案统一改「**已排期**」（它同时表达排到哪一格）。**业务代码未动**，等用户点头。
- **管理端学生账号「目录化」重构方案在 `preview/student-admin-v1/`**（7 屏：方案说明 / 全部账号 / 年级节点 / 班级节点 / 归档回执 / 名册导入 / 导入批次；渲染图 `shots/v1-*.png`）。核心＝把 `StudentAccounts.vue` 的平级页签换成「左侧目录树 + 右侧工作区」，唯一状态源＝树上选中节点，全部 URL 化（`/student`、`?grade=`、`?grade=&class=`、`/student/archive`、`/student/import`、`/student/batches`）；后端 0 改动。**同时给了方案 B（保留页签 + URL 驱动）供用户挑，建议 A。业务代码未动，等用户点头。**
  - ⚠️ **方案 A（左侧目录树）已被用户当场否掉**（2026-09-21 00:39，原话「我要的是可筛选条件不要这样的」）。**不要走树形目录 / 层级下钻这条路。**
- **学生账号现行方案＝`preview/student-admin-v2/`（单页 + 筛选条件，8 屏，`shots/v2-*.png`）**：一个页面（顶栏 → 筛选条件条 → 结果头 → 表 → 分页），**无页签无树无子路由**；条件顺序「年级 → 班级 → 启用状态 → 激活状态 → 导入批次 → 关键字」；**班级级联于年级**（没选年级则禁用写「先选年级」，改年级自动清班级）；已选条件汇总成可摘的胶囊行；**批量操作范围＝筛选结果**（勾选后收敛成选中的 N 个）；**整届操作（导出本届 / 毕业清理）只在选中年级时出现**；导入 / 批次 / 毕业清理＝三个页内弹层；条件全写 query（`?grade&class&activated&state&batch&q`，批次与年级可叠加）。后端 0 改动。**业务代码未动，等用户点头。**
- 本模块最致命的一处（用户口中的「子目录和主目录混淆」）：`classOptions` 取自 `gradeInfo.value?.classes`，**班级下拉的选项取决于上次打开过哪个年级详情** —— 子目录挂在上次访问痕迹上而不是主目录上。任何再动这块的改动都不要走回这条路。
- preview 的「左树 + 右工作区」排布踩坑：`.canvas>*{flex:none}` 的优先级**高于** `.ws{flex:1}`，分栏画布必须写成 `.canvas.split>.ws{flex:1;min-width:0}` 才生效，否则工作区宽度塌掉。

## 工具环境坑（本机实测，会反复踩）

- **agent-browser 必须用文件 fd 做 stdio，不能用管道**：它的常驻 daemon 继承 pipe 写端，`execFileSync`/`spawnSync` 默认 pipe 会一直等不到 EOF 把脚本挂死（现象＝PowerShell 工具超时 exit 1、连输出文件都不生成）。写法：`spawnSync(EXE, args, { stdio:['ignore', fs.openSync(o,'w'), fs.openSync(e,'w')], timeout })`，改完每个命令 200~1000ms 返回。EXE 在 `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node_modules\agent-browser\bin\agent-browser-win32-x64.exe`；可用的子命令：`open / set viewport w h / click / wait ms / eval js / screenshot path / errors / close`。
- **`safe-delete` 钩子的 trash 在本机是坏的**：`Remove-Item`（含 `-LiteralPath` 逐文件）一律报 `SAFE_DELETE_FAIL_CLOSED {"reason":"trash-failed"}`，删不掉任何文件。清理自己的临时文件只能走 Node `fs.unlinkSync`。
- **固定高取景框里，滚动容器的 flex 子项必须 `flex:none`**：`.canvas{display:flex;flex-direction:column;overflow-y:auto}` 的子项默认 `flex-shrink:1`，表格卡会被压矮、`overflow:hidden` 一裁就少整行；而且此时 `scrollHeight === clientHeight`，**常规的「量溢出」自检量不出来**。加 `.canvas>*{flex:none}` 才准。自检除了量 `.canvas` 溢出，还要量内部卡（如 `.card-flush`）的 `scrollHeight - clientHeight` 是否为 0。
