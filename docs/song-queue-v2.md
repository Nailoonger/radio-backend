# 点歌审核规则 v2 · 排期容量池 + 全局候补队列 + 点歌时间窗口

> 状态：**规则已定稿（2026-09-20 23:00，v2.4），业务代码待开工**
> 取代：`docs/song-quota.md` 的「日 / 周名额」口径（该文保留为历史记录，不删）
> 波及：`src/services/songQuotaService.js`（退役）、🆕 `src/services/songQueueService.js`、🆕 `src/services/songWindowService.js`、`broadcastSlotService.js`、`controllers/admin/submitController.js`、`controllers/user/submitController.js`、`models/submit.js`、`routes/admin.js`（窗口配置：仅超管路由）、`app.js`（挂调度器）、管理端 `SongSettings.vue` + 排期矩阵屏 + 小程序点歌页/我的投稿页

## 修订记录

| 版本 | 变更 |
|---|---|
| v2.0 | 初稿：每格正式位 + 每格缓存容器，递补要求已审 |
| v2.1 | 候补**全局化**（跨所有时段一条队列）；递补**不要求先审**（补位后再审，不通过继续递补）；新增候补态通知卡 |
| v2.2 | 候补上限 = 自动等于下周正式位总数；**周日 18:00 定为审核截止**；**全格满额瞬间清空候补队列**；卡片暂不加「换时段重投」 |
| **v2.3** | 新增**点歌时间窗口**：学生只能在开放时间内点歌（默认周六 18:00 → 周日 18:00），超时提交返回 🆕 `40907 不在点歌时间段`；窗口时间**常驻展示在点歌模块**。修正 v2.2 文稿中的错误码笔误（`SLOT_FULL` 实为 **40906**） |
| **v2.4** | 窗口修改权限**钉死为仅超管**（`requireSuperAdmin`），普通管理员只读；推翻 v2.3 中途那版「管理员可改」的说法 |

---

## 0. 一句话

把「**审核那一天能过几条**（日/周名额）」换成「**下一周排期表上有几个格子**」：

- 每格 = **正式位**（该时段能排几首）；**候补 = 一条全局队列**，不绑时段
- **提交即占位**，审核只做内容把关，不再改变容量
- 任一格子空出来 → 候补队列按**先进先出**自动补位；补位后再审，审不过就**继续往下递补**
- **收歌有窗口**：只有开放时间内能提交（默认**周六 18:00 → 周日 18:00**，**仅超管可改**），窗口外一律拒绝；窗口时间**常驻展示在点歌模块**
- **两条关闭线**：① 所有格子满额的那一刻 → 候补队列全部自动驳回 ② **窗口结束＝审核截止＝周日 18:00** → 仍未补位（3）或仍未审完（4）的全部自动驳回，排期定稿
- 队列耗尽时格子空着就空着，不做任何多余动作
- 学生一旦进候补，立刻拿到**候补态通知卡**，位次与结果实时可见

---

## 1. 现状错在哪

| # | 问题 | 后果 |
|---|---|---|
| 1 | **口径错位**：`song_quota_daily/weekly` 计的是「审核动作发生的那一天/那一周」能通过几条 | 学生投稿锁的是「下周一到周五」，管理员却集中周末审：周六审 3 条就满、周日一条都过不了；真正该限制的「下周每个时段能排几首」反而没地方设 |
| 2 | **满额即硬失败** | 名额满 → 管理员点通过直接报错；时段满 → 学生提交当场被系统驳回。没有缓冲区 |
| 3 | **没有候补** | 撤销 / 驳回 / 删除释放的位子无人承接，先到先得，学生也不知道「还有没有希望」 |
| 4 | 独立计数器（`song_quota` 表）+ 手工 `release()` | 驳回已通过件不还名额、批量驳回不过滤状态、通过已驳回件假成功 —— 全因「两本账」 |
| 5 | **没有收歌时间概念** | 学生随时可投，投稿散落在整周，管理员无从判断「什么时候该定稿」 |

**v2 根治：不再有独立计数器。** 占位就是提交行本身。没有第二本账，就没有对不上的可能。

---

## 2. 新模型

### 2.1 结构

