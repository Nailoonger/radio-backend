# 阶段 5 方案 · 点歌排期算法移植

> ## ✅ 实施完成（2026-09-28）
>
> 本方案已**全部落地**，实施结果与方案的偏差记录在下：
>
> | 项 | 方案预期 | 实际 |
> |---|---|---|
> | 函数数 | 12（11 占位 + `logAssignment`） | ✅ 12 个全部完成，占位脚手架已**整体拆除** |
> | 新增文件 | `services/songRescheduleCost.js` | ✅ 逐字搬运（`diff` 验证代码段零差异） |
> | 测试 | 预计 ~110 项 | ✅ **297 项**（`test-scheduling` 234 + `test-scheduling-cost` 63） |
> | 回归基线 | 481 → ~590 | ✅ **783 项全绿** |
> | harness 改动 | 方案未预见 | ⚠️ **2 处必要修复**（见 §10） |
> | 云端验收 | 「user 侧唯一入口是 cancel」 | ❌ **判断有误，已订正**（见 §7.2）—— 用户端**零入口** |
>
> 新增的 §10「实施中发现的两个 harness 缺陷」是本方案之外的重要收获。

> 目标文件：`cloud/cloudfunctions/api/services/scheduling.js`（现 461 行，其中 399–461 是占位）
> 参照源：`src/services/songSchedulingService.js`（943 行）+ `src/services/songRescheduleCost.js`（133 行）
> 状态：**方案待陛下过目，未动一行业务代码**
> 铁律不变：原 `src/`、`admin-web/`、Docker 链路一行不删；迁移只做加法。

---

## 0. 一页结论（先看这个）

1. **风险比想象的低。** 原排期算法里透传的 `transaction` 参数**从未被任何调用点以非 undefined 传入**（已 grep 证实）。也就是说原实现的「跨文档事务」是**空的** —— 真实并发模型一直是「单条条件 UPDATE + affectedRows 判定」。
2. **而那一层逻辑，阶段 4 已经逐字级移植好了** —— 就是 `services/songStatus.js` 的 `applyChange()`（云端用 `updateWhere` + guard，`stats.updated === 0` → 返回空 `logs`）。所以阶段 5 的 12 个函数里，**没有任何一个需要新造并发机制**，改动集中在 3 类机械替换。
3. **需要改的只有 4 类**：① `findAll({order, attributes, raw})` → `findAllPaged` + `orderBy`（驼峰）② `week.update()` → `updateById` + **内存同步**（这类最阴，见 §3.4）③ `[Op.in]` / `[Op.or]` → `_.in` / `_.or` ④ 去掉 `transaction` 实参。
4. **新增 1 个文件**：`services/songRescheduleCost.js`（纯字符串解析，无 DB，逐字搬运）。它是 `reschedule` 的地址选址依据。
5. **一个前置动作必须陛下做**：云函数超时仍是 **3 秒**，而 `sweep()` 是全量扫。不改到 20s，阶段 5 上线后 `sweep` 必 `-504003`。CLI 改不了，只能去云开发控制台。
6. **落地顺序**：成本表 → `logAssignment`+`initialAllocate` → `reschedule` → 两个转发壳 → `lockWeek`/`unlockWeek`/`cancelWeek` → 播放与 sweep。每步配断言，共 6 步。

---

## 1. 移植清单

### 1.1 十二个函数（现 `NOT_PORTED_YET` 11 个 + `logAssignment`）

| # | 函数 | 性质 | 云改写量 | 备注 |
|---|---|---|---|---|
| 1 | `logAssignment` | 写日志 | 小 | 现在**连导出都没有**（不在 `NOT_PORTED_YET` 里），要补导出 |
| 2 | `initialAllocate` | 改状态 | 中 | 第一个真正改状态的函数 |
| 3 | `reschedule` | 改状态 | 中 | 三级排序 + 成本选址，最高复杂度 |
| 4 | `runAllocators` | 转发壳 | **零** | `try { reschedule } catch { warn }` 逐字照搬 |
| 5 | `afterRelease` | 转发壳 | **零** | `weekStartOfRow` → `runAllocators` |
| 6 | `lockWeek` | 改状态 | 中 | 最后调度 + AUTO_REJECTED + 周 LOCKED |
| 7 | `unlockWeek` | 改状态 | 中 | 恢复候补 + `lockPaused=1` |
| 8 | `cancelWeek` | 改状态 | **小** | 一行 `week.update`，但**有内存同步陷阱** |
| 9 | `markPlayed` | 批量改状态 | 中 | 唯一**不能**用 `applyChange` 的函数（批量） |
| 10 | `setPlayed` | 改状态 | **零** | 纯 `S.applyChange` |
| 11 | `manualAssign` | 改状态 | **零** | 纯 `S.applyChange` + `logAssignment` |
| 12 | `sweep` | 调度总闸 | 中 | 全量扫，云超时敏感 |

