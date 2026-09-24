# 点歌：现有实现 ↔ 陛下新给的《V1 规格》逐条对照

> 对照对象
>
> - **A（现在跑的）**：`docs/song-protocol.md` + 已落地代码（2026-09-24 协议版，97 项验证全过）
> - **B（陛下刚发的 PDF）**：《后端可以开工的 V1 规格》17 页 —— 标题重点：**权限一起锁死**，普通管理员只能审核，超级管理员才能改排期规则
>
> 结论先行：**业务算法层面基本一致（12 条对上），但有 3 类真出入** ——  
> ① 权限完全没锁（最严重，也是这份 PDF 的主旨）；② 差一个 `preview`/`unlock` 与成本模型；  
> ③ 一批「实现方式不同但语义等价」的偏离，其中 2 条是之前**有意**做的，需要陛下重新裁决。

---

## ⚠️ 修订状态（2026-09-25）

| 条目 | 内容 | 状态 |
| --- | --- | --- |
| 2.1 | 权限锁死：6 个越权接口 → 超管，另收 `played` / `revoke` / 两个 sweep | ✅ 已修 |
| 2.2 | `preview` 模拟排期（`POST /submit/schedule/preview` + `dryRun` 不写库） | ✅ 已修（`unlock` 仍未做 —— V1 说可先不提供，但要求「锁定后真的不能改」，见 2.3） |
| 2.3 | 锁定守卫：approve / reject / remove / revoke / batch / assign / played / runSchedule | ✅ 已修 |
| 2.4 | 调剂成本表：10 / 20 / 30 / 50 / ∞，独立成 `songRescheduleCost.js` | ✅ 已修 |
| 2.5 | 并发保护：`applyChange` 改带条件 UPDATE（影响 0 行即放弃） | ✅ 已修 |
| 2.6 | 三维状态数字 → 字符串 | ⬜ 待陛下裁决 |
| 2.7 | 角色模型 2 个 → 3 个 | ⬜ 待陛下裁决 |
| 3.1 / 3.3 / 3.4 | `schedule_slots` 表、逐格容量、周创建方式 | ⬜ 保留现状（有意偏离） |

> **另有一处不在原表内的修复（2026-09-25）** —— 见文末第七节：
> `reschedule()` 增加 `crossSlot` 闸门，**收歌窗口内只做「原位递补」**，
> 收歌截止后才允许跨时段调剂。
>
> 验证：`node scripts/verify-song-protocol.js` → **130 项全过**（原 97 项，新增 G2 / G3 / P 三节）。

---

## 一、完全一致的部分（12 条，不用动）

| #  | V1 规格                                                                                            | 现状                                                                          |                   |
| -- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------- |
| 1  | 提交**不检查时段容量**                                                                                    | `submitController.create` 不判容量，一律 `PENDING/UNASSIGNED/NOT_PLAYED`           | ✅                 |
| 2  | 通过 ≠ 拿到位置                                                                                        | `approve` 只改 `review_status=APPROVED`，位置由排期算                                | ✅                 |
| 3  | 第一轮排期**绝对不跨时段**                                                                                  | `initialAllocate` 按首选时段分组，组内 `create_time ASC, id ASC` 取前 capacity          | ✅                 |
| 4  | 调剂候选人 = `APPROVED + WAITING + allow_reschedule=true`                                             | `reschedule` 的 where 条件完全一致                                                 | ✅                 |
| 5  | 调剂排序：①可接受位置少 ②提交早 ③距原时段近                                                                         | `decorated.sort` 三级键，顺序一模一样                                                 | ✅                 |
| 6  | 锁定 = 跑最后一次调剂 → 剩余 WAITING → AUTO_REJECTED → 周 LOCKED                                             | `lockWeek()` 四步齐                                                            | ✅                 |
| 7  | 周状态机 DRAFT/APPLICATION/REVIEW/SCHEDULING/LOCKED/CANCELLED                                        | `WEEK_STATUS` 同 6 值                                                         | ✅                 |
| 8  | 三维状态**名字**：PENDING/APPROVED/REJECTED、UNASSIGNED/APPROVED/WAITING/AUTO_REJECTED、NOT_PLAYED/PLAYED | `songStatusService` 常量名逐个相同                                                 | ✅（存法不同，见 3.5）     |
| 9  | 申请表带 `allow_reschedule`                                                                          | `submit.allow_reschedule` 有                                                 | ✅                 |
| 10 | 两张日志表（状态日志 + 排期变动日志）                                                                             | `request_status_log` / `assignment_log` 都有                                  | ✅（结构不同，见 3.6/3.7） |
| 11 | 自动任务按 4 个时间点推进周状态，不用管理员天天手点                                                                      | `songQueueService.startScheduler()` 每分钟 `sweep()`，`deriveWeekStatus()` 自动推进 | ✅                 |
| 12 | 学生能「查看排期」                                                                                        | `GET /user/submit/week`（整周排期，连登录都不要）                                        | ✅                 |

