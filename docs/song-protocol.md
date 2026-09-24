# 点歌排期协议版（算法重构）· 2026-09-24

> 依据：陛下给的《前后端可共同执行的业务协议》PDF。
> 取代：`docs/song-queue-v2.md`（v2「提交即占位 + 全局 FIFO 候补队列」，该文保留为历史记录）
> 落地代码：`src/services/songSchedulingService.js`（算法）、`src/services/songStatusService.js`（三维状态）、
> `src/services/songQueueService.js`（读路径 + 调度器）、`src/models/{weeklySchedule,assignmentLog,requestStatusLog}.js`
> 迁移：`sql/migrations/2026-09-24-song-protocol.sql`
> 验证：`node scripts/verify-song-protocol.js`（86 项全过）

---

## 0. 一句话

把「**谁先提交谁占位**」换成「**审核通过后统一排期**」：

| | v2（旧） | 协议版（现在） |
|---|---|---|
| 提交时 | 判容量：格子有空 → 占位；满了 → 进候补；都满 → 40904 拒绝提交 | **不判容量**，一律 `PENDING_REVIEW`，谁都能投 |
| 审核通过 | `status 0/4 → 1`（等于拿到位置） | 只是**拿到候选资格**（`review=APPROVED`，`schedule=UNASSIGNED`） |
| 位置怎么来 | 提交那一刻定的 | **第一轮排期**：按「首选时段」分组，组内 `submitted_at` 早的取前 `capacity` 个 |
| 没排上 | 全局一条 FIFO 队列，任意格子空出就补，不绑首选 | `WAITING` → **原位递补**；首选满且允许调剂 → **全局调剂** |
| 状态表达 | 一个 `status` 0/1/2/3/4 | **三个维度** `review_status` / `schedule_status` / `play_status` |
| 定稿 | 窗口结束（周日 18:00）就清 3 / 4 | **`schedule_lock_at` 锁定**：最后一次调度 → 剩余 `WAITING` → `AUTO_REJECTED` |
| 可追溯 | 只有当前状态 | `assignment_log`（换了哪些时段）+ `request_status_log`（状态为什么变） |

**保留不变**（陛下 2026-09-24 确认）：点歌时间窗口 / 每人每周次数上限 / 同曲一周去重。

---

## 1. 三维状态

一个 `status` 同时表达「审核结果 + 排期结果 + 播放结果」会越来越乱，所以拆成三个正交维度：

| 维度 | 取值 | DB 列 |
|---|---|---|
| 审核 | `PENDING` / `APPROVED` / `REJECTED` / `CANCELLED` | `review_status` |
| 排期 | `UNASSIGNED` / `APPROVED` / `WAITING` / `AUTO_REJECTED` | `schedule_status` |
| 播放 | `NOT_PLAYED` / `PLAYED` | `play_status` |

于是「审核通过了但还在候补」写得明明白白：

```
review_status = APPROVED, schedule_status = WAITING, play_status = NOT_PLAYED
```

而不是靠一个 `status = WAITING` 去猜它到底审没审。

### 1.1 占位口径（唯一真值）

```
占一个正式位  ⟺  review_status = APPROVED  AND  schedule_status = APPROVED
```

**这条一式定死了位子释放**：人工驳回只需要把 `review_status` 置成 `REJECTED`，位子自动就
释放了 —— 不需要额外的 `release()` 步骤，因此物理上不可能「忘记归还」。
（v1 的名额泄漏、v2 的两本账，根子都是「占位」和「状态」分开记。）

### 1.2 `status` 是派生镜像

`submit.status` 这一列 **不是真值**，由 `songStatusService.deriveStatus()` 单点算出：

| 三维 | 镜像 status | 文案 |
|---|---|---|
| play=PLAYED | 5 | 已播放 |
| review=CANCELLED | 7 | 已取消 |
| review=REJECTED 或 schedule=AUTO_REJECTED | 2 | 已驳回 |
| schedule=WAITING | 3 | 候补中 |
| schedule=APPROVED | 1 | 已排期 |
| review=APPROVED（还没排期） | 6 | 已通过 · 待排期 |
| 其余 | 0 | 待审核 |

`4`（v2 的「已补位 · 待审」）协议版**不再产生**，常量保留只为兼容。
保留这一列的原因：小程序与 admin-web 还在按单 status 筛选，前端改造是下一期；
有它就可以后端先上线、前端渐进迁移。**任何写路径都必须走 `songStatusService.applyChange()`**，
不许单独改 `status`。

---

## 2. 周状态机 `weekly_schedule`

