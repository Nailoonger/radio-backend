# MySQL → 云数据库 集合映射

> 17 张表 → 17 个集合（一对一，名字保持表名，便于双方对照排查）。
> 原则：**字段名沿用下划线命名（snake_case）**，与现有代码/接口返回体完全一致——前端和控制器代码里读 `row.review_status` 的地方一行都不用改。

## 一、通用改造点

| MySQL 特性 | 云数据库做法 |
|---|---|
| `INTEGER AUTO_INCREMENT` 主键 | 云数据库自带 `_id`（字符串）；**同时保留 `id` 数字字段**，用「计数器集合 + 原子自增」生成，保证与旧数据同一套 id 空间 |
| UNIQUE 索引 | 用「固定 `_id` 写入」模拟：`_id = 业务键拼接串`，重复插入直接失败 |
| 自增字段 `used = used + 1` | `db.command.inc(1)`，必要时配 `where(used < limit)` 做条件更新 |
| 事务 `sequelize.transaction` | 云数据库支持事务（runTransaction），但**跨集合性能差**——本项目的原子性靠「单文档原子更新 + 幂等键」重建，不依赖长事务 |
| `createdAt/updatedAt` | 保留 `create_time` / `update_time` 两个 `Date` 字段，语义不变 |
| 外键 | 全部去掉，改应用层引用 + 日志冗余快照 |
| `Op.like` / `fn/col` 原生查询 | 改 `db.RegExp` 与显式字段比较（逐条重写，见阶段 4） |

## 二、集合清单

### 1. `user`（学生 + 微信用户，双身份）
- 字段：`id, openid, username, password, grade, class_no, seat_no, status, pwd_changed_at, last_login_at, login_count, import_batch_id, unionid, nickname, avatar, create_time, update_time`
- 唯一性（固定 `_id`）：
  - `_id = 'uk_username:' + username`
  - `_id = 'uk_grade_seat:' + grade + ':' + class_no + ':' + seat_no`
  - `_id = 'uk_openid:' + openid`
  - ⚠️ 同一文档不可有多个 `_id`。因此**改为一张 `unique_keys` 辅助集合**做唯一性登记（见第三节），`user` 集合自身用普通 `_id`。
- 索引建议：`username`、`openid`、`grade + class_no`
- ⚠️ 原模型 `defaultScope` 排除 `password`——文档库无 scope，改为**查询后统一剥离**，剥密码逻辑集中一处，避免遗漏泄漏

### 2. `admin`
- 字段：`id, username, password, nickname, role, status, last_login_at, create_time, update_time`
- `role`：0 超管 / 1 普管（语义不变）
- 唯一性：`unique_keys` 登记 `admin:username`

### 3. `submit`（点歌 / 文稿，核心表）
- 字段：`id, openid, type, song_name, singer, wish_content, article_title, article_content, want_broadcast_time, scheduled_slot, queue_at, promoted_at, review_status, schedule_status, play_status, allow_reschedule, assigned_at, played_at, status, reject_reason, reviewer_id, review_time, auto_rejected, create_time, update_time`
- ⚠️ **三维状态 + 派生镜像 `status` 的数字口径全部不变**（5 已播放 / 6 已通过待排期 / 7 已取消等），数字↔常量名仍只在 `songStatusService` 一处定义
- 索引建议：`type + status + create_time`、`schedule_status`、`queue_at`、`review_status + schedule_status`、`assigned_at`
- 列表排序语义必须保持：`create_time ASC, id ASC`（先提交先审，id 兜同秒）

### 4. `program`
- 字段：`id, title, host, broadcast_time, broadcast_date, desc, cover, is_show, is_live, sort, create_time, update_time`
- ⚠️ `broadcast_date` 为 NULL 会导致 weekly 接口不显示——迁移时保持原值，NULL 就是 NULL

### 5. `notice`
- 字段：`id, title, content, is_top, is_show, publisher_id, publish_time, create_time, update_time`

### 6. `message`（留言）
- 字段：`id, openid, program_id, nickname, avatar, content, status, reject_reason, reviewer_id, review_time, create_time`
- ⚠️ 原模型 `timestamps:false`，**只有 `create_time`，没有 `update_time`**，迁移时不要补

### 7. `system_setting`（KV）
- 字段：`id, key, value, desc, update_time`
- 唯一性：`unique_keys` 登记 `setting:key`
- 直接改成 `_id = 'setting:' + key` 的单文档读写（一次查询命中，最快路径）

### 8. `system_switch`（模块开关）
- 字段：`id, key, value, desc, updated_by, update_time, create_time`
- 唯一性：同上，`_id = 'switch:' + key`
- ⚠️ 缺行视为 `on`（沿用原约定）；`KNOWN_SWITCHES` 只增不删

### 9. `cadre`（社干）
- 字段：`id, name, role, grade, avatar, motto, sort, is_show, create_time, update_time`
- `avatar` 目前存 `/uploads/...` 相对路径 → 阶段迁移到云存储后改存云存储 URL（两套并存兼容期见阶段 5）