```
【收歌窗口】默认 周六 18:00 → 周日 18:00（**仅超管可配**，KV `song_submit_window`）
  ├─ 窗口外提交点歌 → 40907「不在点歌时间段」，不落库
  ├─ 窗口时间常驻展示在点歌模块（点歌页 / 时段弹层 / 提交提示 / 管理端设置面板）
  └─ 窗口结束时刻 ＝ 审核截止时刻（默认同一个点，对齐）

下一周排期池（5 天 × N 时段 = 5N 个格子，只看 scheduled_slot）

每格【正式位】capacity（每格可排几首，默认 1）
  ├─ status=0 待审            ← 提交时直接有位，此刻已占位
  ├─ status=4 已补位 · 待审   ← 候补递补上来的，已占位但还没审
  └─ status=1 已排期          ← 审核通过
     驳回 / 删除 → status=2，位子立即释放 → 触发递补
     撤销 → status=0，同样释放 → 触发递补

【全局候补队列】status=3（一条队列，跨所有时段，与格子无关）
  ├─ 排序：queue_at ASC, id ASC（先进先出）
  ├─ 上限：song_queue_limit（默认 0 = 自动 = 下周正式位总数）
  └─ 任一格子出现空位 → 队首自动补位
       · 该行尚未审核 → status=4（已补位 · 待审）
       · 该行审核已通过 → status=1（直接排期）
       · 补位后被驳回 → status=2，位子再次释放 → 继续从队首递补

── 两条关闭线 ────────────────────────────────
① 满额关闭：所有格子 seated == capacity 的那一瞬间
   → status=3 全部自动驳回（「下周排期已满额，未能补位」）
   → 之后若再有人被驳回释放位子：队列已空，位子空着（不做多余动作）

② 定稿关闭：窗口结束时刻（默认播出周开始前的周日 18:00）
   → status=3 全部自动驳回（「已过审核截止时间，未补位」）
   → status=4 全部自动驳回（「已过审核截止时间，未完成审核」）
   → status=0 故意不在此刻清（管理员可能还在审）；跨周残留的 0 会在
     下一次定稿时按「播出周已结束」清掉，不会永久堆积
─────────────────────────────────────────────
```

### 2.2 时间轴（以「下周 9/21~9/25」为例）

| 时刻 | 发生什么 |
|---|---|
| 周一 00:00 ~ 周六 18:00 | **收歌窗口关闭**：提交点歌直接 40907；管理员可继续审已收的稿 |
| 周六 18:00（9/19） | **窗口打开**，学生开始投「下周 9/21~9/25」的稿，占位或进候补 |
| 周日 18:00（9/20） | **窗口关闭 + 审核截止**：候补未补位 + 补位未审 → 全部自动驳回；排期定稿 |
| 周一 00:00（9/21） | 播出周开始；学生再投就是「下下周」（严格下一周，周一也跳下周一） |
| 播出周内 | 管理员仍可审核 status=0，驳回已排期件会释放位子（队列已空则空着） |

### 2.3 新旧口径对照

| | 旧（v1） | 新（v2.3） |
|---|---|---|
| 上限载体 | KV `song_quota_daily` / `song_quota_weekly` | 每格 `capacity` + 全局候补 `song_queue_limit` |
| 计数口径 | 「审核动作发生在哪天/哪周」 | 「这条点歌排到了哪个格子」 |
| 计数器 | `song_quota` 表（两本账） | 无 —— 直接数 submit 行 |
| 占位时机 | 管理员点通过时 | **学生提交时**（候补补位时） |
| 满了怎么办 | 硬失败 / 系统自动驳回 | 进全局候补队列，有空位按 FIFO 自动补位 |
| 候补与时段 | 无 | **跨全部时段**：有空位就补，不绑首选 |
| 递补是否需先审 | — | **不要求**：补位后再审，审不过继续递补 |
| 收歌时间 | **无限制，随时可投** | **窗口制**：默认周六 18:00 → 周日 18:00，超时 40907 |
| 关闭线 | 无 | 满额即清队 + **窗口结束＝审核截止** |
| 日名额 | 有（审核产能） | **取消** |
| 每人每周次数 / 同曲去重 | 保留 | 保留（候补算占用） |

---

## 3. 状态机

### 3.1 状态定义

| status | 名称 | 学生侧文案 | 占正式位 | 占候补位 |
|---|---|---|---|---|
| 0 | 待审 | 待审核 | ✅ | — |
| 1 | 已排期 | 已排期 | ✅ | — |
| 2 | 已驳回 | 已驳回（含系统驳回） | — | — |
| 3 | 候补中 | 候补中 · 第 N 位 | — | ✅ |
| **4** | **已补位 · 待审** | 已补位 · 待审核 | ✅ | — |

> `auto_rejected=1` 区分「系统驳的」和「人驳的」；系统驳回理由四类：满额未补位 / 逾期未补位 / 逾期未审完 / 播出周已结束。
> **窗口外提交不落库**，所以不会产生任何记录，也就没有对应的 status。

### 3.2 转移表

| 动作 | 执行者 | 前置 | 结果 | 副作用 |
|---|---|---|---|---|
| 提交点歌 | 学生 | **不在点歌窗口** | **拒绝落库** | **40907**（不产生记录） |
| 提交点歌 | 学生 | 窗口内 + 目标格子正式位有空 | → 0（写 `scheduled_slot`） | 占位；若此刻全满 → 清队 |
| 提交点歌 | 学生 | 窗口内 + 格子满 + 候补未满 | → **3**（写 `queue_at`） | 入队，返回候补卡 + 位次 |
| 提交点歌 | 学生 | 窗口内 + 格子满 + 候补满 | 拒绝落库 | 40904 |
| 通过 | 管理员 | status ∈ {0,4} | → 1 | 若此刻全满 → 清队 |
| 通过 | 管理员 | status=3 | 保持 3，写 `review_time` | 取得「补位即直接排期」资格 |
| 驳回 | 管理员 | status ∈ {0,1,4} | → 2 | **释放正式位 → 触发全局递补** |
| 驳回 | 管理员 | status=3 | → 2 | 出队，后续位次前移 |
| 撤销 | 管理员 | status ∈ {1,2} | → 0 | 原为 1 时释放位子 → 触发递补 |
| 删除 | 管理员 | 任意 | 行删除 | 原为 0/1/4 时释放位子 → 触发递补 |
| 学生撤销 / 放弃候补 | 学生 | status ∈ {0,3} | 行删除 | 原为 0 时释放位子 → 触发递补 |
| **自动递补** | 系统 | 有空格子 + 队列非空 | 队首 → 4 或 1 | 写 `scheduled_slot` / `promoted_at`，通知卡切换 |
| **满额关闭** | 系统 | 全格子 seated == capacity | 3 → 2（auto_rejected=1） | 队列清空 |
| **定稿关闭** | 系统 | 到窗口结束时刻 | 3 → 2、4 → 2（auto_rejected=1） | 队列清空，排期定稿 |
| 跨周兜底 | 系统 | 播出周已结束仍有残留 0 | → 2，`auto_rejected=1` | 下一个定稿点顺带清 |

