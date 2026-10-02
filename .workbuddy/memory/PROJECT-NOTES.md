# 菁悠广播站 · 项目细则备忘（按需读取）

> `MEMORY.md` 放铁律与主线；本文件放体量大、可自查的细则坑。改动相关模块前读对应小节。

## 云开发迁移细则（`cloud/`）
- 起因：小程序正式版 `url not in domain list`（合法域名需 ICP 备案）→ 陛下裁决**不续费服务器、整体走云开发**
  （免费额度：调用 20 万次/月、资源 10 万 GBs/月、容量 2GB）。环境 `jy-radio-d1gdwmptl816ee6a9`，appid `wxa88836729f07a976`。
- **阶段 9（admin-web 接云）＝HTTP 访问服务通道**：「要不要备案」**都不需要**（官方默认域名已备案，只有绑自有域名才要）。
  - `api/httpBridge.js` 把「集成请求」还原成 `{method,path,body,token,query}`。⚠️ 适配必须放在 index.js **解构 event 之前**
    （放错完全不生效且不报错）；判据只认 `httpMethod || requestContext`（收窄，否则误伤小程序请求）。
    信封模式（admin-web 用，真实路由在 body 里、**不依赖路径透传**）+ RESTful 兜底。
  - admin-web `src/utils/http.js`＝**门面**：`direct` 导出原 axios 实例（行为逐字不变），`cloud` 导出同形状门面
    → 全站 114 处调用零改动。xlsx 改走 `{filename,base64,mime}` → `atob` 还原 Blob。
    ⚠️ 认证分支**别再加** `body?.code === 40101`（原后端失败统一返 HTTP 401，与 cloud 模式已对齐，加了就是改行为）。
- **阶段 8 数据迁移（`cloud/migration/`，手册 `README.md`）**：只 SELECT 原库 → JSON Lines → 控制台导入 → 控制台导出 → `verify.js` 双向校验。
  - 官方三约束：JSON **Lines**、时间必须 `{"$date":"<ISO>"}`（裸 ISO 串 → 导入后是普通字符串，**时间条件静默失效**）、Upsert 可重复。
  - 三个「不报错」陷阱：① **`unique_keys` 必须补登记**（文档库无 UNIQUE，不补＝能建重名管理员**且不报错**），
    **NULL 一律不登记**（MySQL UNIQUE 允许多行 NULL）② **`sequence` 预置 = `max(id)` 不是 +1**（`nextId` 先 inc 再返回）
    ③ `weekStartDate` 是 DATEONLY，**保持字符串**（转 Date 会把 `_id` 拼成 `week:Mon Oct 05 2026…`，周行再也查不到）。
  - 迁移脚本一律纯函数无 IO；**大整数 id 走 `Number()` 归一**（BIGINT 经 mysql2 返字符串）。
  - ⚠️ `.jsonl` 后缀坑：控制台导入对话框通常只列 `.json` → 复制一份同内容 `.json`（控制台要的格式本身就是「每行一个对象」）。
  - ⚠️ `verify.js` 按「**文件名 = 集合名**」认集合（无关文件自动忽略）→ 导出时文件名写错会报「源 N / 云 0 缺 N」。
- **两处源实现瑕疵（陛下已裁决 2026-09-29）**：① `overview.approved` 与 `topSongs()` 的 `status:1` → **均改 `status ∈ {1,5,6}`**
  （⚠️ 别再"顺手"改回）② `previewSchedule(dryRun)` 的 `promoted/rescheduled/stillWaiting` 恒 0 已修
  （`reschedule` 加 dryRun 专用字段，**按 id 去重**），顺带修 `autoRejectedIfLocked` 虚高 → 漂移 #23。
  教训：**「把恒 X 改成真实值」必须补反向用例**（造「值该不为 X」的场景）；自检 `git diff --stat` 里测试脚本必须同时在列。