### 10. `staff`（部员）
- 字段：`id, name, role, department, grade, programs, avatar, motto, sort, is_show, create_time, update_time`

### 11. `song_quota` ⛔ 不迁移
- 已退役（v2 起无日/周名额概念，表已停写）。仅保留 `response.js` 里的错误码常量兼容。

### 12. `notice_ack`（注意事项确认）
- 字段：`id, openid, notice_key, version, create_time, update_time`
- 唯一性：`_id = 'ack:' + openid + ':' + notice_key`（原为 `uk_openid_notice` 复合唯一键）——**这是固定 `_id` 模拟唯一约束的典型受益点**

### 13. `import_batch`（导入批次）
- 字段：`id, filename, total, created, updated, skipped, invalid, operator_id, operator, create_time, update_time`

### 14. `cleanup_log`（整届清理日志）
- 字段：`id, grade, grade_name, mode, total, deleted, disabled, class_count, untouched, cost_ms, operator_id, operator_name, disabled_accounts, create_time, update_time`
- `disabled_accounts` 原为 TEXT(JSON) → 直接存数组/对象，不再手动序列化

### 15. `weekly_schedule`（周行，点歌周期锚点）
- 字段：`id, week_start_date, application_start_at, application_end_at, review_start_at, review_end_at, schedule_lock_at, status, locked_at, lock_paused, created_by, create_time, update_time`
- 唯一性：`_id = 'week:' + week_start_date`（原 unique `weekStartDate`）
- ⚠️ `status` 六态（DRAFT/APPLICATION/REVIEW/SCHEDULING/LOCKED/CANCELLED）与前端 `WEEK_FLOW` 严格对齐，迁移不得改字面量
- ⚠️ `lock_paused` 是解锁后拦住自动锁定的闸门，不能省

### 16. `assignment_log`（排期变更日志）
- 字段：`id, request_id, from_slot, to_slot, assignment_type, reason, operator_id, created_at`
- 无 `update_time`（原 `updatedAt:false`）

### 17. `request_status_log`（状态变更日志）
- 字段：`id, request_id, operator_id, operator_name, dimension, from_status, to_status, reason, created_at`
- 无 `update_time`

## 三、`unique_keys` 辅助集合（唯一性的统一实现）

文档数据库没有 UNIQUE 索引，本项目唯一性需求集中在以下 7 处。统一用一张辅助集合模拟：

```
集合 unique_keys
文档 { _id: '<scope>:<key>', scope, owner_id, create_time }
```

写入流程（等价于数据库级 UNIQUE 冲突检测）：

1. `add({ _id: 'admin:teacher', ... })` —— 若 `_id` 已存在，云数据库**直接报错**，捕获即视为「唯一冲突」；
2. 冲突时按原业务语义抛出对应错误码（例如 40901 / 40903）；
3. 删除主记录时同步删对应 `_id` 文档（或在读取时容错跳过孤儿键）。

需登记的键：

| scope 前缀 | 来源 | 原 MySQL 约束 |
|---|---|---|
| `admin:` | admin.username | UNIQUE |
| `user_name:` | user.username | `uk_username` |
| `user_seat:` | user.grade + class_no + seat_no | `uk_grade_class_seat` |
| `user_openid:` | user.openid | openid 唯一 |
| `setting:` | system_setting.key | UNIQUE |
| `switch:` | system_switch.key | UNIQUE |
| `ack:` | notice_ack.openid + notice_key | `uk_openid_notice` |
| `week:` | weekly_schedule.week_start_date | UNIQUE |

## 四、并发安全重建（迁移最高风险点）

原实现依赖「带条件 UPDATE，影响 0 行即失败」这一 MySQL 原子语义（`songStatusService.applyChange`）。
文档数据库的等价物是 **`where(...).update(...)` 返回 `stats.updated`**——语义完全一致：

```js
const r = await db.collection('submit')
  .where({ _id: docId, review_status: 0, schedule_status: 0 })   // 原 WHERE 条件原样搬
  .update({ data: { review_status: 1, status: 6, update_time: new Date() } });
if (r.stats.updated === 0) return { logs: [] };   // 原「影响 0 行 → 返回空 logs」语义保持
```

映射规则：
- 原 `Submit.update({...}, { where: {...} })` → `collection('submit').where({...}).update({ data: {...} })`
- 判据从 `affectedRows` → `stats.updated`（**0 即失败，调用方写法不变**）

唯一例外是**跨文档原子操作**（占位 + 日志 + 计数三处同时成功）。原实现靠事务，改造方案：
1. 主体操作用单文档原子更新（带条件）抢位；
2. 抢到后再写日志；日志失败不回滚（日志是审计用途，原事务里其实也是「同生共死」，此处放宽为「主操作成功即成功」）；
3. 需要严格一致的位置，用 `_id` 幂等键防重复（重跑安全）。

> 这一节是阶段 5 的施工依据，改 `songStatusService` / `songSchedulingService` 前必须先读这里。