**窗口只管「提交」，不管审核**：窗口关闭期间管理员照常审核、驳回、递补、撤销。

---

## 4. 数据与配置

### 4.1 submit 表新增字段（DDL 见 §9）

| 字段 | 说明 |
|---|---|
| `scheduled_slot` VARCHAR(64) NULL | **实际排期时段**。提交时直接有位 → 写入所选时段；候补补位 → 写入实际排到的时段（**可能与学生首选不同**）；候补中 → 空 |
| `queue_at` DATETIME NULL | 进入候补的时刻（FIFO 主键，同刻用 `id` 兜底） |
| `promoted_at` DATETIME NULL | 递补为占位状态的时刻（复盘用） |

**占位口径统一为** `status ∈ {0,1,4} AND scheduled_slot = ?`。`want_broadcast_time` 保留为「学生首选」，是意愿数据，**永不被覆盖**。

索引：`idx_sched_status (scheduled_slot, status)`、`idx_queue (status, queue_at, id)`。
候补位次不落库：`位次 = COUNT(status=3 AND (queue_at,id) <= 本行) + 1`，实时算。

### 4.2 KV 配置

| key | 含义 | 默认 | 变更 |
|---|---|---|---|
| `song_slot_times` | 每日播出时段（JSON） | — | 不变 |
| `song_slot_capacity` | **每格正式位**（0=不限） | 1 | 保留，语义明确为「每格正式位」 |
| `song_queue_limit` | **全局候补人数上限**（0 或空 = 自动 = 下周正式位总数） | 0（自动） | 🆕 新增 |
| **`song_submit_window`** | **点歌时间窗口**（JSON） | `{enabled:1, startDay:6, startTime:'18:00', endDay:0, endTime:'18:00'}` | 🆕 新增，**仅超管可改**（`requireSuperAdmin`；普通管理员只读） |
| `song_finalize_gate` | 定稿闸门：各播出周是否已定稿（JSON，防重复执行） | 空 | 🆕 内部用 |
| `song_quota_daily` / `song_quota_weekly` | 日/周名额 | — | ⛔ **废弃** |
| `song_weekly_user_limit` | 每人每周点歌次数 | 2 | 不变 |
| `song_dup_block` | 同曲一周去重 | 1 | 不变 |

**窗口字段口径**：`startDay` / `endDay` 用 `0=周日 … 6=周六`（与 `bj.WEEKDAY_CN` 一致）；时刻 `HH:mm`。
`enabled = 0` → 不限时间（回到现状行为）。**定稿时刻 = 窗口结束时刻**，不再单独配置（少一个会打架的开关）。

### 4.3 退役清单 / 错误码

- `song_quota` 表：停止写入，迁移时 `TRUNCATE`（留表一个版本，v2.4 再 DROP）；`songQuotaService.js` 顶部标 `@deprecated`
- `submitController.approveOne` 的「占名额 + 时段容量校验」整段删除
- 管理端「点歌名额」面板 → 「**排期容量与候补**」面板（每格正式位 / 下周总量 / 候补队列 / 定稿倒计时）
- 错误码（`src/utils/response.js` 现状：`40902 QUOTA_EXHAUSTED` / `40903 SUBMIT_REJECTED` / **`40906 SLOT_FULL`**）：
  - ⛔ `40902 QUOTA_EXHAUSTED` 退役
  - ✅ `40906 SLOT_FULL` 保留（单格满）
  - 🆕 **`40904 SLOT_AND_QUEUE_FULL`**（正式位 + 候补都满）
  - 🆕 **`40907 SONG_WINDOW_CLOSED`**（不在点歌时间段）
  - `40905` 留空不用，避免与外部既有对接混淆

---

## 5. 接口变更

### 5.1 学生端

