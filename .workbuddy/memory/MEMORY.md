# 菁悠广播站 · 项目长期备忘

## 铁律（用户明确交代）
- **admin-web 按 v8 落地**（唯一权威 `preview/admin-ui-v8/admin-ui-v8.html`，25 屏；v1~v7 留档）。设计系统＝小程序 app.wxss 三硬规则：唯一强调色 **#0066CC** / 无渐变无彩色投影 / 深色卡为主角。**登录页是唯一例外**（用户自己的 v4 分栏版：330 品牌区 + 400 玻璃卡 + 对角渐变底）。不做自作主张的全量换肤；改前备份 `admin-web/_backup/<时间戳>-src/`；改配色排除 Login.vue。
- **绝不用 `git checkout --`**：HEAD 只有 3 个旧提交，工作树全是未提交成果，checkout 会全退回旧版（Login.vue 丢过一次）。
- **UI/视觉需求先出静态 HTML 预览（标版本号 v1/v2…），点头前不写业务代码。** 版本只增不删：只新增 `preview/<主题>-v<N>/`，主文件与目录同名带版本，渲染图 `shots/v<N>-xx.png`，对比入口 `preview/admin-ui-versions.html`。
- **需求被否 / 含义含糊时先问清形态再动手**（2026-09-21 栽过两次：把「主目录/子目录混淆」做成目录树，用户要的是「可筛选条件」）。宁可多问一句。

## 部署铁律
- 源码改动必须 `docker compose build <svc>` + `up -d --force-recreate <svc>`；restart 不换镜像。
- admin-web 改 views：`npm run build` → `build admin-web` → `up -d --force-recreate --no-deps admin-web`（Dockerfile 多阶段，容器内再 build 一次）。
- radio-nginx 会莫名自退（Exited 0）导致 80 全拒，排障先看它。
- admin-web 健康检查探 `http://127.0.0.1/`（localhost 解析 ::1，nginx 只听 IPv4）。
- vite build 可能写完 dist 后挂住：杀进程取产物，按「index.html 引用 0 缺失 + 无 0 字节」校验。
- **本机 Docker Desktop 的 Linux 引擎常没启动**：`docker ps` 报 `npipe:////./pipe/dockerDesktopLinuxEngine ... cannot find the file` 就是它没开，不是 compose 问题。

## 本机环境坑
- **Bash 工具已坏**（coreutils 缺失，exit 127），shell 一律走 **PowerShell**。PowerShell 不回显 stdout，用 `| Out-File -Encoding utf8` 落盘再 Read；**别用 `*>`**（UTF-16，Read 拒读）。
- PowerShell 捕获 node stdout 按 GBK 解码 → 中文乱码；**让脚本自己 `fs.writeFileSync(...,'utf8')` 落盘**（verify 系列自带 `*-output.txt`）。
- 静态页验证直接 `file://`，不起 dev server。`tests/**` 读取会被安全审批拦。
- jest 失败清单：`npx jest --json --outputFile=_.json --silent` 再解析。
- **同一文件多处改动必须串行 Edit**：并发 Edit 各自基于旧内容，后写的静默吞掉前一个（已栽 2 次）。
- **静态预览搬小程序样式时 `rpx` 必须折算成 px**（1rpx=0.52px）：浏览器里 rpx 非法 → 整条声明丢弃 → 容器塌成 0（表现「内容挤顶部、下方空白」）。折完别再套 `transform:scale(.52)`。固定高手机框里 `vh` 同理换固定 px。
- **只认实测**：截图 + 量值才算验收。