```
DRAFT ──发布──> APPLICATION ──申请截止──> REVIEW ──已跑排期──> SCHEDULING ──锁定──> LOCKED
   └────────────────────── 取消 ──────────────────────> CANCELLED
```

- **一周一行**，`week_start_date` 唯一 → 同一周不可能出现两份排期。
- **懒创建**：学生第一次提交（或管理员第一次打开该周）时自动建行，管理员不用先「创建下周排期」。
- 时间锚点**全部由 KV 点歌窗口派生**（不新增一套申请时间配置）：

  | 字段 | 来源 |
  |---|---|
  | `application_start_at` / `application_end_at` | KV `song_submit_window` 的**收歌**起止 |
  | `review_start_at` | = `application_end_at`（收歌结束即审核开始） |
  | `schedule_lock_at` / `review_end_at` | = **独立「审核截止」**：配了 `reviewDay`/`reviewTime` 就用它；没配则退回 `application_end_at` + `song_lock_offset_minutes`（默认 360 分）；窗口限制关闭时退回播出周周一 00:00 |

  ⚠️ **2026-09-25 起「收歌截止 ≠ 审核截止」**：收歌结束只停止收新歌，到审核截止才自动排期 +
  驳回剩余候补 + 锁定本周。两者之间是留给管理员的审稿/调格留白。
  默认配置（周六 18:00 → 周日 18:00、未配审核截止）下 `schedule_lock_at` 仍是**播出周周一 00:00**，
  升级不改行为。

  ⚠️ **窗口位置算法**：窗口锚在**收歌周的周一 00:00**（= `nextWeekRange(now).start − 7 天`）：
  `offsetOf(day,time) = ((day===0?7:day)−1) * 1 天 + HH:mm`，星期**任选周一→周日**，最长可铺满整周。
  硬约束只有一条：`0 ≤ startOff < endOff ≤ 7 天`（**不跨播出周周一 00:00**）——
  只有窗口整体落在同一周内，窗口里任意时刻的 `nextWeekRange(now)` 才指向同一个播出周。
  旧实现用 `offBack(d)=(1−d+7)%7` 从播出周往回推，`offBack(周一)=0` 会让 `startDay=周一` 落到
  **播出周本身** → 语义直接崩；新公式对旧白名单（五/六/日）与旧公式完全等价。

- `DRAFT/APPLICATION/REVIEW` 由时间自动推进；`SCHEDULING / LOCKED / CANCELLED` 是**写动作**的结果，
  不会被时间反向覆盖（`ensureWeek` 不覆盖 `LOCKED`）。

---

## 3. 完整流程与算法

```
用户提交（窗口内）
   └─ review=PENDING, schedule=UNASSIGNED        ← 不看容量
审核
   ├─ 驳回 → review=REJECTED                     ← 位子自动释放 → 触发调剂
   └─ 通过 → review=APPROVED, schedule=UNASSIGNED
          └─ 触发 InitialAllocator（幂等，每次审核通过都会跑一遍这一周）
                 · 逐格：候选 = review=APPROVED AND schedule=UNASSIGNED AND 首选=这一格
                 · 排序：create_time ASC, id ASC
                 · 前 capacity 个 → schedule=APPROVED, assigned_slot=首选格
                 · 其余        → schedule=WAITING
          └─ 触发 RescheduleAllocator
                 · 空位 = 已占 < capacity 的格子
                 · 候选 = review=APPROVED AND schedule=WAITING
                 · ⚠️ 收歌窗口还没结束 → 只做「原位递补」，别处的空位不外借（见 3.1）
                 · 排序：① 可接受位置少的优先 ② 提交时间早的优先 ③ 距原时段近的优先
                 · 目标格：首选仍空 → 放首选（记 PROMOTED）；否则放 cost 最小的空位（记 RESCHEDULED）
                   ⚠️ allow_reschedule=0 的人只接受首选，首选满就继续等
锁定（到 schedule_lock_at，或管理员手动 force）
   └─ 最后一次 InitialAllocator + RescheduleAllocator
      → 剩余 schedule=WAITING → schedule=AUTO_REJECTED（原因：排期已锁定，没有可用位置）
      → 周状态 = LOCKED
播出时刻过后
   └─ schedule=APPROVED 且 play_status=NOT_PLAYED → play_status=PLAYED
```

### 3.1 跨时段调剂的闸门：收歌截止前不许跨格

**收歌窗口内（`application_end_at` 之前）只做「原位递补」**：

- 这时候还有新申请在进来、也还有人没审完，周内任何一个空位都**可能**属于某个
  「首选那一格」的原申请者；