| 接口 | 变更 |
|---|---|
| `GET /user/submit/window` | 🆕 窗口状态：`{ enabled, open, start, end, nextOpen, text, serverNow }`（投稿页倒计时 + 未开放时禁用按钮） |
| `GET /user/submit/timeslots` | 每格返回 `capacity / seated / left / full`（按 `scheduled_slot` 统计）；顶层返回 `queue: { used, limit, full }`、`finalizeAt`、`window`（同 §5.1 第一行结构） |
| `POST /user/submit` | 窗口外 → **40907**「现在不在点歌时间段」；响应 `outcome: 'seated' \| 'queued' \| 'rejected'`；`queued` 附候补态通知卡（§7） |
| `GET /user/submit/my` | status=3 附 `queuePos / aheadCount / queueHint`；返回 `cards[]` 供顶部通知卡渲染 |
| `POST /user/submit/:id/leave-queue` | 🆕 放弃候补（status=3）：行删除 → 触发递补 |

### 5.2 管理端

| 接口 | 变更 |
|---|---|
| `GET /admin/submit/schedule` | 每格 `seated / left / capacity`；顶层 `queue: { total, limit, full, headWaitMinutes, items[] }`、`finalizeAt`、`finalized`、`window` |
| `GET /admin/submit/window` | 🆕 读窗口配置 + 状态（普通管理员可读，用于展示） |
| `PUT /admin/submit/window` | 🆕 改窗口配置 —— **仅超级管理员**（`requireSuperAdmin`）；普通管理员调用返回 40301 |
| `PUT /admin/submit/slots` | body 增加 `queueLimit`；返回带 `capacity / queueLimit / weekCapacity` |
| `PUT /admin/submit/:id/approve` | 删除名额/容量校验。status=3 时只写 `review_time`；status ∈ {0,4} → 1 |
| `PUT /admin/submit/:id/reject` | 状态校验（已驳回不许重复驳）；原为 0/1/4 时释放位子并**触发递补**；原为 3 时出队 |
| `POST /admin/submit/batch` | 驳回必须带状态过滤；通过逐条走同一路径；返回 `promoted` |
| `PUT /admin/submit/:id/revoke` | 原为 1 时释放位子并触发递补 |
| `POST /admin/submit/queue/sweep` | 🆕 手动触发「递补 + 满额清队 + 定稿清理」（幂等兜底） |
| `GET /admin/submit/capacity` | 🆕 取代 `/submit/quota`：下周总容量、已占、剩余、候补队列快照、定稿时刻 |
| `DELETE /admin/submit/songs` | 照旧（超管 + confirm），候补队列一并清空 |

---

## 6. 关键算法

### 6.1 提交落座（用户端 `type=1`）

```
① 模块开关 assertEnabled('submit_song')
② 点歌时间窗口：不在窗口内 → 抛 40907（放在最前，fail fast，不浪费后续查询和微信接口）
③ 注意事项已确认（assertAcked）
④ 时段必须是系统下发的（isValidSlot）
⑤ 同曲一周去重 + 每人每周次数
⑥ 字段校验 → 防重复提交（1 分钟）→ 微信内容安全
⑦ 落座（事务内）：
     seated = COUNT(status IN (0,1,4) AND scheduled_slot = ?)
     queued = COUNT(status = 3)
     limit  = queueLimit > 0 ? queueLimit : weekCapacity
     if (capacity == 0 || seated < capacity) → status=0, scheduled_slot=slot
     else if (queued < limit)                → status=3, queue_at=NOW()
     else                                    → 抛 40904
⑧ 事务提交后：closeQueueIfFull()
```

### 6.2 审核

```
approve(id):
  status == 1 → 幂等返回「已排期」
  status == 2 → 40001「已驳回，请先撤销再通过」（不再假成功）
  status ∈ {0,4} → 1，提交后 closeQueueIfFull()
  status == 3 → 只写 reviewer/review_time（留队；补位时直接进 1）

reject(id, reason):          // reason 必填
  status == 2 → 40001「已驳回，无需重复操作」
  wasSeated = status IN (0,1,4)
  status=2, auto_rejected=0, 写 reviewer/review_time/reject_reason
  if (wasSeated) promote()   // 释放位子 → 立刻全局递补
```

### 6.3 全局递补 `promote()`

```
在事务内：
  loop:
    // ① 找空位：按周内时间顺序取第一个未满的格子
    slot = 第一个满足 COUNT(status IN (0,1,4) AND scheduled_slot = slot) < capacity 的时段
    if (!slot) { closeQueueIfFull(); break }   // 全满 → 清队（见 6.4）

    // ② 取队首（先进先出）
    head = SELECT * FROM submit WHERE status = 3 ORDER BY queue_at ASC, id ASC LIMIT 1 FOR UPDATE
    if (!head) break                           // 队列耗尽 → 停，格子空着（不做多余动作）

    // ③ 目标时段：首选时段仍空则优先放首选（人还是他，不违反 FIFO），否则填当前空位
    target = (seatedOf(head.want_broadcast_time) < capacity) ? head.want_broadcast_time : slot

    // ④ 补位（条件更新，幂等）
    UPDATE submit SET status = head.review_time ? 1 : 4,
                      scheduled_slot = target, promoted_at = NOW()
     WHERE id = head.id AND status = 3

    // ⑤ 通知卡切换为「已补位」；target ≠ 首选时在卡片文案里说明
  // 循环结束再跑一次 closeQueueIfFull() 兜底
```
- 幂等：空位校验 + `WHERE status = 3`，重复跑只会少做事
- 触发点：**任何使「占位行数」减少的动作**之后都调一次（驳回 / 撤销 / 删除 / 学生撤销 / 放弃候补）
- ⚠️ **必须 `await`，不要 `setImmediate`「着火即忘」**：位子已经释放了，若递补在响应之后才跑，
  ① 接口回「位子已释放，已递补」，管理员刷新却还是空的；② 会和下一位学生的 `decideSeat`
  抢同一条记录，出现「明明满了还让人进候补」这种不可复现的怪象。
  递补内部自己吞异常（失败只记日志、下次 sweep 重试），所以 `await` 不会把审核动作本身搞失败。

