# MySQL → 云数据库 集合映射

> 17 张表 → 17 个集合（一对一，名字保持表名，便于双方对照排查）。
> 原则：**字段名一律用驼峰（camelCase）**，即「Sequelize 属性名」=「云文档字段名」=「接口返回给前端的 JSON 字段名」。
> 原表里的下划线列名（`is_show`）只是 Sequelize 的**存储细节**，不进云端 —— 这样前端零改动，阶段 8 迁移时照属性名写入即可。
>
> ⚠️ 本文档早期版本写的是「沿用 snake_case」，与实现不符，已于 2026-09-28 全文订正。
>    代码口径以 `cloud/cloudfunctions/api/lib/db.js` 文件头 + `parseId()` 注释为准。

## 一、通用改造点

| MySQL 特性 | 云数据库做法 |
|---|---|
| `INTEGER AUTO_INCREMENT` 主键 | 云数据库自带字符串 `_id`；**同时保留数字 `id` 字段**，用「计数器集合 + 原子自增」`nextId(scope)` 生成，与旧数据同一套 id 空间 |
| UNIQUE 索引 | 用 `unique_keys` 辅助集合登记（`_id = '<scope>:<key>'`，重复 add 直接报错），见第三节 |
| 自增字段 `used = used + 1` | `db.command.inc(1)`，必要时配 `where(used < limit)` 做条件更新 |
| 事务 `sequelize.transaction` | 不依赖长事务；靠「单文档原子更新抢位 + 幂等键」重建，见第四节 |
| `createdAt/updatedAt` | 一律显式命名：`createTime` / `updateTime`（**例外**：`system_switch` 是 `updatedAt`，`assignment_log` / `request_status_log` 只有 `createTime` 没有 `updateTime`） |
| 外键 | 全部去掉，改应用层引用 + 日志冗余快照 |
| `Op.like` / `fn/col` 原生查询 | 改 `db.RegExp` 与显式字段比较（逐条重写，见阶段 4） |
| 查询结果上限 | 云函数端单次 `get()` **最多 100 条**，超量必须 `skip/limit` 分页 |

### ⚠️⚠️ 主键口径（两个 id，别混用）

| 标识 | 类型 | 用途 | 怎么查 |
|---|---|---|---|
| `id` | **数字** | 业务主键，= 原 MySQL AUTO_INCREMENT | 详情 / 外键关联**一律用它**：`findOne('cadre', { id, isShow: 1 })` |
| `_id` | 字符串 | 云数据库自带主键 | **仅下面 4 张表**用业务键当 `_id` |

用业务键当 `_id` 的**唯一 4 处**（这几张表**不要**用数字 `id` 查）：

| 集合 | `_id` 形态 |
|---|---|
| `system_setting` | `setting:<key>` |
| `system_switch` | `switch:<key>` |
| `notice_ack` | `ack:<openid>:<notice_key>` |
| `weekly_schedule` | `week:<week_start_date>` |

URL 里的 `:id` 是字符串，**必须**经 `parseId()` 转成数字再用；`parseId` 对非法值返回 `null`，
调用方据此走「不存在」分支 —— 绝不把 `NaN` 塞进 `where`（JSON 序列化后变 `null`，条件会静默失效、还查不到错）。

## 二、集合清单

### 1. `user`（学生 + 微信用户，双身份）
- 字段：`id, openid, username, password, grade, classNo, seatNo, remark, status, pwdChangedAt, lastLoginAt, loginCount, importBatchId, unionid, nickname, avatar, createTime, updateTime`
- 唯一性（`unique_keys` 登记）：`user_name:username` / `user_seat:grade:classNo:seatNo` / `user_openid:openid`
- 索引建议：`username`、`openid`、`grade + classNo`
- ⚠️ 原模型 `defaultScope` 排除 `password` —— 文档库无 scope，改为**查询后统一剥离**，剥密码逻辑集中一处，避免遗漏泄漏
- ⚠️ `remark` 与 `nickname` 必须**同写**（姓名读取点不唯一，见项目备忘）