---

## 二、真出入（必须改）

### 2.1 ⛔ 权限完全没锁 —— 这是这份 PDF 的主旨，当前一个都没落实

V1 规定：**REVIEWER 只能** 查看申请 / 通过 / 驳回 / 查看排期候补；**其余全是 SUPER_ADMIN**。  
现状（`src/routes/admin.js`）：

| 接口                                            | 现在的守卫               | V1 要求                | 判定       |
| --------------------------------------------- | ------------------- | -------------------- | -------- |
| `GET /submit/list` 查看申请                       | `requireAdmin`      | REVIEWER ✅           | 一致       |
| `PUT /submit/:id/approve` 通过                  | `requireAdmin`      | REVIEWER ✅           | 一致       |
| `PUT /submit/:id/reject` 驳回                   | `requireAdmin`      | REVIEWER ✅           | 一致       |
| `GET /submit/schedule`、`GET /submit/week` 看排期 | `requireAdmin`      | REVIEWER ✅           | 一致       |
| `POST /submit/schedule/run` **执行排期**          | `requireAdmin`      | **SUPER_ADMIN / 系统** | ❌ **越权** |
| `POST /submit/schedule/lock` **锁定**           | `requireAdmin`      | **SUPER_ADMIN**      | ❌ **越权** |
| `POST /submit/:id/assign` **人工调整歌曲**          | `requireAdmin`      | **SUPER_ADMIN**      | ❌ **越权** |
| `PUT /submit/slots` **配置歌曲时段**                | `requireAdmin`      | **SUPER_ADMIN**      | ❌ **越权** |
| `PUT /submit/rules` **配置调剂规则**                | `requireAdmin`      | **SUPER_ADMIN**      | ❌ **越权** |
| `PUT /submit/quota` **配置容量**                  | `requireAdmin`      | **SUPER_ADMIN**      | ❌ **越权** |
| `PUT /submit/:id/played` 标记播放                 | `requireAdmin`      | V1 无此行（系统自动）         | ⚠️ 建议收超管 |
| `PUT /submit/:id/revoke` 撤销审核                 | `requireAdmin`      | V1 无此操作              | ⚠️ 建议收超管 |
| `PUT /submit/window` 申请时间                     | `requireSuperAdmin` | SUPER_ADMIN ✅        | 一致       |

**根因**：`docs/song-protocol.md` 里**根本没有权限章节**（目录第 0~8 节全在讲算法），  
所以我上一轮把新接口全挂在了 `requireAdmin` 上。这次 PDF 是第一次把权限写死。

另：V1 要求「**创建周排期**」也是超管动作，而我们是 `ensureWeek()` **懒创建**  
（谁先访问谁建，`created_by` 为空）。这是有意为之（少一步人工），但它意味着  
「一周什么时候诞生」不由超管决定 —— 要请陛下裁决是保留懒创建，还是补一个显式创建接口。

### 2.2 缺少两个接口