### 6.4 满额关闭 `closeQueueIfFull()`（幂等，事件驱动）

```
weekCapacity = 5 天 × 时段数 × capacity        // capacity = 0（不限）时永不触发
if (capacity > 0 && COUNT(status IN (0,1,4)) >= weekCapacity) {
  UPDATE submit SET status=2, auto_rejected=1, review_time=NOW(),
                    reject_reason='下周排期已满额，未能补位'
   WHERE status = 3
}
```
**注记**：清队后若管理员又驳回一条已排期件释放位子，队列已空 → 位子空着（按「不做多余动作」）。
想改成「满额只冻结队列」的话，删掉这段 UPDATE 即可，两行的事。

### 6.5 定稿关闭 + 跨周兜底（调度器）

**项目没有任何调度器**（全仓 grep 无 cron / setInterval），方案：进程内轻量定时器。

```
新建 src/services/songQueueService.js → startScheduler()
app.js 的 start() 里在 app.listen 之后调用

每 60 秒 tick 一次（启动时先立即跑一次）：
  对每个「存在点歌数据的播出周」w：
    cutoff = 窗口结束时刻（默认 w 开始前的周日 18:00，北京时间）
    ended  = now >= w 的周一 00:00 + 5 天（= 周六 00:00，周一到周五播完即算「播出周已结束」）
    if (now >= cutoff && gate 未记录 w) 或 ended：
        ① 清 w 的候选与补位未审：
             UPDATE submit SET status=2, auto_rejected=1, review_time=NOW(),
                    reject_reason='已过审核截止时间，未补位'
              WHERE type=1 AND status=3 AND 属于 w
             UPDATE submit SET status=2, auto_rejected=1, review_time=NOW(),
                    reject_reason='已过审核截止时间，未完成审核'
              WHERE type=1 AND status=4 AND 属于 w
        ② 跨周兜底（**仅 ended 时**）：过往周残留的 status=0 → 驳回
             （'播出周已结束，未及时审核'）—— 刚落截止的目标周 0 要保留给管理员继续审
        ③ gate 记录 w → 不再重复执行
```
> ⚠️ 「播出周已结束」的判据是 **w 的周一 + 5 天（周六 00:00）**，不是「下周一」。
> 用 `+7 天` 会把这批残留多留一整周，学生端会一直看到一条永远播不出的待审。
> 另外 `ended` 分支里 3/4 也一并清 —— 万一 gate 丢失，陈旧周也不会留活口。


兜底：管理端 POST /admin/submit/queue/sweep 手动触发同一套逻辑（幂等）
```
- 失败只记日志，下个 tick 重试；定时器绝不阻塞请求
- 重启即 tick，gate 防重复；即便 gate 丢失，条件里带 `status = 3/4`，已驳回的行不会被二次改动
- **「属于 w」的判定**：`scheduled_slot` 落在 w 的日期区间；候补（`scheduled_slot` 为空）用 `want_broadcast_time` 判定

### 6.6 点歌时间窗口（🆕）

**配置**：`song_submit_window = { enabled, startDay(0=日…6=六), startTime, endDay, endTime }`，默认 `{1, 6, '18:00', 0, '18:00'}`。

**计算口径**（全部走 `bjTime`，不碰进程 TZ）：

```
weekStart = nextWeekRange(now).start          // 目标播出周的周一 00:00（与提交锁定的周一致）
targetDow = 1                                  // 周一
offBack(day) = (targetDow - day + 7) % 7       // 周日→1，周六→2
windowStart = weekStart - offBack(startDay) 天 + startTime
windowEnd   = weekStart - offBack(endDay)   天 + endTime
open = (now >= windowStart && now < windowEnd)
nextOpen = open ? null : windowStart + 7 天   // 过了就等下周同一时刻
```
**为什么能这么锚**：学生的目标周永远是「严格下一周」，而窗口（周五/周六/周日）在周日 24:00 之前结束 ——
所以「周六、周日」任意时刻算出的 `nextWeekRange` 指向的都是同一个目标周，窗口与目标周一一对应。

**配置校验（PUT 时）**：
1. `startTime/endTime` 必须是 `HH:mm`；`startDay/endDay` 必须 0~6
2. 窗口总长度 > 0 且 ≤ 72 小时
3. **`endDay` 必须 ∈ {0(周日), 6(周六)}**，`startDay` 必须 ∈ {5(周五), 6(周六), 0(周日)} —— 否则窗口会跨到周中，学生投的周会跳变（周一投 → 跳下下周）
4. `windowEnd` 不得晚于「目标周周一 00:00」（默认 18:00 早于 00:00 ✓）
5. 返回给管理端一句提醒文案：「窗口结束 = 审核截止，管理员需在此之前审完」

**缓存**：窗口读取加 30s 读缓存（与 `broadcastSlotService` 同风格），`PUT` 写入口主动清缓存。
**错误响应**（40907）：
```json
{ "code": 40907, "message": "现在不在点歌时间段",
  "data": { "opensAt": "2026-09-26T18:00:00+08:00", "windowText": "每周六 18:00 – 周日 18:00" } }