### 2. `admin`
- 字段：`id, username, password, nickname, role, status, lastLoginAt, createTime, updateTime`
- `role`：0 超管 / 1 普管（语义不变）
- 唯一性：`unique_keys` 登记 `admin:username`

### 3. `submit`（点歌 / 文稿，核心表）
- 字段：`id, openid, type, songName, singer, wishContent, articleTitle, articleContent, wantBroadcastTime, scheduledSlot, queueAt, promotedAt, reviewStatus, scheduleStatus, playStatus, allowReschedule, assignedAt, playedAt, status, rejectReason, reviewerId, reviewTime, autoRejected, createTime, updateTime`
- ⚠️ **三维状态 + 派生镜像 `status` 的数字口径全部不变**（5 已播放 / 6 已通过待排期 / 7 已取消等），数字 ↔ 常量名仍只在 `songStatusService` 一处定义
- ⚠️ 占位口径唯一：`reviewStatus=APPROVED AND scheduleStatus=APPROVED`（驳回自动释放）
- 索引建议：`type + status + createTime`、`scheduleStatus`、`queueAt`、`reviewStatus + scheduleStatus`、`assignedAt`
- 列表排序语义必须保持：`createTime ASC, id ASC`（先提交先审，id 兜同秒）

### 4. `program`
- 字段：`id, title, host, broadcastTime, broadcastDate, desc, cover, isShow, isLive, sort, createTime, updateTime`
- ⚠️ `broadcastDate` 为 NULL 会导致 weekly 接口不显示 —— 迁移时保持原值，NULL 就是 NULL

### 5. `notice`
- 字段：`id, title, content, isTop, isShow, publisherId, publishTime, createTime, updateTime`

### 6. `message`（留言）
- 字段：`id, openid, programId, nickname, avatar, content, status, rejectReason, reviewerId, reviewTime, createTime`
- ⚠️ 原模型 `timestamps:false`，**只有 `createTime`，没有 `updateTime`**，迁移时不要补

### 7. `system_setting`（KV）
- 字段：`id, key, value, desc, updateTime`（**无 createTime**）
- 直接用 `_id = 'setting:' + key` 单文档读写（一次查询命中，最快路径）

### 8. `system_switch`（模块开关）
- 字段：`id, key, value, desc, updatedBy, updatedAt, createTime`
- 唯一性：`_id = 'switch:' + key`
- ⚠️ 时间列属性名是 **`updatedAt`**（不是 `updateTime`），与 `system_setting` 不同 —— 抄代码时最容易错的一处
- ⚠️ 缺行视为 `on`（沿用原约定）；`KNOWN_SWITCHES` 只增不删、**不进 seed**

### 9. `cadre`（社干）
- 字段：`id, name, role, grade, avatar, motto, sort, isShow, createTime, updateTime`
- `avatar` 目前存 `/uploads/...` 相对路径 → 迁移到云存储后改存云存储 URL（兼容期两套并存）

### 10. `staff`（部员）
- 字段：`id, name, role, department, grade, programs, avatar, motto, sort, isShow, createTime, updateTime`

### 11. `song_quota` ⛔ 不迁移
- 已退役（v2 起无日/周名额概念，表已停写）。仅保留 `response.js` 里的错误码常量兼容。

### 12. `notice_ack`（注意事项确认）
- 字段：`id, openid, noticeKey, version, createTime, updateTime`
- `_id = 'ack:' + openid + ':' + noticeKey`（原 `uk_openid_notice` 复合唯一键）—— 固定 `_id` 模拟唯一约束的典型受益点

### 13. `import_batch`（导入批次）
- 字段：`id, filename, total, created, updated, skipped, invalid, operatorId, operator, createTime, updateTime`

### 14. `cleanup_log`（整届清理日志）
- 字段：`id, grade, gradeName, mode, total, deleted, disabled, classCount, untouched, costMs, operatorId, operatorName, disabledAccounts, createTime, updateTime`
- `disabledAccounts` 原为 TEXT(JSON) → 直接存数组/对象，不再手动序列化