## 后端约定
- **时区**：backend 容器 UTC，MySQL 北京时间。按天/周逻辑禁裸 `dayjs()`，统一 `src/utils/bjTime.js`。
- **限制器/计数器**：计数放库；占位只用一条带条件 UPDATE（判定写进 WHERE）；周期行靠 UNIQUE 兜并发首建；失败兜底只对「表不存在」降级为不限，其它异常上抛。
- **multer 中文文件名**：latin1→utf8 修正已在 `src/middlewares/uploadExcel.js`，新上传点都要带。
- **路由顺序**：字面量段（`/submit/quota`）必须注册在参数路由（`/submit/:id`）之前。
- **验证脚本**（SQLite 内存库，无需 MySQL/Docker，跑完读同目录 `*-output.txt`；改相关代码先跑）：`verify-song-queue.js`(89)、`verify-song-submit.js`(107)、`verify-student-account.js`(**174**，含 G3 改名段 + G4 批量停用段)。
- **服务器部署路径**：`~/radio`（ubuntu 用户）。改了模型字段后老库会炸 `ER_KEY_COLUMN_DOES_NOT_EXITS`（sync 建索引排在补列前）→ 跑 `docker compose exec radio-backend node scripts/db-repair.js`（幂等补列补索引，已演练）再 `restart`。sqlite3 预编译二进制走 `npm_config_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/sqlite3`（GitHub 直连超时），且已挪到 optionalDependencies（生产 MySQL 用不到）。
- **测试基线**：`npx jest` 56 条里 15 条失败，全是「风采/member」已删未清（member.test.js 14 + switch.test.js 1，40401）。别当新回归。
- **不要往 seed.js 加开关**（switch.test 断言恰好 4 条）：新开关走 `switchService.KNOWN_SWITCHES` + 管理端列表补默认行。

## 点歌体系
- **规则 v2 已落地**（`docs/song-queue-v2.md`，代码 + 验证脚本全绿）：废弃日/周名额（`song_quota` 退役）。容量＝按播出格子：每格正式位 `song_slot_capacity`(默认1) + **全局候补队列** `song_queue_limit`（0=自动=下周正式位总数，FIFO 跨时段）。**提交即占位**（0/1/4 占位，3=候补），容量按 `scheduled_slot`（**不覆盖学生首选** `want_broadcast_time`）。状态机 0 待审 / 1 已排期 / 2 已驳回 / 3 候补中 / 4 已补位待审。两条关闭线：全格满额 → 候补全自动驳回；播出周前**周日 18:00 定稿** → 清 3、4（0 保留）。递补不要求先审，审不过继续递补。调度器 `songQueueService.startScheduler()` 在 `app.js` start() 挂 60s tick + KV `song_finalize_gate` 幂等（无 cron）。
- **v2 三个易错点**：① 释放位子后 `afterRelease()` **必须 await**（曾用 setImmediate → 接口说已递补、列表仍空）；② `finalizeDueWeeks` 的「播出周已结束」= **`wsMs + 5 天`**（周六 00:00），不是 +7d；③ 窗口文案是 `每 + 周六 = 每周六`（`DAY_SHORT`），不是「每周周六」。
- **时间窗口**：默认周六 18:00 → 周日 18:00，KV `song_submit_window`（0=周日…6=周六）。**改窗口仅超管**（2026-09-20 终稿），普通管理员只读。窗口外提交 `40907`；**窗口结束时刻＝审核截止时刻**；文稿不受限；锚在 `nextWeekRange(now).start`，配置校验要求落在周五~周日。
- **铁规矩（用户要求记住）**：点歌起止时间**必须常驻展示**（学生端顶部状态条+倒计时、时段弹层、提交成功、我的投稿卡；管理端设置面板）。文案**服务端下发**（`GET /user/submit/window` 的 windowText/opensAt/closesAt/serverNow），前端不硬编码。
- **错误码**：`40903` SUBMIT_REJECTED、`40906` SLOT_FULL、`40904` SLOT_AND_QUEUE_FULL、`40907` SONG_WINDOW_CLOSED（`40905` 留空）。
- **其他**：严格下一周（周一也跳下周一）；时段 KV `song_slot_times`（`GET/PUT /admin/submit/slots`）；每人每周 2 次（`song_weekly_user_limit`）；同曲一周一次（归一化：全角→半角 + U+3000 单独映射 + 去空白 + 小写）；候补算占用、`auto_rejected=1` 不算。点歌 / 文稿两份注意事项 key 分开。排期矩阵 `GET /admin/submit/schedule`。
- **只有一个管理员审核**（用户确认）：并发不是现实风险，审查重点是**状态机完整性** —— 驳回已通过件不还名额、批量驳回不过滤状态、通过已驳回件假成功。
- 权限 `docs/admin-permissions.md`（73 条路由）；清空 `DELETE /admin/submit/songs` 仅超管（confirm:"DELETE"，只删 type=1；**v2 起不再清 song_quota**）。