> `canCrossSlot` / `waitingSnapshot` / `waitingPosOf` 等读路径**阶段 4 已移植**，阶段 5 只需在 `reschedule` / `sweep` 里复用。

### 1.2 新增文件

- `cloud/cloudfunctions/api/services/songRescheduleCost.js`
  - 逐字搬 `src/services/songRescheduleCost.js`（133 行）。
  - **零 DB 依赖**：只有 `parseSlot` / `dayNumber` / `costBetween` / `describeCost` / `pickBest` / `compareCost` + `COST` / `COST_LABEL` 常量。
  - 打包器无需改：只要 `scheduling.js` 里写**字面量** `require('./songRescheduleCost')`，`cloud/scripts/sync.js` 会静态扫到并收进单文件产物。

### 1.3 `handlers/index.js` 是否需要登记？

**不需要。** 阶段 5 全是 service 层，没有新增接口。唯一已有调用点是 `handlers/user/submit.js` 的 `cancel` → `afterRelease`（已用 catch 兜住，阶段 5 落地后自然生效）。

---

## 2. 等价性论证：原事务是「空的」

### 2.1 证据

```
grep -rn "transaction" src/controllers/ src/services/songSchedulingService.js src/services/songQueueService.js
```

结果：

- `src/controllers/` 里**没有任何** `sequelize.transaction()`。
- `songSchedulingService.js` 里 `transaction` 只作为**形参**出现（`refreshAnchors(..., transaction)` / `ensureWeek({ transaction })` / `initialAllocate({ transaction })` / `reschedule({ transaction })` / `logAssignment(..., transaction)`），并原样透传给 Sequelize 的 `{ transaction }` 选项。
- 唯一真实事务在 `src/controllers/admin/submitController.js:1067` 的 `purgeSongs` —— **与排期无关**。

### 2.2 推论

因为所有调用点传的 `transaction` 都是 `undefined`，Sequelize 的 `{ transaction: undefined }` 等价于「不使用事务」。所以：

- `initialAllocate` 里「读候选 → 逐条 `applyChange` → 改周状态」**本来就是一组独立的自动提交语句**，中途失败会留下「排了一半」的中间态。
- 原实现靠的是 **`applyChange` 的条件 UPDATE 幂等性**，不是事务。重复跑只命中更少的行（候选条件带 `scheduleStatus: UNASSIGNED` / `WAITING`）。

### 2.3 云版等价物

阶段 4 已落地的 `S.applyChange(row, patch, {operatorId, operatorName, reason})`：

```js
const guard = { id: submit.id };
Object.keys(DIMENSION_OF).forEach((k) => { if (patch[k] !== undefined) guard[k] = before[k]; });
const affected = await updateWhere(C.SUBMIT, guard, patch);
if (affected === 0) return { row: submit, status: ..., logs: [], conflict: true };  // ← 没抢到
```

与原 `Submit.update(patch, { where: guard })` + `affectedRows === 0 → logs: []` **语义完全一致**。

→ **结论：阶段 5 不需要跨文档事务，也不需要新的并发原语。** 调用方统一按 `if (r.logs.length)` 判定「是否真的抢到」。

---

## 3. 云固有改写矩阵

### 3.1 查询：`findAll` → `findAllPaged` + `orderBy`（驼峰）

| 源写法 | 云端写法 |
|---|---|
| `Submit.findAll({ where, order: [['create_time','ASC'],['id','ASC']] })` | `findAllPaged(C.SUBMIT, where, { orderBy: [['createTime','asc'],['id','asc']] })` |

⚠️ **排序字段一律驼峰**（`createTime`，不是 `create_time`）—— 云端 `findMany` 的 `orderBy` 直接用文档字段名。这是**静默失效**类坑：写错只会顺序不对，不报错。