- 若此刻就把候补的人跨时段排过去，等那个人审完就没位置了 —— 而且被挪走的人
  已经变成 `APPROVED`，**再也回不到首选格**。

所以 `reschedule()` 带 `crossSlot` 闸门，默认按「收歌是否已截止」自动判定：

| 时机 | 行为 |
| --- | --- |
| 收歌窗口内（自动路径） | 只把「首选格空出来」的人放回首选格，**绝不占别格** |
| 收歌截止后（自动路径，`sweep()` 每分钟会跑到） | 放开跨时段调剂 |
| 超管手动「执行排期」、锁定前最后一次调度 | 显式放开（`crossSlot: true`） |

一句话：**别处的空位不外借，直到不会再有人首选那一格。**

> 这一条是为了保证「每个时段原先申请者的排期」：谁首选了哪个时段，
> 就先拿哪个时段；只有该时段确实装不下了，才轮到跨格调剂。

### 3.2 「距原时段近」= 成本表（V1 §10）

选址不用「周内格子下标差」，而是显式成本表（`src/services/songRescheduleCost.js`）：

```
同一天其他时段        10
前 / 后一天相同时段    20
前 / 后一天其他时段    30
更远日期              50
不可接受（跨周）       ∞        ← 选 cost 最小的那个格子
```

与下标距离的区别：下标把「周一晚 → 周二早」(差 1) 和「周一晚 → 周一午」(差 1)
当成一样近；成本表则是 **周一午 10 < 周二早 20** —— 跨天的相邻时段不该被当成同天邻近。
cost 相同时按周内下标升序，保证同样输入永远得到同样结果。

### 3.3 幂等与并发

- 状态变更统一走 `songStatusService.applyChange()`，它是**带条件的 UPDATE**：
  以「读取时的三维旧值」为 `WHERE` 条件，影响行数为 0 即视为被并发抢先、直接放弃。
  于是 `capacity = 3` 时不会出现第 4 首 `APPROVED`。
- 第一轮排期的候选取 `schedule=UNASSIGNED`，跑第二遍命中 0 行。
- 调剂分配后立即从 `free` 集合里摘掉被占满的格子，同一次调用内不会超容。
- 调度器每分钟兜底 `sweep()`，任何一次失败下个周期重试。

---

## 4. 与协议的两处**有意偏离**（写清楚，别当 bug 改回去）

1. **没有 `schedule_slots` 表，也没有 `schedule_slot_id` 外键。**
   格子由 `broadcastSlotService` 从 KV（`song_slot_times`）派生，**时段值字符串**
   （`2026-09-21 午间 12:20`）就是它的身份。再建一张配置表 = 又多一本账，
   而 v1 的名额泄漏正是「两本账」造成的。因此 `assignment_log` 的列名是
   `from_slot` / `to_slot` 而不是协议里的 `from_slot_id` / `to_slot_id`，语义一致。

2. **每格容量沿用全局 KV（`song_slot_capacity`），不做按格单独容量。**
   协议示例里的 `capacity = 3` 是同一语义，只是没有按格拆分。

另外一处**废弃**：协议没提候补人数上限，所以 `song_queue_limit` 退役 —— 审核通过的人
理应能排队，卡人数没有意义。

---

## 5. 迁移与上线

```bash
# 1) 跑迁移（幂等）
mysql -u<user> -p <db> < sql/migrations/2026-09-24-song-protocol.sql

# 2) 部署新代码
git push && (服务器) docker compose build backend && docker compose up -d --force-recreate backend

# 3) 兜底重算历史周的排期 + 锁定 + 播放标记
curl -X POST http://<host>/api/admin/submit/queue/sweep -H "Authorization: Bearer <admin>"
```

**回填口径**（脚本里③之前那两段 UPDATE）：

| 老 status | review | schedule | 说明 |
|---|---|---|---|
| 1 已排期 | APPROVED | APPROVED | 占位保留 |
| 4 已补位未审 | APPROVED | APPROVED | 它确实占着位子，保住 |
| 3 候补中 | APPROVED | WAITING | 进候补池 |
| 0 待审 | PENDING | UNASSIGNED | **不再占位**（协议版提交不占位），审核通过后重新排 |
| 2 人工驳回 | REJECTED | UNASSIGNED | |
| 2 系统驳回 | APPROVED | AUTO_REJECTED | 保留「系统驳的」痕迹 |

⚠️ `status=0` 的老数据迁移后不再占位，这是方案变更的一部分，不是丢数据。

---

## 6. 接口变更

### 6.1 用户端