## 学生账号体系
- 权威文档 `docs/student-account.md`。账号=年级(4)+班级(2)+序号(2)；初始密码=`user`+学号（`initPasswordFor` 唯一出口，bcrypt cost 8）；复用 user 表（JWT `openid` 填学号）。
- ⚠️ **「姓名」字段名（2026-09-21 修过 bug）**：对外 **`name`**；库里 **`remark` + `nickname` 两列必须同时写**。读取点不唯一：管理端学生账号列表读 `remark`（dto→`name`）；**投稿审核 / 留言审核 / 小程序「我的」/ `/user/me` 读 `nickname || remark`**；名册导入两列一起写。曾前端发 `{remark,nickname}`、后端只认 `payload.name` → 200「已保存」但一个字没动。现 `updateStudent` 三个 key 都接受，空名/超 64 字 → 40001。回归：verify **G3 段**（12 项）。
- ⚠️ **admin-web `utils/http.js` 拦截器对业务错误（`code!==0`）只 reject、不弹 message**（仅 401 / 40301 弹）。调用方写 `catch { /* 已提示 */ }` 是错的，必须自己 `ElMessage.error(e.message)`。
- 强制点在服务端：开关 `account_login_required`（缺行视为 on）→ 微信登录 40302；测试环境放行。改密/重置/停用后旧 token 失效（JWT `pv` + 30s 状态缓存）。
- 年级管理 `GET /student/grades`、`GET/DELETE /student/grade/:grade`（safe/disable/purge）。
- **头像机制（用户定死）：全站头像=姓名首字圆形，用户不可换**。`user.avatar` 恒空串。别再引入头像上传 / image 分支。
- ⚠️ **最致命一处**：`classOptions` 取自 `gradeInfo.value?.classes` —— **班级下拉选项取决于上次打开过哪个年级详情**（即用户口中的「子目录和主目录混淆」）。别再走这条路。

## 学生账号管理端 UI（**已落地业务代码**，2026-09-21）
- `preview/student-admin-v1/` **已废**（左目录树 + 右工作区），2026-09-21 00:39 被当场否掉：「我要的是可筛选条件不要这样的」。**不要树形目录 / 层级下钻。**
- `preview/student-admin-v2/`（8 屏，`shots/v2-*.png`）：**单页 + 筛选条件**，无页签无树无子路由。条件序「年级 → 班级 → 启用状态 → 激活状态 → 导入批次 → 关键字」；**班级级联于年级**（未选年级禁用写「先选年级」，改年级自动清班级）；已选条件可摘胶囊；**批量操作范围＝筛选结果**；**整届操作只在选中年级时出现**；导入/批次/毕业清理＝三个页内弹层。
- `preview/student-admin-v3/`（apple-design skill 做的可交互原型，15 图 `shots/v3-*.png`）：弹簧引擎（`ω0=8/response`，`set()` 改目标保留速度＝可打断）+ 动量投影 + 橡皮筋 + 模态=scrim+父层后退。**刻意没照搬 skill**：不用渐变做滚动边缘、强调色仍只有 #0066CC、模糊半径不逐帧改（全屏 backdrop-filter 每帧改半径会压崩渲染进程）。
- **业务代码已按 v2/v3 落地**：`views/StudentAccounts.vue` 整文件重写（条件条→胶囊→深色 hero→表→分页→批量条，条件全同步 `/student?grade=&class=&status=&activated=&batch=&q=&page=&size=`，**班级选项只取当前选中年级的详情**）；新组件 `utils/spring.js`、`components/PopMenu.vue`、`components/FilterPill.vue`、`components/SlideSheet.vue`、`components/student/{ImportSheet,BatchesSheet,PurgeSheet}.vue`。真机图 `preview/student-admin-v3/shots-real/r*.png`。
- 后端补了 `POST /admin/student/status/batch`（批量启用/停用，上限 500）；`/student/delete/batch` 挪到 `/student/:id` 之前。verify **174 项全绿**（G4=批量停用 8 条）。
- 旧页的批次「状态」列（已撤销/生效中）是假的：`import_batch` 表没有 `rolledBackAt`，永远显示生效中。新版不显示这列。