| V1                                                                                          | 现状     | 影响                                                 |
| ------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| `POST /admin/scheduling/{id}/preview` **模拟排期**（只算不写库，返回 slots / reschedules / autoRejected） | **没有** | 超管没法「先预览、确认没毛病、再正式执行」。V1 特意强调这是为了**算法出问题不污染正式数据**。 |
| `POST /admin/weekly-schedules/{id}/unlock` 解锁（填原因 + 审计日志）                                   | **没有** | V1 说「V1 甚至可以先不提供」→ 可以不做，但**必须保证锁定后真的不能改**（见 2.3）。  |

### 2.3 锁定后还能改 —— 与 V1 第 11 节直接冲突

V1：锁定之后普通管理员 ❌，超级管理员 ⚠，「我建议即使超级管理员也不能普通修改 LOCKED 排期」。

现状：

- `lockWeek()` 有「已锁定就短路」✅、`cancelWeek()` 拦 LOCKED ✅ —— 这两个是好的。
- **但 `submitController` 里 approve / reject / assign / played 全都没有 LOCKED 守卫**，  
  `initialAllocate()` 在已锁定的周上也会照改（只是不回退周状态）。  
  → 也就是说：**锁了还能人工改时段、还能审批、还能重跑排期**，跟没锁差不多。

### 2.4 调剂没有「成本表」，用的是下标距离

V1 第 10 节给了明确的 cost：

```
同一天其他时段        10
前/后一天相同时段      20
前/后一天其他时段      30
更远日期              50
不可接受              ∞
→ 选 cost 最小的
```

现状：`reschedule()` 里选目标格用的是 **`Math.abs(时段下标差)` 最小**。

**这不是等价的**，举例（时段表 = 周一~周五 × 早/午/晚，共 15 格）：

- 周一晚 → 周二早：下标差 **1**（现实现视为"最近"）
- 周一晚 → 周一午：下标差 **1**（V1 也是最近，cost 10）  
  两者现在打平，但按 V1 应该是 **周一午（10）优先于 周二早（30）**。  
  → 跨天的相邻时段会被误当成"同一天邻近"，**排序结果会不一样**。

### 2.5 并发保护达不到 V1 第 13 节的要求

V1 点名：「必须 `BEGIN TRANSACTION` → `LOCK schedule_slot` → `SELECT count` → `IF count < capacity` → `UPDATE` → `INSERT log` → `COMMIT`，  
这样才能保证 **capacity=3 时 APPROVED 永远不会出现 4 首**」。

现状：`applyChange()` 是 `submit.update(patch, {transaction})` —— **无条件 UPDATE，没有行锁、没有乐观锁**；  
`reschedule/initialAllocate` 的 `counters` / `free` 是**内存快照**。  
单进程定时器下几乎撞不上，但**管理端手动触发 + 定时器重叠时理论可超卖**。  
→ 需要补一条「带条件的 UPDATE」（`WHERE id=? AND schedule_status=?` 之类）或 `SELECT ... FOR UPDATE`。

### 2.6 三维状态存的是数字，V1 要求字符串

V1：`review_status VARCHAR(30) / schedule_status VARCHAR(30) / play_status VARCHAR(30)`，值就是 `PENDING` / `WAITING` 这样的**字符串**。  
现状：三列都是 **`TINYINT`**（0/1/2/3），常量名一致但**落库是数字**；`status` 派生镜像也是 `INTEGER`。

**这条要陛下定**：改存字符串 = 要改列类型 + 全量数据迁移 + 所有查询条件（`reviewStatus: 1` → `'APPROVED'`），  
成本不小但一劳永逸；不改 = 与规格书长期不一致，以后交接/排障要一直查对照表。

### 2.7 角色模型是 2 个，V1 是 3 个

V1：`users.role ∈ {USER, REVIEWER, SUPER_ADMIN}`，三种角色**同一张 users 表**。  
现状：学生走 `user` 表，管理员走 `admin` 表，管理员只有 `role` **0/1**（`requireSuperAdmin` 判 `role === 0`）。  
→ 语义上能对上（普通管理员 = REVIEWER，超管 = SUPER_ADMIN），但**表结构与角色枚举值不同**。  
V1 的 `username / display_name` 也没有（学生姓名在 `remark` + `nickname`）。