- **速查**：改完跑 `node cloud/scripts/regression.js`（一键双轮）；⚠️ 本机沙箱**禁子进程**（`spawnSync` 返 `EBUSY`）→ 只能手工双跑，
  脚本会列出两轮命令。⚠️ 产物模式 `HARNESS_API_DIR=miniprogram/cloudfunctions/api` **项数必须与源码模式一致**。
  打包/删 dist 一律 `NODE_OPTIONS=""`（safe-delete 拦 `fs.rmSync`）。云端端到端验收：`MSYS_NO_PATHCONV=1 node cloud/scripts/verify-user.js ws://127.0.0.1:9420`。

## 点歌体系（现行＝协议版，细则 `docs/song-protocol.md`）
- 提交**不判容量**；审核通过只拿候选资格，`initialAllocate` 按首选时段分组、组内按提交时间升序取前 capacity，其余 `WAITING`；到 `schedule_lock_at` 跑 `lockWeek`，剩余 `AUTO_REJECTED`。
- ⛔ **点播截止前 `reschedule` 只做原位递补、绝不跨时段**（`canCrossSlot()` = `now >= applicationEndAt`）；只有 `lockWeek()` 与超管手动「执行排期」传 `crossSlot:true`。选址成本表在 `songRescheduleCost.js`。
- 占位口径唯一：`review=APPROVED AND schedule=APPROVED`。`status` 是**派生镜像**（1 已排期 / 5 已播放 / 6 已通过待排期 / 7 已取消），改状态一律走 `songStatusService.applyChange()`（影响 0 行＝没抢到 → 返回**空 `logs`**，调用方判 `if (r.logs.length)`）。
- **权限**：普管只能看/通过/驳回/看候补；排期、锁定、解锁、人工调整、配置**仅超管**。⚠️ **两套口径别统一**：列表页写操作**隐藏** + 只读虚线块；设置页保存按钮**置灰**。
- **解锁（仅超管）**：①周退回 `SCHEDULING` ②被自动驳回的候补退回 `WAITING` ③**`lock_paused = 1`**（不设则下一轮 sweep 立刻重锁＝白做）。恢复只能**手动重新锁定**。
- ⚠️⚠️ 时间窗口锚点＝**点播周的周一 00:00**（＝播出周 −7 天），`offMon(d)=(d===0?7:d)-1`；旧 `offBack` 对周一给 0 → 窗口落到播出周本身。硬约束只有 `0 ≤ startOff < endOff ≤ 7 天`。
- **点播截止 ≠ 审核截止**：`schedule_lock_at = review_end_at = 审核截止`（KV `reviewDay`/`reviewTime`；null → 退回「点播结束 + 偏移」）。前端别反算偏移，`weekView` 已下发 `reviewEndAt`。
- ⚠️ **周行锚点跟着配置刷新**（`ensureWeek → refreshAnchors`）：学生端窗口＝实时读 KV；`DRAFT/APPLICATION/REVIEW` 重新对齐，**`SCHEDULING/LOCKED/CANCELLED` 冻结**。
- ⚠️ **两个「周」分清**：点播窗口锚**点播周**；播出时段固定下一周周一~周五、锚**播出周**。
- **提交路径只有 5 个拦截码**：`40303`/`40907`/`40001`/`40903`/`40901`。**`40902/40904/40906` 已无生产路径**（仅存常量）；`SLOT_FULL_REASON` 是排期阶段理由。