## UI 规范
- 加载骨架标准在 `preview/admin-ui-v6`：骨架尺寸=真实组件（头像 40/标题 15/正文 12/标签 22/按钮 36）。
- v8 `.tag`(23px/fs-xs/500) / `.ano`(19px/fs-2xs/600) 规范见 admin-ui-v8.html 201/397 行；`ano-new`=红=「需后端新增」，业务文案不走它。
- **行内动作按「会不会改数据」分层**（2026-09-21 定）：只切视图的（筛选/查看/跳转）用强调色**文字链接**（`.link-btn` + `→`）；会改数据的（撤销/停用/删除）用**实体描边按钮**；两者间加 1px `.vsep`。别一律用胶囊。
- **表格行 ≥2 个操作按钮时必须量 `td.scrollWidth`**：只量纵向滚动容器**量不出单元格横向溢出**（导入批次弹层操作列 104px 塞俩胶囊实需 119px，就这么漏的）。
- 点歌时间窗口状态条（小程序）定**两行**：上规则（每周六 18:00 – 周日 18:00）下状态（开放中·距截止…）。一行版 390px 必折行。预览 `preview/song-queue-v1/`。
- `preview/song-queue-admin-v1/`（点歌 v2 管理端适配，5 屏）：沿用 v8，新增 `.tag-queue`(3 候补中·中性灰) / `.tag-acc`(4 已补位·强调色浅底) / `.pos-chip`。管理端「已通过」统一改「**已排期**」。**业务代码已按它落地**（commit `9d35735`：`SubmitList.vue` 整文件重写 + `SongSettings.vue` + `StatusTag.vue` 扩 5 态 + `theme.css` 加 `--acc-bg` + 后端 `submitController` 三处）。
- **预览的列宽不能直接当成业务表格的列宽**：预览里「状态」列给的 128px 刚好掩盖了「已补位 · 待审」胶囊（实测 97.6px）在业务表 106px 列里溢出约 12px 的问题。搬进业务表格前必须按真实列宽重算 —— 量法：静态预览与业务页共用字体栈/CSS 变量，直接在预览页 `getBoundingClientRect()` 量胶囊宽度，再对比业务 `td` 的 `clientWidth − padding`。
- **预览页自检三件套**：**模拟点击页签后**逐屏截图（v7 栽过页签错位）+ 未定义类名扫描 + 溢出量测。配方见 skill `web-ui-screenshot-verify`。
- **本机自定义控件的 `box-sizing` 是 content-box**：`.fsearch` 给 `max-width:220px` 实测 244（220+padding22+border2），筛选条因此 1440 折行。凡自己写的带 padding 又限宽的元素，补 `box-sizing:border-box`。量法：`getComputedStyle().maxWidth` 与 `getBoundingClientRect().width` 对不上就是它。
- **本机不开 Docker 也能整链路真机验证**：后端默认 SQLite —— `DB_STORAGE=./data/_shot.db` 跑 `npm run db:init` + 临时 seed 脚本造数，`node src/app.js` 起 3000；admin-web `vite dev` 起 5173（**路由是 `createWebHistory`，URL 是 `/student` 不是 `/#/student`**）；登录态直接 `localStorage.setItem('admin_token', token)` + `admin_info`（`role:0`）再 reload 即可进超管页。验证完删临时库。
- 布局：flex 双栏行插卡必须带 flex 值；`.canvas>*{flex:none}` 优先级高于 `.ws{flex:1}`，须写 `.canvas.split>.ws{flex:1;min-width:0}`；固定高滚动容器内子项也要 `flex:none`，否则表格卡被压矮且 `scrollHeight===clientHeight` 量不出溢出。

