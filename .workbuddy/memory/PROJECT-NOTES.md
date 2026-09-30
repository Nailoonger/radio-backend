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
- **投稿列表 8 列**（1920 视口）：selection / 内容（唯一弹性 `min-width:330`）/ 首选时段 / 投稿人 / 提交时间 / 审核人·时间 / 状态 / 操作（`fixed="right"`）。⚠️ 改列宽前必须 `getBoundingClientRect()` 逐列实测，别拿截图猜；**量折行看 height 不看 width**。
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
2. **真实内容源** = `src/utils/seed.js` 的 `seedSettings()`：**2005 年**成立（口号"菁菁校园情，悠悠广播声"）；
   开播 **午间 12:30-13:00｜下午 17:00-17:30**；社长电话 13800138000（疑似占位）。
   ⚠️ `seedPrograms()` 那 3 个是**示例种子，不是真栏目**。
   ⚠️ **校园广播站没有 FM 频率** —— "87.6MHz"是假的，早因瞎编被点过 → **别再编任何业务事实**。
3. **结构事实源** = `AGENTS.md`：社干 `cadre` = 站长/副站长/纪检长/站长助理（无部门字段）；
   部员 `staff` = 播音部/主持部/编辑部。
4. 信息架构从 `pages/about` 长出来（品牌区 + 一卡三块 + 分隔线）；真站徽 `preview/assets/station-badge.png`（+ `-mono.png`）。

**自检配方**（参考 `preview/_check-website-v3.cjs`）：gradient 数=0（**必须先剥 `/* */` 注释**，
否则注释里提到 gradient 会误报）、无彩色投影、禁词扫描（FM/假人名/假栏目）、真内容必须在、
JS 过 `new Function`、id/锚点可解析、图片存在、无乱码字符。

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 全局候补队 / `song_queue_limit`）。
- 登录页 v1（AI 底图 + 插画）全删且被否；概念稿 v2–v7 在 `design-preview/`（未跟踪）。
- 学生账号 v1（目录树形态）。