⚠️ **不要**用 `findMany(..., { limit: 999 })` 代替 —— 云函数端单次 `get` **上限 100**，超量静默截断。必须走 `findAllPaged`。

### 3.2 分组：`group` → `countByField`

`countSeatedBySlot`（阶段 4 已改）已是这个模式，阶段 5 直接复用：

```js
const counters = await countSeatedBySlot(values);   // 内部 countByField(C.SUBMIT, seatedWhere({...}), 'scheduledSlot')
```

### 3.3 操作符：`Op` → `_`

| 源 | 云端 |
|---|---|
| `{ wantBroadcastTime: { [Op.in]: values } }` | `{ wantBroadcastTime: _.in(values) }` |
| `{ scheduleStatus: { [Op.in]: [0,1,3,4] } }` | `{ scheduleStatus: _.in([0,1,3,4]) }` |
| `[Op.or]: [ {a:...}, {b:...} ]` | `_.or([ {a:...}, {b:...} ])` |
| `{ id: { [Op.in]: due } }` | `{ id: _.in(chunk) }`（**必须分批，见 §6.4**） |

用到 `_.or` 的只有两处：`lockWeek` 的候补筛选、`unlockWeek` 的候补恢复。

### 3.4 ⚠️⚠️ 最阴的一类：`week.update()` 的内存同步

源里 `week` 是 Sequelize **实例**，`await week.update({status})` 后**实例自身就是新值**，紧接着读 `week.status` / `week.xxx` 拿到的是新数据。

云版 `week` 是**普通对象**，`updateById` 只改数据库，**内存对象不变**。若不补同步：

```js
// cancelWeek（源）
await week.update({ status: WEEK_STATUS.CANCELLED });
return weekView(week, now);                     // ← 源：返回 CANCELLED

// 云版若照抄
await updateById(C.WEEKLY, week._id, { status: WEEK_STATUS.CANCELLED, updateTime: new Date() });
return weekView(week, now);                     // ← ❌ 返回旧状态，且不报错
```

**统一写法**（本阶段所有 `week.update` 都按这个来）：

```js
async function applyWeekPatch(week, patch) {
  await updateById(C.WEEKLY, week._id, { ...patch, updateTime: new Date() });
  Object.assign(week, patch);                   // 内存同步 —— 不可省
  return week;
}
```

受影响点：`initialAllocate`（→ SCHEDULING）、`lockWeek`（→ LOCKED, lockedAt, lockPaused=0）、`unlockWeek`（→ SCHEDULING, lockedAt=null, lockPaused=1）、`cancelWeek`（→ CANCELLED）。

另外 `lockWeek` / `unlockWeek` 结尾的 `await WeeklySchedule.findByPk(week.id)`：
- 云端改为 `findById(C.WEEKLY, week._id)`（`week._id` 就是 `week:<date>`，直查最稳）。
- 不要用数字 `id` 查 `_id` —— 类型不一致会静默查不到。

### 3.5 `attributes` 投影不支持

源里两处用 `attributes: [...] , raw: true` 只为省流量：
- `markPlayed`：`['id','scheduledSlot']`
- `sweep`：`['id','wantBroadcastTime','scheduledSlot','createTime']` 与 `['week_start_date']`

云端 `findAllPaged` 不支持投影 → **全字段返回**。语义不变（用到的字段都在），只是多传了一些。**不要**为此改写成 `findMany` + `limit`，会踩 100 条上限。

⚠️ `sweep` 里 `w.week_start_date` → **`w.weekStartDate`**（驼峰）。写错 → `msOfWeekStartDate(undefined)` → 返回 `null` → 该周被静默跳过 → **永远锁不上**。这是本阶段最值得单独写断言的静默漂移。

---

## 4. 数据口径确认（阶段 5 涉及的两个集合）

### 4.1 `assignment_log`

字段（驼峰，无 `updateTime`）：

```
id, requestId, fromSlot, toSlot, assignmentType, reason, operatorId, createTime
```

`logAssignment` 云端写法：

