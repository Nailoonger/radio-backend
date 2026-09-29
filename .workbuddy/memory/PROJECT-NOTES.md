# 菁悠广播站 · 项目细则备忘（按需读取）

> `MEMORY.md` 放铁律与主线；本文件放体量大、可自查的细则坑。改动相关模块前读对应小节。

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

## 已废弃（别捡回来）
- v2 点歌口径（提交即占位 / 全局候补队 / `song_queue_limit`）。
- 登录页 v1（AI 底图 + 插画）全删且被否；概念稿 v2–v7 在 `design-preview/`（未跟踪）。
- 学生账号 v1（目录树形态）。