## admin-web 点歌页（视觉参数）
- **周状态带**：一个阶段只有两种形态——进行中带「中」，已完成与未到都不带；只由胶囊颜色表达（深 `--ink`＝当前 / 绿＝走过 / 羊皮纸＝未到 / 浅灰＝已取消）。⚠️⚠️ **必须与后端 `WEEK_STATUS` 六态对齐**（曾漏 `CANCELLED` → `findIndex` −1 → 整条链全落「未到」，静默错）。
- **投稿列表 8 列**（2026-10-03 A 方案后）：selection 46 / 内容 330 / 首选时段 150 / 投稿人 150 / 提交时间 118 / 审核人·时间 142 / 状态 148 / 操作 288，**全部 `min-width`**，操作 `fixed="right"`。
  ⚠️⚠️ **Element Plus 余量分配规则**：只有 1 个 `min-width` 列 ⇒ 余量**全给它**（旧版 906px 全灌给「内容」⇒ 状态与操作之间一个大洞，被点名）；多个 `min-width` 列 ⇒ 按各列 min-width **等比例**分摊；全 `width` ⇒ 余量留空。
  ⇒ **想均摊就必须每列都写 min-width**。2280 实测：`46/559/252/252/198/239/249/485`，操作按钮组 261 ⇒ 左右各留 112 正好居中。
  ⚠️ `fixed="right"` **不影响**余量分配；`header-align` **缺省跟随 `align`**（`column.headerAlign || column.align`）。
  ⚠️ 对齐口径：**只有「内容」列左对齐**，其余六列（含操作）全居中。
  ⚠️ 改列宽前必须 `getBoundingClientRect()` 逐列实测，别拿截图猜；**量折行看 height 不看 width**。