```js
async function logAssignment(requestId, fromSlot, toSlot, type, reason, operatorId = null) {
  try {
    const id = await nextId(C.ASSIGNMENT_LOG);
    await insertOne(C.ASSIGNMENT_LOG, {
      id, requestId, fromSlot: fromSlot || null, toSlot: toSlot || null,
      assignmentType: type, reason: reason || null, operatorId: operatorId || null,
      createTime: new Date(),
    });
  } catch (e) {
    logger.warn(`[songSchedule] 排期日志写入失败 #${requestId}：${e.message}`);   // 保留：日志失败不影响主流程
  }
}
```

⚠️ 不能用 `insertWithId` —— 这张表**不用业务键当 `_id`**（只有 `system_setting` / `system_switch` / `notice_ack` / `weekly_schedule` 四张用）。

### 4.2 `weekly_schedule`

- `_id = week:<week_start_date>`，**同时照旧写入数字 `id`**（`ensureWeek` 里 `nextId(C.WEEKLY)` 已实现）。
- 因此既可 `findById(C.WEEKLY, week._id)`，也可 `findOne(C.WEEKLY, { id })`。**本阶段统一用前者**（直查主键，不用走索引）。
- 写周行一律 `updateById(C.WEEKLY, week._id, patch)`，**不走 `updateWhere`**。

---

## 5. 分步落地（每步一个提交 + 一轮断言）

### 步骤 1 · 成本表

- 新增 `services/songRescheduleCost.js`（逐字搬运）。
- 断言（新 `cloud/scripts/test-scheduling-cost.js`，目标 ~20 项）：
  - `costBetween` 五档 + `Infinity`：同格 0 / 同天异时段 10 / 前后一天同段 20 / 前后一天异段 30 / 更远 50 / 跨周或解析失败 `Infinity`。
  - **反例钉死**：`周一晚 → 周二早` 必须是 **30**、`周一晚 → 周一午` 必须是 **10**（下标距离会把两者算成一样近 —— 这正是当初对不上规格的 bug）。
  - `pickBest` 同 cost 时按**周内下标升序**（可复现性）；`compareCost` 对 `Infinity` 不能相减。
  - `describeCost` 的 `Infinity → { cost: null, text: '不可接受' }`。

### 步骤 2 · `logAssignment` + `initialAllocate`

- 实现两个函数，从 `NOT_PORTED_YET` 里移除 `initialAllocate`，把 `logAssignment` 加进 `module.exports`。
- 断言（并入 `test-scheduling.js`）：
  - **候选排序**：`createTime` 升序、`id` 兜同秒 —— 造三条同秒记录，验证顺序稳定。
  - **capacity 截断**：capacity=2、某格 3 个候选 → 前 2 个 `APPROVED`，第 3 个 `WAITING`。
  - **改动顺序**：`r.logs.length` 为真才 `logAssignment`（空 logs 不写日志）。
  - **幂等**：连跑两次，第二次 `assigned=0`、`waiting=0`。
  - **dryRun 不写库**：`dryRun: true` 前后 submit 集合快照完全一致，`actions` 长度正确。
  - **周状态**：跑完周 → `SCHEDULING`（LOCKED / CANCELLED 除外）。
  - **`logAssignment` 字段**：`requestId/fromSlot=null(首轮)/toSlot=value/assignmentType=INITIAL/reason=INITIAL_ALLOCATION`。

### 步骤 3 · `reschedule`（本阶段最高风险）

- 断言：
  - **闸门**：点播未截止（`now < applicationEndAt`）→ `crossSlot=false`，只做原位递补；
    `crossSlot: true` 显式放开 → 跨时段；`now >= applicationEndAt` 自动放开。
    判据：`res.crossSlot` 的值 + 「首选格满的候补是否被挪到别格」。
  - **三级排序**：① 可接受位数量少的优先 ② 提交早的优先 ③ 成本低（离首选近）的优先。造一个「A 只有 1 个可选位、B 有 3 个」的场景，验证 A 先被安排。
  - **`allowReschedule = 0` 的人永不跨时段**（即使 `crossSlot: true`）。
  - **`free` 集合随分配收缩**：capacity=1 时同一格不能同时排进两个人。
  - **并发冲突跳过**：mock 一次 `updateWhere` 返回 0 → `continue`，且 `res.promoted/rescheduled` 不增加。
  - **dryRun**：纯算不写，`actions` 里 `PROMOTE` / `RESCHEDULE` / `WAITING` 三类动作名正确。
  - **`changed` 统计**：`promoted` 与 `rescheduled` 分别对应 `isSame` 真/假，且日志的 `assignmentType` 分别是 `PROMOTED` / `RESCHEDULED`。

### 步骤 4 · `runAllocators` + `afterRelease`

- 逐字转发，**零改写**。断言：
  - `runAllocators` 吞异常 → 返回 `{promoted:0, rescheduled:0, left:0, error}` 而不是抛。
  - `afterRelease(row)` 用的是**这条记录所属周**（`weekStartOfRow`），不是「下一周」—— 造一条落在别的周的记录验证。
  - `weekStartOfRow` 返回 null（无有效时段）时安全返回空结果。

### 步骤 5 · `lockWeek` / `unlockWeek` / `cancelWeek`

- 断言：
  - **`already` 短路**：已 LOCKED 的周再锁 → `{already: true, rejected: 0}`，不改库。
  - **`tooEarly`**：`now < scheduleLockAt` 且 `force=false` → `{tooEarly: true, rejected: 0}`；`force=true` 绕过。
  - **锁定时显式跨时段**：`lockWeek` 内部调 `reschedule(..., { crossSlot: true })` —— 即使点播**未**截止也放开（这是协议允许的唯一例外）。
  - **AUTO_REJECTED**：锁定后仍 `WAITING` 的 → `scheduleStatus=AUTO_REJECTED` + `autoRejected=1` + `rejectReason=lockedNoSlot` + `reviewTime`。
  - **周终态**：`status=LOCKED`、`lockedAt` 有值、`lockPaused=0`；**且返回体的 `weekView` 是新状态**（验证 §3.4 内存同步）。
  - **`unlockWeek`**：非 LOCKED 周抛 `code=40001`；`restore: true` 时把「当时系统驳回且现在仍是 AUTO_REJECTED」的退回 WAITING 并清 `rejectReason`/`autoRejected`；**管理员手动动过的不碰**；`lockPaused=1`；`lockedAt=null`。
  - ⚠️ **解锁后 `sweep` 不能再锁回去**（`lockPaused=1` 拦住）—— 这条单独钉死，它是解锁功能的全部意义。
  - **`cancelWeek`**：LOCKED 周抛 40001；正常周 → CANCELLED，且返回体状态正确。

### 步骤 6 · `markPlayed` / `setPlayed` / `manualAssign` / `sweep`

- 断言：
  - `markPlayed` 只标「播出时刻已过」的（用 `instantOfValue` 判定），未来时段不动；重复跑第二次 `played=0`。
  - `markPlayed` 是**批量** UPDATE → 断言它**不写** `request_status_log`（与源一致，别顺手"修正"）。
  - `setPlayed` 手动置位/取消，`playedAt` 相应置值/置 null。
  - `manualAssign` 目标时段不属于任何可选周 → 抛 40001；合法 → `APPROVED` + `scheduledSlot` + `logAssignment(MANUAL)`。
  - `sweep` **三种分支**：LOCKED/CANCELLED 跳过、`lockPaused=1` 只排不锁、到点且未暂停 → `lockWeek`、未到点 → `initialAllocate` + `reschedule`。
  - ⚠️⚠️ **sweep 第②步必须独立于第①步扫 `weekly_schedule`**：造一个「所有点歌都排好了、一条 UNASSIGNED/WAITING 都不剩、但周已到锁定时刻」的周 —— 它**必须**被锁上。这条是最易错点（源的注释专门警告过），要单独立一个断言。
  - `sweep` 末尾会带上 `played`。

---

## 6. 风险清单（必须逐条确认）

### 6.1 ⚠️ 云函数超时 3s —— **前置动作，陛下做**

`initialAllocate` + `reschedule` 都要全量拉 submit，`sweep` 还要再套一层循环。冷启动 + 全量扫**大概率超 3s** → `-504003`。CLI 无改超时能力，必须：

> 云开发控制台 → 云函数 `api` → 配置 → 超时时间改为 **20 秒**。

建议在步骤 2 开工前就先改掉，否则每轮云端验证都会撞。

### 6.2 `week.update` 内存同步（§3.4）

本阶段**唯一**会造成「返回值悄悄是旧状态」的坑。已在 §3.4 给出统一 `applyWeekPatch`。**判据**：断言 `cancelWeek` / `lockWeek` / `unlockWeek` 的返回体 `week.status` 是新值。

### 6.3 `week_start_date` 驼峰（§3.5）

`sweep` 里写错 → 该周静默跳过 → 永远锁不上。**判据**：`sweep` 断言里必须有一个「周行存在但无点歌」的场景能被锁上。

### 6.4 `markPlayed` 批量 `_.in(due)` 分批

`due` 是「所有已到播出时刻的已排期记录 id」。一周 5 天 × N 时段 × capacity，量不大，但**历史库全量扫**时可能上千。云数据库单次命令体有限制 → 按 **100 一批**切分，累加 `updated`。

### 6.5 `affectedRows` 语义差

源 `markPlayed` 的 `const [n] = await Submit.update(patch, {where})` 取的是「实际变更行数」。MySQL 在「值未变」时不计数；云端 `stats.updated` 同样不计数。**理论一致，但要在断言里实测**（重复跑第二次 `played=0` 就是这条的判据）。

### 6.6 如实保留的两处「遗产行为」

1. `markPlayed` **不加** `reviewStatus/scheduleStatus/playStatus` 守卫（源就没有）。加守卫会改变 `affectedRows` 语义 → **不加**。
2. user 侧 `cancel` 里 `APPROVED + WAITING` 落进 `revocable` → 「请用『放弃候补』」是**死文案**。阶段 4 已如实保留 + 注释，阶段 5 不动。

### 6.7 打包器

只要 `scheduling.js` 里是**字面量** `require('./songRescheduleCost')`，`cloud/scripts/sync.js` 会自动收。若写成变量拼接，会**静默漏打包** → 云端 `Cannot find module`。落地后用 `test-bundle` 复验产物文件清单。

---

## 7. 验收方式

### 7.1 本地（主力）

1. 新脚本 `cloud/scripts/test-scheduling.js`（预计 90–110 项）+ `test-scheduling-cost.js`（~20 项）。
2. 全量回归基线从 481 项 → **约 590 项必须全绿**。
3. **产物模式自证**：`HARNESS_API_DIR=<打包产物>` 跑同一套断言，结果必须与源码模式一致（阶段 4 已建立的机制）。

### 7.2 云端（真跑）—— ⚠️ **本方案原判断有误，已订正**

> **订正（2026-09-28 实施后）**：原文写「阶段 5 算法在 user 侧唯一入口是
> `POST /user/submit/cancel` → `afterRelease`」—— **这是错的**。
>
> 用户端 `cancel` 的可撤销判定是
> `review===PENDING || (review===APPROVED && schedule===WAITING)`，
> 而 `cancelRequest` 里触发 `afterRelease` 的条件是 `isSeated()`
> （= `review APPROVED` **且** `schedule APPROVED`）。**两者互斥** ——
> `if (wasSeated)` 这条分支在**学生端永远不可达**。
>
> 结论：**阶段 5 的排期算法在用户端一个入口都没有**，真实入口全在管理端（阶段 7）。
>
> 因此：**不能用用户端接口做云端验收**。当下能拿到的最强证据 = 本地 harness
> **783 项全绿** + 产物模式自证；云端真跑**必须等阶段 7 的管理端接口接上**
> （届时可验：`/admin/submit/schedule/*` 触发 `initialAllocate`/`reschedule`/
> `lockWeek`/`unlockWeek`/`sweep`）。
>
> 这条已同步写进 `test-scheduling.js` 的 V 段（直接把「用户端到不了」变成断言）
> 与 `cloud/README.md`。

### 7.3 部署

- `cloud/scripts/sync.js` 打包 → 单文件产物（`filesCount` 会从 2 涨到 3：`index.js` / `package.json` / 无 —— 成本表被打进 `index.js`，所以仍是 2）。⚠️ 落地后以实际 `filesCount` 为准，别预设。
- `deploy` 后跑 `verify-user.js`（31 条）确认无回归。

---

## 8. 本阶段「不做什么」（边界）

- ❌ 不动 `src/` 任何文件（含 `songSchedulingService.js` / `songRescheduleCost.js` 原文）。
- ❌ 不动 `admin-web/`、Docker、nginx。
- ❌ 不建 `schedule_slots` 表（格子由 `broadcastSlotService` 派生，这是有意偏离协议且已定）。
- ❌ 不引入跨文档事务（§2 已论证不需要）。
- ❌ 不在本阶段做定时触发器 —— 那是**阶段 6**（替换原 60s `setInterval` 的 `sweep` + `markPlayed`）。本阶段只保证 `sweep` 函数本身可被调用。
- ❌ 不「顺手修正」§6.6 两处遗产行为。

---

## 9. 待陛下裁决的两点

1. **超时改成 20s** 是否现在就做？（不做，阶段 5 没法云端真跑）
2. 阶段 5 云端验收按 §7.2 的**间接验证**（只验 `afterRelease → reschedule` 一条链）是否可以接受，其余算法留到阶段 7 接口接上后统一验收？

> 陛下点头后我按 §5 的 6 步逐步落地，每步一个提交、每步跑断言、**不改任何原有文件**。

---

## 10. 实施中发现的两个 harness 缺陷（方案未预见，已修）

这两个都是「**本地绿、线上错**」型的 —— 写完断言才发现 harness 本身表达不了真实行为。
它们不在排期代码里，而在测试基础设施里，所以值得单独记档。

### 10.1 多键排序用 `===` 比较 Date → 排序退化成插入顺序

`harness.js` 的 `_rows()` 里原本是：

```js
if (av === bv) continue;      // ❌ 对象同一性比较
```

每个文档都是 `clone()` 出来的**独立 Date 实例**，两行 `createTime` 同一时刻但实例不同，
`av === bv` 是 **false** → `av < bv ? -1 : 1` 恒返回 `1` → 比较器自相矛盾
→ **多键排序退化成插入顺序**（V8 TimSort 对全 1 比较器几乎保持原序）。

为什么这次才暴露：排期算法的可复现性**完全建立在这个排序上** ——
`initialAllocate` / `reschedule` 的候选顺序是 `createTime` 升序 + `id` 兜同秒。
排序失效时「同秒提交的两个人谁先落座」每次跑都不一样，但**接口永远 200**。

修法：比较前把 Date 归一成 `getTime()`，相等则 `c = 0` 交给下一个排序键。

**判据**（已写进 `test-scheduling.js` C4–C6）：三条同 `createTime`、id 分别 30/10/20
→ 必须按 id 升序 10、20 再 30。

### 10.2 `where()` 不支持顶层 `_.and([...])` / `_.or([...])` → 恒不匹配

真实云数据库的 `where()` 既能接**字段映射**，也能接**顶层逻辑指令**（官方文档示例）：

```js
db.collection('order_info').where(_.and([
  { publish_type: '1' },
  _.or([{ _openid: openid }, { order_openid: openid }]),
])).get()
```

顶层 `_.and` / `_.or` 的**子项是 where 子句**（不是字段值），且可嵌套。
而 harness 的 `matches()` 只支持「字段级指令」→ 顶层 `or` 会**恒不匹配、静默返回空集**。
线上正常、本地空集 —— 这是最坏的一种不一致方向（本地测试「通过」了本不该通过的断言）。

排期算法里 `lockWeek` / `unlockWeek` 的候补筛选正是这个形状，
所以移植时**必须**先补 harness 能力，否则那两个函数的核心分支等于没测。

修法：`matches` → `matchesWhere`，识别顶层 Cmd 并递归求值；
`command.and/or` 同时容忍 `_.or([a, b])`（官方数组形式）与 `_.or(a, b)`。
`updateWhere`（批量条件更新）也共用 `matches`，所以一并受益。

### 10.3 一个结论：**改了 harness 必须全量复跑**

这两处改动触及所有查询路径。每次改完都跑了 9 个脚本的**全量**回归
（阶段 4 的 481 项一并复验）才算过 —— 只跑新脚本会漏掉对既有用例的影响。

---

## 11. 实施后的回归基线（783 项）

| 脚本 | 项数 |
|---|---|
| `selfcheck.js` | 75 |
| `test-system.js` | 21 |
| `test-gateway.js` | 26 |
| `test-user-readonly.js` | 76 |
| `test-user-auth.js` | 62 |
| `test-user-submit.js` | 206 |
| `test-scheduling-cost.js` | 63 |
| `test-scheduling.js` | 234 |
| `test-bundle.js` | 20 |
| **合计** | **783** |

产物模式自证：`HARNESS_API_DIR=miniprogram/cloudfunctions/api` 跑
`test-scheduling`（234/0）、`test-scheduling-cost`（63/0）、`test-user-submit`（206/0）
—— 与源码模式**完全一致**。