---

## 三、实现方式不同但语义等价（有意偏离，需陛下确认或保留）

| #    | 项                    | V1                                                                                                                                                                                | 现状                                                                                                          | 说明                                                                                                    |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 3.1  | 时段与容量                | **建 `schedule_slots` 表**，每格独立 `capacity`（例：周一 12:00-13:00 capacity=3）                                                                                                             | **不建表**，格子由 `broadcastSlotService` 从 KV 派生，时段值字符串（`2026-09-28 午间 12:20`）即身份；**容量是全局 KV，不按格拆**               | 之前**有意**这么做（避免"配置表 + 派生态"两本账）。但 V1 的「配置容量」是逐格的，且超管权限项里有，**这次需要重新裁决**                                  |
| 3.2  | 申请挂周                 | `song_requests.weekly_schedule_id` FK                                                                                                                                             | **没有这一列**，靠 `weekStartOfValue(scheduledSlot)` 从时段值反推                                                        | 语义等价（时段值里带日期）；但少一次 join，也少一层约束                                                                        |
| 3.3  | 时段引用                 | `requested_slot_id` / `assigned_slot_id` → FK `schedule_slots.id`                                                                                                                 | `want_broadcast_time` / `scheduled_slot` 字符串                                                                | 同 3.1 的连带结果                                                                                           |
| 3.4  | 周创建                  | 超管手动「创建周排期」                                                                                                                                                                       | `ensureWeek()` **懒创建**（谁先访问谁建）                                                                              | 少一步人工，但周不落在超管手里                                                                                       |
| 3.5  | 提交前置校验               | 校验 `weeklySchedule = APPLICATION` 且 `now ∈ [application_start_at, application_end_at)`                                                                                            | 校验 **KV 点歌窗口**（`songWindow.assertOpen()`，周六18:00→周日18:00）                                                   | 语义等价，数据源不同。V1 没提的 **「每人每周 2 次」「同曲一周去重」是陛下要求保留的旧规则**，现状保留 ✅                                            |
| 3.6  | 状态日志结构               | 三维各一对列：`from_review_status/to_...` + `from_schedule_status/to_...` + `from_play_status/to_...`（6 列）                                                                               | `dimension` + `from_status` + `to_status`（3 列，一次变更一行）                                                       | 行为等价，查询写法不同。V1 的 6 列写法一行记一次完整快照                                                                       |
| 3.7  | `assignment_type` 取值 | `ORIGINAL` / `RESCHEDULED` / `MANUAL` / `WAITING`                                                                                                                                 | `INITIAL` / `RESCHEDULED` / `MANUAL` / `PROMOTED` / `RELEASED`                                              | **两边各有对方没有的值**：V1 的 `WAITING` 我没记；我的 `PROMOTED`（原位递补）`RELEASED`（释放位子）V1 没定义。**建议统一成 V1 的四个 + 保留补充说明** |
| 3.8  | 撤销/放弃候补              | `review_status` 只有 PENDING/APPROVED/REJECTED，**没有 CANCELLED**                                                                                                                     | 我多加了 `CANCELLED`（学生撤销、放弃候补 → 改状态不删行）                                                                        | **V1 里"学生放弃候补"没有表达方式**。要么保留 CANCELLED（我倾向），要么按 V1 硬删行                                                 |
| 3.9  | 命名                   | `users` / `weekly_schedules` / `schedule_slots` / `song_requests` / `request_status_logs` / `assignment_logs`；API `/api/v1/song-requests`、`/api/v1/admin/scheduling/{id}/initial` | `user` / `weekly_schedule` / `submit` / `request_status_log` / `assignment_log`；API `/api/admin/submit/...` | 纯命名。**现有表已被小程序/后台/老数据大量引用，改名代价高**，建议只在文档里做映射表                                                         |
| 3.10 | 字段名（语义相同）            | `submitted_at` / `message` / `reviewed_at`                                                                                                                                        | `create_time` / `wish_content` / `review_time`                                                              | 同上                                                                                                    |
| 3.11 | 字段长度                 | `reject_reason VARCHAR(500)`、`assignment_logs.reason VARCHAR(500)`                                                                                                                | `STRING(255)` / `STRING(64)`                                                                                | ⚠️ **建议放宽**：驳回原因和调度原因 64 字很容易截断                                                                       |
| 3.12 | `created_by`         | `NOT NULL`                                                                                                                                                                        | `allowNull: true`                                                                                           | 懒创建时为 null（见 3.4）                                                                                     |