- **「首选时段」列调剂红标**（陛下裁定 B）：实排≠首选时，首选项 `line-through` + 压灰，**灰用 `--muted`(#7a7a7a) 不能用 `--soft`(#c7c7cc)**（对比度 ≈1.9:1 读不出）；下一行灰箭头引出**红色实排**，红色只上时间串。原则：「退到后面」≠「看不见」。
- **点歌设置 v3**：页首「一个播出周期」总览 → 5 分组；卡头右侧保存态（绿「已保存 ✓」/ 琥珀「有未保存的改动」，**只提示不拦截**）；容量卡上半只读统计 + `.div-line` + 下半编辑。
- ⚠️ **Element Plus `el-option` 不能用 `null` 当 value**（`v-model` null 视为空值，显示 placeholder）→ UI 用字符串哨兵（`FOLLOW_REVIEW`），提交时转回 `null`。
- 陛下发来的批注截图 → skill `screenshot-annotation-parse`，别肉眼猜。

## 学生账号（细则 `docs/student-account.md`）
- 账号＝年级(4)+班级(2)+序号(2)；初始密码 `user`+学号（`initPasswordFor` 唯一出口）；复用 user 表。
- ⚠️ 姓名对外 `name`，库里 `remark` + `nickname` 必须同写（读取点不唯一）。头像＝姓名首字圆形。
- ⚠️ `utils/http.js` 对业务错误只 reject 不弹 message，调用方自己 `ElMessage.error(e.message)`。
- 开关 `account_login_required`（缺行视为 on）；改密/重置/停用后旧 token 靠 `pv` + 30s 缓存作废。
- 管理端 v2＝单页 + 条件条 + 胶囊 + 批量＝筛选结果，**不要目录树**。页头动作组走 MainLayout `#ph-actions` + `Teleport`，**必须 onMounted+nextTick 后再挂**。⚠️ `bulkCreate` 必须传模型**驼峰**属性名（下划线名被静默丢弃）。
- 顶栏 v8：**没有全局搜索、没有刷新按钮**；副标题＝`共 N 个账号 · X 届 · 已激活 M`。

## ⚠️⚠️ 动 UI / 编内容之前，先读这三处源
> 起因：做官网介绍页时没读文档就自起配色、自编内容，被陛下当面点名（同类错已犯两次）。

1. **设计 token 源** = `admin-web/src/styles/theme.css`（继承 `miniprogram/app.wxss`）。
   三硬规则：① 唯一强调色 `--accent #0066cc` ② 无装饰性渐变 ③ 无彩色投影。
   token：`--tile #272729`（深色卡主角）/ `--parchment #f5f5f7` / `--canvas #fff` / `--ink #1d1d1f` /
   `--muted #7a7a7a` / `--soft #c7c7cc` / `--hairline #e0e0e0` / `--divider #f0f0f0` / `--live #ff453a`；
   圆角 `--r-card 18 / --r-input 12 / --r-tile 20 / --r-pill`；间距 `--s1..s6 = 4/8/13/18/26/34`。
   ⚠️ **别自起私有配色**（admin-login v1/v2 栽过，v3 才接回 token）。
   ⚠️⚠️ **「标签 / 胶囊与相邻文字必须垂直居中」是硬规则** —— 陛下已反复点名
   「标签与内容又不居中，你能不能记住啊」。写法＝`display:inline-flex; align-items:center; line-height:1`；
   **判据不是"看着齐"，是量出来**：同一行两者的**中心 y 偏差 ≤1px**（含标签内的圆点/图标与文字）。
   开关类控件放进表单时，必须有**与输入框同高（34px）的容器**，让 label 对齐 label、控件对齐控件，
   别让开关悬在两行中间（问题卡的「题型 / 必填」就栽在这）。
   ⚠️⚠️ **变体类名别撞名**：`.ff-row.col` 撞上弹窗栏的 `.dlg-body .col{padding:24px}`（后写 + 同权重胜出）
   ⇒ 内边距 15 被顶成 24，整列开关偏移 **9px**。变体一律用语义名（`.group` / `.stack`），别用 `col`。
2. **真实内容源** = `src/utils/seed.js` 的 `seedSettings()`：**2005 年**成立（口号"菁菁校园情，悠悠广播声"）；
   开播 **午间 12:30-13:00｜下午 17:00-17:30**；社长电话 13800138000（疑似占位）。
   ⚠️ `seedPrograms()` 那 3 个是**示例种子，不是真栏目**。
   ⚠️ **校园广播站没有 FM 频率** —— "87.6MHz"是假的，早因瞎编被点过 → **别再编任何业务事实**。
3. **结构事实源** = `AGENTS.md`：社干 `cadre` = 站长/副站长/纪检长/站长助理（无部门字段）；
   部员 `staff` = 播音部/主持部/编辑部。
4. 信息架构从 `pages/about` 长出来（品牌区 + 一卡三块 + 分隔线）；真站徽 `preview/assets/station-badge.png`（+ `-mono.png`）。

**自检配方** = `node preview/_check-website.cjs <v4|v5> [--allow-gradient]`：
gradient 数=0（**必须先剥 `/* */` 注释**，否则注释里提到 gradient 会误报）、无彩色投影、
禁词扫描（FM/假人名/假栏目）、真内容必须在、JS 过 `new Function`、id/锚点可解析、图片存在、无乱码字符。
破例版（如近黑 v5）用 `--allow-gradient` 放行渐变，其余判据照跑。

⚠️⚠️ **三个坑（2026-09-30 v4/v5 踩出）**
① **「彩色投影」的判据是「有没有色相」**，不是 RGB 数值白名单 —— 三通道极差 ≤12 算中性。
   初版按数值白名单把 `rgba(242,244,247,.55)` 近白误判成彩色投影。
② **语法通过 ≠ 能跑 ≠ 算对。** 静态脚本之上必须再加一层**逻辑冒烟**：
   `preview/_smoke-axis.cjs` —— 把页面 `<script>` **原样抠出来**喂 `new Function`，跑在假 DOM 上，
   再用假 `Date` 把北京时间**钉**到三个时刻（12:45 / 16:15 / 23:30）验 ON AIR 判定、倒计时文案、游标位置。
   ⚠️ 必须抠真源码，另抄一份只能证明"我抄对了"。
③ **JS 正则不能写 PCRE 的 `\x{0400}`**，要写 `\u0400`，否则直接 `SyntaxError: Invalid escape`。

## 管理端小程序（分包 `pages-admin/`，2026-10-01 落地）

设计源 = `preview/admin-mp-v6`（7 屏静态稿，陛下批的就是它）。一期 ＝ **登录 / 待办台 /
投稿&点歌审核 / 审核处理台 / 留言审核**；**排期、批量、学生账号、系统设置仍在电脑端**。

- ⚠️⚠️ **token 分键**：管理端走 storage `admin_token` + `globalData.adminToken`，
  请求一律用 `utils/request.js` 的 **`adminRequest()`**（内部 `scope='admin'`）。
  与学生端共用一个 `token` key 会互相顶登录态（老师可能同机双登）。
  `app.js` 里有 `adminLogin() / adminLogout() / isAdminLoggedIn()`。
- ⚠️ **驳回理由服务端硬校验必填** ⇒ 列表页的「驳回」**跳处理台**（那页才有理由输入框）；
  留言「屏蔽」用 `wx.showModal({ editable: true })` 收原因 —— 都别想静默提交空理由。
- ⚠️ **审核通过会立刻进排期并改写这条记录**（approve 里会 reload）⇒ 处理台操作完**只信列表刷新**：
  `navigateTo` 时挂 `events: { reviewed }`，处理台 `getOpenerEventChannel().emit('reviewed')`。
- 处理台 = **L1 白卡大投影**（`--sh-lift`，纯黑透明 / 三通道极差 0）：页面底 `--parchment`，
  主卡白底 + 第 3 档投影 + **去掉全部细描边**，卡内次级块（名额条 / 文本域）退回灰底。
  其余三个管理端页面仍是「白底页面 + 羊皮纸卡」。
- ⚠️⚠️ **投影阶梯的"档位名"≠ 实际可见度**（2026-10-01 实测）：
  `--sh-card = 0 1px 2px rgba(0,0,0,.04)` 叠在 `--parchment #F5F5F7` 上**归零** ——
  卡左侧灰底 `min = 245`，与"完全没有影子"**逐像素一致**。
  ⇒ **`--sh-card` 只能当"极淡的分隔暗示"，表达不了"浮起来"**；
  要浮必须 `--sh-lift`（min 237）或中间档 `0 4px 12px -4px rgba(0,0,0,.10)`（min 241）。
  ⇒ **别照档位名写交付说明**，采样像素：同一采样行最小灰度差 **< 6 灰阶 = 视觉上没差别**，≥15 才算一档海拔。
- ⚠️⚠️ **任何"让顶栏 / 导航区变白底"的方案，先想微信胶囊**：胶囊本身就是白色圆角条，
  顶栏变白卡后两者**同色糊死**，只剩那 1px 描边能认（v13 的 C 案实测，证据图 `preview/admin-mp-v13/shots/v13-c-capsule.png`）。
- 处理台用**页面滚动 + `position: fixed` 底栏**（不用 `scroll-view`）：textarea 是原生组件，
  且 `wx.pageScrollTo({ selector })` 对 scroll-view 无效。body 留 `padding-bottom: 220rpx` 防压。
- 改管理端 wxss 后必跑 `node preview/_check-admin-mp.cjs`（判据 `未定义 CSS 变量: 0` /
  `非登录页配色越界: 0 处`）+ `node scripts/check-wxml-classes.js`（已纳入 5 个管理端页面，
  且新增「wxml 绑的事件处理函数在 js 里存在吗」——本次真漏过一次 `goBack`）。
- ⚠️ **`var(--x)` 指向一个不存在的变量 = 静默无效果，不是报错**。`--ease` 就是这么漏掉的：
  登录页从 v2 起写 `transition: … var(--ease)`，而 app.wxss 从没定义过它 → 已补真实定义。
- ⚠️⚠️ **WXML 不解析 HTML 实体**：写了 `&amp;` 会**原样显示**成 `&amp;`（文案从 HTML 预览稿搬过来必踩）。
  WXML 里 `&` 直接写；**预览稿（HTML）里的 `&amp;` 是对的，别跟着改反**。
  `check-wxml-classes.js` 已加这条静态检查（判据行 `HTML 实体: 无 OK`）—— 这类错只有渲染出来才看得见。
- ⚠️⚠️ **`<text>` 保留换行**（不做 HTML 那种空白折叠）：内容被拆成多行会多渲染一个空行盒，
  把胶囊 / 徽章撑成两倍高、文字掉到底部（2026-10-01 真机反馈「红绿胶囊均错位」）。
  **修法：文案在 js 的 `decorate()` 里拼好（`tagClass`/`tagText`），wxml 一行写完**；
  别拿 `line-height`/`align-items` 去治（高度是行盒撑的，CSS 治不了）。
  判据行 `<text> 跨行: 无 OK`。
  ⚠️ 该检查**分析前必须先剥 wxml 注释**（注释里写字面量 `<text>` 会被当标签 → 报假错）。
  ⚠️ **定位这类问题的最快办法：同页找一个「同类但正常」的元素当对照组**（本次是写在一行的 `.fl` 筛选胶囊），
  只看两者模板写法的差异 —— 比逐行审代码快得多。细则见 skill `wxml-render-traps`。
- ⚠️ **顶栏右侧必须避让右上角微信胶囊**：`navigationStyle: custom` 下胶囊一定在，
  而**预览稿的模拟器里没有它** ⇒ 设计阶段看不见（待办台的「指导老师」被吃成「指导老」）。
  `app.js` 有 `globalData.navRightSpace`（＝ windowWidth − rect.left），顶栏右侧有内容就
  `style="margin-right: {{navRightSpace}}px"` 让位。左侧不用管（胶囊只在右边）。
  ✅ **顶栏右侧一直是空的**（不放任何东西）。**但「指导老师」的位置改过一次**：
  最初挪进待办卡右上角（`.tl-who`）→ **2026-10-01 再挪到顶栏标题下面**（v12-C 案，陛下贴图指定）。
  现在顶栏 = 徽章 + 两行文字块（「导播台」/「指导老师」），待办卡右上角**空着**。
  `navRightSpace` 让位码已从 `todo.js` 删掉，**别放回去**。
- ⚠️⚠️ **站徽 PNG 是透明底（环形文字镂空）**：`miniprogram/assets/station-badge.png` 1410×1410 RGBA，
  四角与 45° 半对角处 alpha 都是 0 —— 只有环带和圆心有像素。
  ⇒ **用它当图标时必须自己给 `background`**，否则镂空处直接透出页面底色（在羊皮纸灰上，环形文字像"缺字"）。
  待办台顶栏 `.badge` 已加 `background: var(--canvas)`（= 预览稿里就有的白底圆）。
  ⚠️ 这是**背景色不是卡片**（没外扩尺寸、没投影）—— 徽章卡片的形态（v13 方块 / v14 正圆）**另行讨论**。
- **待办台（todo）视觉 = L1「白卡大投影」+ C 案「主浮次平」**（2026-10-01 陛下定版 v7-C / v8-②）：
  页面底 `--parchment` 灰；**待办卡浮起**（`--sh-lift`，整屏唯一）；**两个入口卡白底但贴平**（无投影）；
  卡内图标底退回灰（白卡嵌灰块）。⚠️ 页面转灰后 `--soft` 提示会糊底 → 用 `--muted`。
  ⚠️ **这屏现在没有深色卡了** —— 与审核处理台同一套 L1，别在别的屏顺手扩散。
  ⚠️ **顶栏高度不能再写死 `height`**：两行文字块（2026-10-01 起）比单行高，实测 **112rpx vs 88rpx**，
  已改成 `min-height: 88rpx` + `padding: 16rpx 36rpx 20rpx`；徽章同步 `52rpx → 64rpx`（两行文字变高后徽章不跟着长会显小）。
- 一期**没做**（预览里没有、或权限不允）：批量审核、撤销、改时段、指派排期、播放标记
  —— 全是 `requireSuperAdmin` 或超出一期范围。
- ❌ **处理台四段（投稿人 / 投稿内容 / 驳回原因 / 审核记录）「合成一张白卡」—— 陛下看完 v10/v11 后决定：算了，先维持现状。**
  **所以 `review-detail/detail.wxml` 一个字没动，仍是四块独立白卡。别自己往上搬。**
  设计稿留在 `preview/admin-mp-v10`（静态四案）和 `preview/admin-mp-v11`（可交互原型，含#a/#b/#c/#now 深链）。
  若将来再提合并，这几条是结论，别重新推一遍：**投影只留一个**（四块卡的真毛病是"四个影子各浮各的"）；
  **段间线通栏、段内 kv 线缩进**（两样线不一样，远看才认得出是四段）；动手区（驳回原因）垫灰块；
  ⚠️ 别吹省高度 —— 实测只省 82rpx（≈6%），收益在"读作一张单"；实测数据 现状 1636 / A 1528 / B 1568 / C 1568 rpx。
- ⚠️⚠️ **顶栏右侧一律留空**（微信胶囊地盘）。全项目 9 页只有 `detail.wxml` 破过例
  （放「点歌」，会被胶囊盖掉）→ 已改回 `.navbar-spacer`；类型在卡里「投稿内容（点歌）」已有，删掉不丢信息。
  ⚠️ 这条是**缺陷修复**（那个字在真机上本来就被盖住），**视觉上等于没变**，与"维持现状"不冲突。

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 全局候补队 / `song_queue_limit`）。
- 登录页 v1（AI 底图 + 插画）全删且被否；概念稿 v2–v7 在 `design-preview/`（未跟踪）。

## 登录页系列（`preview/student-login-v*`，选型还在走）
- 已出过的风格：v4 **调频刻度**（v4.1 浅色版）／v5 **收听证**／v8.4 **点唱机**（俯视深色盘 + `#0066CC`）
  ／v9 **简笔画唱片机 · 纸感墨线** → **v9.1**（纸 `#F2EFE8` + 墨 `#2B2B30`，**无白卡**）
  → **v9.2**（造型不动，**登录流程重设计为「开播三步」：备碟→对轨→开播，唱臂当进度条**
  ——新角度只有 `.tonearm.cue{rotate(-40°)}`，几何仍 26/26 逐属性一致）。
  → **v10**（**拟真版唱片机**：金属质感 + 径向渐变转盘 + 黑胶，**允许渐变**；造型沿用开播三步，
  但**唱片机几何按自查修 5 处错**：补配重 / 封面本地化 / 直棍改 S 臂 / 转盘同心 / 唱针三态）。
  ⚠️ 「调频那一版」＝登录页 v4（不是首页；首页那版叫「调频刻度」）。
- 造型素材在 `login-redesign-preview/`（`唱片机简笔画.html` / `站标简笔画动效.html` / 拟真版 / 平面图）。
  ⚠️⚠️ **两台唱片机，指令相反，判据不同——先看陛下说的是哪条：**
  - **简笔画**（v9/v9.1）：「原样画出来，不要给我乱改」→ **逐属性 + 逐像素照抄，不许加滤镜**。
    v9 初版给它套了层 `feTurbulence`「手绘抖动」把正圆盘纹拧歪，被当场退回。
    正确范围：几何、`stroke-width`、`fill`（含 Off/On `#6B6B70`、转速未选 `#B3B0A7`）、`font-size`、`transform`
    （停放 `rotate(-64°)`）、连两个透明命中区 `hitPower/hitSpeed`，**全部照抄**；改之前跑
    `preview/student-login-v9.1/_diffgeom.cjs`（判据 `✅ 逐属性一致`）。
  - **拟真版**（v10）：「画得有些地方不对，你自己检查然后修改」→ **允许且必须改几何/结构**：
    我得自己审 anatomy 并修错（配重缺失 / 封面外链 404 / 直棍臂 / 转盘偏心 / 唱针停中段），
    **不套用 1:1 还原判据**；拟真本意就含渐变金属质感，自检不强制 0 渐变。
  ⇒ 同样的「唱片机」因指令不同而走完全不同的处理路径，别把 v9 的"原样抄"套到 v10 上，也别反过来。
- 预览稿两条固定约定（v4.1 起）：`?final` 跳过「一笔画」入场（否则截图截出空图）、
  `#login/#error/#activate` hash 深链切态（否则每屏没法单独验）。
  v9/v9.1 的坑与判据见 `.workbuddy/memory/2026-10-01.md` 末两节 + skill `web-ui-screenshot-verify`。
- 学生账号 v1（目录树形态）。