### 15. `weekly_schedule`（周行，点歌周期锚点）
- 字段：`id, weekStartDate, applicationStartAt, applicationEndAt, reviewStartAt, reviewEndAt, scheduleLockAt, status, lockedAt, lockPaused, createdBy, createTime, updateTime`
- `_id = 'week:' + weekStartDate`（原 unique `weekStartDate`）
- ⚠️ `status` 六态（DRAFT/APPLICATION/REVIEW/SCHEDULING/LOCKED/CANCELLED）与前端 `WEEK_FLOW` 严格对齐，迁移不得改字面量
- ⚠️ `lockPaused` 是解锁后拦住自动锁定的闸门，不能省

### 16. `assignment_log`（排期变更日志）
- 字段：`id, requestId, fromSlot, toSlot, assignmentType, reason, operatorId, createTime`
- 无 `updateTime`（原 `updatedAt:false`）

### 17. `request_status_log`（状态变更日志）
- 字段：`id, requestId, operatorId, operatorName, dimension, fromStatus, toStatus, reason, createTime`
- 无 `updateTime`

## 三、`unique_keys` 辅助集合（唯一性的统一实现）

文档数据库没有 UNIQUE 索引，本项目唯一性需求集中在以下 7 处。统一用一张辅助集合模拟：

```
集合 unique_keys
文档 { _id: '<scope>:<key>', scope, key, owner_id, create_time }
```

写入流程（等价于数据库级 UNIQUE 冲突检测）：

1. `add({ _id: 'admin:teacher', ... })` —— 若 `_id` 已存在，云数据库**直接报错**，捕获即视为「唯一冲突」；
2. 冲突时按原业务语义抛出对应错误码（例如 40901 / 40903）；
3. 删除主记录时同步调 `releaseUnique()` 删对应文档（避免孤儿键挡住后续写入）。

`lib/db.js` 已提供：`reserveUnique(scope, key, ownerId)` / `releaseUnique(scope, key)` / `getUniqueOwner(scope, key)`。

需登记的键：

| scope 前缀 | 来源 | 原 MySQL 约束 |
|---|---|---|
| `admin:` | admin.username | UNIQUE |
| `user_name:` | user.username | `uk_username` |
| `user_seat:` | user.grade + classNo + seatNo | `uk_grade_class_seat` |
| `user_openid:` | user.openid | openid 唯一 |
| `setting:` | system_setting.key | UNIQUE |
| `switch:` | system_switch.key | UNIQUE |
| `ack:` | notice_ack.openid + noticeKey | `uk_openid_notice` |
| `week:` | weekly_schedule.weekStartDate | UNIQUE |

## 四、并发安全重建（迁移最高风险点）

原实现依赖「带条件 UPDATE，影响 0 行即失败」这一 MySQL 原子语义（`songStatusService.applyChange`）。
文档数据库的等价物是 **`where(...).update(...)` 返回 `stats.updated`** —— 语义完全一致：

```js
const n = await updateWhere(
  'submit',
  { _id: docId, reviewStatus: 0, scheduleStatus: 0 },   // 原 WHERE 条件原样搬（字段名换驼峰）
  { reviewStatus: 1, status: 6, updateTime: new Date() }
);
if (n === 0) return { logs: [] };   // 原「影响 0 行 → 返回空 logs」语义保持
```

映射规则：
- 原 `Submit.update({...}, { where: {...} })` → `updateWhere('submit', {...}, {...})`
- 判据从 `affectedRows` → `stats.updated`（**0 即失败，调用方写法不变**）

唯一例外是**跨文档原子操作**（占位 + 日志 + 计数三处同时成功）。原实现靠事务，改造方案：
1. 主体操作用单文档原子更新（带条件）抢位；
2. 抢到后再写日志；日志失败不回滚（日志是审计用途，此处放宽为「主操作成功即成功」）；
3. 需要严格一致的位置，用 `_id` 幂等键防重复（`acquireIdempotentKey()`，重跑安全）。

> 这一节是阶段 5 的施工依据，改 `songStatusService` / `songSchedulingService` 前必须先读这里。