---

## 四、我实现里多出来的（V1 未定义）

- `review_status = CANCELLED`（见 3.8）
- `assignment_type = PROMOTED` / `RELEASED`（见 3.7）
- `weekly_schedule.locked_at`（记录"实际锁定时刻"，手动提前锁时会与 `schedule_lock_at` 不同）—— 纯增强，建议保留
- `submit.status` 派生镜像列（0~7 单值，给还没改造的前端过渡用）—— 临时列，前端改造完可删

---

## 五、建议的动手顺序

按「先堵洞、再对表、最后改数据」排：

1. **P0｜权限锁死**（纯改 `src/routes/admin.js` 的中间件，不动算法，半小时）  
   6 个越权接口换成 `requireSuperAdmin`；`played`/`revoke` 一并收上去。  
   同步补前端：普通管理员登录时这 6 个按钮不渲染。
2. **P0｜锁定守卫**：`approve`/`reject`/`assign`/`played`/`runSchedule` 开头加  
   「本周已 LOCKED → 40001 拒绝」，与 V1 第 11 节对齐。
3. **P1｜模拟排期 `preview`**：把 `initialAllocate + reschedule` 抽成"纯计算"模式  
   （`dryRun: true` 不写库），返回 V1 那份 JSON 结构。这个对陛下自己验证算法很有用。
4. **P1｜调剂成本表**：把选址从「下标距离」换成 V1 的 cost（10/20/30/50/∞），  
   独立成 `RescheduleCostCalculator`（V1 也建议单独抽，方便以后改规则）。
5. **P1｜并发保护**：`applyChange` 改成带条件的 UPDATE，排期落座改成  
   「条件 UPDATE 影响行数 = 1 才算抢到」。
6. **P2｜数据模型对齐**（要陛下先定）：三维状态数字 → 字符串？建不建 `schedule_slots`？  
   容量逐格还是全局？这三条定了才好动，动起来涉及迁移 + 前端。
7. **P2｜命名与字段长度**：`reason` 放宽到 500；文档里加一张表名/字段名映射表（不改表名）。

---

## 六、一句话总结

**算法是对的，权限是漏的。**  
V1 这份规格相比上一版协议，真正的增量就是「**权限锁死 + 预览排期 + 成本模型**」三件事，  
其中权限那件我一行都没做（因为上一版协议里压根没写权限），  
另外两件算法侧也缺。其余都是命名、存储形态、表结构的差异，不影响现在跑的结果。

---

## 七、2026-09-25 补充：算法侧还有一处真 bug（不在原表内）

陛下指出「**你没有保证每个时段原先申请的用户的排期，其他格子一满就直接往其他空位排**」——
对照代码确认成立：

- `reschedule()` 原来是「只要 `allow_reschedule = 1` 且周内有空位就能去」，
  **不看这个人首选的那一格是不是还有原申请者没审完**；
- 而它挂在「每次审核通过 / 驳回」之后（`runWeekSchedule`），也挂在每分钟的 `sweep()` 上 ——
  等于**审核还没结束就在跨时段调剂**。

后果：收歌窗口内，某人首选格满了 → 被排到别格 → 等他首选那一格的原申请者
（提交更早、还在待审）审完，位子已经被外时段的人占了；而且被挪走的人已是 `APPROVED`，
回不到首选格。

**已修**：`reschedule()` 加 `crossSlot` 闸门（收歌截止前只做原位递补），
并把选址从「下标距离」换成成本表。细节见 `docs/song-protocol.md` §3.1 / §3.2。