```
**点歌时间必须常驻展示在点歌模块**（用户 2026-09-20 明确要求「在点歌模块展示」）：

| 位置 | 展示内容 |
|---|---|
| 点歌页顶部状态条（常驻，不可折叠） | 「点歌时间：每周六 18:00 – 周日 18:00」+ 实时状态：开放中「距截止 2 小时 15 分」／未开放「距开放 3 小时」 |
| 提交按钮区 | 未开放时按钮禁用 + 灰字「现在不在点歌时间段」 |
| 时段选择弹层顶部 | 同样带一行窗口时间（学生选到一半也知道截止点） |
| 提交成功提示 | 附一句「本次收歌截止 周日 18:00」 |
| 我的投稿 / 候补卡 | 候补卡底部弱化显示窗口截止时间 |
| 管理端 · 点歌设置面板 | 顶部显示当前窗口配置 + 「本周窗口：9/19 18:00 – 9/20 18:00」+ 距截止倒计时。**普通管理员只读**（能看不能改），编辑入口仅超管可见 |

**文案一律由服务端下发**（`GET /user/submit/window` 的 `windowText` / `opensAt` / `closesAt` / `serverNow`），前端不硬编码星期与时刻 —— 管理员一改配置，学生端立刻跟着变。

- 未开放时服务端仍然硬拦（不信前端）
- 文稿投稿**不受窗口限制**（窗口只作用于点歌；要连文稿一起限，改一行判断）

---

## 7. 候补态通知卡（学生端）

### 7.1 三种形态

| 形态 | 触发 | 卡片内容 | 操作 |
|---|---|---|---|
| **候补中** | 提交成功进 status=3 | 「已进入候补队列 · 第 2 位（前面 1 人）」「下周任意时段有空位时按提交先后自动补位，**实际排到的时段可能与你首选不同**」「排队 2 / 上限 15」 | 「放弃候补」（仅此一个） |
| **已补位** | 递补为 status=4 或 1 | 「已自动补位：**周五 午间 12:20**（你首选的是周三 午间）」「审核通过后即安排播出」 | — |
| **未补上** | 四类系统驳回之一 | 「下周排期已满额」「已过周日 18:00 截止时间」「播出周已结束」 | — |

### 7.2 接口形态

```
POST /user/submit →
{ outcome: "queued",
  card: { type: "queue", status: "waiting",
          queuePos: 2, aheadCount: 1, queueUsed: 3, queueLimit: 15,
          preferred: "2026-09-23 午间 12:20",
          finalizeAt: "2026-09-20T18:00:00+08:00",
          hint: "下周任意时段有空位时按顺序自动补位，实际时段可能与你首选不同",
          actions: [{ key: "leave", label: "放弃候补" }] } }

窗口外 → 40907，无记录、无卡片，前端展示开放时间说明
GET /user/submit/my → 每条投稿带 card + 顶层 cards[] 汇总
```
管理端候补面板复用同一结构（多带姓名 / 学号 / 是否已审 / 排队时长）。

### 7.3 界面交付方式

按既有约定：**小程序候补卡 + 窗口状态条 + 管理端候补面板与窗口设置区，先出静态 HTML 预览（`preview/song-queue-v1/`，标版本号），你点头后再写小程序与 Vue 代码。** 后端接口与状态机可先落地。

---

## 8. 与其他规则的交互

| 规则 | 关系 |
|---|---|
| 点歌时间窗口 | **只管提交**；不影响审核、驳回、递补、撤销；文稿不限 |
| 每人每周次数（默认 2） | 候补算占用；`auto_rejected=1` 的系统驳回不算；人工驳回算 |
| 同曲一周去重 | 占用口径 = `status ∈ {0,1,3,4}` |
| 内容安全 | 提交时 `msgSecCheck` 照旧；补位不要求先审，但 status=4 会在排期表高亮，窗口截止前必须审完 |
| 模块开关 `submit_song` | 照旧最先生效（关掉 = 整个点歌模块不可用，比窗口更彻底） |
| 文稿 `type=2` | 不进容量池、不进候补、不受窗口限制 |

---

## 9. 迁移与上线步骤（开工第一步）

```sql
ALTER TABLE `submit`
  ADD COLUMN `scheduled_slot` VARCHAR(64) DEFAULT NULL COMMENT '实际排期时段（候补补位后可能与首选不同）',
  ADD COLUMN `queue_at`       DATETIME    DEFAULT NULL COMMENT '进入候补队列时刻',
  ADD COLUMN `promoted_at`    DATETIME    DEFAULT NULL COMMENT '递补为占位状态时刻';