| 接口 | 变更 |
|---|---|
| `POST /user/submit` | **不再判容量**；响应 `outcome: 'submitted'`（原来 `seated`/`queued`），带 `reviewStatus/scheduleStatus/allowReschedule/week/lockAt`；新增入参 `allowReschedule`（默认 true） |
| `GET /user/submit/timeslots` | 每格 `seated` 是**排期结果**，`full` 只是提示，不再阻止提交；`week` + `lockAt` |
| `GET /user/submit/window` | 增带 `week`（含 `scheduleLockAt`） |
| `GET /user/submit/quota` | `queue.limit = 0 / unlimited = true`（候补无上限）；增带 `week`、`lockAt` |
| `GET /user/submit/my` | 每条带三维字段 + `statusText`；卡片改为四形态 |
| `DELETE /user/submit/:id` | 不再删行，置 `review=CANCELLED`（保留「他投过什么」） |
| `POST /user/submit/:id/leave-queue` | 同上（放弃候补 = CANCELLED） |

**学生端状态卡四形态**（`songQueueService.cardFor`）：

| 形态 | 触发 | 说明 |
|---|---|---|
| `pending_schedule` | review=APPROVED & schedule=UNASSIGNED | 「审核已通过，等待排期」 |
| `waiting` | schedule=WAITING | 候补中 · 第 N 位；带「是否接受调剂」说明 + 放弃入口 |
| `scheduled` / `played` | schedule=APPROVED | 已排期 / 已播放；被调剂过会写明「你首选的是 X，被调剂到 Y」 |
| `failed` | review=REJECTED 或 schedule=AUTO_REJECTED | 未排上，给系统驳回理由 |

### 6.2 管理端

| 接口 | 变更 |
|---|---|
| `PUT /submit/:id/approve` | 只做审核；通过后**自动重跑该周排期**，响应 reload 后的最新状态（不再回中间态） |
| `PUT /submit/:id/reject` | 位子自动释放 → 触发调剂 |
| `PUT /submit/:id/revoke` | 三维一起归零，写 `RELEASED` 排期日志 |
| `GET /submit/schedule` | 每格 `scheduled / waiting / pending`；顶层 `week` + `lockAt` |
| `GET /submit/week` 🆕 | 目标周的排期状态、时间锚点、已占 / 剩余 |
| `POST /submit/schedule/run` 🆕 | 执行第一轮排期 + 全局调剂（协议 §16/§17） |
| `POST /submit/schedule/lock` 🆕 | 正式锁定（协议 §18）；`force: true` 提前锁 |
| `POST /submit/:id/assign` 🆕 | 人工指定时段（协议 §20），写 `MANUAL` 日志 |
| `PUT /submit/:id/played` 🆕 | 标记已播放 / 取消 |
| `GET /submit/:id/status-logs` 🆕 | 状态变更历史 |
| `GET /submit/:id` | 增带 `statusHistory` + `assignments` |
| `GET/PUT /submit/quota` | `queueLimit` 废弃（传了不生效）；改名不改路径，仍兼容 |
| `POST /submit/queue/sweep` | 改为「排期 + 锁定 + 播放标记」全量兜底 |

---

## 7. 验证

`node scripts/verify-song-protocol.js` → **86 项全过**（结果同时写 `scripts/verify-song-protocol-output.txt`）。

覆盖：模型与索引 / 周懒创建与时间锚点 / 周状态推进与锁定不可逆 /
提交不判容量 / 第一轮排期（按提交时间取前 capacity）/ 原位递补 / 全局调剂 /
调剂三级优先级 / 锁定与 AUTO_REJECTED / 播放标记 / 人工调整 / 两类日志 /
镜像不变量（库内每行的 status 都与三维一致）/ 三条保留规则 / 兜底 sweep。

回归：`npx jest` 15 失败 —— 全部是早已删除的「风采 / member」模块（基线值），点歌相关 41 项全过。
`scripts/verify-song-submit.js` 107/107。
`scripts/verify-song-queue.js` **已作废**（断言的是 v2 口径），文件头加了守卫，直接跳过并提示改用本脚本。

### 本次抓到的 1 个真 bug

`approve` 接口返回的是**排期前的旧快照**（库里已更新，响应体还是 `status=6`），
界面显示「还没排上」、刷新又变「已排期」。修法：排期跑完后 `fresh.reload()`。

---

## 8. 前端（下一期）

后端已上线三维字段与 `statusText`，前端（小程序点歌页 / 我的投稿 / admin-web 审核台与排期矩阵）
**按既有约定先出静态预览、标版本号、陛下点头后再写业务代码**。
目前前端仍按派生镜像 `status` 工作，新增的 `6 已通过·待排期` 与 `7 已取消` 两个值需要在前端补上文案与筛选格。