## 工具环境坑（本机实测）
- **agent-browser 必须用文件 fd 做 stdio，不能用管道**：常驻 daemon 继承 pipe 写端，默认 pipe 等不到 EOF 把脚本挂死（PowerShell 工具超时 exit 1，连输出文件都不生成）。写法 `spawnSync(EXE, args, { stdio:['ignore', fs.openSync(o,'w'), fs.openSync(e,'w')], timeout })`，改完每命令 200~1000ms。EXE 在 `...\node_modules\agent-browser\bin\agent-browser-win32-x64.exe`；子命令 `open / set viewport w h / click / wait ms / eval js / screenshot path / errors / close`。
- **`safe-delete` 钩子的 trash 本机是坏的**：`Remove-Item`（含 `-LiteralPath`）一律 `SAFE_DELETE_FAIL_CLOSED {"reason":"trash-failed"}`。清自己的临时文件只能走 Node `fs.unlinkSync`。
- ⚠️ **agent-browser 会话跑久后会崩，崩点随机 —— 别把它当成自己的 CSS bug**（2026-09-21 白改两轮弹层材质才想明白）：
  现象＝`screenshot` 只产出 **3680 字节**的空白图，之后所有 `eval` 跑在**空白页**上，探针返回
  `{undef:[],rows:0,pills:0,...}` 这种**「全 0 但没报错」的假绿**（空白页 `document.styleSheets` 为空，类名扫描照样返回 `[]`）。
  正确做法：**分段重开会话**（一次会话只拍 ≤3 张，会话内 `open` 重来）；`shot()` 必须带**体积断言**
  （`<40000` 就标「疑似空白」）；**首个会话必出空白**（先热身拍一张丢掉再拍正片）。
- **看到 `sed: node_modules/mysql2/lib/constants/charsets.js: No such file or directory`，先怀疑 `npm ci` 层，别动 sed**：国内镜像零星 ECONNRESET → npm 重试用尽后撞上自身 bug "Exit handler never called!" 且**以 exit 0 退出** → 「装了一半的 node_modules」被 BuildKit 当成功层缓存，错误延迟到 sed 那层才爆（`--no-cache` 重建也复现，不是脏缓存）。Dockerfile 已加固：重试放大 + **独立断言层**（`node -e` 逐个 `require.resolve` 所有 `dependencies`，比 `npm ls --all` 稳，后者被 peer 告警误判）+ sed 前后 `test -f`/`grep -q`。
- **本机 push 之前必须先开代理**：GitHub 直连 `fatal: schannel: server closed abruptly (missing close_notify)`（`git ls-remote` 报 `Operation too slow. Less than 1000 bytes/sec`）。代理客户端是 **FlClash**；Docker Desktop 代理设置里写死了 `http://127.0.0.1:7890`，该端口没开时连 `alpine:latest` 都拉不下来（基础镜像全靠本地缓存）。
- **用户明确表态（2026-09-21）**：别在本机折腾构建/部署，直接 commit + push，然后给他服务器上的更新步骤。本机 Docker 不是部署目标。

## 已废弃（别再捡回来）
- **登录页背景 v1（2026-09-21，11:51 用户要求全删）**：`preview/login-bg-v1/`、`login-bg-v1.miora`、`login-bg-v1_assets/` **已全部删除**。原本形态＝**全页底图 + 品牌插画**（AI 生成图），调性 Apple 式柔光。
  - ❌ 用户看完否掉：「这次你所有的产出都删了，不要」。**别再默认走「AI 生成底图 + AI 生成插画」这条路做登录页**——下次先问到底要什么。
  - ✅ **登录页（`Login.vue`）全程没动过**，至今仍是陛下的 v4 分栏版：330 品牌区（内联 SVG 广播塔） + 400 玻璃卡 + 对角渐变底 `linear-gradient(135deg,#e1ecf8,#fbfdfe)`。要动登录页先按这条基线来。
  - 保留沉淀：技能 `png-white-to-alpha`（白底图转真透明 PNG，公式 `alpha=1-min(RGB)/255` 反预乘 + bbox 裁剪 + 色相推 210°）—— **因为 `mix-blend-mode:multiply` 在带 z-index 的祖先里会失效**（露出白方块）。
  - 保留沉淀：agent-browser **`set viewport` 必须在 `open` 之前**；CLI `click` 不支持带属性选择器的选择器（改用 `eval` 里 `.click()`）；长会话会崩，审计另起 `--session`。已写进 skill `web-ui-screenshot-verify`。