ALTER TABLE `submit`
  ADD KEY `idx_sched_status` (`scheduled_slot`, `status`),
  ADD KEY `idx_queue`        (`status`, `queue_at`, `id`);

UPDATE `submit` SET `scheduled_slot` = `want_broadcast_time`
 WHERE `type` = 1 AND `status` IN (0,1) AND `scheduled_slot` IS NULL;

TRUNCATE TABLE `song_quota`;
DELETE FROM `system_setting` WHERE `key` IN ('song_quota_daily','song_quota_weekly');
```
落地文件：`sql/migrations/2026-09-20-song-queue.sql`（同步进 `sql/schema.sql`，新库首启即带）。

**上线检查清单**：
1. `song_slot_capacity` 设成实际每格首数（建议 1）
2. `song_queue_limit` 留空（自动 = 下周正式位总数）
3. `song_submit_window` 确认 `{enabled:1, 周六 18:00 → 周日 18:00}`；**若不想马上限制投稿时间，先设 `enabled:0`**
4. 管理端显示「定稿倒计时」，避免错过周日 18:00

---

## 10. 验收与测试

新增 `scripts/verify-song-queue.js`（SQLite 内存库，无需 MySQL / Docker），覆盖：

1. **窗口**：周六 20:00 / 周日 10:00 可提交；周五 23:00、周一 09:00 返回 40907；`enabled=0` 时全时段可提交
2. **窗口边界**：周六 17:59 拒绝、18:00 放行；周日 17:59 放行、18:00 拒绝（左闭右开）
3. **窗口与目标周一致**：周六、周日提交锁定的都是同一个目标播出周
4. **配置校验**：`endDay=3`（周三）被拒；开始日/结束日越界被拒；时刻格式非法被拒（**注意**：允许日组合下最长窗口只有「周五 00:00 → 周日 23:59」= 71:59，所以 72 小时上限只是防日后放开日期限制的兜底，当前不可触发 —— 脚本改为断言「最长合法窗口被接受」+「上限常量 = 72h」）
5. 落座：占位满 → 进候补；候补满 → 40904
6. **全局补位**：任意格子空出 → 队首补位，跨时段成立
7. **首选优先**：首选时段仍空则补到首选，不违反 FIFO
8. **递补无前置审核**：未审候补 → status=4；已审候补 → status=1
9. **驳回后继续递补**：status=4 被驳回 → 释放 → 队首继续补位
10. **满额清队**：填满最后一个空位 → 队列全部转 2 且 `auto_rejected=1`
11. **定稿关闭**：模拟到窗口结束 → 3 与 4 全部转 2；0 保留；gate 只跑一次
12. **跨周兜底**：过往周残留 0 被清
13. FIFO 顺序与位次实时前移
14. 状态防护：重复驳回 40001、通过已驳回件 40001、通过已排期件幂等
15. 释放一致性：驳回 / 撤销 / 删除 / 放弃候补后 `COUNT(占位)` 立即 -1 且递补 1 条
16. 通知卡字段与库内一致；`queueLimit` 自动口径 = 下周正式位总数
17. 权限：`PUT /admin/submit/window` **仅超管**（普通管理员 40301，未登录 40101）；`GET` 普通管理员可读；清空点歌数据仍仅超管；审核类 requireAdmin
18. **窗口展示**：`GET /user/submit/window` 返回的 `windowText / opensAt / closesAt` 与 KV 配置一致；管理员改配置后学生端文案随之变化（无硬编码）

19. **窗口闸门接线**：窗口外调 `userSubmit.create` → 40907 且**不落库**；把窗口关掉后同一请求不再报 40907
20. **路由顺序**：管理端/用户端所有字面量段（`/submit/window`、`/submit/capacity`、`/submit/queue/sweep`…）都排在 `/submit/:id` 之前

### 实际落地与验证结果（2026-09-20）

`node scripts/verify-song-queue.js` → **101 项全过**（结果同时写入 `scripts/verify-song-queue-output.txt`）。
配套回归：`verify-song-submit.js` **107/107**、`verify-student-account.js` **151/151**；`npx jest` 失败数 26 → **15**，剩下的 15 条全部是早已删除的「风采/member」模块（40401 路由不存在），与点歌无关。

老的 `scripts/verify-song-submit.js` 里 3 条与「日/周名额计数器」绑定的断言已改写为 v2 口径（清空数据 → 实时计数归零 → 可立即重新落座），**没有**出现预计的 12~15 项大改：因为 `songQuotaService` 作为独立服务仍保留并有自己的单测，只有「清空点歌数据」那一段与 v2 冲突。
`tests/app.js` 新增 `openSongWindowForTest()`（测试里关掉窗口限制 + 本周上限调不限）与 `nextWeekSlotValues()`；`submit.test.js` / `switch.test.js` 的点歌用例补 `wantBroadcastTime`，同曲重复期望码 40901 → **40903**。

**本次实现中抓到的 4 个真 bug（都靠这脚本暴露）**：
1. `songWindowService.setConfig` 的 `endTime` 三元写成 `… ? cur.endTime : cur.endTime` —— **超管改窗口结束时间永远不生效**（静默存回 18:00）。
2. `afterRelease()` 用 `setImmediate` 着火即忘（admin 3 处 + user 2 处）→ 响应与递补结果不一致、并与后续请求抢记录。全部改 `await`。
3. `finalizeDueWeeks` 的「播出周已结束」用 `+7 天`，残留待审会多留一整周 → 改 `+5 天（周六 00:00）`。
4. 窗口文案 `每周周六` → `每周六`。

### 前端落地（2026-09-20 晚，已完成）

按用户偏好「先出静态预览再写业务代码」，预览 `preview/song-queue-v1/`（学生端窗口状态条 + 候补卡三形态）点头后落地：

| 端 | 改动 |
|---|---|
| 小程序 · 公共 | `utils/windowBar.js`（新增，窗口状态条公共逻辑：服务端下发文案 + `serverNow` 校准设备时钟 + 秒级倒计时 + 跨边界自动重拉）、`utils/format.js`（五态文案、`fmtIso` 直接取墙钟字段不经过设备时区、`fmtDur` 倒计时、`fmtSlot` 时段串、`fmtMd`）、`app.wxss`（`.win-bar` 组件 + `.tag-queued`/`.tag-promoted` + `--accent-tint`） |
| 小程序 · 投稿页 | 标题下常驻窗口状态条（两行：规则 + 此刻状态与倒计时）；未开放时按钮置灰改文案「未到点歌时间」+ 灰字提示；按钮上方提示带「收歌截止 MM-DD HH:mm」；时段弹层顶部补一行窗口时间；提交返回 `outcome='queued'` 时弹候补卡说明（位次/前面几人/上限/截止）；兜住 40907（窗口外，顺手刷新状态条）与 40904（时段+候补都满） |
| 小程序 · 我的投稿 | Hero 统计 4 格 → **6 格**（全部/待审核/候补中/已补位/已通过/已驳回，否则「全部」与各状态对不上账）；筛选 4 格 → **6 格**；列表按候补卡三形态渲染（候补中/已补位＝深色卡，未补上＝羊皮纸卡，其余＝普通行）；普通行补「播出时段/希望时段」副行；`status=3` 新增「放弃候补」→ `POST /user/submit/:id/leave-queue` |
| admin-web | `SubmitList.vue`（深色摘要块 + 6 状态筛选 + 候补位次副行 + 审核台三块「该格占位/全局候补队列/点歌时间窗口」+ 排期矩阵四种角标 + 候补列表）、`SongSettings.vue`（名额段 → 排期容量与候补；新增点歌时间窗口设置段，超管可改、普通管理员只读） |

自检（`preview/song-queue-v2/` 渲染自检 v2，非新方案）：类名扫描 submit 74 / mySubmit 70 个全部有定义、两份 wxml 标签闭合配平、**横向溢出 0**、6 格统计每格 51px、6 格筛选每格 57px、页内 JS 报错为空；逐屏截图在 `preview/song-queue-v2/shots/`。

### 待办（上线）

- 上线迁移：跑 `sql/migrations/2026-09-20-song-queue.sql`；KV 建议 `song_slot_capacity=1`、`song_queue_limit` 留空（自动）、`song_submit_window` 默认开启。
- 部署走 git → 服务器（本机 Docker 未运行，本地不构建镜像）。

---

## 11. 规则确认记录（2026-09-20 定稿）

| # | 规则 | 结论 |
|---|---|---|
| 1 | 候补上限 | **自动 = 下周正式位总数**（KV 0/空即自动；填数字则固定） |
| 2 | 递补后没人审 | **窗口结束（默认周日 18:00）截止**，候选（3）与补位未审（4）全部自动驳回 |
| 3 | 卡片操作 | 暂不加「换时段重投」，只保留「放弃候补」 |
| 4 | 满额后 | **所有格子占满 → 候补队列全部自动驳回** |
| 5 | 队列耗尽仍有空位 | 停，不做多余动作 |
| 6 | **点歌时间窗口** | **默认周六 18:00 → 周日 18:00**，窗口外提交返回 **40907**；**仅超管可修改**（最终口径，2026-09-20 23:00 再次确认；普通管理员只读）；窗口结束 = 审核截止；**点歌开始/结束时间必须常驻展示在点歌模块**（文案由服务端下发） |

---

## 12. 分期

- **v2.0（后端 + 前端均已落地 2026-09-20；仅剩服务器迁移）**：格子容量 + 全局候补队列 + 自动补位 + 两条关闭线 + 点歌时间窗口（含超管配置）+ 分钟级调度器 + 状态机修漏 + 管理端排期容量/候补/窗口面板 + 学生端候补卡与窗口状态条（后端 101 项验证全过；小程序与 admin-web 已按预览落地并做渲染自检）
- **v2.1**：小程序订阅消息推送（补位成功 / 窗口开放提醒）、按天或按格单独设容量（`song_slot_overrides`）、`song_quota` 表 DROP
- **不做**：管理员手动指定某人插队（需要时用手动 sweep 兜底）
